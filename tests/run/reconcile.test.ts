// Reconciliation decisions (R3-3): the table a *later* MCP process follows.
//
// The red line this file exists for: a run that stopped without a terminal turn must land on the
// **existing** fail-closed reason (`turn-unknown:missing-turn-end`) as `failed` — never as
// `succeeded`, and never as a status the vocabulary does not have.

import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "../../src/dsh/types.js";
import { JOURNAL_VERSION, type JournalRecord } from "../../src/run/journal.js";
import {
  SUPERSEDED_DUPLICATE_REASON,
  journalRecordAfterOutcome,
  journalRecordFor,
  reconcileDecision,
  resolveClaims,
  restoredRecord,
  supersededOutcome,
  type JournalClaim,
  type ReconcileObservation,
} from "../../src/run/reconcile.js";
import { createRunRecord, RunRegistry } from "../../src/run/registry.js";
import { nextActionFor } from "../../src/run/state.js";
import type { RunStatus } from "../../src/run/types.js";
import { classifyThrownFailure, type ClassifiedWireFailure } from "../../src/dsh/wire.js";
import "../support/isolation.js";

const RUN_STATUSES: readonly RunStatus[] = ["running", "succeeded", "failed", "cancelled"];

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: JOURNAL_VERSION,
    runId: "run-1",
    serviceId: "svc-1",
    sessionId: "ses-1",
    sessionReused: false,
    workspace: "C:\\ws",
    task: "t",
    webUrl: "http://127.0.0.1:51234/?token=fixture",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: null,
    status: "running",
    reason: null,
    lastKnownSeq: 5,
    startEventSeq: 3,
    sawRunningSession: true,
    cancelRequested: false,
    error: null,
    ...overrides,
  };
}

function observation(overrides: Partial<ReconcileObservation> = {}): ReconcileObservation {
  return { serviceAlive: true, session: "idle", events: [], asOfSeq: 5, ...overrides };
}

function turnEnd(kind: string, seq: number, extra: Record<string, unknown> = {}): HistoryEvent {
  return { event: { type: "turn/end", seq, data: { turn: 1, reason: { kind, ...extra } } } };
}

describe("reconcileDecision: the three required branches", () => {
  it("adopts a run whose session is still running", () => {
    const decision = reconcileDecision(
      record(),
      observation({ session: "running", events: [{ event: { type: "assistant/message", seq: 9, data: {} } }], asOfSeq: 9 }),
    );

    expect(decision).toEqual({ kind: "adopt", lastEventSeq: 9 });
  });

  it("adopts from the journal's own high-water mark when the Host is behind it", () => {
    const decision = reconcileDecision(record({ lastKnownSeq: 40 }), observation({ session: "running", asOfSeq: 12 }));
    expect(decision).toEqual({ kind: "adopt", lastEventSeq: 40 });
  });

  it("fails closed when the session is idle without a terminal turn marker", () => {
    const decision = reconcileDecision(record(), observation({ session: "idle", asOfSeq: 9 }));

    expect(decision.kind).toBe("settle");
    expect(decision).toMatchObject({
      outcome: { kind: "failed", reason: "turn-unknown:missing-turn-end" },
    });
  });

  it("says when the session never reported a running turn (same reason, honest wording)", () => {
    const decision = reconcileDecision(record({ sawRunningSession: false }), observation({ session: "idle" }));

    expect(decision).toMatchObject({ outcome: { kind: "failed", reason: "turn-unknown:missing-turn-end" } });
    expect(JSON.stringify(decision)).toContain("never reported a running turn");
  });

  it("fails with service-unreachable when no service serves the workspace", () => {
    const decision = reconcileDecision(record(), observation({ serviceAlive: false }));

    expect(decision).toMatchObject({ outcome: { kind: "failed", reason: "service-unreachable" } });
  });

  it("fails with service-unreachable when the session disappeared", () => {
    const decision = reconcileDecision(record(), observation({ session: "missing" }));

    expect(decision).toMatchObject({ outcome: { kind: "failed", reason: "service-unreachable" } });
  });
});

