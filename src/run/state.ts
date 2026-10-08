// Run state: the terminal-state invariant, the failure vocabulary, and the recovery policy.
//
// Two rules live here, both from ADR-0003 §3.2:
//
//   1. **settle-once** — `settle()` is the single terminal writer. It refuses a second write by
//      returning `false` (so a stop/dispose path can never be interrupted by a racing settle),
//      and `settleStrict()` is the test-only variant that throws instead.
//   2. **classification drives recovery** — this module owns the policy table (attempts,
//      backoff, terminal reason). The *class* comes from `dsh/wire.ts#classifyThrownFailure`,
//      the single classifier; no caller re-derives a class from an error message.
//
// Pure module: no IO, no clock beyond the injectable `now` parameter, and — because
// `tests/module-boundaries.test.ts` holds this file to the pure-module rule — no import from
// another layer. {@link FailureKind} therefore restates `dsh/wire.ts`'s `WireFailureKind`
// members (plus `unknown`); `tests/unit/wire.test.ts` fails to compile if the two drift apart.

import type { FailureReason, RunAction } from "./types.js";
import type { RunRecord } from "./registry.js";

/** What a run converges to. */
export type RunOutcome =
  | { kind: "succeeded" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: FailureReason; message: string };

/**
 * Failure classes a thrown operation can be classified into.
 *
 * The first five members are exactly `dsh/wire.ts`'s `WireFailureKind`; the last is this
 * project's "not recognized, therefore not retryable".
 */
export type FailureKind = "auth-expired" | "transport" | "protocol-drift" | "not-found" | "rpc" | "unknown";

/** How many attempts a class gets, and what happens when they run out. */
export interface RecoveryPolicy {
  /** Total attempts *including* the first one. `1` means "never retry". */
  readonly attempts: number;
  /** Clear the held credential before retrying (the next call re-exchanges the launch URL). */
  readonly reauthenticate: boolean;
  /** Delay before each retry, in order; the last value repeats if `attempts` is larger. */
  readonly backoffMs: readonly number[];
  /** Settle the run as failed immediately instead of retrying. */
  readonly settleWithoutRetry: boolean;
  /** A caller error: propagate it and leave the run record untouched (no terminal state). */
  readonly propagates: boolean;
}

const SETTLE_NOW: RecoveryPolicy = {
  attempts: 1,
  reauthenticate: false,
  backoffMs: [],
  settleWithoutRetry: true,
  propagates: false,
};

const CALLER_ERROR: RecoveryPolicy = {
  attempts: 1,
  reauthenticate: false,
  backoffMs: [],
  settleWithoutRetry: false,
  propagates: true,
};

/**
 * Business error codes whose handling is decided here (ADR-0003 §3.2, "Rpc" row).
 *
 * The table is explicit even where every entry says "terminal": an unregistered code is also
 * terminal, and the point of writing the decision down is that *retrying a business error has
 * to be a decision*, never a default.
 */
export const RPC_HANDLING: Readonly<Record<string, "terminal">> = {
  // The Host refused to attach the workspace to the session: deterministic, retry cannot help.
  "session/workspace-attach-failed": "terminal",
  // A session the Host no longer knows about: the run is over either way.
  "session/not-found": "terminal",
};

/** True when a business error code has a registered handling entry. */
export function isRegisteredRpcCode(code: string): boolean {
  return Object.hasOwn(RPC_HANDLING, code);
}

/** The recovery policy for one failure class (plus its code, for the `rpc` class). */
export function recoveryPolicyFor(kind: FailureKind, code: string | null = null): RecoveryPolicy {
  switch (kind) {
    case "auth-expired":
      // Clear the stale cookie, exchange the launch URL once more, retry once (ADR-0003 §3.2).
      return { attempts: 2, reauthenticate: true, backoffMs: [0], settleWithoutRetry: false, propagates: false };
    case "transport":
      // Backoff retries, at most 3 retries, then a terminal `service-unreachable`.
      return { attempts: 4, reauthenticate: false, backoffMs: [0, 150, 400, 900], settleWithoutRetry: false, propagates: false };
    case "protocol-drift":
      // Never retry a contract mismatch: the Host will answer the same way again.
      return SETTLE_NOW;
    case "not-found":
      return CALLER_ERROR;
    case "rpc":
      // Registered or not, business errors are terminal; the table documents *that* choice.
      return SETTLE_NOW;
    case "unknown":
      return SETTLE_NOW;
  }
}

/**
 * The terminal reason a class settles with, given the code the failure carried.
 *
 * `not-found` never reaches this function: it propagates as a caller error (see
 * {@link recoveryPolicyFor}), so asking for its terminal reason is a programming error.
 */
export function terminalReasonFor(kind: FailureKind, code: string | null): FailureReason {
  switch (kind) {
    case "auth-expired":
      return "auth";
    case "transport":
      return "service-unreachable";
    case "protocol-drift":
      return "protocol-drift";
    case "not-found":
      throw new Error("not-found failures propagate as caller errors and have no terminal reason");
    case "rpc":
      return `rpc:${code ?? "unknown"}`;
    case "unknown":
      return `turn-unknown:${code ?? "error"}`;
  }
}

