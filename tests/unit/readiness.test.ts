// Unit coverage for the activity-reset readiness budget (ADR-0002, architecture §4).
//
// The clock is injected, so "output keeps the service alive" and "silence fails it" are
// asserted without any real waiting, and the failure text is checked for the three things
// an operator needs: the redacted Harness log tail, the runtime package path, and the npm
// stderr tail.

import { describe, expect, it } from "vitest";
import { ActivityBudget, ReadinessWatcher, startupFailureMessage } from "../../src/service/readiness.js";
import { redactLaunchToken } from "../../src/service/credentials.js";
import "../support/isolation.js";

function clock(): { now: () => number; set: (value: number) => void } {
  let current = 0;
  return { now: () => current, set: (value: number) => { current = value; } };
}

describe("activity-reset startup budget", () => {
  it("never expires while output keeps arriving", () => {
    const time = clock();
    const watcher = new ReadinessWatcher({ timeoutMs: 1_000, now: time.now });

    time.set(900);
    watcher.push("step 1\n");
    time.set(1_800);
    expect(watcher.budget.expired()).toBe(false);
    time.set(1_899);
    watcher.push("step 2\n");
    time.set(2_898);
    expect(watcher.budget.expired()).toBe(false);
    time.set(2_900);
    expect(watcher.budget.expired()).toBe(true);

    expect(watcher.budget.hasOutput).toBe(true);
  });

  it("expires after pure silence and reports no-first-output", () => {
    const time = clock();
    const watcher = new ReadinessWatcher({ timeoutMs: 1_000, now: time.now });

    time.set(999);
    expect(watcher.budget.expired()).toBe(false);
    time.set(1_000);
    expect(watcher.budget.expired()).toBe(true);
    expect(watcher.cause()).toBe("no-first-output");
    expect(watcher.readyUrl).toBeNull();
  });

  it("reports no-url-line when the child printed other output", () => {
    const time = clock();
    const watcher = new ReadinessWatcher({ timeoutMs: 250, now: time.now });

    watcher.push("booting...\n");
    time.set(249);
    expect(watcher.budget.expired()).toBe(false);
    time.set(250);
    expect(watcher.budget.expired()).toBe(true);
    expect(watcher.cause()).toBe("no-url-line");
  });

  it("detects the ready URL across chunk boundaries exactly once", () => {
    const watcher = new ReadinessWatcher({ timeoutMs: 1_000 });

    watcher.push("dsh ");
    expect(watcher.readyUrl).toBeNull();
    watcher.push("web: http://127.0.0.1:55274/?token=SECRET-TOKEN\n");
    expect(watcher.readyUrl).toBe("http://127.0.0.1:55274/?token=SECRET-TOKEN");

    watcher.push("later noise\n");
    expect(watcher.readyUrl).toBe("http://127.0.0.1:55274/?token=SECRET-TOKEN");
  });

  it("is a plain budget when driven directly", () => {
    const time = clock();
    const budget = new ActivityBudget({ timeoutMs: 100, now: time.now });

    expect(budget.hasOutput).toBe(false);
    expect(budget.silenceMs()).toBe(0);
    time.set(99);
    expect(budget.expired()).toBe(false);
    time.set(150);
    budget.touch();
    expect(budget.expired()).toBe(false);
    expect(budget.timeout).toBe(100);
  });
});

describe("startup failure diagnosis", () => {
  it("carries the redacted log tail, the runtime path, and the npm stderr tail", () => {
    const watcher = new ReadinessWatcher({ timeoutMs: 1_000 });
    watcher.push("GET http://127.0.0.1:1/?token=SUPERSECRET 200\n");
    watcher.push("still booting\n");

    const message = startupFailureMessage({
      cause: watcher.cause(),
      timeoutMs: 1_000,
      log: watcher.rawLog,
      runtimeRoot: "C:\\data\\versions\\0.2.1-alpha.1",
      npmStderrTail: "npm error code ENOTCACHED\nnpm error cache mode is 'only-if-cached'",
    });

    expect(message).toContain("1000ms of silence");
    expect(message).toContain("no-url-line");
    // One vocabulary only (ADR-0003 裁决): the superseded doc aliases must not appear.
    expect(message).not.toContain("silent-timeout");
    expect(message).not.toContain("no-output");
    expect(message).toContain("token=[redacted]");
    expect(message).not.toContain("SUPERSECRET");
    expect(message).toContain("C:\\data\\versions\\0.2.1-alpha.1");
    expect(message).toContain("ENOTCACHED");
  });

  it("names the silence cause for a child that never printed anything", () => {
    const watcher = new ReadinessWatcher({ timeoutMs: 500 });
    const message = startupFailureMessage({
      cause: watcher.cause(),
      timeoutMs: 500,
      log: watcher.rawLog,
      runtimeRoot: "C:\\data\\versions\\0.2.1-alpha.1",
      npmStderrTail: null,
    });

    expect(watcher.cause()).toBe("no-first-output");
    expect(message).toContain("no-first-output");
    expect(message).not.toContain("no-output /");
    expect(message).toContain("Harness log tail: (empty)");
  });

  it("keeps the exit-before-readiness wording used by the service tests", () => {
    const message = startupFailureMessage({
      cause: "exit-before-ready",
      log: "dsh web: http://127.0.0.1:1/?token=SECRET\n",
      exit: { code: 1, signal: null },
      runtimeRoot: "/data/versions/0.2.1-alpha.1",
      npmStderrTail: null,
    });

    expect(message).toContain("exited before readiness");
    expect(message).toContain("code 1");
    expect(message).toContain("token=[redacted]");
    expect(message).toContain("npm stderr tail: (none)");
  });

  it("redacts tokens in both the harness log and the npm tail", () => {
    expect(redactLaunchToken("http://x/?token=abc&y=1")).toBe("http://x/?token=[redacted]&y=1");
    const message = startupFailureMessage({
      cause: "install-failed",
      detail: "install failed",
      log: "",
      runtimeRoot: null,
      npmStderrTail: "GET http://registry/?token=npmsecret failed",
    });
    expect(message).not.toContain("npmsecret");
    expect(message).toContain("Harness log tail: (empty)");
  });
});
