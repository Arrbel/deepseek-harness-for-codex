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
  resolvePruneVersionsEnabled,
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

describe("environment resolution", () => {
  it("uses the frozen defaults", () => {
    expect(resolveHarnessPackage({})).toBe(DEFAULT_HARNESS_PACKAGE);
    expect(DEFAULT_HARNESS_PACKAGE).toBe("@deepseek-ai/dsh@0.2.1-alpha.1");
    expect(resolveInstallTimeoutMs({})).toBe(DEFAULT_INSTALL_TIMEOUT_MS);
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(900_000);
    expect(resolveStartupTimeoutMs({})).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
    expect(DEFAULT_STARTUP_TIMEOUT_MS).toBe(180_000);
    expect(resolveDataDirectory({ DSH_MCP_DATA_DIR: "C:\\data" })).toBe("C:\\data");
    expect(resolveAllowedRoots({ DSH_MCP_WORKSPACE_ROOTS: "C:\\a;C:\\b" })).toEqual(["C:\\a", "C:\\b"]);
  });

  it("honours overrides and rejects non-numeric budgets", () => {
    expect(resolveHarnessPackage({ DSH_MCP_HARNESS_PACKAGE: " @scope/pkg@1.2.3 " })).toBe("@scope/pkg@1.2.3");
    expect(resolveInstallTimeoutMs({ DSH_MCP_INSTALL_TIMEOUT_MS: "1234" })).toBe(1234);
    expect(resolveInstallTimeoutMs({ DSH_MCP_INSTALL_TIMEOUT_MS: "soon" })).toBe(DEFAULT_INSTALL_TIMEOUT_MS);
    expect(resolveStartupTimeoutMs({ DSH_MCP_STARTUP_TIMEOUT_MS: "-5" })).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
  });

  it("enables the version-directory prune by default and only an explicit opt-out disables it", () => {
    // Absent/blank means "on": the prune is fail-closed, so a default that never reclaimed
    // anything would leave the 486 MB-per-version leak in place (P0-4).
    expect(resolvePruneVersionsEnabled({})).toBe(true);
    expect(resolvePruneVersionsEnabled({ DSH_MCP_PRUNE_VERSIONS: "" })).toBe(true);
    expect(resolvePruneVersionsEnabled({ DSH_MCP_PRUNE_VERSIONS: "   " })).toBe(true);
    expect(resolvePruneVersionsEnabled({ DSH_MCP_PRUNE_VERSIONS: "on" })).toBe(true);
    expect(resolvePruneVersionsEnabled({ DSH_MCP_PRUNE_VERSIONS: "1" })).toBe(true);
    for (const value of ["off", "OFF", " 0 ", "false", "No", "disabled"]) {
      expect(resolvePruneVersionsEnabled({ DSH_MCP_PRUNE_VERSIONS: value })).toBe(false);
    }
  });
});

