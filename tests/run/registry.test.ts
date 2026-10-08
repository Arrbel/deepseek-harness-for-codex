// The run registry's bookkeeping: the session lock and the "who is still running" queries.
//
// Worth its own file because of *how* these methods fail. A `releaseService` regression shows up as
// "the next `start_run` says the session already has an active MCP run" — long after the service
// stop that leaked the claim, and far away from the code that caused it. These tests keep the
// symptom attached to the root cause.

import { describe, expect, it } from "vitest";
import { RunRegistry, createRunRecord, type RunRecord } from "../../src/run/registry.js";
import { settle } from "../../src/run/state.js";
import "../support/isolation.js";

function record(overrides: { runId: string; serviceId?: string; sessionId?: string } = { runId: "run-1" }): RunRecord {
  return createRunRecord({
    runId: overrides.runId,
    serviceId: overrides.serviceId ?? "svc-1",
    sessionId: overrides.sessionId ?? "ses-1",
    sessionReused: false,
    startEventSeq: 1,
    task: "task",
    workspace: "C:\\ws",
    webUrl: "http://127.0.0.1:1/?token=fixture",
    startedAt: new Date("2026-10-09T00:00:00.000Z"),
    lastEventSeq: 1,
  });
}

describe("RunRegistry bookkeeping", () => {
  it("inserts, lists in order, and finds without throwing", () => {
    const registry = new RunRegistry();
    const first = registry.add(record({ runId: "run-1" }));
    registry.add(record({ runId: "run-2" }));

    expect(registry.list().map((run) => run.runId)).toEqual(["run-1", "run-2"]);
    expect(registry.find("run-1")).toBe(first);
    expect(registry.find("nope")).toBeNull();
    expect(registry.require("run-2").runId).toBe("run-2");
    expect(() => registry.require("nope")).toThrow("Unknown runId: nope");
  });

  it("composes the lock key from both identities", () => {
    expect(RunRegistry.sessionKey("svc-1", "ses-1")).toBe("svc-1:ses-1");
  });
});

describe("session lock", () => {
  it("refuses a second claim of the same session and allows it again after release", () => {
    const registry = new RunRegistry();

    registry.acquireSession("svc-1", "ses-1");
    expect(() => registry.acquireSession("svc-1", "ses-1")).toThrow("Harness session already has an active MCP run: ses-1");

    registry.releaseSession("svc-1", "ses-1");
    expect(() => registry.acquireSession("svc-1", "ses-1")).not.toThrow();
  });

  it("is idempotent on release (a double release must not throw)", () => {
    const registry = new RunRegistry();
    registry.acquireSession("svc-1", "ses-1");

    registry.releaseSession("svc-1", "ses-1");
    expect(() => registry.releaseSession("svc-1", "ses-1")).not.toThrow();
    expect(() => registry.releaseSession("svc-1", "never-claimed")).not.toThrow();
  });

  it("scopes the lock per service, so two services may run the same session id", () => {
    const registry = new RunRegistry();

    registry.acquireSession("svc-1", "ses-1");
    expect(() => registry.acquireSession("svc-2", "ses-1")).not.toThrow();
  });
});

describe("releaseService", () => {
  it("frees every claim of that service so the next start is not blocked", () => {
    const registry = new RunRegistry();
    registry.acquireSession("svc-1", "ses-1");
    registry.acquireSession("svc-1", "ses-2");

    registry.releaseService("svc-1");

    expect(() => registry.acquireSession("svc-1", "ses-1")).not.toThrow();
    expect(() => registry.acquireSession("svc-1", "ses-2")).not.toThrow();
  });

  it("leaves other services' claims alone (the prefix match is exact)", () => {
    const registry = new RunRegistry();
    registry.acquireSession("svc", "ses-1");
    registry.acquireSession("svc-2", "ses-1");

    registry.releaseService("svc");

    // `svc-2` must not be released by `releaseService("svc")`, or an unrelated service would lose
    // its lock and two runs could drive the same session.
    expect(() => registry.acquireSession("svc-2", "ses-1")).toThrow("already has an active MCP run");
    expect(() => registry.acquireSession("svc", "ses-1")).not.toThrow();
  });

  it("is idempotent and harmless for a service that never claimed anything", () => {
    const registry = new RunRegistry();
    registry.acquireSession("svc-1", "ses-1");

    registry.releaseService("svc-unknown");
    registry.releaseService("svc-1");

    expect(() => registry.acquireSession("svc-1", "ses-1")).not.toThrow();
  });
});

describe("runningRunIds", () => {
  it("lists only the runs that are still running, in insertion order", () => {
    const registry = new RunRegistry();
    const running = registry.add(record({ runId: "run-running" }));
    const cancelled = registry.add(record({ runId: "run-cancelled" }));
    const failed = registry.add(record({ runId: "run-failed" }));
    const succeeded = registry.add(record({ runId: "run-succeeded" }));

    settle(cancelled, { kind: "cancelled" });
    settle(failed, { kind: "failed", reason: "auth", message: "no credential" });
    settle(succeeded, { kind: "succeeded" });

    expect(registry.runningRunIds()).toEqual(["run-running"]);
    expect(registry.runningRunIds()).toEqual(
      registry.list().filter((run) => run.status === "running").map((run) => run.runId),
    );
    expect(running.status).toBe("running");
  });

  it("frees the run from the query the moment it settles (idempotently)", () => {
    const registry = new RunRegistry();
    const run = registry.add(record({ runId: "run-1" }));
    expect(registry.runningRunIds()).toEqual(["run-1"]);

    expect(settle(run, { kind: "failed", reason: "service-unreachable", message: "gone" })).toBe(true);
    expect(settle(run, { kind: "failed", reason: "service-unreachable", message: "gone" })).toBe(false);
    expect(registry.runningRunIds()).toEqual([]);
  });
});
