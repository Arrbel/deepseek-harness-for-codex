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
import { homedir } from "node:os";
import { join } from "node:path";
import { identityOwnsRecord, orphanProblem, orphanState, parsePidFile, pidFilePath, type OrphanReport } from "../policy/orphans.js";
import { dataLocationAliasProblems, type RealpathLookup } from "../policy/paths.js";
import { SUPPORTED_NODE_RANGE, directorySizeSync, inspectInstalledRuntime, resolveRuntimeLayout, satisfiesNodeRange } from "../service/runtime-package.js";
import { isProcessAlive, readProcessIdentity } from "../service/process-tree.js";
import { findNpmCli, resolveNpmCli } from "../service/npm-cli.js";
import { realpathOnDisk } from "../service/supervisor.js";
import {
  DEPRECATED_ENV_VARS,
  resolveAllowedRoots,
  resolveDataDirectoryInfo,
  resolveHarnessPackage,
  type DataDirectorySource,
} from "../config/resolve.js";
import { PACKAGE_VERSION } from "../version.js";
import { classifyContract, contractBlocksReadiness, type ContractReport } from "../dsh/matrix.js";

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
 *
 * N-R5-1: a location the runner will refuse is **never probed**. A junction pointing at the user's
 * home *exists* and *is a directory*, so the probe would otherwise create (and delete) a file
 * inside the real home — the very write the P0-5 guard exists to prevent. Such a location is
 * reported as `unknown` (not measured), and the actionable problem comes from the guard itself.
 */
