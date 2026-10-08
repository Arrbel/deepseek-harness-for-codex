// Runtime package acquisition for the local Harness Web service (ADR-0002).
//
// The published `@deepseek-ai/dsh` is installed once into `<dataDir>/versions/<version>/`
// and then started directly through `node <package>/lib/bin.js`. This module owns the
// whole acquisition half of that vector:
//
//   * exact-version spec parsing (ranges and dist-tags are rejected, never resolved);
//   * idempotent reuse: an already installed tree is returned without touching npm;
//   * a real npm install run as `node <npm-cli.js> install ...` with `shell:false`;
//   * `<dataDir>/versions/.install.lock` so concurrent starts install exactly once;
//   * temporary prefix + atomic rename, so a half-written tree is never promoted;
//   * typed failure classification (`ETARGET`/`E404`, `ENOTCACHED`, network, unknown).
//
// Everything that touches the outside world is injectable (`spawnImpl`, `now`) so the
// unit suite drives a fake npm CLI instead of the registry.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  RuntimePackageError,
  SUPPORTED_NODE_RANGE,
  parseExactPackageSpec,
  satisfiesNodeRange,
  type RuntimePackageFailureKind,
} from "../policy/package-spec.js";
import { identityOwnsRecord, orphanState, parsePidFile, pidFilePath, type PidFileRecord } from "../policy/orphans.js";
import { isProcessAlive, readProcessIdentity } from "./process-tree.js";
import type { NpmCliResolution } from "../config/types.js";
import { npmCliCandidates } from "../config/resolve.js";
import { tail as tailShared } from "../util/errors.js";

// Re-exported so acquisition keeps one public surface; the definitions are the pure
// policies in `policy/package-spec.ts`.
export {
  RuntimePackageError,
  SUPPORTED_NODE_RANGE,
  parseExactPackageSpec,
  satisfiesNodeRange,
  type ExactPackageSpec,
  type RuntimePackageErrorInit,
  type RuntimePackageFailureKind,
} from "../policy/package-spec.js";

// --- npm CLI location -------------------------------------------------------------------

/** Retained characters of each npm stream (the tail is what failures report). */
const STDERR_TAIL_CHARACTERS = 4_000;

/** Bounded npm stream tail (kept as a local alias of the shared helper). */
function tail(value: string, max = STDERR_TAIL_CHARACTERS): string {
  return tailShared(value, max);
}

/** Returns the first existing npm CLI, or `null` when none of the candidates exist. */
export function findNpmCli(env: NodeJS.ProcessEnv = process.env): NpmCliResolution | null {
  try {
    return resolveNpmCli(env);
  } catch {
    return null;
  }
}

/** Resolves the npm CLI or throws with the exact list of probed locations. */
export function resolveNpmCli(env: NodeJS.ProcessEnv = process.env): NpmCliResolution {
  const candidates = npmCliCandidates(env);
  const override = candidates[0];
  if (override !== undefined && override.source === "DSH_MCP_NPM_CLI") {
    if (!isAbsolute(override.path)) {
      throw new RuntimePackageError("npm-cli-missing", `DSH_MCP_NPM_CLI must be an absolute path to npm-cli.js, received ${JSON.stringify(override.path)}.`, {
        hint: "Point it at the real js entry, for example <node>\\node_modules\\npm\\bin\\npm-cli.js — not at npm.cmd, which needs a shell.",
      });
    }
    if (!existsSync(override.path)) {
      throw new RuntimePackageError("npm-cli-missing", `DSH_MCP_NPM_CLI does not exist: ${override.path}`, {
        hint: "Fix the path or unset DSH_MCP_NPM_CLI so it is derived from process.execPath.",
      });
    }
    return override;
  }
  const found = candidates.find((candidate) => existsSync(candidate.path));
  if (found !== undefined) return found;
  throw new RuntimePackageError(
    "npm-cli-missing",
    `Could not locate npm-cli.js. Probed: ${candidates.map((candidate) => candidate.path).join(", ")}`,
    { hint: "Set DSH_MCP_NPM_CLI to the absolute path of npm-cli.js, or install npm next to the running Node." },
  );
}

/** Throws unless the running Node satisfies {@link SUPPORTED_NODE_RANGE}. */
export function assertSupportedNode(version: string = process.versions.node): void {
  if (satisfiesNodeRange(version)) return;
  throw new RuntimePackageError(
    "unsupported-node",
    `Node ${version} is outside the supported range ${SUPPORTED_NODE_RANGE}.`,
    { hint: `Install a supported Node (${SUPPORTED_NODE_RANGE}) and restart the MCP server.` },
  );
}

// --- layout and installed-tree inspection -----------------------------------------------

/** Filesystem layout of one pinned runtime package version. */
export interface RuntimeLayout {
  readonly name: string;
  readonly version: string;
  /** `<dataDir>/versions/<version>` — also the npm prefix used for the install. */
  readonly root: string;
  /** `<root>/node_modules/<name>`. */
  readonly packageDir: string;
  /** Conventional entry point; verified against `package.json#bin` before use. */
  readonly binPath: string;
}