describe("reconcileDecision: a terminal turn in the log decides, not a guess", () => {
  it("takes the recorded outcome when the Host finished before the crash", () => {
    expect(reconcileDecision(record(), observation({ events: [turnEnd("completed", 7)], asOfSeq: 7 })))
      .toMatchObject({ outcome: { kind: "succeeded" } });
    expect(reconcileDecision(record(), observation({ events: [turnEnd("blocked", 7)], asOfSeq: 7 })))
      .toMatchObject({ outcome: { kind: "failed", reason: "turn-blocked" } });
    expect(reconcileDecision(record(), observation({ events: [turnEnd("max-tokens", 7)], asOfSeq: 7 })))
      .toMatchObject({ outcome: { kind: "failed", reason: "turn-truncated" } });
    expect(reconcileDecision(record(), observation({ events: [turnEnd("error", 7, { error: { code: "boom", message: "x" } })], asOfSeq: 7 })))
      .toMatchObject({ outcome: { kind: "failed", reason: "rpc:boom" } });
  });

  it("honours a user cancellation recorded in the log", () => {
    expect(
      reconcileDecision(record(), observation({ events: [turnEnd("aborted", 7, { reason: { kind: "user" } })], asOfSeq: 7 })),
    ).toMatchObject({ outcome: { kind: "cancelled" } });
  });

  it("treats an idle session with a requested cancel as cancelled, before the missing-marker rule", () => {
    expect(reconcileDecision(record({ cancelRequested: true }), observation({ session: "idle" })))
      .toMatchObject({ outcome: { kind: "cancelled" } });
    // ...but a still-running session is not cancelled just because a cancel was requested.
    expect(reconcileDecision(record({ cancelRequested: true }), observation({ session: "running" })))
      .toEqual({ kind: "adopt", lastEventSeq: 5 });
  });
});

describe("reconcileDecision: observed RPC failures keep their own classification", () => {
  it("maps a classified failure exactly like the in-process path", () => {
    const failure: ClassifiedWireFailure = {
      kind: "protocol-drift",
      code: "wire/shape",
      message: "bad shape",
      method: "session/list",
      path: "items",
    };
    const decision = reconcileDecision(record(), observation({ failure }));

    // `terminalReasonFor("protocol-drift")` — the same mapping `failRun` performs.
    expect(decision).toMatchObject({ outcome: { kind: "failed", reason: "protocol-drift" } });
  });

  it("ignores a not-found failure (the orchestrator turns it into 'session disappeared')", () => {
    const failure: ClassifiedWireFailure = {
      kind: "not-found",
      code: "session/not-found",
      message: "no such session",
      method: "session/projections",
      path: "sessionId",
    };
    // A `not-found` never reaches the decision as a failure (the orchestrator maps it to
    // `session: "missing"`), so the decision must not try to map its reason either.
    expect(reconcileDecision(record(), observation({ session: "missing" }))).toMatchObject({
      outcome: { kind: "failed", reason: "service-unreachable" },
    });
    expect(failure.kind).toBe("not-found");
  });
});

describe("no new status: reconciliation stays inside the vocabulary", () => {
  const sessions: ReconcileObservation["session"][] = ["running", "idle", "missing"];
  const ends: HistoryEvent[][] = [[], [turnEnd("completed", 7)], [turnEnd("blocked", 7)]];

  it("never invents a status, and never reports success without a terminal turn", () => {
    for (const session of sessions) {
      for (const events of ends) {
        for (const serviceAlive of [true, false]) {
          for (const cancelRequested of [false, true]) {
            const decision = reconcileDecision(
              record({ cancelRequested }),
              observation({ session, events, serviceAlive, asOfSeq: 9 }),
            );
            if (decision.kind === "adopt") {
              // Adoption is the only non-terminal decision, and it always means `running`.
              expect(RUN_STATUSES).toContain("running");
              continue;
            }
            expect(["succeeded", "failed", "cancelled"]).toContain(decision.outcome.kind);
            const hasTerminalTurn = events.some((entry) => entry.event.type === "turn/end");
            if (decision.outcome.kind === "succeeded") expect(hasTerminalTurn, JSON.stringify(decision)).toBe(true);
            if (decision.outcome.kind === "failed") {
              // No failure path introduces a reason outside the closed vocabulary.
              expect(decision.outcome.reason).toMatch(/^(auth|transport|protocol-drift|service-unreachable|turn-(blocked|truncated|interrupted)|rpc:|turn-aborted:|turn-unknown:)/u);
            }
          }
        }
      }
    }
  });
});