function dataDirectoryReport(env: NodeJS.ProcessEnv, locationProblems: readonly string[]): DataDirectoryReport {
  const { path, source } = resolveDataDirectoryInfo(env);
  if (!existsSync(path)) return { path, source, exists: false, writable: "unknown" };
  if (locationProblems.length > 0) return { path, source, exists: true, writable: "unknown" };
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
 * The P0-5 verdict for the data directory, **alias-aware** (N-R5-1).
 *
 * Why this exists: `doctor` answers "can this start safely?", so it must not say yes where the
 * runner says no. The runner refuses an unsafe data location in `supervisor.ts` (alias-aware since
 * R5-1); `doctor` used to never ask that question, so a junction pointing at the user's home
 * produced `ready:true` and then a refused start — the worst possible pair for an operator.
 *
 * Direction of the alignment is **refuse-aligned**, never permissive: this adds problems, it never
 * removes the runner's check. A location `doctor` clears must still pass the runner's own guard.
 *
 * `DSH_HOME` is workspace-specific (`<dataDir>/services/<workspace key>`), and a pre-flight has no
 * workspace, so the probe uses `<dataDir>/services` — the directory every per-workspace home lives
 * in. The containment rule and every alias rule therefore apply to it. (A link at the per-workspace
 * *leaf* is still only observable at `start_run`; recorded as a residual in the report.)
 *
 * Never throws: like everything else here, an unusable location is reported.
 *
 * Exported for the tests, with the production resolver as the default. The default is the *real*
 * thing (never a weakening), so a call site that omits it still gets the alias-aware verdict; the
 * parameter exists so a test can inject a failing resolver and prove the fail-closed branch.
 */
export function dataLocationPrerequisiteProblems(
  dataDirectory: string,
  realpath: RealpathLookup = realpathOnDisk,
): string[] {
  try {
    const problems = dataLocationAliasProblems({
      dataDirectory,
      serviceHome: join(dataDirectory, "services"),
      home: homedir(),
      realpath,
    });
    // The guard's own message text is reused verbatim so the pre-flight and the runner point at the
    // same defect in the same words (`reports/r6-doctor-alias-consistency.md`).
    return problems.map((problem) => `Unsafe data location: ${problem}`);
  } catch (error) {
    // Fail closed: a location this surface cannot evaluate is not one to call ready.
    return [
      "Unsafe data location: the data directory could not be checked "
        + `(${error instanceof Error ? error.message : String(error)}) — fix the path, or point DSH_MCP_DATA_DIR at a directory this process can resolve.`,
    ];
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

/** What the next Harness child will use for permissions, and what that means for the user. */
export interface PermissionReport {
  /** Effective `DSH_PERMISSION_MODE` passed to the child. */
  mode: string;
  /** `env` when the caller set it, `default` when the DSH default applies. */
  source: "env" | "default";
  /** The approval policy that mode maps to inside DSH. */
  approval: "ask" | "never";
  /** Non-null when the user must be told that a turn may wait for a click. */
  advisory: string | null;
}

/** The DSH default when `DSH_PERMISSION_MODE` is unset (mirrors the bundle's own default). */
export const DEFAULT_PERMISSION_MODE = "workspace-write";

/**
 * Reports the permission mode **without** spawning anything.
 *
 * The mapping is copied from the Harness bundle it describes —
 * `packages/bundle/base/cordis.patch.yml`: `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`
 * and `policy: … === 'danger-full-access' ? 'never' : 'ask'`. It is reported (never enforced) so a
 * user can see *before* starting a run that an approval click will be required; the field is
 * deliberately **not** a prerequisite, so it can never change `ready`.
 */
export function permissionReport(env: NodeJS.ProcessEnv = process.env): PermissionReport {
  const configured = env.DSH_PERMISSION_MODE?.trim() ?? "";
  const mode = configured === "" ? DEFAULT_PERMISSION_MODE : configured;
  const source = configured === "" ? "default" : "env";
  const approval = mode === "danger-full-access" ? "never" : "ask";
  const advisory = approval === "ask"
    ? `Harness will ask for approval (permission mode \`${mode}\`) before actions that need it, and this MCP server cannot answer that prompt: a turn that needs approval waits until somebody approves it in the Harness page. Open the page, or set DSH_PERMISSION_MODE=danger-full-access in a controlled environment.`
    : null;
  return { mode, source, approval, advisory };
}

/** The already-resolved facts `problems` is derived from (explicit, so each branch is testable). */
export interface PrerequisiteInputs {
  nodeVersion: string;
  nodeSupported: boolean;
  npmFound: boolean;
  dataDirectory: DataDirectoryReport;
  runtimePackage: RuntimePackageReport;
  /** The resolved contract-matrix verdict (R3-1). Only `unsupported` may fail a prerequisite. */
  contract: ContractReport;
}

/**
 * The prerequisites that are not satisfied, each with its own fix.
 *
 * These are the **only** input of `ready` (`prerequisites.length === 0` ⇔ ready): a `ready=false`
 * that does not explain itself forces the caller to guess which of several fields is the cause.
 * (`inspectRuntime` appends the P0-5 location problems to the array this returns — see
 * {@link dataLocationPrerequisiteProblems} — so this function stays the description of the four
 * installation prerequisites while the caller decides what else can block a start.) The returned
 * array is composed with advisory entries (a leftover pidfile) into the report's
 * `problems`, so `problems` may be non-empty while `ready` is true — never infer readiness from
 * `problems.length`. `runtimePackage.error` stays as the detail layer.
 *
 * `contract` is the fifth branch and is deliberately the narrowest: it fires **only** for a
 * version line whose wire this project has never recorded. A `compatible` version (a patch on a
 * recorded line) and `unknown` (nothing resolved yet — the state before the first install) are
 * reported, never punished; {@link contractBlocksReadiness} is the single place that decides.
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
  if (contractBlocksReadiness(parts.contract)) {
    problems.push(
      `The harness contract for version line ${String(parts.contract.dshLine)} was never recorded: ${parts.contract.detail}`,
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
  // P0-5 (N-R5-1) is evaluated *before* the writability probe, because the probe is the one write
  // this surface may perform: an unsafe location must be reported, not touched. One evaluation, so
  // the probe decision and the `problems` entry can never disagree.
  const locationProblems = dataLocationPrerequisiteProblems(resolveDataDirectoryInfo(env).path);
  const dataDirectory = dataDirectoryReport(env, locationProblems);
  const deprecatedEnv = DEPRECATED_ENV_VARS.filter((name) => (env[name]?.trim() ?? "") !== "");
  // R3-1: the contract verdict is derived from the *resolved* harness version (the version the
  // configured package spec points at), which is `null` only when the spec itself is unusable.
  const contract = classifyContract(runtimePackage.version);
  // The four prerequisites decide `ready` (ADR-0003 D3/D-a); they are never widened. The contract
  // verdict joins them through `contractBlocksReadiness`, so `compatible`/`unknown` cannot move it.
  // N-R5-1 adds a *safety* prerequisite to the same list: an unsafe data location (P0-5, alias-aware)
  // is one the runner will refuse, so a pre-flight that ignored it would contradict the runner.
  const prerequisites = [
    ...prerequisiteProblems(env, {
      nodeVersion,
      nodeSupported,
      npmFound: npm !== null,
      dataDirectory,
      runtimePackage,
      contract,
    }),
    ...locationProblems,
  ];
  // Orphaned services are an *advisory*: they are actionable, but a leftover pidfile must not
  // make an otherwise runnable installation report itself as not ready.
  const orphans = orphanReport(dataDirectory.path);
  const orphanHint = orphanProblem(orphans);
  const problems = orphanHint === null ? prerequisites : [...prerequisites, orphanHint];

  return {
    // Five-term composition (ADR-0003 裁决 D3 + D-a, plus N-R5-1): engines, npm CLI, a data
    // directory that is not *known to be* unwritable, a parseable package spec, and a data location
    // the runner will not refuse (P0-5, alias-aware). `unknown` (no directory yet)
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
    contract,
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    allowedWorkspaceRoots: resolveAllowedRoots(env),
    orphans,
    permission: permissionReport(env),
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