/** Resolves the deterministic version-directory layout for an exact spec (no disk access). */
export function resolveRuntimeLayout(dataDir: string, spec: string): RuntimeLayout {
  const parsed = parseExactPackageSpec(spec);
  const root = join(resolve(dataDir), "versions", parsed.version);
  const packageDir = join(root, "node_modules", ...parsed.name.split("/"));
  return {
    name: parsed.name,
    version: parsed.version,
    root,
    packageDir,
    // ADR-0002/P1: the package declares `bin: {dsh: "lib/bin.js"}`; the `.bin/dsh.cmd`
    // shim needs a shell and `.bin/dsh` is a POSIX shim, so the real entry is resolved
    // from `package.json#bin` and then verified to exist.
    binPath: join(packageDir, "lib", "bin.js"),
  };
}

/** Result of inspecting one version directory. */
export type InstalledInspection =
  | { readonly ok: true; readonly value: InstalledRuntimePackage }
  | {
      readonly ok: false;
      readonly reason: "not-installed" | "version-mismatch" | "bin-missing";
      readonly detail: string;
    };

/** An installed, verified runtime package. */
export interface InstalledRuntimePackage {
  readonly name: string;
  readonly version: string;
  readonly root: string;
  readonly packageDir: string;
  readonly binPath: string;
}

function declaredBin(bin: unknown, packageName: string): string | null {
  if (typeof bin === "string") return bin;
  if (typeof bin !== "object" || bin === null) return null;
  const record = bin as Record<string, unknown>;
  const unscoped = packageName.startsWith("@") ? packageName.slice(packageName.indexOf("/") + 1) : packageName;
  const candidates = [record[unscoped], record[packageName], ...Object.values(record)];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return null;
}

/**
 * Verifies a version directory: `package.json#version` must match the directory name (and
 * therefore the requested spec), and the resolved `bin` entry must exist on disk.
 */
export function inspectInstalledRuntime(layout: RuntimeLayout): InstalledInspection {
  const manifestPath = join(layout.packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, reason: "not-installed", detail: `${manifestPath} is missing` };
  }
  let manifest: { version?: unknown; bin?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown; bin?: unknown };
  } catch (error) {
    return {
      ok: false,
      reason: "not-installed",
      detail: `${manifestPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (manifest.version !== layout.version) {
    return {
      ok: false,
      reason: "version-mismatch",
      detail: `${manifestPath} declares version ${JSON.stringify(manifest.version)} but ${layout.version} is required`,
    };
  }
  const binRelative = declaredBin(manifest.bin, layout.name);
  if (binRelative === null) {
    return { ok: false, reason: "bin-missing", detail: `${manifestPath} does not declare a "bin" entry` };
  }
  const binPath = resolve(layout.packageDir, binRelative);
  if (!existsSync(binPath)) {
    return { ok: false, reason: "bin-missing", detail: `${binPath} (from ${manifestPath}#bin) does not exist` };
  }
  return {
    ok: true,
    value: {
      name: layout.name,
      version: layout.version,
      root: layout.root,
      packageDir: layout.packageDir,
      binPath,
    },
  };
}

/**
 * Best-effort recursive size of an installed tree (used by `doctor`).
 *
 * The entry limit is only a runaway guard: a full 0.2.1 tree is ~27.6k files / 486 MB, so a
 * limit below that would silently under-report the disk cost of a version directory.
 */
export function directorySizeSync(root: string, limit = 200_000): number {
  let total = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length > 0 && visited < limit) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > limit) break;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // A file that disappears mid-walk is not a diagnostic failure.
        }
      }
    }
  }
  return total;
}

// --- npm install ------------------------------------------------------------------------

/** Injectable process spawner; the default is `node:child_process#spawn`. */
export type NpmSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Maps raw npm output to one of the documented failure classes. */
export function classifyNpmFailure(text: string): RuntimePackageFailureKind {
  if (/npm error code ETARGET|notarget|No matching version found/u.test(text)) return "version-not-found";
  if (/npm error code E404|404 Not Found|is not in this registry/u.test(text)) return "version-not-found";
  if (/ENOTCACHED|cache mode is 'only-if-cached'/u.test(text)) return "offline-or-cache-missing";
  return "network";
}

function hintFor(kind: RuntimePackageFailureKind, spec: string, npmCli: string): string {
  switch (kind) {
    case "version-not-found":
      return `The requested version does not exist on the registry. Check DSH_MCP_HARNESS_PACKAGE against: node ${npmCli} view ${spec.split("@").slice(0, -1).join("@") || spec} versions`;
    case "offline-or-cache-missing":
      return `npm has no cached copy of ${spec}. Connect to the network once, or pre-warm the cache with: node ${npmCli} cache add ${spec} (offline reuse works as soon as the version directory exists).`;
    case "install-timeout":
      return "The install made no progress before the install budget elapsed. Check network/proxy settings, then retry or pre-install the runtime package.";
    default:
      return "Transient registry/network failure. Verify connectivity or configure a registry mirror (npm_config_registry), then retry.";
  }
}

export interface NpmInstallRequest {
  npmCli: string;
  prefix: string;
  spec: string;
  timeoutMs: number;
  onProgress: (line: string) => void;
  spawnImpl: NpmSpawn;
  now: () => number;
}

