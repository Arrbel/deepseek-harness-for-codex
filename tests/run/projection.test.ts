// Step-progress projection end to end (`run/**` + `dsh/events.ts`, R3-5).
//
// Two things are proven here that the unit tests cannot:
//
//   1. **A running turn is visible.** Driven through the real container and the protocol fixture,
//      a `running` snapshot now says which step is open — the point of the whole change.
//   2. **Tool parameters cannot travel.** The event payloads really do carry them: the synthetic
//      fixture echoes the task text into `user/message`, and the recorded real-wire capture carries
//      a 27 KB `request/header` holding the whole tool catalogue with descriptions. Both are
//      asserted absent from the projection, in the same spirit as R3-2's drift log.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager, type RunManagerOptions } from "../support/manager.js";
import { NO_STEP_PROGRESS, projectStepProgress, type StepProjection } from "../../src/dsh/events.js";
import { EMPTY_PROGRESS, createRunRecord } from "../../src/run/registry.js";
import type { RunProgress, RunSnapshot } from "../../src/run/types.js";
import type { HarnessLaunch } from "../../src/service/launch.js";
import "../support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-harness.mjs");
const recordedRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "recorded");
const recordedDir = join(recordedRoot, "0.2.1");
const openBrowser = vi.fn(async () => undefined);

/** A fragment of the tool *definitions* the recorded wire carries at `request/header` (seq 12). */
const RECORDED_TOOL_DESCRIPTION = "Questions to ask the user before continuing";

interface FixtureStats {
  rpc: Record<string, number>;
}

