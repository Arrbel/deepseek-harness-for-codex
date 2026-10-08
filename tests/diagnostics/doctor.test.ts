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
import { inspectRuntime, permissionReport, prerequisiteProblems } from "../../src/diagnostics/doctor.js";
import { orphanProblem } from "../../src/policy/orphans.js";
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

describe("doctor (inspectRuntime)", () => {
  it("reports the runtime package, engines, npm CLI, proxy, and deprecated env", () => {
    const dataDirectory = scratch();
    const report = inspectRuntime({
      DSH_MCP_DATA_DIR: dataDirectory,
      DSH_MCP_HARNESS_PACKAGE: "@deepseek-ai/dsh@0.2.1-alpha.1",
      DSH_MCP_NPX_COMMAND: "npx.cmd",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "localhost",
    });

    expect(report.version).toBe(PACKAGE_VERSION);
    expect(report.engines).toMatchObject({ range: SUPPORTED_NODE_RANGE, nodeVersion: process.versions.node, supported: true });
    expect(report.runtimePackage).toMatchObject({
      spec: "@deepseek-ai/dsh@0.2.1-alpha.1",
      installed: false,
      version: "0.2.1-alpha.1",
      diskBytes: 0,
      error: null,
    });
    expect((report.runtimePackage as { root: string }).root).toBe(join(dataDirectory, "versions", "0.2.1-alpha.1"));
    expect(report.npmCli).toMatchObject({ exists: true });
    expect((report.npmCli as { path: string }).path).toMatch(/npm-cli\.js$/u);
    expect((report.dataDirectory as { path: string }).path).toBe(dataDirectory);
    expect((report.dataDirectory as { source: string }).source).toBe("DSH_MCP_DATA_DIR");
    expect(report.proxy).toEqual({ env: { HTTPS_PROXY: "http://127.0.0.1:1" }, noProxy: "localhost" });
    expect(report.deprecatedEnv).toEqual(["DSH_MCP_NPX_COMMAND"]);
    expect(report.surface).toBe("web");
    expect(report.ready).toBe(true);
    // `problems` is the only input of `ready`: empty means ready, and it says why when not.
    expect(report.problems).toEqual([]);
  });

  it("reports an installed runtime package with its bin path and size", () => {
    const dataDirectory = scratch();
    const packageDir = join(dataDirectory, "versions", "0.2.1-alpha.1", "node_modules", "@deepseek-ai", "dsh");
    const manifest = JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-alpha.1", bin: { dsh: "lib/bin.js" } });
    const entry = "#!/usr/bin/env node\n";
    const nested = "x".repeat(1_024);
    mkdirSync(join(packageDir, "lib", "deep"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), manifest, "utf8");
    writeFileSync(join(packageDir, "lib", "bin.js"), entry, "utf8");
    writeFileSync(join(packageDir, "lib", "deep", "nested.js"), nested, "utf8");

    const report = inspectRuntime({ DSH_MCP_DATA_DIR: dataDirectory });
    const runtimePackage = report.runtimePackage as { installed: boolean; binPath: string; diskBytes: number };

    expect(runtimePackage.installed).toBe(true);
    expect(runtimePackage.binPath).toBe(join(packageDir, "lib", "bin.js"));
    // The size walk must reach nested directories (a small entry limit would under-report).
    expect(runtimePackage.diskBytes).toBe(manifest.length + entry.length + nested.length);
  });

  it("reports an invalid spec instead of throwing, and does not claim ready", () => {
    const report = inspectRuntime({ DSH_MCP_DATA_DIR: scratch(), DSH_MCP_HARNESS_PACKAGE: "@deepseek-ai/dsh@latest" });

    // 裁决 D-a: an unusable spec is a configuration error — "cannot possibly run" — so `ready` is
    // false and `problems` carries the fix; `runtimePackage.error` stays as the detail layer.
    expect(report.ready).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems).toEqual([expect.stringContaining("is invalid")]);
    expect(report.problems).toEqual([expect.stringContaining("DSH_MCP_HARNESS_PACKAGE")]);
    expect((report.runtimePackage as { error: string }).error).toMatch(/name@x\.y\.z/u);
    expect(report.deprecatedEnv).toEqual([]);
  });

  it("reports the data directory source, existence, and a real writability probe", () => {
    const dataDirectory = scratch();
    const missing = join(dataDirectory, "not-created-yet");

    const absent = inspectRuntime({ DSH_MCP_DATA_DIR: missing });
    expect(absent.dataDirectory).toMatchObject({ path: missing, source: "DSH_MCP_DATA_DIR", exists: false, writable: "unknown" });
    // Probing must never create the directory (that is the leak class this suite guards).
    expect(existsSync(missing)).toBe(false);

    mkdirSync(missing, { recursive: true });
    const present = inspectRuntime({ DSH_MCP_DATA_DIR: missing });
    expect(present.dataDirectory).toMatchObject({ exists: true, writable: "yes" });
    expect(present.ready).toBe(true);
  });

  it("reports the PLUGIN_DATA fallback and reports ready=false when the target is not a directory", () => {
    const directory = scratch();
    const pluginData = join(directory, "plugin-data");
    mkdirSync(pluginData, { recursive: true });
    const fallback = inspectRuntime({ PLUGIN_DATA: pluginData });
    expect(fallback.dataDirectory).toMatchObject({ path: pluginData, source: "PLUGIN_DATA", exists: true, writable: "yes" });

    const asFile = join(directory, "data-is-a-file");
    writeFileSync(asFile, "", "utf8");
    const unwritable = inspectRuntime({ DSH_MCP_DATA_DIR: asFile });
    expect(unwritable.dataDirectory).toMatchObject({ exists: true, writable: "no" });
    expect(unwritable.ready).toBe(false);
    expect(unwritable.problems).toEqual([expect.stringContaining("is not writable")]);
    expect(unwritable.problems).toEqual([expect.stringContaining("DSH_MCP_DATA_DIR")]);
  });

  it("names every unmet prerequisite, each with the fix, and ready is exactly 'problems is empty'", () => {
    const writableNowhere: Parameters<typeof prerequisiteProblems>[1]["dataDirectory"] = {
      path: "C:\\data",
      source: "default",
      exists: true,
      writable: "no",
    };
    const unparseable: Parameters<typeof prerequisiteProblems>[1]["runtimePackage"] = {
      spec: "@deepseek-ai/dsh@latest",
      installed: false,
      version: null,
      root: null,
      binPath: null,
      diskBytes: 0,
      error: "The package spec must be name@x.y.z",
    };
    const env = { DSH_MCP_NPM_CLI: "relative\\npm-cli.js" };

    // Node outside the range is the fourth branch; it cannot be produced through `inspectRuntime`
    // (the running Node is by definition fixed), so it is asserted on the pure builder.
    const problems = prerequisiteProblems(env, {
      nodeVersion: "21.7.3",
      nodeSupported: false,
      npmFound: false,
      dataDirectory: writableNowhere,
      runtimePackage: unparseable,
    });

    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/Node 21\.7\.3 is outside the supported range/u);
    expect(problems[0]).toContain(SUPPORTED_NODE_RANGE);
    expect(problems[1]).toMatch(/absolute path/u);
    expect(problems[1]).toMatch(/DSH_MCP_NPM_CLI/u);
    expect(problems[2]).toMatch(/C:\\data is not writable/u);
    expect(problems[3]).toContain("@deepseek-ai/dsh@latest");
    expect(problems[3]).toContain("DSH_MCP_HARNESS_PACKAGE");

    // The empty-problems case is the same code path as the happy-path assertion above.
    expect(prerequisiteProblems({}, {
      nodeVersion: "22.22.2",
      nodeSupported: true,
      npmFound: true,
      dataDirectory: { path: "C:\\data", source: "default", exists: false, writable: "unknown" },
      runtimePackage: { ...unparseable, spec: "@deepseek-ai/dsh@0.2.1-alpha.1", error: null },
    })).toEqual([]);
  });
});