function emitLines(chunk: string, emit: (line: string) => void): void {
  for (const line of chunk.split(/\r?\n/u)) {
    if (line.trim() !== "") emit(line);
  }
}

async function runNpmInstallOnce(request: NpmInstallRequest): Promise<void> {
  const args = [
    request.npmCli,
    "install",
    "--prefix",
    request.prefix,
    "--no-save",
    "--no-audit",
    "--no-fund",
    request.spec,
  ];
  let child: ChildProcess;
  try {
    child = request.spawnImpl(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_progress: "false",
        npm_config_update_notifier: "false",
      },
    });
  } catch (error) {
    throw new RuntimePackageError("unknown", `Could not start npm (${process.execPath} ${request.npmCli}): ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  // The install budget resets on every line of npm output: a slow download is progress,
  // a silent hang is not.
  let lastActivityAt = request.now();
  const tick = Math.max(50, Math.min(1_000, Math.floor(request.timeoutMs / 10)));
  const timer = setInterval(() => {
    if (request.now() - lastActivityAt < request.timeoutMs) return;
    timedOut = true;
    child.kill();
  }, tick);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = tail(`${stdout}${chunk}`);
    lastActivityAt = request.now();
    emitLines(chunk, request.onProgress);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = tail(`${stderr}${chunk}`);
    lastActivityAt = request.now();
    emitLines(chunk, request.onProgress);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => clearInterval(timer));

  if (timedOut) {
    throw new RuntimePackageError(
      "install-timeout",
      `npm install ${request.spec} produced no output for ${request.timeoutMs}ms (install budget exhausted).`,
      { stderrTail: stderr, stdoutTail: stdout, hint: hintFor("install-timeout", request.spec, request.npmCli) },
    );
  }
  if (exit.code !== 0) {
    const combined = `${stderr}\n${stdout}`;
    const kind = classifyNpmFailure(combined);
    throw new RuntimePackageError(
      kind,
      `npm install ${request.spec} failed with exit code ${String(exit.code)} (signal ${String(exit.signal)}): ${kind}`,
      { stderrTail: stderr, stdoutTail: stdout, hint: hintFor(kind, request.spec, request.npmCli) },
    );
  }
}

/** Runs the install, retrying once for transient `network` failures (P7). */
async function runNpmInstall(request: NpmInstallRequest): Promise<void> {
  try {
    await runNpmInstallOnce(request);
  } catch (error) {
    if (error instanceof RuntimePackageError && error.kind === "network") {
      request.onProgress("[runtime-package] transient install failure; retrying once");
      await runNpmInstallOnce(request);
      return;
    }
    throw error;
  }
}

// --- install lock -----------------------------------------------------------------------

interface LockRecord {
  pid: number;
  startedAt: number;
  host: string;
}

type LockOutcome =
  | { readonly kind: "acquired"; readonly release: () => Promise<void> }
  | { readonly kind: "installed-elsewhere" };

// `isProcessAlive` / `readProcessIdentity` come from `service/process-tree.ts` (P0-1): process
// liveness and identity have exactly one implementation, shared by the orphan reclaimer and
// the prune below. Do not re-declare local variants.

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number" || typeof parsed.host !== "string") {
      return null;
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt, host: parsed.host };
  } catch {
    return null;
  }
}

/**
 * Serializes installs through `<dataDir>/versions/.install.lock`.
 *
 * A live holder is waited on (and the installed state re-checked while waiting); a lock
 * whose owner is gone, or that is older than `staleMs`, is broken with a warning so a
 * crashed installer cannot wedge every later start.
 */
async function acquireInstallLock(
  lockPath: string,
  settings: {
    now: () => number;
    pollMs: number;
    timeoutMs: number;
    staleMs: number;
    onProgress: (line: string) => void;
    isInstalled: () => boolean;
  },
): Promise<LockOutcome> {
  const deadline = settings.now() + settings.timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      const record: LockRecord = { pid: process.pid, startedAt: settings.now(), host: hostname() };
      await handle.writeFile(JSON.stringify(record), "utf8");
      return {
        kind: "acquired",
        release: async () => {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readLockRecord(lockPath);
    const age = existing === null ? Number.POSITIVE_INFINITY : settings.now() - existing.startedAt;
    const alive = existing !== null && existing.host === hostname() && isProcessAlive(existing.pid);
    if (!alive || age > settings.staleMs) {
      settings.onProgress(
        `[runtime-package] breaking stale install lock ${lockPath} (${existing === null ? "unreadable" : `pid ${String(existing.pid)}, age ${String(Math.round(age))}ms`})`,
      );
      await rm(lockPath, { force: true }).catch(() => undefined);
      continue;
    }
    if (settings.now() > deadline) {
      throw new RuntimePackageError(
        "lock-timeout",
        `Another process (pid ${String(existing.pid)}) is installing the Harness runtime and did not finish within ${String(settings.timeoutMs)}ms.`,
        { hint: `Wait for it to finish, or delete ${lockPath} if that process is gone.` },
      );
    }
    if (settings.isInstalled()) return { kind: "installed-elsewhere" };
    await delay(settings.pollMs);
  }
}

// --- ensureRuntimePackage ---------------------------------------------------------------

/** Inputs for {@link ensureRuntimePackage}. */
export interface EnsureRuntimeOptions {
  /** Data directory; the runtime lives under `<dataDir>/versions/<version>/`. */
  readonly dataDir: string;
  /** Exact npm spec, e.g. `@deepseek-ai/dsh@0.2.1-alpha.1`. */
  readonly spec: string;
  /** Absolute path to `npm-cli.js`, executed as `node <npmCli> install ...`. */
  readonly npmCli: string;
  /** One-off install budget (never part of the startup budget). */
  readonly timeoutMs: number;
  readonly onProgress?: (line: string) => void;
  readonly spawnImpl?: NpmSpawn;
  readonly now?: () => number;
  readonly lockPollMs?: number;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
  /**
   * Seams for the prune that runs after a successful install (P0-4). Product code passes none;
   * the suite injects the OS interactions (liveness, identity, removal) through them.
   */
  readonly prune?: EnsurePruneOverrides;
}

/** Resolution result of {@link ensureRuntimePackage}. */
export interface EnsuredRuntimePackage extends InstalledRuntimePackage {
  /** True only when this call performed the install. */
  readonly installedNow: boolean;
  /** Outcome of the prune that followed this install (P0-4). */
  readonly prune?: PruneVersionsResult;
}

/**
 * Guarantees that `<dataDir>/versions/<version>/` holds a complete, runnable runtime.
 *
 * Already-installed trees are returned without invoking npm at all (offline reuse). A
 * missing tree is installed into `<dataDir>/versions/.tmp-<rand>` and atomically renamed
 * into place; concurrent callers serialize on `.install.lock`.
 */
export async function ensureRuntimePackage(options: EnsureRuntimeOptions): Promise<EnsuredRuntimePackage> {
  const onProgress = options.onProgress ?? ((): void => undefined);
  const now = options.now ?? Date.now;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const lockPollMs = options.lockPollMs ?? 200;
  const lockTimeoutMs = options.lockTimeoutMs ?? Math.max(options.timeoutMs, 60_000);
  const staleLockMs = options.staleLockMs ?? Math.max(options.timeoutMs, 900_000);

  assertSupportedNode();
  const layout = resolveRuntimeLayout(options.dataDir, options.spec);

  const installed = inspectInstalledRuntime(layout);
  if (installed.ok) return { ...installed.value, installedNow: false };

  await mkdir(join(resolve(options.dataDir), "versions"), { recursive: true });
  const lockPath = join(resolve(options.dataDir), "versions", ".install.lock");

  const lock = await acquireInstallLock(lockPath, {
    now,
    pollMs: lockPollMs,
    timeoutMs: lockTimeoutMs,
    staleMs: staleLockMs,
    onProgress,
    isInstalled: () => inspectInstalledRuntime(layout).ok,
  });

  if (lock.kind === "installed-elsewhere") {
    const concurrent = inspectInstalledRuntime(layout);
    if (concurrent.ok) return { ...concurrent.value, installedNow: false };
    throw new RuntimePackageError("unknown", `Concurrent install reported success but ${layout.root} is not installed.`);
  }

  try {
    // Re-check under the lock: the previous holder may have installed while we waited.
    const rechecked = inspectInstalledRuntime(layout);
    if (rechecked.ok) return { ...rechecked.value, installedNow: false };

    const temporaryPrefix = join(resolve(options.dataDir), "versions", `.tmp-${randomBytes(6).toString("hex")}`);
    await mkdir(temporaryPrefix, { recursive: true });
    try {
      onProgress(`[runtime-package] installing ${options.spec} into ${temporaryPrefix}`);
      await runNpmInstall({
        npmCli: options.npmCli,
        prefix: temporaryPrefix,
        spec: options.spec,
        timeoutMs: options.timeoutMs,
        onProgress,
        spawnImpl,
        now,
      });

      const stagedLayout: RuntimeLayout = {
        ...layout,
        root: temporaryPrefix,
        packageDir: join(temporaryPrefix, "node_modules", ...layout.name.split("/")),
      };
      const staged = inspectInstalledRuntime(stagedLayout);
      if (!staged.ok) {
        throw new RuntimePackageError(
          staged.reason === "version-mismatch" ? "version-mismatch" : "bin-missing",
          `npm reported success but the installed tree is unusable: ${staged.detail}`,
          { hint: "Delete the version directory and retry the install; the registry copy may be corrupt." },
        );
      }

      try {
        await rename(temporaryPrefix, layout.root);
      } catch (error) {
        const winner = inspectInstalledRuntime(layout);
        if (winner.ok) {
          // Windows cannot rename onto an existing directory; losing the race is success.
          onProgress(`[runtime-package] another process installed ${layout.version} first; discarding ${temporaryPrefix}`);
        } else {
          // The target is a stale/unusable directory (wrong version, missing bin). We hold
          // the install lock, so nobody else can be mid-rename: replace it.
          onProgress(`[runtime-package] replacing unusable ${layout.root}: ${winner.detail}`);
          await rm(layout.root, { recursive: true, force: true });
          try {
            await rename(temporaryPrefix, layout.root);
          } catch (retryError) {
            throw new RuntimePackageError(
              "unknown",
              `Could not promote ${temporaryPrefix} to ${layout.root}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
              { cause: retryError },
            );
          }
        }
      }

      const promoted = inspectInstalledRuntime(layout);
      if (!promoted.ok) {
        throw new RuntimePackageError("unknown", `Promoted tree is unusable: ${promoted.detail}`);
      }
      // P0-4: reclaim the version directories that are provably unused, while we still hold the
      // install lock. Prune never fails the install: every error and every doubt is reported in
      // the result (`ran:false` / `skipped`) instead of being raised.
      const prune = await pruneAfterInstall({
        dataDir: options.dataDir,
        spec: options.spec,
        now,
        onProgress,
        ...(options.prune === undefined ? {} : { overrides: options.prune }),
      });
      return { ...promoted.value, installedNow: true, prune };
    } finally {
      await rm(temporaryPrefix, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await lock.release();
  }
}