/** The outcome a classified failure settles with. */
export function outcomeFor(kind: FailureKind, code: string | null, message: string): RunOutcome {
  return { kind: "failed", reason: terminalReasonFor(kind, code), message };
}

/** True once the run reached a terminal status, by either gate. */
export function isTerminal(record: RunRecord): boolean {
  return record.settled || record.status !== "running";
}

/**
 * The failure reasons that are *closed* vocabulary — i.e. everything except the three open
 * families (`rpc:`, `turn-aborted:`, `turn-unknown:`), which carry a code this project may never
 * have seen.
 */
export type ClosedFailureReason = Exclude<FailureReason, `${string}:${string}`>;

/**
 * `reason → next action`, the single source of `RunSnapshot.nextAction` (R2-1).
 *
 * The table is `satisfies Record<ClosedFailureReason, RunAction>`, so adding a closed reason
 * without deciding its action is a **compile error** rather than a silent fallback. Every open
 * family is intentionally absent and therefore lands on `report-only`: an unnameable failure must
 * not be answered with a plausible-looking guess (`rpc:session/not-found` *looks* like
 * "new-session", but deciding that is a product judgement, not a derivation).
 *
 * `turn-blocked` → `new-session` (Lead ruling, task-21 revision 4): the turn was rejected **before
 * any step ran**, so there is nothing to narrow — and the already-published guidance
 * (`SKILL.md`, README) says "try a fresh session or check the permission mode". A rejection is a
 * session/permission-side condition, and a fresh session is the cheap, clean retry.
 *
 * `turn-interrupted` → `report-only` (same ruling, and the evidence confirms it): it is DSH's
 * *crash recovery* for a persisted log (`packages/core/session/src/repair.ts:20-29`), and the
 * resume path reopens the **same** session and continues
 * (`packages/core/agent-loop/src/index.ts:848-880`), with the cold read documented as "ready for
 * in-place Session restoration"
 * (`packages/session-query/session-query/src/cold-read.ts:20-56`). Nothing couples `interrupted`
 * to session disposal — the ACP codec separately reserves `cancelled` for cancellation *and
 * disposal* (`packages/acp/acp/src/codec.ts:20-26`). Asserting "the old session is unusable" would
 * therefore claim something we have not verified.
 */
export const NEXT_ACTION_BY_REASON = {
  auth: "relogin",
  transport: "restart-service",
  "protocol-drift": "report-only",
  "service-unreachable": "restart-service",
  "turn-blocked": "new-session",
  "turn-truncated": "retry-narrower",
  "turn-interrupted": "report-only",
} as const satisfies Record<ClosedFailureReason, RunAction>;

/**
 * The single derivation for `RunSnapshot.nextAction` (R2-1): `reason` in, action out.
 *
 * `reason === null` is exactly the non-failure state (`running`/`succeeded`/`cancelled` — see
 * `applyOutcome`), so `none` needs no second input and the field stays one-directional.
 */
export function nextActionFor(reason: FailureReason | null): RunAction {
  if (reason === null) return "none";
  // Open families (`rpc:*`, `turn-aborted:*`, `turn-unknown:*`) are absent from the table.
  return (NEXT_ACTION_BY_REASON as Readonly<Record<string, RunAction>>)[reason] ?? "report-only";
}

/**
 * Whether the snapshot's `webUrl` still points at a live service (R2-2).
 *
 * Only `service-unreachable` proves the service is gone. A restart binds a new port *and* rotates
 * the launch token, so the old link (and its token) is dead — nothing else in the vocabulary
 * establishes that.
 */
export function webUrlStaleFor(reason: FailureReason | null): boolean {
  return reason === "service-unreachable";
}

function applyOutcome(record: RunRecord, outcome: RunOutcome, now: Date): void {
  record.settled = true;
  record.finishedAt = now;
  switch (outcome.kind) {
    case "succeeded":
      record.status = "succeeded";
      record.reason = null;
      record.error = null;
      return;
    case "cancelled":
      record.status = "cancelled";
      record.reason = null;
      record.error = null;
      return;
    case "failed":
      record.status = "failed";
      record.reason = outcome.reason;
      record.error = outcome.message;
      return;
  }
}

/**
 * Applies one outcome to a run record — **once**.
 *
 * Returns `true` when this call wrote the terminal state, `false` when the run had already
 * settled (the write is dropped, not merged). The boolean is what makes repeated settles safe
 * on the stop/dispose paths: nothing can throw halfway through releasing resources.
 */
export function settle(record: RunRecord, outcome: RunOutcome, now: Date = new Date()): boolean {
  if (isTerminal(record)) return false;
  applyOutcome(record, outcome, now);
  return true;
}

/**
 * Test-only strict variant: a second settle is a programming error, not a state transition.
 *
 * Production paths use {@link settle}; this exists so the "two writers race for the terminal
 * state" bug can be *asserted* rather than merely tolerated.
 */
export function settleStrict(record: RunRecord, outcome: RunOutcome, now: Date = new Date()): void {
  if (isTerminal(record)) {
    throw new Error(`run already settled as ${record.status}; refusing to settle again as ${outcome.kind}`);
  }
  applyOutcome(record, outcome, now);
}