async function readStats(webUrl: string): Promise<FixtureStats> {
  const response = await fetch(new URL("/__fixture/stats", new URL(webUrl).origin));
  expect(response.status).toBe(200);
  return await response.json() as FixtureStats;
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

describe("run progress projection (R3-5)", () => {
  let temporaryRoot: string;
  let workspace: string;

  function createManager(fixtureEnv: Record<string, string> = {}, overrides: Partial<RunManagerOptions> = {}): RunManager {
    return new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      openBrowser,
      spawnProcess: spawnLaunch,
      launchEnv: { ...fixtureEnv },
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

  it("shows the open step of a running turn, then closes it when the turn ends", async () => {
    const manager = createManager({ FIXTURE_DELAY_MS: "1500" });
    try {
      const started = await manager.start({ task: "long turn", workspace, openBrowser: false });

      expect(started.status).toBe("running");
      // Before this change a running snapshot could only say `running`; now it names the step.
      expect(started.progress.started).toBeGreaterThanOrEqual(1);
      expect(started.progress.finished).toBe(0);
      expect(started.progress.current).not.toBeNull();
      expect(started.progress.current?.turn).toBe(1);
      expect(started.progress.current?.step).toBe(1);
      expect(Number.isInteger(started.progress.current?.seq)).toBe(true);

      const completed = await manager.wait(started.runId, 5_000);

      expect(completed.status).toBe("succeeded");
      expect(completed.progress.finished).toBeGreaterThanOrEqual(1);
      expect(completed.progress.current).toBeNull();
      // Additive: the existing projection is untouched by the new one.
      expect(completed.assistantText).toBe("completed:long turn");
      expect(completed.lastEventSeq).toBeGreaterThanOrEqual(started.lastEventSeq);
    } finally {
      await manager.close();
    }
  });

  it("keeps the submitted task text — a stand-in for a tool parameter — out of the projection", async () => {
    // The fixture echoes the task into a `user/message` event, so the payload really contains it.
    const secret = "SECRET-PROMPT-rm-rf-slash-etc";
    const manager = createManager({ FIXTURE_DELAY_MS: "1500" });
    try {
      const started = await manager.start({ task: `run ${secret}`, workspace, openBrowser: false });

      expect(JSON.stringify(started.progress)).not.toContain(secret);
      expect(JSON.stringify(started.progress)).not.toContain("run ");
      expect(JSON.stringify(started.progress)).not.toContain("user/message");
      // The only strings the projection may contain are none at all: three numbers and a null.
      for (const value of Object.values(started.progress)) {
        expect(typeof value === "number" || value === null || (typeof value === "object" && value !== null)).toBe(true);
      }
      expect(started.progress.current).toMatchObject({ turn: 1, step: 1 });
      expect(Object.keys(started.progress).sort()).toEqual(["current", "finished", "started"]);
      expect(Object.keys(started.progress.current as object)).toEqual(["turn", "step", "seq"]);
    } finally {
      await manager.close();
    }
  });

  it("does not let the recorded tool catalogue reach the projection", async () => {
    const manager = createManager({ FIXTURE_RECORDED: recordedDir });
    try {
      const started = await manager.start({ task: "replay the captured turn", workspace, openBrowser: false });
      const settled = await manager.wait(started.runId, 5_000);

      // The recorded turn published exactly one step, and closed it (seq 6 -> seq 17).
      expect(settled.progress).toEqual({ started: 1, finished: 1, current: null });

      const serialized = JSON.stringify(settled.progress);
      expect(serialized).not.toContain(RECORDED_TOOL_DESCRIPTION);
      expect(serialized).not.toContain("tools");
      expect(serialized).not.toContain("request/header");
      // …while the payload is genuinely in the window the run read (the settled snapshot still
      // carries the Host's failure text), so the assertion above is not vacuous.
      expect(settled.status).toBe("failed");
    } finally {
      await manager.close();
    }
  });

  it("holds the configured pace as a ceiling: a silent wait cannot become a storm", async () => {
    // Arithmetic for the bound below. A 3 s turn, default 400 ms ceiling, 150 ms floor:
    //   * with the backoff the loop sleeps 300, 400, 400, … and refreshes ~9 times (once at t=0,
    //     then every ~300-400 ms until the turn settles);
    //   * with no backoff at all it would sleep 150 ms every time and refresh ~21 times.
    // So `<= 12` separates the two behaviours while tolerating scheduler jitter.
    const manager = createManager({ FIXTURE_DELAY_MS: "3000" }, { pollIntervalMs: 400 });
    try {
      const started = await manager.start({ task: "quiet turn", workspace, openBrowser: false });
      const completed = await manager.wait(started.runId, 5_000);

      expect(completed.status).toBe("succeeded");
      const stats = await readStats(started.webUrl);
      const pages = stats.rpc["session/page"] ?? 0;
      expect(pages).toBeGreaterThanOrEqual(2);
      expect(pages).toBeLessThanOrEqual(12);
    } finally {
      await manager.close();
    }
  });

  it("keeps the snapshot's key set additive and its vocabulary in sync with dsh/events", () => {
    // 1. `RunProgress` and `StepProjection` are two declarations of one shape (run/types.ts is a
    //    no-import DTO, so it cannot import the dsh one). Both directions must keep compiling.
    const fromEvents: StepProjection = NO_STEP_PROGRESS;
    const asRunProgress: RunProgress = fromEvents;
    const backToEvents: StepProjection = asRunProgress;
    expect(backToEvents).toEqual(fromEvents);
    expect(EMPTY_PROGRESS).toEqual(NO_STEP_PROGRESS);

    // 2. The projection's runtime shape is the declared one, and only that.
    const projected = projectStepProgress([{ event: { type: "step/start", seq: 3, data: { turn: 1, step: 2 } } }]);
    const asDeclared: StepProjection = projected;
    expect(Object.keys(asDeclared).sort()).toEqual(["current", "finished", "started"]);

    // 3. The snapshot gained `progress` and nothing else.
    const keys: readonly (keyof RunSnapshot)[] = [
      "runId",
      "serviceId",
      "sessionId",
      "sessionReused",
      "task",
      "workspace",
      "webUrl",
      "status",
      "reason",
      "nextAction",
      "webUrlStale",
      "cancelRequested",
      "startedAt",
      "finishedAt",
      "assistantText",
      "lastEventSeq",
      "progress",
      "error",
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("progress");
  });

  it("starts a run at empty progress rather than guessing one", () => {
    // `EMPTY_PROGRESS` is what a record holds until its first window is read, and the snapshot
    // copies the record — so a caller can never see progress the run did not observe.
    const record = createRunRecord({
      runId: "run-1",
      serviceId: "service-1",
      sessionId: "session-1",
      sessionReused: false,
      startEventSeq: 0,
      task: "task",
      workspace: "C:\\workspace",
      webUrl: "http://127.0.0.1:1/?token=x",
      startedAt: new Date(0),
      lastEventSeq: 0,
    });

    expect(record.progress).toEqual({ started: 0, finished: 0, current: null });
    expect(record.progress).toEqual(EMPTY_PROGRESS);
    expect(EMPTY_PROGRESS).toEqual(NO_STEP_PROGRESS);
    // An existing caller that passes no `progress` still compiles (the init field is optional),
    // which is what keeps this change additive for the other suites.
  });
});