// --- version directory prune (P0-4) -------------------------------------------------------

// Every DSH version costs ~486 MB (`versions/<version>/`), and old versions plus interrupted
// staging directories used to accumulate forever (`doctor` only reported the size). Pruning is
// deliberately hard to get wrong:
//
//   * it only ever runs while *this* process holds `<versions>/.install.lock` (no waiting, no
//     stealing: if the lock is not ours the whole run is skipped with a reason);
//   * the current pin is never a candidate;
//   * a version is deleted only when we can prove no service is using it: the per-service pidfile
//     (`<dataDir>/services/<key>/dsh.pid`, written by `service/launch.ts`/`supervisor.ts` before
//     the child is usable) names the version and its OS-reported command line. A pidfile whose
//     recorded process is alive — even when its identity cannot be verified — keeps the version;
//   * evidence we cannot read or interpret (unreadable `services/`, malformed pidfile, pidfile
//     that does not describe this data directory) fails *every* version deletion closed;
//   * a platform that refuses the delete (`EBUSY`/`EPERM` on Windows) is reported as `skipped`,
//     never retried into a thrown error.
//
// The decision half is pure (`planVersionPrune`) so the fail-closed matrix is unit-testable
// without a filesystem, and the IO half only collects observations and executes the plan.

/** Staging directories are named `.tmp-<random>` and only exist while an install holds the lock. */
const STAGING_DIRECTORY_PREFIX = ".tmp-";

