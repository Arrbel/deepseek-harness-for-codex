// Pre-flight diagnostics (`doctor`).
//
// Reporting on top of `config/`, `policy/` and `service/runtime-package.ts`: it never installs,
// never starts a process, and never throws — an unusable configuration is exactly what this
// surface exists to describe.
//
// The one filesystem *write* it may perform is the writability probe (ADR-0003 裁决 D3): and only
// inside a data directory that already exists. It never creates that directory — creating it to
// make the probe succeed is the defect class that put 225 stray directories in a user's home
// (see `reports/fix-test-isolation.md`).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { identityOwnsRecord, orphanProblem, orphanState, parsePidFile, pidFilePath, type OrphanReport } from "../policy/orphans.js";
import { SUPPORTED_NODE_RANGE, directorySizeSync, inspectInstalledRuntime, resolveRuntimeLayout, satisfiesNodeRange } from "../service/runtime-package.js";
import { isProcessAlive, readProcessIdentity } from "../service/process-tree.js";
import { findNpmCli, resolveNpmCli } from "../service/npm-cli.js";
import {
  DEPRECATED_ENV_VARS,
  resolveAllowedRoots,
  resolveDataDirectoryInfo,
  resolveHarnessPackage,
  type DataDirectorySource,
} from "../config/resolve.js";
import { PACKAGE_VERSION } from "../version.js";

/** Installed-state summary of the pinned runtime package. */
export interface RuntimePackageReport {
  spec: string;
  installed: boolean;
  version: string | null;
  root: string | null;
  binPath: string | null;
  diskBytes: number;
  error: string | null;
}

/** Result of the real write probe. `unknown` means "not probed", never "probed and unclear". */
export type DataDirectoryWritability = "yes" | "no" | "unknown";

/** Where the data directory came from, whether it exists, and whether it is writable. */
export interface DataDirectoryReport {
  path: string;
  source: DataDirectorySource;
  exists: boolean;
  /**
   * `yes`/`no` only after a real create-and-delete probe inside an existing directory;
   * `unknown` when the directory does not exist yet (the first install creates it).
   */
  writable: DataDirectoryWritability;
}

/** Proxy variables are reported, never judged: a bypass rule is the operator's call. */
function proxyReport(env: NodeJS.ProcessEnv): { env: Record<string, string>; noProxy: string | null } {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  const present: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") present[name] = value;
  }
  const noProxy = env.NO_PROXY?.trim() || env.no_proxy?.trim() || null;
  return { env: present, noProxy };
}

