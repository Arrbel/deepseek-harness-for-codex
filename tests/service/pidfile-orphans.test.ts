// P0-1 integration: pidfile reconciliation, port self-healing, and the P0-5 refusal.
//
// Every OS interaction is injected (`spawnProcess`, `processIdentity`, `isAlive`, `reapOrphan`,
// `reapProcessTree`, `portProbe`), so this file never signals a real pid — a test that called
// `taskkill` on a recorded pid would be a loaded gun pointed at the developer's own processes.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceSupervisor, serviceHomeFor, type SupervisorOptions } from "../../src/service/supervisor.js";
import { PID_FILE_NAME, parsePidFile, serializePidFile, type PidFileRecord } from "../../src/policy/orphans.js";
import type { EnsuredRuntimePackage } from "../../src/service/runtime-package.js";
import "../support/isolation.js";

const PORT = 51_234;
const ORPHAN_PID = 7777;
const CHILD_PID = 4242;
const BIN_PATH = join("C:\\data\\versions\\0.2.1-alpha.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js");

class FakeChild extends EventEmitter {
  public pid: number | undefined = CHILD_PID;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public kill(): boolean {
    this.exitCode = 0;
    return true;
  }
}

interface Harness {
  supervisor: ServiceSupervisor;
  workspace: string;
  dataDirectory: string;
  serviceHome: string;
  child: FakeChild;
  reapOrphan: ReturnType<typeof vi.fn>;
  reapTree: ReturnType<typeof vi.fn>;
  identity: ReturnType<typeof vi.fn>;
  alive: ReturnType<typeof vi.fn>;
  root: string;
}

let harness: Harness | null = null;

function createHarness(overrides: Partial<SupervisorOptions> = {}, options: { orphan?: Partial<PidFileRecord> | "corrupt" | null } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "dsh-pidfile-"));
  const workspace = join(root, "ws");
  const dataDirectory = join(root, "data");
  const serviceHome = serviceHomeFor(dataDirectory, workspace);
  mkdirSync(workspace, { recursive: true });
  // The real spawn path (`launch.ts#spawnHarness`) creates the service home; the injected seam
  // does not, so the tests create it exactly as the real path would.
  mkdirSync(serviceHome, { recursive: true });

  const child = new FakeChild();
  const reapOrphan = vi.fn(async () => undefined);
  const reapTree = vi.fn(async () => undefined);
  const identity = vi.fn((_pid: number) => BIN_PATH + " web --no-open --port 0");
  const alive = vi.fn(() => true);

  const supervisor = new ServiceSupervisor({
    dataDirectory,
    allowedRoots: [root],
    startupTimeoutMs: 2_000,
    pollIntervalMs: 10,
    stopGraceMs: 20,
    forceStopGraceMs: 30,
    ensureRuntime: async (): Promise<EnsuredRuntimePackage> => ({
      name: "@deepseek-ai/dsh",
      version: "0.2.1-alpha.1",
      root: join(root, "runtime"),
      packageDir: join(root, "runtime"),
      binPath: BIN_PATH,
      installedNow: false,
    }),
    spawnProcess: (): ChildProcess => {
      queueMicrotask(() => {
        child.stdout.write(`dsh web: http://127.0.0.1:${String(PORT)}/?token=fixture-token\n`);
      });
      return child as unknown as ChildProcess;
    },
    processIdentity: identity,
    isAlive: alive,
    reapOrphan,
    reapProcessTree: reapTree,
    portProbe: async () => false,
    ...overrides,
  });

  const result: Harness = { supervisor, workspace, dataDirectory, serviceHome, child, reapOrphan, reapTree, identity, alive, root };
  if (options.orphan !== undefined && options.orphan !== null) {
    const path = join(serviceHome, PID_FILE_NAME);
    if (options.orphan === "corrupt") writeFileSync(path, "{ this is not json");
    else {
      const record: PidFileRecord = {
        pid: ORPHAN_PID,
        port: PORT,
        version: "0.2.1-alpha.1",
        binPath: BIN_PATH,
        startedAt: "2026-10-09T00:00:00.000Z",
        dataDirectory,
        workspace,
        serviceHome,
        ...options.orphan,
      };
      writeFileSync(path, serializePidFile(record));
    }
  }
  harness = result;
  return result;
}

function pidFilePathOf(current: Harness): string {
  return join(current.serviceHome, PID_FILE_NAME);
}

afterEach(() => {
  const current = harness;
  harness = null;
  if (current !== null) rmSync(current.root, { recursive: true, force: true });
});