/** Age after which a staging directory is treated as the leftover of a crashed install. */
const DEFAULT_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** `DSH_MCP_PRUNE_VERSIONS` values that disable pruning outright. */
const PRUNE_DISABLED_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

/** Whether the environment wants unused version directories pruned (default: enabled). */
export function pruneEnabledByEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DSH_MCP_PRUNE_VERSIONS?.trim().toLowerCase();
  if (value === undefined || value === "") return true;
  return !PRUNE_DISABLED_VALUES.has(value);
}

/** One directory under `<dataDir>/versions/` that is not a staging directory. */
export interface VersionDirectoryCandidate {
  readonly name: string;
  readonly path: string;
  /** The name parses as an exact version of the pinned package. */
  readonly versionShaped: boolean;
  /** `node_modules` inside the candidate holds a complete install of exactly that version. */
  readonly complete: boolean;
}

/** One staging directory (`.tmp-*`) under `<dataDir>/versions/`. */
export interface StagingDirectoryCandidate {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Usage evidence for one version, read from a service pidfile.
 *
 * `alive` means the recorded process answers as ours (its command line carries the recorded
 * `binPath` plus `--port`); `unverified` means the pid is alive but ownership could not be
 * proven (OS query failed, permissions, recycled pid). Both mean "do not delete".
 */
export interface VersionUsageEvidence {
  readonly version: string;
  readonly path: string;
  readonly pid: number;
  readonly state: "alive" | "unverified";
}

/** Evidence we could not read or interpret. Any entry fails every version deletion closed. */
export interface PruneBlocker {
  readonly path: string;
  readonly reason: string;
}

/** Everything the pure planner needs; collected by {@link pruneRuntimeVersions}. */
export interface VersionPruneObservation {
  readonly pinVersion: string;
  readonly now: number;
  readonly stagingMaxAgeMs: number;
  readonly versionDirs: readonly VersionDirectoryCandidate[];
  readonly stagingDirs: readonly StagingDirectoryCandidate[];
  readonly usage: readonly VersionUsageEvidence[];
  readonly blockers: readonly PruneBlocker[];
}

/** What {@link planVersionPrune} decided. */
export interface VersionPrunePlan {
  readonly removeVersions: readonly { path: string; name: string; reason: string }[];
  readonly removeStaging: readonly { path: string; reason: string }[];
  readonly skipped: readonly { path: string; reason: string }[];
}

/**
 * Decides what may be deleted. Pure: no filesystem, no clock, no process probing.
 *
 * Order of the fail-closed rules (first match wins):
 *   1. any blocker (unreadable/uninterpretable evidence) → no version directory is deleted at
 *      all; age-expired staging directories are still reclaimed because they are unrelated to
 *      service usage and provably orphaned while the install lock is held;
 *   2. the current pin is never deleted;
 *   3. a directory whose name is not an exact version of the pinned package is never deleted;
 *   4. a version named by live (`alive` or `unverified`) usage evidence is never deleted;
 *   5. a directory without a verified complete install is never deleted.
 */
export function planVersionPrune(observation: VersionPruneObservation): VersionPrunePlan {
  const removeStaging: { path: string; reason: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const dir of observation.stagingDirs) {
    if (observation.now - dir.mtimeMs > observation.stagingMaxAgeMs) {
      removeStaging.push({ path: dir.path, reason: "expired-staging" });
    } else {
      skipped.push({ path: dir.path, reason: "recent-staging" });
    }
  }

  if (observation.blockers.length > 0) {
    for (const dir of observation.versionDirs) skipped.push({ path: dir.path, reason: "evidence-unreadable" });
    for (const blocker of observation.blockers) skipped.push({ path: blocker.path, reason: blocker.reason });
    return { removeVersions: [], removeStaging, skipped };
  }

  const removeVersions: { path: string; name: string; reason: string }[] = [];
  for (const dir of observation.versionDirs) {
    if (dir.name === observation.pinVersion) {
      skipped.push({ path: dir.path, reason: "current-pin" });
      continue;
    }
    if (!dir.versionShaped) {
      skipped.push({ path: dir.path, reason: "not-a-version-directory" });
      continue;
    }
    const evidence = observation.usage.filter((entry) => entry.version === dir.name);
    const alive = evidence.find((entry) => entry.state === "alive");
    if (alive !== undefined) {
      skipped.push({ path: dir.path, reason: `in-use:pid ${String(alive.pid)}` });
      continue;
    }
    if (evidence.length > 0) {
      skipped.push({ path: dir.path, reason: "unverified-owner" });
      continue;
    }
    if (!dir.complete) {
      skipped.push({ path: dir.path, reason: "unverified-install" });
      continue;
    }
    removeVersions.push({ path: dir.path, name: dir.name, reason: "idle:complete" });
  }
  return { removeVersions, removeStaging, skipped };
}

/** One entry of {@link PruneVersionsResult.removed}. */
export interface PrunedPath {
  readonly path: string;
  readonly kind: "version" | "staging";
  readonly bytes: number;
}

/** Structured outcome of one prune run (also summarised through the install progress channel). */
export interface PruneVersionsResult {
  /** `false` when the whole run was skipped (disabled, lock not held, nothing to read). */
  readonly ran: boolean;
  /** Why the whole run was skipped; `null` when it ran. */
  readonly reason: string | null;
  readonly removed: readonly PrunedPath[];
  readonly skipped: readonly { path: string; reason: string }[];
  readonly reclaimedBytes: number;
}

/** Inputs of {@link pruneRuntimeVersions}. */
export interface PruneRuntimeVersionsOptions {
  readonly dataDir: string;
  /** Exact pin; its version directory is never a candidate. */
  readonly spec: string;
  /** `true` when the caller already holds `<versions>/.install.lock` (the install path does). */
  readonly lockHeld?: boolean;
  readonly enabled?: boolean;
  readonly now?: () => number;
  /** Age after which `.tmp-*` counts as a leftover (default 24 h). */
  readonly stagingMaxAgeMs?: number;
  readonly isProcessAliveImpl?: (pid: number) => boolean;
  readonly processIdentityImpl?: (pid: number) => string | null;
  /** Deletes one tree; injectable so the `EBUSY`/`EPERM` path is testable off Windows. */
  readonly removeImpl?: (path: string) => Promise<void>;
  readonly sizeImpl?: (path: string) => number;
  readonly platform?: NodeJS.Platform;
  readonly onProgress?: (line: string) => void;
}

/** Human-readable one-liner for the install log (also asserted by the suite). */
export function pruneSummary(result: PruneVersionsResult): string {
  if (!result.ran) return `[runtime-package] prune: skipped (${result.reason ?? "unknown"})`;
  const versions = result.removed.filter((entry) => entry.kind === "version").length;
  const staging = result.removed.length - versions;
  const reasons = new Map<string, number>();
  for (const entry of result.skipped) reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  const detail = [...reasons.entries()].map(([reason, count]) => `${reason} x${String(count)}`).join(", ");
  return `[runtime-package] prune: reclaimed ${formatMegabytes(result.reclaimedBytes)}`
    + ` (${String(versions)} version ${versions === 1 ? "directory" : "directories"}, ${String(staging)} staging)`
    + `; skipped ${String(result.skipped.length)}${detail === "" ? "" : ` (${detail})`}`;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Windows paths are case-insensitive, so equal directories can be spelled two ways. */
function canonicalPath(value: string, platform: NodeJS.Platform): string {
  const slashed = normalize(value).replaceAll("\\", "/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Reads and parses one pidfile, distinguishing "absent" from "unreadable"/"malformed". */
function readServicePidFile(
  path: string,
): { kind: "absent" } | { kind: "blocked"; reason: string } | { kind: "record"; record: PidFileRecord } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "blocked", reason: "pidfile-unreadable" };
  }
  const record = parsePidFile(text);
  if (record === null) return { kind: "blocked", reason: "pidfile-unparseable" };
  return { kind: "record", record };
}

/** Every installed package directory under `<versionRoot>/node_modules`, with its package name. */
function installedPackageDirs(versionRoot: string): { dir: string; name: string }[] {
  const nodeModules = join(versionRoot, "node_modules");
  const found: { dir: string; name: string }[] = [];
  let entries;
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!entry.name.startsWith("@")) {
      found.push({ dir: join(nodeModules, entry.name), name: entry.name });
      continue;
    }
    try {
      for (const scoped of readdirSync(join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          found.push({ dir: join(nodeModules, entry.name, scoped.name), name: `${entry.name}/${scoped.name}` });
        }
      }
    } catch {
      // A scope directory that cannot be listed adds no candidates.
    }
  }
  return found;
}

