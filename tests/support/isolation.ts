// Suite-level isolation guard: a test run must never touch the user's real data directory.
//
// The defect this prevents: the service supervisor used to resolve its data directory from the
// process environment and create `services/<24-char key>` before spawning anything, so a suite
// that constructed it without an explicit directory wrote hundreds of empty directories into
// `~/.deep-seek-harness-mcp` (see `reports/fix-test-isolation.md`).
//
// Every test file imports this module. At import time it records whether the data directories
// a *real* process would own exist, and in `afterAll` it fails that file when the existence
// changed. `tests/isolation.test.ts` rejects any test file that forgets the import, so the net
// has no manual step to remember.
//
// The two directories are **not** watched with the same rule (P8/B1 fix):
//
//   * the *default* directory (`~/.deep-seek-harness-mcp`) belongs to the user's real home and
//     must never change at all — created or deleted, either way the suite is red;
//   * a *configured* directory (`DSH_MCP_DATA_DIR` / `PLUGIN_DATA`) is the operator's explicit
//     choice, and the first run is supposed to create it. It may appear, but it must never
//     disappear: deleting it would destroy data the operator asked for.
//
// When both point at the same path the stricter rule wins, so configuring the default directory
// cannot be used to buy the "may appear" allowance.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

/** The data directory `config/resolve.ts` falls back to when nothing is configured. */
export const DEFAULT_DATA_DIRECTORY = join(homedir(), ".deep-seek-harness-mcp");

/** The policy that applies to one watched data directory. */
export interface WatchedDataDirectory {
  path: string;
  /**
   * `true` only for a directory the operator configured explicitly: the suite may be the thing
   * that creates it (a cold run installs the runtime there). An explicit directory may still
   * never be deleted.
   */
  allowCreation: boolean;
}

/** Whether a path existed when the suite observed it, plus the rule that was in force. */
export interface DataDirectoryObservation extends WatchedDataDirectory {
  existed: boolean;
}

/** Windows paths are case-insensitive, so the same directory can be spelled two ways. */
function canonical(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Data directories a real process would own under `env`, with the rule for each.
 *
 * The configured override (when set) is watched with `allowCreation: true`; the unconfigured
 * default is always watched with `allowCreation: false`. If they resolve to the same directory,
 * only the strict entry survives — an operator pointing the data directory at the default one
 * must not weaken the protection of their own home directory.
 */
export function watchedDataDirectories(env: NodeJS.ProcessEnv = process.env): WatchedDataDirectory[] {
  const configured = env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  const strict: WatchedDataDirectory = { path: DEFAULT_DATA_DIRECTORY, allowCreation: false };
  if (configured === undefined || configured === "") return [strict];
  if (canonical(configured) === canonical(DEFAULT_DATA_DIRECTORY)) return [strict];
  return [{ path: configured, allowCreation: true }, strict];
}

/** The watched paths only (`tests/isolation.test.ts` and the guard banner use this shape). */
export function realDataDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  return watchedDataDirectories(env).map((entry) => entry.path);
}

/** Snapshots the existence of every watched data directory, carrying its policy along. */
export function observeRealDataDirectories(env: NodeJS.ProcessEnv = process.env): DataDirectoryObservation[] {
  return watchedDataDirectories(env).map((entry) => ({ ...entry, existed: existsSync(entry.path) }));
}

/**
 * The violations in `before`, given a probe for current existence.
 *
 * Pure on purpose: the regression tests drive every policy branch with synthetic observations
 * and a fake probe, so proving the rules never risks creating a real directory.
 */
export function dataDirectoryViolations(
  before: readonly DataDirectoryObservation[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  const violations: string[] = [];
  for (const entry of before) {
    const present = exists(entry.path);
    if (present === entry.existed) continue;
    if (entry.existed) {
      violations.push(`${entry.path} disappeared during the test run`);
      continue;
    }
    if (entry.allowCreation) continue; // the operator configured it; a cold run creates it
    violations.push(`${entry.path} was created during the test run`);
  }
  return violations;
}

/** Fails when a watched data directory changed in a way its policy forbids. */
export function assertRealDataDirectoriesUnchanged(before: readonly DataDirectoryObservation[]): void {
  const violations = dataDirectoryViolations(before);
  if (violations.length === 0) return;
  const guidance = violations.some((violation) => violation.includes("was created"))
    ? [
        "The composition root (src/app/container.ts) is the only place allowed to resolve the data",
        "directory; the service layer receives it through SupervisorOptions. Test suites must pass a",
        "temporary directory (tests/support/manager.ts does this by default) or inject the spawn seam.",
      ]
    : ["A suite must never delete the operator's data directory (DSH_MCP_DATA_DIR / PLUGIN_DATA)."];
  throw new Error([
    "test isolation violated: this suite changed the real data directory",
    ...violations,
    ...guidance,
  ].join("\n"));
}

const observedAtImport = observeRealDataDirectories();

afterAll(() => {
  assertRealDataDirectoriesUnchanged(observedAtImport);
});