describe("doctor: orphaned service state (P0-1)", () => {
  /** Writes one pidfile under `<dataDir>/services/<key>/dsh.pid`. */
  function withPidFile(dataDirectory: string, key: string, contents: string): string {
    const serviceHome = join(dataDirectory, "services", key);
    mkdirSync(serviceHome, { recursive: true });
    writeFileSync(join(serviceHome, "dsh.pid"), contents);
    return serviceHome;
  }

  it("reports nothing when there is no service state", () => {
    const report = inspectRuntime({ DSH_MCP_DATA_DIR: scratch() });
    expect(report["orphans"]).toEqual([]);
    expect((report["problems"] as string[]).join("\n")).not.toContain("orphaned");
  });

  it("reports a stale pidfile and keeps `ready` on the four prerequisites", () => {
    const dataDirectory = scratch();
    // 2147483646 can never be a live process id on Windows, so liveness is deterministic.
    withPidFile(dataDirectory, "stale", JSON.stringify({
      pid: 2_147_483_646,
      port: 51999,
      version: "0.2.1-alpha.1",
      binPath: "C:\\data\\versions\\0.2.1-alpha.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      startedAt: "2026-10-09T00:00:00.000Z",
      dataDirectory,
      workspace: "C:\\ws",
      serviceHome: join(dataDirectory, "services", "stale"),
    }));

    const report = inspectRuntime({ DSH_MCP_DATA_DIR: dataDirectory });
    const orphans = report["orphans"] as { pid: number | null; state: string }[];

    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.state).toBe("stale-pidfile");
    expect(orphans[0]?.pid).toBe(2_147_483_646);
    // The advisory shows up in `problems`, and it must NOT flip the four-term `ready`.
    expect((report["problems"] as string[]).join("\n")).toContain("orphaned Harness Web service state");
    expect(report["ready"]).toBe(true);
  });

  it("never claims ownership of a live pid whose command line is not ours", () => {
    const dataDirectory = scratch();
    withPidFile(dataDirectory, "live", JSON.stringify({
      pid: process.pid,
      port: 51998,
      version: "0.2.1-alpha.1",
      binPath: "C:\\nowhere\\versions\\9.9.9\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
      startedAt: "2026-10-09T00:00:00.000Z",
      dataDirectory,
      workspace: "C:\\ws",
      serviceHome: join(dataDirectory, "services", "live"),
    }));

    const orphans = inspectRuntime({ DSH_MCP_DATA_DIR: dataDirectory })["orphans"] as { state: string }[];

    expect(orphans).toHaveLength(1);
    // This test runner is alive, but it is not the recorded runtime entry: fail-closed.
    expect(orphans[0]?.state).toBe("unverified");
  });

  it("reports an unreadable pidfile as stale instead of guessing a pid", () => {
    const dataDirectory = scratch();
    withPidFile(dataDirectory, "corrupt", "{ not json");

    const orphans = inspectRuntime({ DSH_MCP_DATA_DIR: dataDirectory })["orphans"] as { pid: number | null; state: string; serviceHome: string }[];

    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.pid).toBeNull();
    expect(orphans[0]?.state).toBe("stale-pidfile");
    expect(orphans[0]?.serviceHome).toContain("corrupt");
  });
});