/**
 * Whether `versions/<name>` holds a complete install of exactly `<name>`.
 *
 * The pinned package is checked first (the normal case). When the directory holds a different
 * package — the operator switched `DSH_MCP_HARNESS_PACKAGE` to a mirror or a fork — any package
 * under `node_modules` whose `package.json#version` equals the directory name counts, so that
 * tree is still recognised as a complete, reclaimable install instead of being kept forever.
 */
function verifyVersionDirectory(versionRoot: string, version: string, packageName: string): boolean {
  const inspect = (packageDir: string, name: string): boolean =>
    inspectInstalledRuntime({ name, version, root: versionRoot, packageDir, binPath: "" }).ok;
  if (inspect(join(versionRoot, "node_modules", ...packageName.split("/")), packageName)) return true;
  return installedPackageDirs(versionRoot).some((entry) => inspect(entry.dir, entry.name));
}

/** Reads the on-disk state one prune run needs; `null` means "nothing installed yet". */
function observePrune(input: {
  dataDir: string;
  versionsDir: string;
  packageName: string;
  pinVersion: string;
  now: number;
  stagingMaxAgeMs: number;
  isProcessAliveImpl: (pid: number) => boolean;
  processIdentityImpl: (pid: number) => string | null;
  platform: NodeJS.Platform;
}): { kind: "empty" } | { kind: "blocked"; reason: string } | { kind: "observation"; observation: VersionPruneObservation } {
  let entries;
  try {
    entries = readdirSync(input.versionsDir, { withFileTypes: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "empty" } : { kind: "blocked", reason: "versions-unreadable" };
  }

  const versionDirs: VersionDirectoryCandidate[] = [];
  const stagingDirs: StagingDirectoryCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(input.versionsDir, entry.name);
    if (entry.name.startsWith(STAGING_DIRECTORY_PREFIX)) {
      let mtimeMs = input.now;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        // A staging directory that vanished mid-walk is not a candidate.
        continue;
      }
      stagingDirs.push({ path, mtimeMs });
      continue;
    }
    if (entry.name.startsWith(".")) continue;
    let versionShaped = false;
    try {
      versionShaped = parseExactPackageSpec(`${input.packageName}@${entry.name}`).version === entry.name;
    } catch {
      versionShaped = false;
    }
    versionDirs.push({
      name: entry.name,
      path,
      versionShaped,
      complete: versionShaped && verifyVersionDirectory(path, entry.name, input.packageName),
    });
  }

  // Usage evidence: the per-service pidfile names the version and the entry it runs.
  const usage: VersionUsageEvidence[] = [];
  const blockers: PruneBlocker[] = [];
  const servicesDir = join(resolve(input.dataDir), "services");
  let serviceHomes: Dirent[];
  try {
    serviceHomes = readdirSync(servicesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { kind: "blocked", reason: "services-unreadable" };
    serviceHomes = [];
  }
  for (const home of serviceHomes) {
    const path = pidFilePath(join(servicesDir, home.name));
    const read = readServicePidFile(path);
    if (read.kind === "absent") continue;
    if (read.kind === "blocked") {
      blockers.push({ path, reason: read.reason });
      continue;
    }
    const { record } = read;
    if (
      canonicalPath(record.serviceHome, input.platform) !== canonicalPath(join(servicesDir, home.name), input.platform)
      || canonicalPath(record.dataDirectory, input.platform) !== canonicalPath(resolve(input.dataDir), input.platform)
    ) {
      blockers.push({ path, reason: "pidfile-foreign" });
      continue;
    }
    const expectedRoot = join(input.versionsDir, record.version);
    // The recorded entry must live inside the version directory it names; anything else is a
    // record we do not understand and must not act on.
    if (!canonicalPath(record.binPath, input.platform).startsWith(`${canonicalPath(expectedRoot, input.platform)}/`)) {
      blockers.push({ path, reason: "pidfile-binpath-mismatch" });
      continue;
    }
    if (!input.isProcessAliveImpl(record.pid)) continue; // stale pidfile: no live service
    const identity = input.processIdentityImpl(record.pid);
    const state = orphanState({
      alive: true,
      owned: identity === null ? null : identityOwnsRecord(identity, record, input.platform),
    });
    if (state === "stale-pidfile") continue;
    usage.push({ version: record.version, path, pid: record.pid, state });
  }

  return {
    kind: "observation",
    observation: {
      pinVersion: input.pinVersion,
      now: input.now,
      stagingMaxAgeMs: input.stagingMaxAgeMs,
      versionDirs,
      stagingDirs,
      usage,
      blockers,
    },
  };
}