describe("orphan reclamation at start (P0-1)", () => {
  it("reclaims a verified orphan, then records the new child and its port", async () => {
    const current = createHarness({}, { orphan: {} });

    const snapshot = await current.supervisor.start({ workspace: current.workspace });

    // The recorded pid was ours (command line matched binPath + --port) → it was reaped.
    expect(current.reapOrphan).toHaveBeenCalledWith(ORPHAN_PID);
    expect(current.identity).toHaveBeenCalledWith(ORPHAN_PID);
    // ...and the pidfile now describes the child we just started, including the bound port.
    const record = parsePidFile(readFileSync(pidFilePathOf(current), "utf8"));
    expect(record?.pid).toBe(CHILD_PID);
    expect(record?.port).toBe(PORT);
    expect(record?.binPath).toBe(BIN_PATH);
    expect(record?.serviceHome).toBe(current.serviceHome);
    expect(snapshot.webUrl).toContain(String(PORT));
  });

  it("never kills when the identity cannot be established (fail-closed → unverified)", async () => {
    const current = createHarness({ processIdentity: () => null }, { orphan: {} });

    await current.supervisor.start({ workspace: current.workspace });

    expect(current.reapOrphan).not.toHaveBeenCalled();
    // The evidence is kept, so the next run (or a human) can act on it.
    expect(existsSync(pidFilePathOf(current))).toBe(true);
  });

  it("never kills a pid whose command line is somebody else's", async () => {
    const current = createHarness(
      { processIdentity: () => "node C:\\unrelated\\tool.js --serve" },
      { orphan: {} },
    );

    await current.supervisor.start({ workspace: current.workspace });

    expect(current.reapOrphan).not.toHaveBeenCalled();
    expect(existsSync(pidFilePathOf(current))).toBe(true);
  });

  it("removes a stale pidfile without signalling anything", async () => {
    const current = createHarness({ isAlive: () => false }, { orphan: {} });

    await current.supervisor.start({ workspace: current.workspace });

    expect(current.reapOrphan).not.toHaveBeenCalled();
    // The stale file was replaced by this run's own record, never reclaimed by pid.
    expect(parsePidFile(readFileSync(pidFilePathOf(current), "utf8"))?.pid).toBe(CHILD_PID);
  });

  it("discards a corrupt pidfile without guessing a pid", async () => {
    const current = createHarness({}, { orphan: "corrupt" });

    await current.supervisor.start({ workspace: current.workspace });

    expect(current.reapOrphan).not.toHaveBeenCalled();
    expect(parsePidFile(readFileSync(pidFilePathOf(current), "utf8"))?.pid).toBe(CHILD_PID);
  });

  it("does nothing when there is no pidfile at all", async () => {
    const current = createHarness();
    await current.supervisor.start({ workspace: current.workspace });
    expect(current.identity).not.toHaveBeenCalled();
    expect(current.reapOrphan).not.toHaveBeenCalled();
  });
});

describe("port self-healing at stop (P0-1)", () => {
  it("confirms the stop only when the port is released, and deletes the pidfile", async () => {
    const current = createHarness({ portProbe: async () => false });
    await current.supervisor.start({ workspace: current.workspace });

    const stopped = await current.supervisor.stop(
      (await current.supervisor.list())[0]!.serviceId,
    );

    expect(stopped.stopUnconfirmed).toBe(false);
    expect(existsSync(pidFilePathOf(current))).toBe(false);
  });

  it("re-reaps a tree whose port survived, then reports honestly if it still listens", async () => {
    const current = createHarness({ portProbe: async () => true });
    await current.supervisor.start({ workspace: current.workspace });

    const stopped = await current.supervisor.stop((await current.supervisor.list())[0]!.serviceId);

    // The child exited, but a descendant kept the port: the second reap is attempted and the
    // snapshot refuses to claim success.
    expect(current.reapTree).toHaveBeenCalled();
    expect(stopped.stopUnconfirmed).toBe(true);
    // The evidence stays behind for the next start to reconcile.
    expect(existsSync(pidFilePathOf(current))).toBe(true);
  });
});

describe("unsafe data location is refused before any write (P0-5)", () => {
  it("rejects a data directory that is the user's home and creates nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-fake-home-"));
    try {
      const workspace = mkdtempSync(join(tmpdir(), "dsh-unsafe-ws-"));
      try {
        const supervisor = new ServiceSupervisor({
          dataDirectory: home, // the accident: the data directory *is* the user's home
          allowedRoots: [workspace],
          homeDirectory: home,
          ensureRuntime: async () => {
            throw new Error("must never be reached");
          },
          spawnProcess: () => {
            throw new Error("must never be reached");
          },
        });

        const rejection = await supervisor.start({ workspace }).then(() => null, (error: unknown) => error as Error);

        expect(rejection?.message).toMatch(/unsafe data location/u);
        expect(rejection?.message).toMatch(/must not be the user's home directory/u);
        // Fail-closed means "no side effects": no services directory was created either.
        expect(existsSync(join(home, "services"))).toBe(false);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