// N-2: the advisory line must not claim more than the pidfile proves. `port: null` means the child
// was killed before it bound one, so "still hold a port" would be an unsupported claim.
describe("orphan advisory wording matches the evidence (N-2)", () => {
  it("says 'port unknown' when the pidfile never recorded a port", () => {
    const line = orphanProblem([{ pid: 4242, port: null, serviceHome: "C:\\data\\services\\k", state: "alive" }]);

    expect(line).toContain("port unknown");
    expect(line).toContain("4242");
    expect(line).not.toContain("holding port");
    expect(line).toContain("does not block `ready`");
  });

  it("states the ports it knows and flags the ones it does not", () => {
    const line = orphanProblem([
      { pid: 1, port: 51_234, serviceHome: "a", state: "alive" },
      { pid: 2, port: null, serviceHome: "b", state: "unverified" },
    ]);

    expect(line).toContain("holding port(s) 51234");
    expect(line).toContain("port unknown for 1 of them");
    expect(line).toContain("pid 1, 2");
  });

  it("keeps the stale-only wording free of port claims", () => {
    const line = orphanProblem([{ pid: null, port: null, serviceHome: "c", state: "stale-pidfile" }]);

    expect(line).toContain("leftover pid files");
    expect(line).not.toContain("holding port");
  });
});

describe("doctor.permission mirrors the Harness approval policy without touching ready (R2-3)", () => {
  it("defaults to workspace-write + ask, and says what that means", () => {
    const report = permissionReport({});

    expect(report.mode).toBe("workspace-write");
    expect(report.source).toBe("default");
    expect(report.approval).toBe("ask");
    expect(report.advisory).toContain("cannot answer that prompt");
    expect(report.advisory).toContain("DSH_PERMISSION_MODE");
  });

  it("is the harness bundle's own expression: only danger-full-access is never", () => {
    // packages/bundle/base/cordis.patch.yml:248
    //   policy: (DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'
    expect(permissionReport({ DSH_PERMISSION_MODE: "danger-full-access" }).approval).toBe("never");
    expect(permissionReport({ DSH_PERMISSION_MODE: "danger-full-access" }).advisory).toBeNull();
    expect(permissionReport({ DSH_PERMISSION_MODE: "read-only" }).approval).toBe("ask");
    expect(permissionReport({ DSH_PERMISSION_MODE: "workspace-write" }).approval).toBe("ask");
    // An empty override still lands on the default, and anything unknown still asks (fail-closed).
    expect(permissionReport({ DSH_PERMISSION_MODE: "   " }).source).toBe("default");
    expect(permissionReport({ DSH_PERMISSION_MODE: "something-new" }).approval).toBe("ask");
  });

  it("reports the source so a default can be told apart from a decision", () => {
    expect(permissionReport({ DSH_PERMISSION_MODE: "workspace-write" }).source).toBe("env");
    expect(permissionReport({}).source).toBe("default");
  });

  it("never widens `ready`: the permission key is not a prerequisite", () => {
    const report = inspectRuntime({ DSH_MCP_DATA_DIR: scratch() });
    const problems = report.problems as string[];

    expect(Object.keys(report)).toContain("permission");
    expect(report.permission).toEqual(permissionReport({}));
    // Same four-term composition as before this field existed.
    expect(report.ready).toBe(problems.length === 0);
  });
});
