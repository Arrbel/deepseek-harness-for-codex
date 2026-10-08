// Unit tests for the run state machine and the recovery policy (`run/state.ts`).
//
// These are the tests ADR-0003 §3.2 asks for by name: settle-once (including the *illegal*
// second transition), classification without message guessing, and the class → policy table.
import { describe, expect, it } from "vitest";
import { createRunRecord, type RunRecord } from "../../src/run/registry.js";
import {
  RPC_HANDLING,
  isRegisteredRpcCode,
  isTerminal,
  outcomeFor,
  recoveryPolicyFor,
  settle,
  settleStrict,
  terminalReasonFor,
  type RunOutcome,
} from "../../src/run/state.js";
import "../support/isolation.js";

function newRecord(): RunRecord {
  return createRunRecord({
    runId: "run-1",
    serviceId: "service-1",
    sessionId: "session-1",
    sessionReused: false,
    startEventSeq: 0,
    task: "task",
    workspace: "E:\\ws",
    webUrl: "http://127.0.0.1:1/?token=SECRET",
    startedAt: new Date(0),
    lastEventSeq: 0,
  });
}

const FAILED: RunOutcome = { kind: "failed", reason: "auth", message: "cookie expired" };

describe("run/state settle-once", () => {
  it("writes the terminal state exactly once and reports that it did", () => {
    const run = newRecord();
    expect(isTerminal(run)).toBe(false);

    const wrote = settle(run, { kind: "succeeded" }, new Date(1_000));

    expect(wrote).toBe(true);
    expect(run.status).toBe("succeeded");
    expect(run.settled).toBe(true);
    expect(run.reason).toBeNull();
    expect(run.error).toBeNull();
    expect(run.finishedAt?.getTime()).toBe(1_000);
    expect(isTerminal(run)).toBe(true);
  });

  it("drops a second settle instead of overwriting the first one", () => {
    const run = newRecord();
    settle(run, { kind: "failed", reason: "turn-truncated", message: "truncated" }, new Date(2_000));

    const wrote = settle(run, { kind: "succeeded" }, new Date(3_000));

    expect(wrote).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.reason).toBe("turn-truncated");
    expect(run.error).toBe("truncated");
    expect(run.finishedAt?.getTime()).toBe(2_000);
  });

  it("keeps the strict variant as the only way to make a second settle an error", () => {
    const run = newRecord();
    settleStrict(run, FAILED);

    expect(run.status).toBe("failed");
    expect(run.reason).toBe("auth");
    expect(() => settleStrict(run, { kind: "cancelled" })).toThrow(/already settled as failed/u);
    // The production API stays quiet: a stop path must not be interrupted by a race.
    expect(settle(run, { kind: "cancelled" })).toBe(false);
    expect(run.status).toBe("failed");
  });
});

describe("run/state recovery policy", () => {
  it("re-exchanges the credential once for an expired cookie", () => {
    const policy = recoveryPolicyFor("auth-expired");
    expect(policy).toMatchObject({ attempts: 2, reauthenticate: true, settleWithoutRetry: false, propagates: false });
  });

  it("backs off at most three retries for the transport", () => {
    const policy = recoveryPolicyFor("transport");
    expect(policy.attempts).toBe(4);
    expect(policy.backoffMs.length).toBe(4);
    expect(policy.reauthenticate).toBe(false);
  });

  it("never retries protocol drift, business errors, or unknown failures", () => {
    for (const kind of ["protocol-drift", "rpc", "unknown"] as const) {
      expect(recoveryPolicyFor(kind)).toMatchObject({ attempts: 1, settleWithoutRetry: true, propagates: false });
    }
  });

  it("lets a caller error propagate untouched", () => {
    expect(recoveryPolicyFor("not-found").propagates).toBe(true);
  });

  it("keeps the business-error table explicit", () => {
    expect(isRegisteredRpcCode("session/workspace-attach-failed")).toBe(true);
    expect(isRegisteredRpcCode("session/not-found")).toBe(true);
    expect(isRegisteredRpcCode("something/unknown")).toBe(false);
    expect(Object.keys(RPC_HANDLING).length).toBeGreaterThan(0);
  });
});

describe("run/state terminal reasons", () => {
  it("maps each class onto the frozen reason vocabulary", () => {
    expect(terminalReasonFor("auth-expired", null)).toBe("auth");
    expect(terminalReasonFor("transport", "ECONNREFUSED")).toBe("service-unreachable");
    expect(terminalReasonFor("protocol-drift", null)).toBe("protocol-drift");
    expect(terminalReasonFor("rpc", "session/not-found")).toBe("rpc:session/not-found");
    expect(terminalReasonFor("rpc", null)).toBe("rpc:unknown");
    expect(terminalReasonFor("unknown", null)).toBe("turn-unknown:error");
    expect(terminalReasonFor("unknown", "EWHAT")).toBe("turn-unknown:EWHAT");
  });

  it("refuses to invent a terminal reason for a caller error", () => {
    expect(() => terminalReasonFor("not-found", "ENOENT")).toThrow(/propagate/u);
  });

  it("builds the failed outcome from the classified failure", () => {
    const outcome = outcomeFor("transport", "ECONNRESET", "socket closed");
    expect(outcome).toEqual({ kind: "failed", reason: "service-unreachable", message: "socket closed" });
  });
});
