// Service-layer isolation tests.
//
// The regression these guard is concrete: `ServiceSupervisor` used to resolve its data
// directory from the process environment and create `services/<key>` in `start()`, before any
// process existed. A suite that did not pass a directory wrote empty directories into the
// user's real `~/.deepseek-harness-mcp` (see `reports/fix-test-isolation.md`).
//
// Two properties are asserted: the data directory is a compile-time requirement of this layer,
// and the injected spawn seam has no filesystem side effects at all.

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { ServiceSupervisor, type SupervisorOptions } from "../../src/service/supervisor.js";
import { spawnHarness, type HarnessLaunch } from "../../src/service/launch.js";
import { WORKSPACE_KEY_LENGTH } from "../../src/util/ids.js";
import type { ChildProcess } from "node:child_process";
import "../support/isolation.js";

const scratchRoots: string[] = [];

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A fake child that reports readiness, so `start()` completes without spawning anything. */
function fakeHarnessChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    // Out of the platform's pid range on purpose: if this record is ever terminated for real,
    // `taskkill`/`kill(-pid)` must not be able to hit an unrelated process.
    pid: 0x7fff_fffe,
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
    kill: () => true,
  });
  setTimeout(() => { stdout.write("dsh web: http://127.0.0.1:1/?token=fake\n"); }, 5);
  return child;
}

describe("ServiceSupervisor data-directory ownership", () => {
  it("makes the data directory a compile-time requirement of the service layer", () => {
    // A missing `dataDirectory` must not compile. If the service layer ever regains a fallback
    // (the original defect), this directive becomes unused and `tsc --noEmit` fails the check.
    // @ts-expect-error dataDirectory is required: the service layer must never derive it.
    const missing: SupervisorOptions = { allowedRoots: [] };

    expect(missing).not.toHaveProperty("dataDirectory");
  });

  it("writes nothing to the injected data directory when the spawn seam is injected", async () => {
    const root = scratch("dsh-supervisor-iso-");
    const dataDirectory = join(root, "data");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const launches: HarnessLaunch[] = [];
    let child: ChildProcess | null = null;
    const supervisor = new ServiceSupervisor({
      dataDirectory,
      allowedRoots: [root],
      startupTimeoutMs: 2_000,
      stopGraceMs: 10,
      forceStopGraceMs: 10,
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(root, "runtime"),
        packageDir: join(root, "runtime"),
        binPath: join(root, "runtime", "bin.js"),
        installedNow: false,
      }),
      spawnProcess: (launch) => {
        launches.push(launch);
        child = fakeHarnessChild();
        return child;
      },
    });

    const service = await supervisor.start({ workspace });

    expect(service.status).toBe("running");
    expect(launches).toHaveLength(1);
    // The launch still names the service home; creating it belongs to the real spawn path.
    const serviceHome = launches[0]!.serviceHome;
    expect(serviceHome.startsWith(join(dataDirectory, "services"))).toBe(true);
    expect(serviceHome.split(/[\\/]/u).at(-1)).toHaveLength(WORKSPACE_KEY_LENGTH);

    // Zero filesystem side effects: an injected spawn must not create the data directory, the
    // `services` parent, or the per-workspace home.
    expect(existsSync(dataDirectory)).toBe(false);
    expect(existsSync(join(dataDirectory, "services"))).toBe(false);
    expect(existsSync(serviceHome)).toBe(false);

    // Mark the fake child as exited so teardown takes the already-exited branch.
    Object.assign(child!, { exitCode: 0 });
    await supervisor.dispose();
  });

  it("creates the service home on the real spawn path", async () => {
    const root = scratch("dsh-supervisor-spawn-");
    const serviceHome = join(root, "data", "services", "0123456789abcdef01234567");
    const launch: HarnessLaunch = {
      command: process.execPath,
      args: ["-e", "0"],
      cwd: root,
      env: { ...process.env },
      serviceHome,
      shell: false,
      windowsHide: true,
      detached: false,
    };

    const child = spawnHarness(launch);

    expect(existsSync(serviceHome)).toBe(true);
    expect(readdirSync(serviceHome)).toEqual([]);
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  });
});