function runtimePackageReport(env: NodeJS.ProcessEnv): RuntimePackageReport {
  const spec = resolveHarnessPackage(env);
  const dataDirectory = resolveDataDirectoryInfo(env).path;
  let layout;
  try {
    layout = resolveRuntimeLayout(dataDirectory, spec);
  } catch (error) {
    return {
      spec,
      installed: false,
      version: null,
      root: null,
      binPath: null,
      diskBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const inspected = inspectInstalledRuntime(layout);
  return {
    spec,
    installed: inspected.ok,
    version: layout.version,
    root: layout.root,
    binPath: inspected.ok ? inspected.value.binPath : layout.binPath,
    diskBytes: inspected.ok ? directorySizeSync(layout.root) : 0,
    error: null,
  };
}

/**
 * Probes writability without ever creating the directory.
 *
 * A directory that does not exist is `unknown`, not `no`: the first install creates it, and a
 * probe that creates a directory would be indistinguishable from a leak. The probe file is
 * removed in every branch.
 */
function dataDirectoryReport(env: NodeJS.ProcessEnv): DataDirectoryReport {
  const { path, source } = resolveDataDirectoryInfo(env);
  if (!existsSync(path)) return { path, source, exists: false, writable: "unknown" };
  let isDirectory = false;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    // It vanished between the two calls; report the conservative answer.
    return { path, source, exists: true, writable: "no" };
  }
  if (!isDirectory) return { path, source, exists: true, writable: "no" };
  const probe = join(path, `.doctor-write-probe-${String(process.pid)}-${randomUUID().slice(0, 8)}`);
  try {
    writeFileSync(probe, "", { flag: "wx" });
    return { path, source, exists: true, writable: "yes" };
  } catch {
    return { path, source, exists: true, writable: "no" };
  } finally {
    rmSync(probe, { force: true });
  }
}

/**
 * One actionable line for an unresolvable npm CLI.
 *
 * The text is taken from `resolveNpmCli`, which is where the "absolute path to npm-cli.js, not
 * npm.cmd" hint lives — so the summary and the thrown error can never disagree.
 */
function npmProblem(env: NodeJS.ProcessEnv): string {
  try {
    resolveNpmCli(env);
    return "The npm CLI could not be resolved: set DSH_MCP_NPM_CLI to the absolute path of npm-cli.js.";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = error instanceof Error ? (error as { hint?: unknown }).hint : undefined;
    return typeof hint === "string" ? `${message} ${hint}` : message;
  }
}

/** The already-resolved facts `problems` is derived from (explicit, so each branch is testable). */
export interface PrerequisiteInputs {
  nodeVersion: string;
  nodeSupported: boolean;
  npmFound: boolean;
  dataDirectory: DataDirectoryReport;
  runtimePackage: RuntimePackageReport;
}

/**
 * The prerequisites that are not satisfied, each with its own fix.
 *
 * `problems` is deliberately the **only** input of `ready` (empty ⇔ ready): a `ready=false` that
 * does not explain itself forces the caller to guess which of several fields is the cause, which
 * is exactly the over-optimism/silence pair this phase removes. `runtimePackage.error` stays as
 * the detail layer.
 */
export function prerequisiteProblems(env: NodeJS.ProcessEnv, parts: PrerequisiteInputs): string[] {
  const problems: string[] = [];
  if (!parts.nodeSupported) {
    problems.push(
      `Node ${parts.nodeVersion} is outside the supported range ${SUPPORTED_NODE_RANGE}: install a supported Node (22.19+ LTS, or 24+) and restart the MCP client.`,
    );
  }
  if (!parts.npmFound) problems.push(npmProblem(env));
  if (parts.dataDirectory.writable === "no") {
    problems.push(
      `The data directory ${parts.dataDirectory.path} is not writable (source: ${parts.dataDirectory.source}): fix its permissions, or point DSH_MCP_DATA_DIR at a writable directory.`,
    );
  }
  if (parts.runtimePackage.error !== null) {
    problems.push(
      `The runtime package spec "${parts.runtimePackage.spec}" is invalid: ${parts.runtimePackage.error} Set DSH_MCP_HARNESS_PACKAGE to an exact version, for example @deepseek-ai/dsh@0.2.1-alpha.1.`,
    );
  }
  return problems;
}

/**
 * Reports local prerequisites without installing anything or opening a browser.
 *
 * `doctor` must never throw: an unusable configuration is *reported*, because diagnosing
 * "cannot install" is the whole point of the pre-flight surface.
 */
export function inspectRuntime(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const nodeVersion = process.versions.node;
  const nodeSupported = satisfiesNodeRange(nodeVersion, SUPPORTED_NODE_RANGE);
  const npm = findNpmCli(env);
  const runtimePackage = runtimePackageReport(env);
  const dataDirectory = dataDirectoryReport(env);
  const deprecatedEnv = DEPRECATED_ENV_VARS.filter((name) => (env[name]?.trim() ?? "") !== "");
  // The four prerequisites decide `ready` (ADR-0003 D3/D-a); they are never widened.
  const prerequisites = prerequisiteProblems(env, {
    nodeVersion,
    nodeSupported,
    npmFound: npm !== null,
    dataDirectory,
    runtimePackage,
  });
  // Orphaned services are an *advisory*: they are actionable, but a leftover pidfile must not
  // make an otherwise runnable installation report itself as not ready.
  const orphans = orphanReport(dataDirectory.path);
  const orphanHint = orphanProblem(orphans);
  const problems = orphanHint === null ? prerequisites : [...prerequisites, orphanHint];

  return {
    // Four-term composition (ADR-0003 裁决 D3 + D-a): engines, npm CLI, a data directory that is
    // not *known to be* unwritable, and a parseable package spec. `unknown` (no directory yet)
    // does not fail `ready`; deriving it from `problems` keeps the two from ever drifting.
    ready: prerequisites.length === 0,
    problems,
    version: PACKAGE_VERSION,
    engines: {
      range: SUPPORTED_NODE_RANGE,
      nodeVersion,
      supported: nodeSupported,
      source: "declared by this package (the published @deepseek-ai/dsh has no engines field)",
    },
    nodeVersion,
    nodeSupported,
    platform: process.platform,
    architecture: process.arch,
    npmCli: npm === null ? { path: null, source: null, exists: false } : { path: npm.path, source: npm.source, exists: true },
    runtimePackage,
    dataDirectory,
    proxy: proxyReport(env),
    deprecatedEnv,
    harnessPackage: runtimePackage.spec,
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    allowedWorkspaceRoots: resolveAllowedRoots(env),
    orphans,
    surface: "web",
  };
}

/**
 * Scans `<dataDir>/services/<key>/dsh.pid` for state a killed MCP host left behind (P0-1).
 *
 * Never throws: this is a report. A pid is only classified as `alive` when the OS-reported
 * command line proves it is our runtime entry; anything unprovable is `unverified`, which is the
 * signal to *not* kill it (a recycled pid would be somebody else's process).
 */
function orphanReport(dataDirectory: string): OrphanReport[] {
  const servicesRoot = join(dataDirectory, "services");
  let entries: Dirent[];
  try {
    entries = readdirSync(servicesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const reports: OrphanReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const serviceHome = join(servicesRoot, entry.name);
    let text: string;
    try {
      text = readFileSync(pidFilePath(serviceHome), "utf8");
    } catch {
      continue;
    }
    const record = parsePidFile(text);
    if (record === null) {
      // Interrupted or hand-edited: the pid is unknowable, so it is never signalled.
      reports.push({ pid: null, port: null, serviceHome, state: "stale-pidfile" });
      continue;
    }
    const alive = isProcessAlive(record.pid);
    const owned = alive ? identityOwnsRecord(readProcessIdentity(record.pid), record) : null;
    reports.push({
      pid: record.pid,
      port: record.port,
      serviceHome,
      state: orphanState({ alive, owned }),
    });
  }
  return reports;
}