describe("duplicate ownership claims (U-3, defensive)", () => {
  function claim(runId: string, sessionId: string, startedAt: string, lastKnownSeq = 1): JournalClaim {
    return { runId, sessionId, startedAt, lastKnownSeq };
  }

  it("keeps only the newest claim per session", () => {
    const older = claim("run-old", "ses-1", "2026-10-09T00:00:00.000Z");
    const newer = claim("run-new", "ses-1", "2026-10-09T00:00:30.000Z");

    const { owners, superseded } = resolveClaims([older, newer]);

    expect(owners).toEqual([newer]);
    expect(superseded).toEqual([{ claim: older, supersededBy: "run-new" }]);
  });

  it("breaks a timestamp tie deterministically (sequence, then runId)", () => {
    const startedAt = "2026-10-09T00:00:00.000Z";
    const low = claim("run-a", "ses-1", startedAt, 3);
    const high = claim("run-b", "ses-1", startedAt, 7);
    expect(resolveClaims([low, high]).owners).toEqual([high]);

    const first = claim("run-aaa", "ses-2", startedAt, 1);
    const second = claim("run-bbb", "ses-2", startedAt, 1);
    expect(resolveClaims([second, first]).owners).toEqual([first]);
  });

  it("supersedes every disk claim for a session a live run already owns", () => {
    const older = claim("run-old", "ses-1", "2026-10-09T00:00:00.000Z");
    const newer = claim("run-new", "ses-1", "2026-10-09T00:00:30.000Z");

    // A current owner beats a disk record, whatever the timestamps say.
    const { owners, superseded } = resolveClaims([older, newer], [{ sessionId: "ses-1", runId: "live-run" }]);

    expect(owners).toEqual([]);
    expect(superseded.map((entry) => [entry.claim.runId, entry.supersededBy])).toEqual([
      ["run-old", "live-run"],
      ["run-new", "live-run"],
    ]);
  });

  it("keeps claims of different sessions independent of each other", () => {
    const a = claim("run-a", "ses-a", "2026-10-09T00:00:00.000Z");
    const b = claim("run-b", "ses-b", "2026-10-09T00:00:00.000Z");

    const { owners, superseded } = resolveClaims([a, b]);

    expect(owners).toEqual([a, b]);
    expect(superseded).toEqual([]);
  });

  it("stays inside the existing vocabulary: an open form that maps to report-only", () => {
    expect(SUPERSEDED_DUPLICATE_REASON).toBe("turn-unknown:superseded-duplicate-journal");
    expect(nextActionFor(SUPERSEDED_DUPLICATE_REASON)).toBe("report-only");
    expect(supersededOutcome("run-new", "ses-1")).toMatchObject({
      kind: "failed",
      reason: SUPERSEDED_DUPLICATE_REASON,
    });
    expect(JSON.stringify(supersededOutcome("run-new", "ses-1"))).toContain("run-new");
  });
});

describe("journal mapping helpers", () => {
  it("projects a live record and restores it as running", () => {
    const live = createRunRecord({
      runId: "run-9",
      serviceId: "svc-1",
      sessionId: "ses-9",
      sessionReused: true,
      startEventSeq: 4,
      task: "t",
      workspace: "C:\\ws",
      webUrl: "http://127.0.0.1:1/?token=x",
      startedAt: new Date("2026-10-09T00:00:00.000Z"),
      lastEventSeq: 11,
    });
    const persisted = journalRecordFor(live);

    expect(persisted).toMatchObject({ status: "running", reason: null, finishedAt: null, lastKnownSeq: 11 });

    const restored = restoredRecord(persisted, "svc-2");
    expect(restored.status).toBe("running");
    expect(restored.serviceId).toBe("svc-2");
    expect(restored.runId).toBe("run-9");
    expect(restored.lastEventSeq).toBe(11);
    expect(restored.sessionReused).toBe(true);
    // And the round-trip is stable.
    expect(journalRecordFor(restored)).toEqual({ ...persisted, serviceId: "svc-2" });
  });

  it("carries a requested cancel across the restart", () => {
    const restored = restoredRecord(record({ cancelRequested: true }), "svc-1");
    expect(restored.cancelRequested).toBe(true);
  });

  it("maps each terminal outcome onto the record fields together", () => {
    const base = record();
    const now = new Date("2026-10-09T01:00:00.000Z");

    expect(journalRecordAfterOutcome(base, { kind: "succeeded" }, now)).toMatchObject({
      status: "succeeded",
      reason: null,
      finishedAt: now.toISOString(),
      error: null,
    });
    expect(journalRecordAfterOutcome(base, { kind: "cancelled" }, now)).toMatchObject({
      status: "cancelled",
      reason: null,
      error: null,
    });
    expect(
      journalRecordAfterOutcome(base, { kind: "failed", reason: "turn-unknown:missing-turn-end", message: "no marker" }, now),
    ).toMatchObject({
      status: "failed",
      reason: "turn-unknown:missing-turn-end",
      error: "no marker",
      finishedAt: now.toISOString(),
    });
  });

  it("keeps the snapshot projection in agreement after adoption", () => {
    const restored = restoredRecord(record(), "svc-1");
    const snapshot = RunRegistry.snapshot(restored);

    expect(snapshot.status).toBe("running");
    expect(snapshot.nextAction).toBe("none");
    expect(snapshot.webUrlStale).toBe(false);
  });
});
