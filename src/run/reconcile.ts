// Reconciliation: what a *later* MCP process concludes about a run it never started (R3-3).
//
// The decision is a pure function of the journal record plus one observation of the live Host, and
// it deliberately reuses the vocabulary the in-process path already uses (`run/state.ts`,
// `dsh/events.ts`) — no new status, no new reason, no second opinion:
//
//   * a terminal `turn/end` in the log  → that outcome (whatever it is), exactly as `refresh` does;
//   * the session is still running      → **adopt** it as `running` and keep polling;
//   * the session is idle, no `turn/end` → `failed(turn-unknown:missing-turn-end)` (fail closed);
//   * the service or the session is gone → `failed(service-unreachable)` (⇒ `webUrlStale: true`).
//
// The only thing that may **not** happen here is `succeeded` without a `turn/end`.

import { lastTurnEndOutcome } from "../dsh/events.js";
import type { ClassifiedWireFailure } from "../dsh/wire.js";
import type { HistoryEvent } from "../dsh/types.js";
import { createRunRecord, type RunRecord } from "./registry.js";
import { journalWebUrl, type JournalRecord } from "./journal.js";
import { outcomeFor, type RunOutcome } from "./state.js";

/** One observation of the live Host, taken by the orchestrator through the service client. */
export interface ReconcileObservation {
  /** False when this process has no running service for the record's workspace. */
  readonly serviceAlive: boolean;
  readonly session: "running" | "idle" | "missing";
  /** Events after the journal's `startEventSeq` (empty when unreadable). */
  readonly events: readonly HistoryEvent[];
  /** `session/projections#asOfSeq`; the high-water mark the events were read against. */
  readonly asOfSeq: number;
  /**
   * The classified failure that stopped the observation, when it was not a "session is gone".
   *
   * Kept so the decision maps it exactly like the in-process path does (`failRun`), instead of
   * inventing a reason for an RPC that failed in its own way.
   */
  readonly failure?: ClassifiedWireFailure | undefined;
}

/** What to do with one non-terminal journal record. */
export type ReconcileDecision =
  | { readonly kind: "adopt"; readonly lastEventSeq: number }
  | { readonly kind: "settle"; readonly outcome: RunOutcome };

/**
 * Reason used to converge a duplicate ownership claim (open form, `report-only` downstream).
 *
 * Defensive: after the atomic reservation (N-R3-1) a *new* duplicate cannot be produced, but a
 * durable state that already contains one must not end up with two owners driving the same Harness
 * session. It stays inside the existing open vocabulary (`turn-unknown:<kind>`), so no closed-table
 * entry and no `RunStatus` member is added.
 */
export const SUPERSEDED_DUPLICATE_REASON = "turn-unknown:superseded-duplicate-journal";

/** The identity fields the ownership rule needs from a journal record. */
export type JournalClaim = Pick<JournalRecord, "runId" | "sessionId" | "startedAt" | "lastKnownSeq">;

/** One live run of this process that already owns a session. */
export interface OwnedSession {
  readonly sessionId: string;
  readonly runId: string;
}

/** The outcome of resolving who owns which session among the non-terminal journal records. */
export interface ClaimResolution<T extends JournalClaim> {
  /** Claims that may be adopted or settled. */
  readonly owners: T[];
  /** Claims that lost ownership, with the run they were superseded by. */
  readonly superseded: { readonly claim: T; readonly supersededBy: string }[];
}

/**
 * Decides which non-terminal journal records may act (pure).
 *
 * Two rules, both defensive:
 *
 *   1. a session that a **live run of this process** already owns cannot have a second owner, so a
 *      journal claim for it is superseded regardless of timestamps (a current owner beats a disk
 *      record);
 *   2. among the remaining records, only the **newest** claim per `sessionId` acts; older claims are
 *      duplicates left behind by the pre-fix race (N-R3-1).
 *
 * "Newest" is `startedAt` descending, then `lastKnownSeq` descending, then `runId` ascending — a
 * total order, so the result never depends on directory iteration order.
 */
export function resolveClaims<T extends JournalClaim>(
  claims: readonly T[],
  owned: readonly OwnedSession[] = [],
): ClaimResolution<T> {
  const ownedSessions = new Map(owned.map((run) => [run.sessionId, run.runId]));
  const superseded: { claim: T; supersededBy: string }[] = [];
  const ownerBySession = new Map<string, T>();

  for (const claim of claims) {
    const liveOwner = ownedSessions.get(claim.sessionId);
    if (liveOwner !== undefined) {
      superseded.push({ claim, supersededBy: liveOwner });
      continue;
    }
    const current = ownerBySession.get(claim.sessionId);
    if (current === undefined) {
      ownerBySession.set(claim.sessionId, claim);
      continue;
    }
    const winner = isNewer(claim, current) ? claim : current;
    const loser = winner === claim ? current : claim;
    ownerBySession.set(claim.sessionId, winner);
    // The previously accepted owner may itself be an earlier duplicate.
    const stale = superseded.findIndex((entry) => entry.claim === winner);
    if (stale >= 0) superseded.splice(stale, 1);
    superseded.push({ claim: loser, supersededBy: winner.runId });
  }

  const order = new Map<T, number>(claims.map((claim, index) => [claim, index]));
  const owners = [...ownerBySession.values()].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  return { owners, superseded };
}

/** Total order for "which claim is the newer ownership claim". */
function isNewer(candidate: JournalClaim, current: JournalClaim): boolean {
  if (candidate.startedAt !== current.startedAt) return candidate.startedAt > current.startedAt;
  if (candidate.lastKnownSeq !== current.lastKnownSeq) return candidate.lastKnownSeq > current.lastKnownSeq;
  return candidate.runId < current.runId;
}

