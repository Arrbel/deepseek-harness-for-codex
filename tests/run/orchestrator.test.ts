import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager, type RunManagerOptions } from "../support/manager.js";
import { RuntimePackageError } from "../../src/service/runtime-package.js";
import type { HarnessLaunch } from "../../src/service/launch.js";
import "../support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-harness.mjs");
const openBrowser = vi.fn(async () => undefined);

interface FixtureStats {
  tokenExchanges: number;
  unauthorizedGets: number;
  rpc: Record<string, number>;
  turnEndReasons: unknown[];
  lastAssistantMessage: Record<string, unknown> | null;
}

async function readStats(webUrl: string): Promise<FixtureStats> {
  const response = await fetch(new URL("/__fixture/stats", new URL(webUrl).origin));
  expect(response.status).toBe(200);
  return await response.json() as FixtureStats;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await predicate();
}

function spawnLaunch(launch: HarnessLaunch): ChildProcess {
  return spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}
describe("Harness run orchestration through the container", () => {
  let temporaryRoot: string;
  let workspace: string;

  function createManager(fixtureEnv: Record<string, string> = {}, overrides: Partial<RunManagerOptions> = {}): RunManager {
    return new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      launchEnv: { ...fixtureEnv },
      // ADR-0002: the runtime package is resolved/installed before the launch vector is
      // built. The suite pins that seam to the protocol fixture instead of npm.
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(temporaryRoot, "runtime"),
        packageDir: join(temporaryRoot, "runtime"),
        binPath: fixture,
        installedNow: false,
      }),
      ...overrides,
    });
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    openBrowser.mockClear();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  describe("run state projection", () => {
    let manager: RunManager;
    beforeEach(() => { manager = createManager(); });
    afterEach(async () => { await manager.close(); });

    it("submits the task into the visible Web session", async () => {
      const started = await manager.start({ task: "implement feature", workspace, openBrowser: true });
      expect(started.status).toBe("running");
      expect(started.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=fixture-token$/);
      expect(started.sessionId).toBe("session-1");
      expect(started.sessionReused).toBe(false);

      const completed = await manager.wait(started.runId, 2_000);
      expect(completed.status).toBe("succeeded");
      expect(completed.assistantText).toBe("completed:implement feature");
      expect(completed.lastEventSeq).toBe(5);
      expect(completed.error).toBeNull();
    });

    it("reuses one Web service for later tasks in the workspace", async () => {
      const first = await manager.start({ task: "first", workspace });
      const second = await manager.start({ task: "second", workspace });

      expect(second.serviceId).toBe(first.serviceId);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(manager.listServices()).toHaveLength(1);
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it("lets the caller continue a completed session without returning earlier output", async () => {
      const first = await manager.start({ task: "first", workspace, openBrowser: false });
      await manager.wait(first.runId, 2_000);

      const second = await manager.start({
        task: "follow-up",
        workspace,
        sessionId: first.sessionId,
        openBrowser: false,
      });
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.sessionReused).toBe(true);

      const completed = await manager.wait(second.runId, 2_000);
      expect(completed.status).toBe("succeeded");
      expect(completed.assistantText).toBe("completed:follow-up");
      expect(completed.lastEventSeq).toBe(11);
    });

    it("collects every assistant message by paging backwards with beforeSeq", async () => {
      const paged = createManager({ FIXTURE_MESSAGES: "7", FIXTURE_PAGE_LIMIT: "3" });
      try {
        const started = await paged.start({ task: "paged", workspace });
        const completed = await paged.wait(started.runId, 5_000);

        const expected = [
          "completed:paged",
          "completed:paged#2",
          "completed:paged#3",
          "completed:paged#4",
          "completed:paged#5",
          "completed:paged#6",
          "completed:paged#7",
        ].join("\n");
        expect(completed.assistantText).toBe(expected);
        expect(completed.lastEventSeq).toBe(11);

        // A server that answers hasMore:false on the first window would expose
        // only the tail of the message list.
        const stats = await readStats(started.webUrl);
        expect(stats.rpc["session/page"] ?? 0).toBeGreaterThanOrEqual(3);
      } finally {
        await paged.close();
      }
    }, 30_000);

    it("rejects reuse while the selected session is running", async () => {
      const held = createManager({ FIXTURE_DELAY_MS: "5000" });
      try {
        const first = await held.start({ task: "first", workspace, openBrowser: false });

        await expect(held.start({
          task: "overlap",
          workspace,
          sessionId: first.sessionId,
          openBrowser: false,
        })).rejects.toThrow("still running");
      } finally {
        await held.close();
      }
    });

    it("rejects a session that belongs to a different workspace", async () => {
      const outside = await mkdtemp(join(tmpdir(), "deepseek-harness-other-"));
      const mismatched = createManager({ FIXTURE_CWD: outside });
      try {
        const first = await mismatched.start({ task: "first", workspace });
        await mismatched.wait(first.runId, 2_000);

        await expect(mismatched.start({
          task: "elsewhere",
          workspace,
          sessionId: first.sessionId,
        })).rejects.toThrow("belongs to a different workspace");
      } finally {
        await mismatched.close();
        await rm(outside, { recursive: true, force: true });
      }
    });

    it("rejects an unknown session for this workspace", async () => {
      const missing = createManager({ FIXTURE_LIST_OMIT_SESSION: "1" });
      try {
        await expect(missing.start({
          task: "unknown",
          workspace,
          sessionId: "session-does-not-exist",
        })).rejects.toThrow("Unknown sessionId for this workspace");
      } finally {
        await missing.close();
      }
    });

    it("refuses to reuse a session whose summary omits cwd (fail closed)", async () => {
      // P4 tolerated this (fail-open): a session without a reported `cwd` was assumed to belong to
      // the requested workspace. P6 tightened the contract (`cwd` is required and typed) and the
      // reuse decision fails closed, so the item is now protocol drift with a JSON path.
      const noCwd = createManager({ FIXTURE_LIST_OMIT_CWD: "1" });
      try {
        const first = await noCwd.start({ task: "first", workspace });
        await noCwd.wait(first.runId, 2_000);

        const rejection = await noCwd.start({
          task: "second",
          workspace,
          sessionId: first.sessionId,
        }).then(() => null, (error: unknown) => error as { message: string; kind?: string });

        expect(rejection?.message).toMatch(/items\.0\.cwd|Cannot prove Harness session/u);
        expect(rejection?.kind).toBe("protocol-drift");
      } finally {
        await noCwd.close();
      }
    });

    it("rejects relative and out-of-policy workspaces", async () => {
      await expect(manager.startService({ workspace: "." })).rejects.toThrow("absolute path");
      const outside = await mkdtemp(join(tmpdir(), "deepseek-harness-outside-"));
      try {
        await expect(manager.startService({ workspace: outside })).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
  describe("turn outcome", () => {
    let manager: RunManager;
    afterEach(async () => { await manager.close(); });

    it.each([
      ["error", /no API key for provider route/u, "rpc:MISSING_CREDENTIAL"],
      ["interrupted", /turn ended with interrupted/u, "turn-interrupted"],
      ["aborted-parent", /turn ended with aborted/u, "turn-aborted:parent"],
    ])("fails the run when the turn ends as %s", async (kind, pattern, reason) => {
      manager = createManager({ FIXTURE_FAIL_KIND: kind });
      const started = await manager.start({ task: `fail:${kind}`, workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("failed");
      expect(completed.error).toMatch(pattern);
      expect(completed.reason).toBe(reason);
      expect(completed.finishedAt).not.toBeNull();
    });

    it("treats a user abort as a cancellation rather than a failure", async () => {
      manager = createManager({ FIXTURE_FAIL_KIND: "aborted-user" });
      const started = await manager.start({ task: "aborted by the user", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("cancelled");
      expect(completed.reason).toBeNull();
      expect(completed.error).toBeNull();
    });

    // These two used to be `it.fails`: the replaced mapping only recognized
    // error/aborted/disposed/interrupted, so every other official TurnEndReason fell through to
    // `null` and the run was reported as a success. They are ordinary assertions now.
    it("fails the run when the turn ends as blocked", async () => {
      manager = createManager({ FIXTURE_FAIL_KIND: "blocked" });
      const started = await manager.start({ task: "blocked", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("turn-blocked");
      expect(completed.error).toMatch(/blocked/u);
    });

    it("fails the run when the turn ends as max-tokens", async () => {
      manager = createManager({ FIXTURE_FAIL_KIND: "max-tokens" });
      const started = await manager.start({ task: "max-tokens", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("turn-truncated");
      expect(completed.error).toMatch(/token limit/u);
    });

    it("fails a run whose session stops running without ever publishing a terminal turn", async () => {
      manager = createManager({ FIXTURE_TURN_END: "skip" });
      const started = await manager.start({ task: "no terminal marker", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      // Leaving this `running` forever is the state ADR-0003 removes; the mapping fails closed.
      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("turn-unknown:missing-turn-end");
      expect(completed.error).toMatch(/without a terminal turn marker/u);
    });

    it("re-exchanges the launch URL once when a single call is rejected", async () => {
      manager = createManager({ FIXTURE_UNAUTHORIZED: "once" });
      const started = await manager.start({ task: "one 401", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("succeeded");
      // One exchange for the original call, one after the cookie was discarded.
      const stats = await readStats(started.webUrl);
      expect(stats.tokenExchanges).toBe(2);
    });

    it("settles the run as failed(auth) when the credential keeps being rejected", async () => {
      manager = createManager({ FIXTURE_UNAUTHORIZED: "after-prompt" });
      const started = await manager.start({ task: "auth lost", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("auth");
      expect(completed.error).toMatch(/HTTP 401/u);
      const stats = await readStats(started.webUrl);
      expect(stats.tokenExchanges).toBeGreaterThanOrEqual(2);
    });

    it("fails the run when the service dies mid-turn instead of hanging", async () => {
      manager = createManager({ FIXTURE_DELAY_MS: "10000", FIXTURE_EXIT_AFTER_MS: "800" });
      const started = await manager.start({ task: "service dies", workspace });
      const completed = await manager.wait(started.runId, 5_000);

      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("service-unreachable");
    });


    it("cancels a run but keeps its Web service alive", async () => {
      manager = createManager({ FIXTURE_DELAY_MS: "5000" });
      const started = await manager.start({ task: "long task", workspace, openBrowser: false });
      const cancelled = await manager.cancel(started.runId);

      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.cancelRequested).toBe(true);
      expect(cancelled.error).toBeNull();
      expect(manager.listServices()[0]?.status).toBe("running");

      // The wire closer for a user cancellation is aborted@user, not the
      // crash-recovery marker interrupted.
      const stats = await readStats(started.webUrl);
      expect(stats.turnEndReasons).toContainEqual({ kind: "aborted", reason: { kind: "user" } });
      expect(stats.turnEndReasons).not.toContainEqual({ kind: "interrupted" });
    });

    it("surfaces a missing session projection as a failed run", async () => {
      manager = createManager({ FIXTURE_PROJECTIONS: "null" });
      await expect(manager.start({ task: "no projection", workspace }))
        .rejects.toThrow("did not publish the new session");
    });

    it("rejects a non-integer session cursor and fails the run with a diagnosable reason", async () => {
      manager = createManager({ FIXTURE_ASOF_SEQ: "-5" });
      const started = await manager.start({ task: "bad cursor", workspace });
      const completed = await manager.wait(started.runId, 2_000);

      // Contract drift is not retryable: the run converges instead of painting an error onto a
      // run that would otherwise stay `running` (ADR-0003 §3.2).
      expect(completed.status).toBe("failed");
      expect(completed.reason).toBe("protocol-drift");
      expect(completed.error).toMatch(/invalid session cursor/u);
      expect(completed.finishedAt).not.toBeNull();
    });
  });
});