/** Whether `.install.lock` says this very process holds the lock. */
async function installLockIsHeld(versionsDir: string): Promise<boolean> {
  const record = await readLockRecord(join(versionsDir, ".install.lock"));
  return record !== null && record.pid === process.pid && record.host === hostname();
}

/**
 * Reclaims version directories that are provably unused plus age-expired staging directories.
 *
 * Fail-closed by construction: without the install lock, without a readable evidence source, or
 * with evidence we cannot interpret, the affected deletions do not happen and the reason is
 * returned. Deletion errors (`EBUSY`/`EPERM` on Windows, permissions) become `skipped` entries.
 */
export async function pruneRuntimeVersions(options: PruneRuntimeVersionsOptions): Promise<PruneVersionsResult> {
  const onProgress = options.onProgress ?? ((): void => undefined);
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const stagingMaxAgeMs = options.stagingMaxAgeMs ?? DEFAULT_STAGING_MAX_AGE_MS;
  const remove = options.removeImpl ?? (async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true, maxRetries: 0 });
  });
  const size = options.sizeImpl ?? ((path: string): number => directorySizeSync(path));

  const skipWholeRun = (reason: string): PruneVersionsResult => {
    const result: PruneVersionsResult = { ran: false, reason, removed: [], skipped: [], reclaimedBytes: 0 };
    onProgress(pruneSummary(result));
    return result;
  };

  if (options.enabled === false) return skipWholeRun("disabled");

  let parsed;
  try {
    parsed = parseExactPackageSpec(options.spec);
  } catch {
    return skipWholeRun("invalid-spec");
  }

  const versionsDir = join(resolve(options.dataDir), "versions");
  if (options.lockHeld !== true && !(await installLockIsHeld(versionsDir))) {
    return skipWholeRun("install-lock-not-held");
  }

  const observed = observePrune({
    dataDir: options.dataDir,
    versionsDir,
    packageName: parsed.name,
    pinVersion: parsed.version,
    now: now(),
    stagingMaxAgeMs,
    isProcessAliveImpl: options.isProcessAliveImpl ?? ((pid: number): boolean => isProcessAlive(pid)),
    processIdentityImpl: options.processIdentityImpl ?? ((pid: number): string | null => readProcessIdentity(pid, platform)),
    platform,
  });
  if (observed.kind === "empty") {
    const result: PruneVersionsResult = { ran: true, reason: null, removed: [], skipped: [], reclaimedBytes: 0 };
    onProgress(pruneSummary(result));
    return result;
  }
  if (observed.kind === "blocked") return skipWholeRun(observed.reason);

  const plan = planVersionPrune(observed.observation);
  const removed: PrunedPath[] = [];
  const skipped: { path: string; reason: string }[] = [...plan.skipped];
  let reclaimedBytes = 0;
  for (const item of plan.removeVersions) {
    try {
      const bytes = size(item.path);
      await remove(item.path);
      removed.push({ path: item.path, kind: "version", bytes });
      reclaimedBytes += bytes;
    } catch (error) {
      skipped.push({ path: item.path, reason: `remove-failed:${errorCode(error) ?? "unknown"}` });
    }
  }
  for (const item of plan.removeStaging) {
    try {
      const bytes = size(item.path);
      await remove(item.path);
      removed.push({ path: item.path, kind: "staging", bytes });
      reclaimedBytes += bytes;
    } catch (error) {
      skipped.push({ path: item.path, reason: `remove-failed:${errorCode(error) ?? "unknown"}` });
    }
  }

  const result: PruneVersionsResult = { ran: true, reason: null, removed, skipped, reclaimedBytes };
  onProgress(pruneSummary(result));
  return result;
}