/** The terminal outcome a superseded duplicate is converged to. */
export function supersededOutcome(supersededBy: string, sessionId: string): RunOutcome {
  return {
    kind: "failed",
    reason: SUPERSEDED_DUPLICATE_REASON,
    message:
      `Superseded by run ${supersededBy} for the same Harness session ${sessionId}: this journal record is a`
      + " duplicate ownership claim (defensive reconciliation rule).",
  };
}

/** Highest sequence in a window, or `baseline` when the window is empty. */
function highestSeq(events: readonly HistoryEvent[], baseline: number): number {
  return events.reduce((highest, entry) => Math.max(highest, entry.event.seq), baseline);
}

/**
 * The reconciliation decision (pure).
 *
 * Mirrors `RunOrchestrator#refresh` rule for rule, including message wording, so a recovered run
 * explains itself in exactly the same terms as one that never lost its process.
 */
export function reconcileDecision(record: JournalRecord, observation: ReconcileObservation): ReconcileDecision {
  const failure = observation.failure;
  if (failure !== undefined && failure.kind !== "not-found") {
    // Same mapping the in-process path uses for an observed failure (`failRun`). `not-found` never
    // reaches here: the orchestrator turns it into "the session disappeared" before deciding.
    return { kind: "settle", outcome: outcomeFor(failure.kind, failure.code, failure.message) };
  }
  if (!observation.serviceAlive) {
    return {
      kind: "settle",
      outcome: {
        kind: "failed",
        reason: "service-unreachable",
        message: `Harness Web service is gone; the run cannot be observed any more (recovered from the run journal): ${record.sessionId}`,
      },
    };
  }
  if (observation.session === "missing") {
    return {
      kind: "settle",
      outcome: {
        kind: "failed",
        reason: "service-unreachable",
        message: `Harness session disappeared: ${record.sessionId}`,
      },
    };
  }
  const terminal = lastTurnEndOutcome([...observation.events], { cancelRequested: record.cancelRequested });
  if (terminal !== null) {
    // The Host finished the turn before we lost the process: the outcome was never a guess.
    return { kind: "settle", outcome: terminal };
  }
  const idle = observation.session === "idle";
  if (record.cancelRequested && idle) {
    return { kind: "settle", outcome: { kind: "cancelled" } };
  }
  if (idle) {
    // Fail closed. Reusing the existing rule (and its reason) is the point: a run that stopped
    // without a terminal turn marker is *not* a success, and this process has no way to observe
    // the missing evidence any more.
    return {
      kind: "settle",
      outcome: {
        kind: "failed",
        reason: "turn-unknown:missing-turn-end",
        message: record.sawRunningSession
          ? `Harness session stopped running without a terminal turn marker: ${record.sessionId}`
          : `Harness session never reported a running turn and has no terminal turn marker: ${record.sessionId}`,
      },
    };
  }
  return {
    kind: "adopt",
    lastEventSeq: Math.max(record.lastKnownSeq, highestSeq(observation.events, record.lastKnownSeq), observation.asOfSeq),
  };
}

/**
 * The journal record after a terminal outcome, without a live record to project from.
 *
 * Used by the reconciliation pass for a run that exists only on disk: the terminal fields come
 * from the same `RunOutcome` the in-process path would have settled with.
 */
export function journalRecordAfterOutcome(record: JournalRecord, outcome: RunOutcome, now: Date): JournalRecord {
  const finishedAt = now.toISOString();
  switch (outcome.kind) {
    case "succeeded":
      return { ...record, status: "succeeded", reason: null, finishedAt, error: null, webUrl: journalWebUrl(record.webUrl, "succeeded") };
    case "cancelled":
      return { ...record, status: "cancelled", reason: null, finishedAt, error: null, webUrl: journalWebUrl(record.webUrl, "cancelled") };
    case "failed":
      return {
        ...record,
        status: "failed",
        reason: outcome.reason,
        finishedAt,
        error: outcome.message,
        webUrl: journalWebUrl(record.webUrl, "failed"),
      };
  }
}

/** Projects a live run record into the durable shape. */
export function journalRecordFor(run: RunRecord): JournalRecord {
  return {
    version: 1,
    runId: run.runId,
    serviceId: run.serviceId,
    sessionId: run.sessionId,
    sessionReused: run.sessionReused,
    workspace: run.workspace,
    task: run.task,
    // The credential rule (R3-3b) lives in one place: `journalWebUrl` keeps the full link while the
    // run can still be adopted and reduces it to origin + path once it is terminal.
    webUrl: journalWebUrl(run.webUrl, run.status),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status,
    reason: run.reason,
    lastKnownSeq: Math.max(run.lastEventSeq, run.startEventSeq),
    startEventSeq: run.startEventSeq,
    sawRunningSession: run.sawRunningSession,
    cancelRequested: run.cancelRequested,
    error: run.error,
  };
}

/**
 * Rebuilds a *running* record from a journal entry.
 *
 * The record is deliberately reconstructed as `running`: adoption is the only non-terminal
 * decision, and `settle()` remains the single writer of terminal state.
 */
export function restoredRecord(record: JournalRecord, serviceId: string): RunRecord {
  const run = createRunRecord({
    runId: record.runId,
    serviceId,
    sessionId: record.sessionId,
    sessionReused: record.sessionReused,
    startEventSeq: record.startEventSeq,
    task: record.task,
    workspace: record.workspace,
    webUrl: record.webUrl,
    startedAt: new Date(record.startedAt),
    lastEventSeq: record.lastKnownSeq,
    sawRunningSession: record.sawRunningSession,
  });
  run.cancelRequested = record.cancelRequested;
  return run;
}
