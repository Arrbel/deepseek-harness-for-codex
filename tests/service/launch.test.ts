// Launch-vector and environment tests for ADR-0002.
//
// The regression this file guards is the whole point of the ADR: the Harness must be started
// as `process.execPath <installed bin> web --no-open --port 0` with `shell: false`, never
// through npx/npx.cmd (which required `shell: true` on Windows and produced a four-layer
// process tree). `doctor` must derive its npm path and engine range locally, because the
// published runtime package carries no `engines` field.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_PACKAGE,
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  npmCliCandidates,
  resolveAllowedRoots,
  resolveDataDirectory,
  resolveHarnessPackage,
  resolveInstallTimeoutMs,
  resolveStartupTimeoutMs,
} from "../../src/config/resolve.js";
import { buildHarnessLaunch, launchSpawnOptions } from "../../src/service/launch.js";
import { findNpmCli, resolveNpmCli } from "../../src/service/npm-cli.js";
import { inspectRuntime } from "../../src/diagnostics/doctor.js";
import {
  RuntimePackageError,
  SUPPORTED_NODE_RANGE,
  satisfiesNodeRange,
} from "../../src/service/runtime-package.js";
import { PACKAGE_VERSION } from "../../src/version.js";
import "../support/isolation.js";

const scratchDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-runtime-test-"));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Harness launch vector", () => {
  it("launches process.execPath with the resolved bin and no shell", () => {
    // `platform` is explicit on purpose (task-20 / N-1): without it the assertions below read
    // `process.platform`, so the ubuntu columns of `.github/workflows/check.yml` failed
    // deterministically while Windows stayed green.
    const launch = buildHarnessLaunch({
      binPath: "C:\\data\\versions\\0.2.1-alpha.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      workspace: "C:\\workspace",
      serviceHome: "C:\\data\\services\\abc",
      env: { PATH: "C:\\node", DSH_PERMISSION_MODE: "danger-full-access" },
      platform: "win32",
    });

    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([
      "C:\\data\\versions\\0.2.1-alpha.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      "web",
      "--no-open",
      "--port",
      "0",
    ]);
    expect(launch.shell).toBe(false);
    // Windows must not detach: a detached child would flash a new console window.
    expect(launch.detached).toBe(false);
    expect(launch.windowsHide).toBe(true);
    expect(launch.cwd).toBe("C:\\workspace");
    expect(launch.env.DSH_CWD).toBe("C:\\workspace");
    expect(launch.env.DSH_HOME).toBe("C:\\data\\services\\abc");
    expect(launch.env.DSH_PERMISSION_MODE).toBe("danger-full-access");
    expect(launch.env.DSH_TELEMETRY_DISABLED).toBe("1");
    expect(launch.env.NO_COLOR).toBe("1");

    // The removed npx vector must not come back through the launch shape.
    expect(launch.args.join(" ")).not.toMatch(/npx|--package/u);

    const spawnOptions = launchSpawnOptions(launch);
    expect(spawnOptions.shell).toBe(false);
    expect(spawnOptions.detached).toBe(false);
    expect(spawnOptions.windowsHide).toBe(true);
    expect(spawnOptions.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("detaches on POSIX so kill(-pid) can reach the whole tree (P0-2)", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const launch = buildHarnessLaunch({
        binPath: "/data/versions/0.2.1-alpha.1/node_modules/@deepseek-ai/dsh/lib/bin.js",
        workspace: "/workspace",
        serviceHome: "/data/services/abc",
        env: {},
        platform,
      });

      // The premise of the POSIX process-group kill: without `detached` the group does not
      // exist, `kill(-pid)` raises ESRCH, and the Harness grandchild used to survive.
      expect(launch.detached, platform).toBe(true);
      expect(launchSpawnOptions(launch).detached, platform).toBe(true);
      // `detached: true` must never come with `unref()`: stdout/stderr pipes carry readiness.
      expect(launch.shell).toBe(false);
      expect(launchSpawnOptions(launch).stdio).toEqual(["ignore", "pipe", "pipe"]);
    }
  });

  it("follows the host platform when none is injected (the shape CI exercises)", () => {
    const launch = buildHarnessLaunch({
      binPath: "/data/bin.js",
      workspace: "/workspace",
      serviceHome: "/data/services/abc",
      env: {},
    });

    expect(launch.detached).toBe(process.platform !== "win32");
  });
});

// Both platform branches, executed on *any* host. This is the permanent version of the
// throwaway `ubuntu-sim.mts` the verifier used to reproduce N-1: it removes "my machine is
// Windows" as the reason a POSIX regression can hide.
describe("launch vector: both platform branches regardless of the host", () => {
  function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const real = process.platform;
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return run();
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }
  }

  it("simulated win32 host: no detach", () => {
    withPlatform("win32", () => {
      const launch = buildHarnessLaunch({
        binPath: "C:\\data\\bin.js",
        workspace: "C:\\ws",
        serviceHome: "C:\\data\\services\\abc",
        env: {},
      });
      expect(launch.detached).toBe(false);
      expect(launchSpawnOptions(launch).detached).toBe(false);
    });
  });

  it("simulated linux host: detaches (the ubuntu-latest shape)", () => {
    withPlatform("linux", () => {
      const launch = buildHarnessLaunch({
        binPath: "/data/bin.js",
        workspace: "/ws",
        serviceHome: "/data/services/abc",
        env: {},
      });
      expect(launch.detached).toBe(true);
      expect(launchSpawnOptions(launch).detached).toBe(true);
    });
  });

  it("simulated darwin host: detaches too", () => {
    withPlatform("darwin", () => {
      const launch = buildHarnessLaunch({
        binPath: "/data/bin.js",
        workspace: "/ws",
        serviceHome: "/data/services/abc",
        env: {},
      });
      expect(launch.detached).toBe(true);
    });
  });
});

describe("Harness launch vector: environment defaults", () => {
  it("defaults the permission mode to workspace-write and honours extra env", () => {
    const launch = buildHarnessLaunch({
      binPath: "/data/bin.js",
      workspace: "/workspace",
      serviceHome: "/home",
      env: {},
      extraEnv: { FIXTURE_MODE: "serve" },
    });

    expect(launch.env.DSH_PERMISSION_MODE).toBe("workspace-write");
    expect(launch.env.FIXTURE_MODE).toBe("serve");
  });
});

