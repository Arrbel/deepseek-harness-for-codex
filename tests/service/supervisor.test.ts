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
describe("Harness service supervisor lifecycle through the container", () => {
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
  describe("service lifecycle", () => {
    let manager: RunManager;
    beforeEach(() => { manager = createManager(); });
    afterEach(async () => { await manager.close(); });

    it("starts the Web service and opens its page", async () => {
      const service = await manager.startService({ workspace, openBrowser: true });

      expect(service.status).toBe("running");
      expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=fixture-token$/);
      expect(service.browserOpened).toBe(true);
      expect(openBrowser).toHaveBeenCalledWith(service.webUrl);

      // The launch URL is a one-time credential exchange: the Host answers 303
      // with the authority-bound cookie. A bare redirect-following fetch has no
      // cookie jar, so it lands on the authenticated root and is answered 401;
      // only redirect:'manual' observes the exchange itself.
      const exchange = await fetch(service.webUrl!, { redirect: "manual" });
      expect(exchange.status).toBe(303);
      expect(exchange.headers.get("set-cookie")).toMatch(/^dsh-auth=fixture;/);
      expect(exchange.headers.get("location")).toBe("./");

      const bare = await fetch(new URL("/", new URL(service.webUrl!).origin), { redirect: "manual" });
      expect(bare.status).toBe(401);
    });

    it("starts the Web service without opening its page by default", async () => {
      const service = await manager.startService({ workspace });

      expect(service.status).toBe("running");
      expect(service.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=fixture-token$/);
      expect(service.browserOpened).toBe(false);
      expect(openBrowser).not.toHaveBeenCalled();
    });

    it("redacts the launch token from the observable log tail", async () => {
      const service = await manager.startService({ workspace });

      expect(service.logTail).toContain("token=[redacted]");
      expect(service.logTail).not.toContain("fixture-token");
      // The returned URL stays usable: it is the caller's one-time credential.
      expect(service.webUrl).toContain("token=fixture-token");
    });

    it("redacts the launch token from a startup failure message", async () => {
      const crashing = createManager({ FIXTURE_MODE: "crash-with-token" });
      try {
        const error = await crashing.startService({ workspace }).then(
          () => null,
          (thrown: unknown) => thrown as Error,
        );
        expect(error).not.toBeNull();
        expect(error!.message).toContain("exited before readiness");
        expect(error!.message).toContain("token=[redacted]");
        expect(error!.message).not.toContain("FIXTURE-SECRET-LAUNCH-TOKEN");
      } finally {
        await crashing.close();
      }
    });

    it("stops the service process and releases its port", async () => {
      const service = await manager.startService({ workspace });
      expect(service.processId).not.toBeNull();
      const pid = service.processId!;
      expect(isProcessAlive(pid)).toBe(true);

      const stopped = await manager.stopService(service.serviceId);

      expect(stopped.status).toBe("stopped");
      expect(stopped.stoppedAt).not.toBeNull();
      await expect(until(() => !isProcessAlive(pid))).resolves.toBe(true);
      await expect(until(async () => {
        try {
          await fetch(service.webUrl!, { redirect: "manual" });
          return false;
        } catch {
          return true;
        }
      })).resolves.toBe(true);
    });

    // ADR-0002: the launch vector is `process.execPath <resolved bin> web --no-open --port 0`
    // with `shell:false`. A regression back to npx (or to a shell) turns this red.
    it("launches the resolved runtime bin through process.execPath without a shell", async () => {
      const launches: HarnessLaunch[] = [];
      const observed = createManager({}, {
        spawnProcess: (launch) => {
          launches.push(launch);
          return spawnLaunch(launch);
        },
      });
      try {
        const service = await observed.startService({ workspace });

        expect(service.status).toBe("running");
        expect(launches).toHaveLength(1);
        const launch = launches[0]!;
        expect(launch.command).toBe(process.execPath);
        expect(launch.args[0]).toBe(fixture);
        expect(launch.args.slice(1)).toEqual(["web", "--no-open", "--port", "0"]);
        expect(launch.shell).toBe(false);
        expect(launch.cwd).toBe(workspace);
        expect(launch.args.join(" ")).not.toMatch(/npx|--package/u);
      } finally {
        await observed.close();
      }
    });

    it("converges stopped state even when the process had already exited", async () => {
      const service = await manager.startService({ workspace });
      const pid = service.processId!;
      process.kill(pid, "SIGKILL");
      await expect(until(() => !isProcessAlive(pid))).resolves.toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const stopped = await manager.stopService(service.serviceId);

      expect(stopped.status).toBe("stopped");
      expect(stopped.stoppedAt).not.toBeNull();
      expect(stopped.stopUnconfirmed).toBe(false);

      // Idempotent: a second stop keeps the converged record.
      const again = await manager.stopService(service.serviceId);
      expect(again.status).toBe("stopped");
      expect(manager.listServices()).toHaveLength(1);
    });

    it("reports stopUnconfirmed instead of pretending a stubborn child exited", async () => {
      const stubborn = createManager({}, {
        stopGraceMs: 50,
        forceStopGraceMs: 50,
        spawnProcess: () => {
          const child = new EventEmitter() as ChildProcess;
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          Object.assign(child, {
            pid: 0x7fff_fffe,
            exitCode: null,
            signalCode: null,
            stdout,
            stderr,
            kill: () => true,
          });
          setTimeout(() => { stdout.write("dsh web: http://127.0.0.1:1/?token=stubborn\n"); }, 10);
          return child;
        },
      });
      try {
        const service = await stubborn.startService({ workspace });
        expect(service.status).toBe("running");

        const stopped = await stubborn.stopService(service.serviceId);

        expect(stopped.status).toBe("stopped");
        expect(stopped.stopUnconfirmed).toBe(true);
        expect(stopped.stoppedAt).not.toBeNull();
      } finally {
        await stubborn.close();
      }
    }, 20_000);

    it("marks the service failed and releases the workspace when the install fails", async () => {
      const attempts: number[] = [];
      const failing = createManager({}, {
        ensureRuntime: async () => {
          attempts.push(attempts.length + 1);
          throw new RuntimePackageError("version-not-found", "npm install failed", {
            stderrTail: "npm error code ETARGET",
            hint: "check DSH_MCP_HARNESS_PACKAGE",
          });
        },
      });
      try {
        const error = await failing.startService({ workspace }).then(() => null, (thrown: unknown) => thrown as Error);

        expect(error).not.toBeNull();
        expect(error!.message).toContain("install failed");
        expect(error!.message).toContain("ETARGET");
        expect(error!.message).toContain("npm stderr tail:");
        expect(error!.message).toContain("check DSH_MCP_HARNESS_PACKAGE");

        const services = failing.listServices();
        expect(services).toHaveLength(1);
        expect(services[0]!.status).toBe("failed");
        expect(services[0]!.stoppedAt).not.toBeNull();
        expect(services[0]!.processId).toBeNull();

        // The workspace index was released, so a retry really retries.
        await expect(failing.startService({ workspace })).rejects.toThrow(/install failed/u);
        expect(attempts).toHaveLength(2);
      } finally {
        await failing.close();
      }
    });
  });
  describe("launch URL authentication", () => {
    it("exchanges the launch URL cookie exactly once for many RPC calls", async () => {
      const manager = createManager();
      try {
        const started = await manager.start({ task: "one exchange", workspace });
        await manager.get(started.runId);
        await manager.list();
        await manager.get(started.runId);

        const stats = await readStats(started.webUrl);
        const rpcCalls = Object.values(stats.rpc).reduce((total, count) => total + count, 0);
        expect(rpcCalls).toBeGreaterThanOrEqual(5);
        const authenticatedRpc = (stats.rpc["session/list"] ?? 0) + (stats.rpc["session/page"] ?? 0);
        expect(authenticatedRpc).toBeGreaterThanOrEqual(3);
        expect(stats.tokenExchanges).toBe(1);
      } finally {
        await manager.close();
      }
    });

    it.each([
      ["plain", "200"],
      ["no-cookie", "303"],
      ["server-error", "500"],
    ])("rejects a launch exchange that is not a cookie-bearing 303 (%s)", async (mode, expectedStatus) => {
      const manager = createManager({ FIXTURE_AUTH: mode });
      try {
        const service = await manager.startService({ workspace });
        expect(service.status).toBe("running");
        await expect(manager.start({ task: "authenticate", workspace }))
          .rejects.toThrow(new RegExp(`authentication failed with HTTP ${expectedStatus}`));
      } finally {
        await manager.close();
      }
    });
  });
});
