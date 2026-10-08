// Session-event projection: what the durable event log means for a run.
//
// Two projections live here, both pure:
//
//   * `projectAssistantText` — the assistant text the user must see.
//   * `turnEndOutcome` — what a terminal `turn/end` means for the run (ADR-0003 §3.2).
//
// `turnEndOutcome` exhausts the official `TurnEndReasonMap` and **fails closed**: only
// `completed` is a success. `blocked`, `max-tokens`, `forked`, and any kind this project has
// never seen are failures — the defect this replaces judged `blocked`/`max-tokens` as success
// (a silent false positive pinned by two `it.fails` cases in P4).
//
// Note on `aborted`: `reason.reason.kind` carries the cause (`user` / `parent` / `hook` /
// `disposed` / `legacy`). There is no top-level `disposed` kind — treating one as a turn end was
// a dead branch.

import type { HistoryEvent } from "./types.js";

/** Text carried by a `turn/end` failure record (`message` or `error`). */
export function recordText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return typeof record.message === "string" ? record.message : typeof record.error === "string" ? record.error : null;
}

/** The `turn/end` payload this project reads. */
export interface TurnEndReason {
  /** `turn/end.reason.kind` — one of the official `TurnEndReasonMap` members. */
  readonly kind: string;
  /** `turn/end.reason.reason.kind` — the cause an `aborted` reason carries, else `null`. */
  readonly cause: string | null;
  /** `turn/end.reason.error` — the coded error an `error` reason carries, else `undefined`. */
  readonly error: unknown;
}

/** The last `turn/end` reason in an event window, or `null` when the turn has not ended. */
export function lastTurnEndReason(events: HistoryEvent[]): TurnEndReason | null {
  const turnEnd = [...events].reverse().find((entry) => entry.event.type === "turn/end");
  if (turnEnd === undefined || typeof turnEnd.event.data !== "object" || turnEnd.event.data === null) return null;
  const reason = (turnEnd.event.data as Record<string, unknown>).reason;
  if (typeof reason !== "object" || reason === null) return null;
  const kind = (reason as Record<string, unknown>).kind;
  if (typeof kind !== "string") return null;
  const nested = (reason as Record<string, unknown>).reason;
  const cause =
    typeof nested === "object" && nested !== null && typeof (nested as Record<string, unknown>).kind === "string"
      ? ((nested as Record<string, unknown>).kind as string)
      : null;
  return { kind, cause, error: (reason as Record<string, unknown>).error };
}

/**
 * Failure reasons a terminal turn can produce.
 *
 * This mirrors the subset of `run/types.ts`'s `FailureReason` this module emits. It is declared
 * here because `dsh/events.ts` is a pure module and the boundary suite forbids importing the run
 * layer; the orchestrator assigns these values into `FailureReason` (a structural subset), and
 * `tests/unit/wire.test.ts` + `tests/unit/events.test.ts` pin the shared vocabulary.
 */
export type TurnFailureReason =
  | `rpc:${string}`
  | "turn-blocked"
  | "turn-truncated"
  | `turn-aborted:${string}`
  | "turn-interrupted"
  | `turn-unknown:${string}`;

/** What a terminal turn means for the run. */
export type TurnEndOutcome =
  | { kind: "succeeded" }
  | { kind: "cancelled" }
  | { kind: "failed"; reason: TurnFailureReason; message: string };

/** Context the mapping needs beyond the reason itself. */
export interface TurnEndContext {
  /** True when this process already asked the Host to cancel the turn. */
  readonly cancelRequested: boolean;
}

/** The business code an `error` reason carries, or `null`. */
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * Maps a terminal `turn/end` reason onto the run outcome, failing closed.
 *
 * `blocked` and `max-tokens` are failures: in both, the caller must be told the task did not
 * complete. `aborted` is a cancellation only when the user asked for it — a `parent`/`hook`/
 * `disposed`/`legacy` abort is a failure with its cause in the reason.
 */
export function turnEndOutcome(reason: TurnEndReason, context: TurnEndContext): TurnEndOutcome {
  switch (reason.kind) {
    case "completed":
      return { kind: "succeeded" };
    case "error": {
      const code = errorCode(reason.error);
      const text = recordText(reason.error) ?? "DeepSeek Harness turn failed.";
      return {
        kind: "failed",
        // The code is the actionable part of a Host-reported failure (ADR-0003 §3.2).
        reason: code === null ? "turn-unknown:error" : `rpc:${code}`,
        message: code === null ? text : `${text} (code: ${code})`,
      };
    }
    case "blocked":
      return {
        kind: "failed",
        reason: "turn-blocked",
        message: "DeepSeek Harness refused the turn before it started (blocked).",
      };
    case "max-tokens":
      return {
        kind: "failed",
        reason: "turn-truncated",
        message: "DeepSeek Harness truncated the turn at the token limit.",
      };
    case "aborted": {
      if (context.cancelRequested || reason.cause === "user") return { kind: "cancelled" };
      return {
        kind: "failed",
        reason: `turn-aborted:${reason.cause ?? "unknown"}`,
        message: `DeepSeek Harness turn ended with aborted (${reason.cause ?? "unknown"}).`,
      };
    }
    case "interrupted":
      return {
        kind: "failed",
        reason: "turn-interrupted",
        message: "DeepSeek Harness turn ended with interrupted.",
      };
    default:
      // `forked` and anything DSH adds later: never a success.
      return {
        kind: "failed",
        reason: `turn-unknown:${reason.kind}`,
        message: `DeepSeek Harness turn ended with an unrecognized reason: ${reason.kind}.`,
      };
  }
}

/** The outcome of the last terminal turn in the window, or `null` when there is none. */
export function lastTurnEndOutcome(events: HistoryEvent[], context: TurnEndContext): TurnEndOutcome | null {
  const reason = lastTurnEndReason(events);
  return reason === null ? null : turnEndOutcome(reason, context);
}

/** Concatenates every `assistant/message` text block in the window, in event order. */
export function projectAssistantText(events: HistoryEvent[]): string {
  const blocks: string[] = [];
  for (const { event } of events) {
    if (event.type !== "assistant/message" || typeof event.data !== "object" || event.data === null) continue;
    const message = (event.data as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") blocks.push(text);
      }
    }
  }
  return blocks.join("\n");
}
