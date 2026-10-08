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

import type { FailureReason } from "./types.js";
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
