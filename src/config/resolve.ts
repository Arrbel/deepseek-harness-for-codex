// Environment → configuration. Pure: reads the passed environment map only, never the
// filesystem, a child process, or the network.
//
// One deliberate split: this module can *list and shape* npm CLI candidates, but it does not
// test whether they exist (`existsSync` lives in `service/runtime-package.ts`, which already
// owns npm execution). That keeps `config/*` deterministic and unit-testable.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { NpmCliResolution, RuntimeConfig } from "./types.js";

/** Exact npm spec installed into the data directory when nothing else is configured. */
export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.2.1-alpha.1";

/** One-off install budget: never part of the startup budget (ADR-0002 §1). */
export const DEFAULT_INSTALL_TIMEOUT_MS = 900_000;

/** Startup budget; measured as *silence*, reset by every line of child output. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;

/** Default poll interval used while waiting on a running Harness session. */
export const DEFAULT_POLL_INTERVAL_MS = 400;

/** Grace period between the graceful kill and the platform tree kill. */
export const DEFAULT_STOP_GRACE_MS = 5_000;

/** Extra wait after the platform tree kill before declaring the exit unconfirmed. */
export const DEFAULT_FORCE_STOP_GRACE_MS = 2_000;

/** Poll interval for the readiness watcher. */
export const DEFAULT_READINESS_POLL_MS = 50;

/** Environment variables that ADR-0002 removed but users may still have set. */
export const DEPRECATED_ENV_VARS = ["DSH_MCP_NPX_COMMAND"] as const;

/** Where the resolved data directory came from (ADR-0003 裁决 D5: the fallback is explicit). */
export type DataDirectorySource = "DSH_MCP_DATA_DIR" | "PLUGIN_DATA" | "default";

/** The data directory plus the evidence for *why* it is that path. */
export interface DataDirectoryInfo {
  readonly path: string;
  readonly source: DataDirectorySource;
}

/**
 * Resolves the persistent data directory used for runtime packages and service state.
 *
 * Precedence is fixed and reportable: `DSH_MCP_DATA_DIR` → `PLUGIN_DATA` → `~/.deep-seek-harness-mcp`.
 * `PLUGIN_DATA` is kept deliberately: when a host plugin sets it, a 486 MB runtime plus per-workspace
 * state belongs in the host-managed directory (uninstallable, isolated) rather than in the user's home.
 * The *fallback itself* is not hidden — `doctor` reports the source, and the service layer never
 * resolves this on its own (the composition root injects it).
 */
export function resolveDataDirectoryInfo(env: NodeJS.ProcessEnv = process.env): DataDirectoryInfo {
  const explicit = env.DSH_MCP_DATA_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return { path: explicit, source: "DSH_MCP_DATA_DIR" };
  const pluginData = env.PLUGIN_DATA?.trim();
  if (pluginData !== undefined && pluginData !== "") return { path: pluginData, source: "PLUGIN_DATA" };
  return { path: join(homedir(), ".deep-seek-harness-mcp"), source: "default" };
}

/** Resolves the persistent data directory used for runtime packages and service state. */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDataDirectoryInfo(env).path;
}

/** Resolves optional workspace roots that the MCP server may modify. */
export function resolveAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DSH_MCP_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Raw configured npm spec (validated by `policy/package-spec.ts` when used). */
export function resolveHarnessPackage(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
}

/**
 * Raw `DSH_MCP_NPM_CLI` value, or `null` when unset.
 *
 * Existence, absoluteness, and the actionable error are decided by the service layer: this
 * module never stats the filesystem.
 */
export function resolveNpmCliOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.DSH_MCP_NPM_CLI?.trim();
  return override === undefined || override === "" ? null : override;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Install budget for the runtime package (independent of startup). */
export function resolveInstallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.DSH_MCP_INSTALL_TIMEOUT_MS, DEFAULT_INSTALL_TIMEOUT_MS);
}

/** Startup budget: maximum silence between child outputs before readiness fails. */
export function resolveStartupTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env.DSH_MCP_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);
}

/**
 * Candidate `npm-cli.js` locations, in resolution order.
 *
 * npm is never taken from `PATH`: `npm.cmd`/`npx.cmd` require `shell:true`, which is the
 * injection surface ADR-0002 removes. The CLI is executed as `node <absolute js path>`.
 */
export function npmCliCandidates(env: NodeJS.ProcessEnv = process.env): NpmCliResolution[] {
  const candidates: NpmCliResolution[] = [];
  const override = resolveNpmCliOverride(env);
  if (override !== null) {
    candidates.push({ path: override, source: "DSH_MCP_NPM_CLI" });
  }
  const execDir = dirname(process.execPath);
  // Windows Node distributions ship npm inside <execDir>\node_modules\npm.
  candidates.push({ path: join(execDir, "node_modules", "npm", "bin", "npm-cli.js"), source: "node distribution (next to node)" });
  // POSIX layouts keep it under <prefix>/lib/node_modules.
  candidates.push({ path: resolve(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), source: "node distribution (../lib)" });
  try {
    const resolved = createRequire(import.meta.url).resolve("npm/bin/npm-cli.js");
    candidates.push({ path: resolved, source: "module resolution" });
  } catch {
    // npm's package exports block this on some installations; the path probes cover it.
  }
  if ((env.APPDATA ?? "") !== "") {
    candidates.push({ path: join(env.APPDATA as string, "npm", "node_modules", "npm", "bin", "npm-cli.js"), source: "%APPDATA%\\npm" });
  }
  return candidates;
}

/** Resolves every environment-derived setting in one pass (the composition root's view). */
export function resolveRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    dataDirectory: resolveDataDirectory(env),
    allowedRoots: resolveAllowedRoots(env),
    harnessPackage: resolveHarnessPackage(env),
    npmCliOverride: resolveNpmCliOverride(env),
    installTimeoutMs: resolveInstallTimeoutMs(env),
    startupTimeoutMs: resolveStartupTimeoutMs(env),
  };
}

/** Absolute-or-not check with no filesystem access, used to shape npm CLI errors. */
export function isAbsolutePath(value: string): boolean {
  return isAbsolute(value);
}
