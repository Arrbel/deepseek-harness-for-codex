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

describe("npm CLI resolution", () => {
  it("resolves npm-cli.js from the running Node, never from PATH", () => {
    const found = findNpmCli({});
    expect(found).not.toBeNull();
    expect(found!.path).toMatch(/npm-cli\.js$/u);
    expect(found!.path).not.toMatch(/\.cmd$/u);
    expect(found!.source).not.toBe("PATH");
    // The first candidate is the Node distribution next to process.execPath.
    expect(npmCliCandidates({})[0]!.path).toBe(join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js"));
  });

  it("prefers a valid DSH_MCP_NPM_CLI override", () => {
    const directory = scratch();
    const cli = join(directory, "npm-cli.js");
    writeFileSync(cli, "", "utf8");

    const resolved = resolveNpmCli({ DSH_MCP_NPM_CLI: cli });

    expect(resolved.path).toBe(cli);
    expect(resolved.source).toBe("DSH_MCP_NPM_CLI");
  });

  it("rejects a relative or missing override with an actionable hint", () => {
    for (const override of ["npm-cli.js", join(scratch(), "missing", "npm-cli.js")]) {
      const error = (() => {
        try {
          resolveNpmCli({ DSH_MCP_NPM_CLI: override });
          return null;
        } catch (thrown) {
          return thrown as RuntimePackageError;
        }
      })();
      expect(error?.kind).toBe("npm-cli-missing");
      expect(error?.hint).not.toBeNull();
    }
  });
});