/** Prune seams the install path forwards (tests inject the OS interactions through these). */
export interface EnsurePruneOverrides {
  readonly enabled?: boolean;
  readonly stagingMaxAgeMs?: number;
  readonly isProcessAliveImpl?: (pid: number) => boolean;
  readonly processIdentityImpl?: (pid: number) => string | null;
  readonly removeImpl?: (path: string) => Promise<void>;
  readonly sizeImpl?: (path: string) => number;
  readonly platform?: NodeJS.Platform;
}

/** Runs the prune for one successful install, never letting a prune problem fail the install. */
async function pruneAfterInstall(input: {
  dataDir: string;
  spec: string;
  now: () => number;
  onProgress: (line: string) => void;
  overrides?: EnsurePruneOverrides;
}): Promise<PruneVersionsResult> {
  const overrides = input.overrides ?? {};
  try {
    return await pruneRuntimeVersions({
      ...overrides,
      dataDir: input.dataDir,
      spec: input.spec,
      lockHeld: true,
      now: input.now,
      onProgress: input.onProgress,
      enabled: overrides.enabled ?? pruneEnabledByEnvironment(),
    });
  } catch (error) {
    const reason = `prune-failed:${error instanceof Error ? error.message : String(error)}`;
    const result: PruneVersionsResult = { ran: false, reason, removed: [], skipped: [], reclaimedBytes: 0 };
    input.onProgress(pruneSummary(result));
    return result;
  }
}
