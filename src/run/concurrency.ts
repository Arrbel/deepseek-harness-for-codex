// Concurrency admission (R3-4): one run per workspace, at most `limit` runs per MCP process.
//
// The model is **refuse with an actionable message**, never queue:
//
//   * a queue would need a state to say "accepted but not started" — and `RunStatus` must stay
//     `running | succeeded | failed | cancelled` (settle-once, ADR-0003). A refused call creates
//     **no** run record at all, so there is nothing to settle, nothing to journal, and nothing to
//     leak into `list_runs`;
//   * the caller (Codex) is a person-facing agent: an immediate, explicit "workspace busy, here is
//     the run to wait for / cancel" is more useful than a silent stall it cannot observe.
//
// Adoption/reconciliation (R3-3) is deliberately **not** gated: those runs already exist outside
// this process, and refusing to restore them would recreate the permanent-`running` hole.

import { samePath } from "../policy/paths.js";
import type { RunStatus } from "./types.js";

/** Environment variable that overrides the per-process run limit. */
export const RUN_LIMIT_ENV = "DSH_MCP_RUN_LIMIT";

/**
 * Default limit: four concurrent runs per MCP process.
 *
 * Reasoning (a machine-independent, worst-case bound rather than a benchmark):
 *   * each run = one live Harness *session* (browser tab + LLM stream). The service layer already
 *     keeps one Harness *process* per workspace, so N runs across M workspaces cost N sessions in
 *     M processes (~100 MB RSS + one port per workspace);
 *   * with per-workspace serialization in place, the limit only binds *across* workspaces, i.e. it
 *     is the "how many different repositories may run at once" budget;
 *   * 2 is a common suggestion but refuses the ordinary "hands-on task + two background cleanups"
 *     pattern; 8+ multiplies the failure surface (memory, ports, rate limits) and the user cannot
 *     follow eight browser sessions anyway;
 *   * 4 keeps a comfortable headroom on an 8 GB laptop while still being a *bound* — the point is
 *     that exceeding it is reported, not that 4 is sacred.
 */
export const DEFAULT_RUN_CONCURRENCY_LIMIT = 4;

/** Lower bound of the configurable limit. */
export const MIN_RUN_CONCURRENCY_LIMIT = 1;

/** Upper bound of the configurable limit (a typo must not remove the bound entirely). */
export const MAX_RUN_CONCURRENCY_LIMIT = 64;

/** One run that still occupies a slot. */
export interface ActiveRun {
  readonly runId: string;
  readonly workspace: string;
  readonly status: RunStatus;
}

/**
 * A slot held by a submission that was admitted but has **no run record yet**.
 *
 * This is the piece that makes admission atomic: `start_run` reserves the slot in the same
 * synchronous block that decides it, *before* any `await` (N-R3-1). Without it, two concurrent
 * calls both pass "is this workspace free?" before either registers a run.
 *
 * A pending slot is deliberately **not** a run: it has no runId, no `RunStatus`, no snapshot entry
 * and no journal record — which is exactly why "no `running` record" still means "no `queued`".
 */
export interface PendingRun {
  /** Canonical workspace path this submission will start in. */
  readonly workspace: string;
}

/** Everything that occupies a concurrency slot right now. */
export interface Occupancy {
  readonly active: readonly ActiveRun[];
  readonly pending: readonly PendingRun[];
}

/** The outcome of admitting (or refusing) one `start_run`. */
export type RunAdmission =
  | { readonly ok: true; readonly limit: number; readonly active: number }
  | { readonly ok: false; readonly reason: "workspace-busy"; readonly message: string }
  | { readonly ok: false; readonly reason: "limit-reached"; readonly message: string };

/**
 * Reads the configured limit.
 *
 * A malformed value falls back to the default instead of throwing: a typo in an environment
 * variable must not make the server unusable. Valid values are clamped to
 * `[MIN, MAX]`.
 */
export function resolveRunLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[RUN_LIMIT_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RUN_CONCURRENCY_LIMIT;
  if (!/^[+-]?\d+$/u.test(raw)) return DEFAULT_RUN_CONCURRENCY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Math.min(Math.max(parsed, MIN_RUN_CONCURRENCY_LIMIT), MAX_RUN_CONCURRENCY_LIMIT);
}

/** `3/4 active in 2 workspaces` — the occupancy line used inside refusal messages. */
export function concurrencyLine(occupancy: Occupancy, limit: number): string {
  const slots = [...occupancy.active.map((run) => run.workspace), ...occupancy.pending.map((run) => run.workspace)];
  const workspaces = new Set(slots).size;
  return `${String(slots.length)}/${String(limit)} active in ${String(workspaces)} workspace${workspaces === 1 ? "" : "s"}`;
}

/** `, 1 start_run in progress` — appended when a slot is held by an admission that has no runId yet. */
function pendingNote(occupancy: Occupancy): string {
  const count = occupancy.pending.length;
  return count === 0 ? "" : `, ${String(count)} start_run${count === 1 ? "" : "s"} in progress`;
}

/**
 * The process-capacity verdict alone (`limit-reached` or ok).
 *
 * Split out because an explicitly named session is validated *before* the workspace verdict: the
 * established "this session is still running" refusal must keep priority over "this workspace is
 * busy" (the caller named a session, so the session rules are the more specific answer) — while the
 * capacity bound has no such dependency and can be checked before any side effect.
 */
export function capacityVerdict(input: Occupancy & { readonly limit: number }): RunAdmission {
  const slots = input.active.length + input.pending.length;
  if (slots >= input.limit) {
    const running = input.active.map((run) => run.runId).join(", ");
    const listed = input.pending.length === 0 && running !== "" ? `: ${running}.` : ".";
    return {
      ok: false,
      reason: "limit-reached",
      message:
        `Run limit reached (${concurrencyLine(input, input.limit)}${pendingNote(input)})${listed}`
        + " Wait for one to finish (wait_run), cancel one (cancel_run), or raise"
        + ` ${RUN_LIMIT_ENV} (current limit ${String(input.limit)}).`,
    };
  }
  return { ok: true, limit: input.limit, active: slots };
}

/**
 * Decides whether one more run may start (pure).
 *
 * Both the workspace rule and the capacity bound count **runs and pending admissions** alike: a
 * submission that has reserved its slot must be visible to a concurrent one, which is the whole
 * reason the reservation exists.
 */
export function admitRun(input: Occupancy & {
  readonly workspace: string;
  readonly limit: number;
}): RunAdmission {
  const holder = input.active.find((run) => samePath(run.workspace, input.workspace));
  if (holder !== undefined) {
    return {
      ok: false,
      reason: "workspace-busy",
      message:
        `Workspace ${input.workspace} already has a run in flight (runId ${holder.runId}); this server runs one run`
        + ` per workspace at a time. Wait for it with wait_run ${holder.runId}, read it with get_run ${holder.runId},`
        + ` stop it with cancel_run ${holder.runId}, or start this task in a different workspace.`,
    };
  }
  if (input.pending.some((pending) => samePath(pending.workspace, input.workspace))) {
    return {
      ok: false,
      reason: "workspace-busy",
      message:
        `Workspace ${input.workspace} already has a start_run in progress; this server starts one run per workspace`
        + " at a time. Wait for that call to produce a runId (then wait_run / get_run it), or start this task in a"
        + " different workspace.",
    };
  }
  return capacityVerdict({ active: input.active, pending: input.pending, limit: input.limit });
}
