// R2-1 `nextAction` and R2-2 `webUrlStale`: the recovery vocabulary a caller acts on.
//
// Both fields are **derived from `reason` alone** (`run/state.ts`). The tables below are the
// contract, written out in full rather than re-derived through the implementation: a change to
// the mapping must be a deliberate edit to this file too.
//
// The point of the closed set is the *open* families: `rpc:*`, `turn-aborted:*`, `turn-unknown:*`
// carry a code this project may never have seen, and answering them with a concrete action would
// be a guess dressed as advice. They are `report-only`, exhaustively.

import { describe, expect, it } from "vitest";
import { RunRegistry, createRunRecord, type RunRecord } from "../../src/run/registry.js";
import {
  NEXT_ACTION_BY_REASON,
  nextActionFor,
  settle,
  webUrlStaleFor,
  type ClosedFailureReason,
} from "../../src/run/state.js";
import type { FailureReason, RunAction } from "../../src/run/types.js";
import "../support/isolation.js";

const ACTIONS: readonly RunAction[] = [
  "retry-narrower",
  "new-session",
  "restart-service",
  "relogin",
  "report-only",
  "none",
];

/** Every *closed* failure reason, with the action the contract assigns it. */
const CLOSED_TABLE: readonly (readonly [ClosedFailureReason, RunAction])[] = [
  ["auth", "relogin"],
  ["transport", "restart-service"],
  ["protocol-drift", "report-only"],
  ["service-unreachable", "restart-service"],
  // Rejected before any step ran → nothing to narrow; the already-published guidance says "try a
  // fresh session or check the permission mode" (Lead ruling, task-21 revision 4).
  ["turn-blocked", "new-session"],
  ["turn-truncated", "retry-narrower"],
  // Crash recovery over a persisted log that DSH then resumes in the *same* session, so we have no
  // evidence the session became unusable: the choice stays with the caller (Lead ruling ②).
  ["turn-interrupted", "report-only"],
];

/** Open families, with codes chosen to look like they *might* justify a concrete action. */
const OPEN_TABLE: readonly FailureReason[] = [
  "rpc:session/not-found",
  "rpc:session/workspace-attach-failed",
  "rpc:rate-limited",
  "turn-aborted:parent",
  "turn-aborted:hook",
  "turn-aborted:disposed",
  "turn-aborted:legacy",
  "turn-aborted:unknown",
  "turn-unknown:forked",
  "turn-unknown:error",
  "turn-unknown:completed-late",
];

const ALL_REASONS: readonly FailureReason[] = [
  ...CLOSED_TABLE.map(([reason]) => reason),
  ...OPEN_TABLE,
];

function record(): RunRecord {
  return createRunRecord({
    runId: "run-1",
    serviceId: "svc-1",
    sessionId: "ses-1",
    sessionReused: false,
    startEventSeq: 0,
    task: "t",
    workspace: "C:\\ws",
    webUrl: "http://127.0.0.1:51234/?token=fixture",
    lastEventSeq: 0,
    startedAt: new Date("2026-10-09T00:00:00.000Z"),
  });
}

describe("nextAction: reason → action (closed set)", () => {
  it.each(CLOSED_TABLE)("maps %s to %s", (reason, expected) => {
    expect(nextActionFor(reason)).toBe(expected);
  });

  it("covers every closed reason exactly once in the mapping table", () => {
    // `NEXT_ACTION_BY_REASON` is `satisfies Record<ClosedFailureReason, RunAction>`, so this pins
    // the runtime contents to the same closed set the type describes.
    expect(Object.keys(NEXT_ACTION_BY_REASON).sort()).toEqual(CLOSED_TABLE.map(([reason]) => reason).sort());
  });

  it("reserves none for non-failures", () => {
    expect(nextActionFor(null)).toBe("none");
    expect(ACTIONS).toContain("none");
  });

  it("never returns anything outside the closed six", () => {
    for (const reason of [...ALL_REASONS, null]) {
      expect(ACTIONS, String(reason)).toContain(nextActionFor(reason));
    }
  });
});

describe("nextAction: open families are report-only, without exception", () => {
  it.each(OPEN_TABLE)("does not guess an action for %s", (reason) => {
    expect(nextActionFor(reason)).toBe("report-only");
  });

  it("treats any unknown code inside an open family the same way", () => {
    for (const code of ["a", "session/not-found", "totally-new:code", "UPPER", "中文"]) {
      expect(nextActionFor(`rpc:${code}`)).toBe("report-only");
      expect(nextActionFor(`turn-aborted:${code}`)).toBe("report-only");
      expect(nextActionFor(`turn-unknown:${code}`)).toBe("report-only");
    }
  });

  it("also refuses to guess for closed reasons whose cause lies outside us", () => {
    // `turn-interrupted` is crash recovery over a log DSH resumes; it is not a session verdict.
    expect(nextActionFor("turn-interrupted")).toBe("report-only");
    expect(nextActionFor("protocol-drift")).toBe("report-only");
  });
});

describe("webUrlStale: only a dead service invalidates the link (R2-2)", () => {
  it("is true for service-unreachable and false for every other reason", () => {
    for (const reason of ALL_REASONS) {
      expect(webUrlStaleFor(reason), reason).toBe(reason === "service-unreachable");
    }
    expect(webUrlStaleFor(null)).toBe(false);
  });
});

describe("RunSnapshot projection carries both derived fields", () => {
  function snapshotAfter(outcome: Parameters<typeof settle>[1]): ReturnType<typeof RunRegistry.snapshot> {
    const run = record();
    expect(settle(run, outcome, new Date("2026-10-09T00:01:00.000Z"))).toBe(true);
    return RunRegistry.snapshot(run);
  }

  it("reports none/false while running and after success", () => {
    const running = RunRegistry.snapshot(record());
    expect(running.status).toBe("running");
    expect(running.nextAction).toBe("none");
    expect(running.webUrlStale).toBe(false);

    const succeeded = snapshotAfter({ kind: "succeeded" });
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.reason).toBeNull();
    expect(succeeded.nextAction).toBe("none");
    expect(succeeded.webUrlStale).toBe(false);
  });

  it("reports none/false for a user cancellation", () => {
    const cancelled = snapshotAfter({ kind: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nextAction).toBe("none");
    expect(cancelled.webUrlStale).toBe(false);
  });

  it("tells the caller to restart the service when the Host died (the stale-link case)", () => {
    // Exactly what the orchestrator settles with when the transport retries run out.
    const died = snapshotAfter({ kind: "failed", reason: "service-unreachable", message: "socket hang up" });
    expect(died.nextAction).toBe("restart-service");
    expect(died.webUrlStale).toBe(true);
    // The link and its token are what a restart invalidates.
    expect(died.webUrl).toContain("token=");
  });

  it("keeps an open rpc code report-only even when it looks actionable", () => {
    const failed = snapshotAfter({ kind: "failed", reason: "rpc:session/not-found", message: "no session" });
    expect(failed.nextAction).toBe("report-only");
    expect(failed.webUrlStale).toBe(false);
  });

  it("re-derives from the settled reason, not from the status text", () => {
    const failed = snapshotAfter({ kind: "failed", reason: "auth", message: "401" });
    expect(failed.nextAction).toBe("relogin");
    expect(failed.webUrlStale).toBe(false);
  });
});
