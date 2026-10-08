// The service supervisor: lifecycle of every local Harness Web process this MCP server owns.
//
// One instance per MCP process. It is the single writer of service state:
//
//   idle ──start()──> starting ──ready──> running ──stop()/crash──> stopped
//                       │                    │
//                       └──fail(cause)──────> failed(cause)
//
// `stop()` is idempotent and every branch converges `status`/`stoppedAt` and releases the
// workspace index — including the "process already exited" early branch. When the exit
// cannot be confirmed the snapshot says `stopUnconfirmed: true` instead of lying.
//
// Two ownership rules keep this layer free of hidden side effects. It never resolves the data
// directory itself (see {@link SupervisorOptions.dataDirectory}), and it never creates the
// per-workspace service home: only the real spawn path in `service/launch.ts` does, so a
// caller that injects `spawnProcess` observes zero filesystem writes.

import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_FORCE_STOP_GRACE_MS, DEFAULT_POLL_INTERVAL_MS, DEFAULT_READINESS_POLL_MS, DEFAULT_STOP_GRACE_MS, resolveAllowedRoots, resolveHarnessPackage, resolveInstallTimeoutMs, resolveStartupTimeoutMs } from "../config/resolve.js";
import { dataLocationProblems, samePath } from "../policy/paths.js";
import {
  identityOwnsRecord,
  orphanState,
  parsePidFile,
  pidFilePath,
  serializePidFile,
  type OrphanReport,
  type PidFileRecord,
} from "../policy/orphans.js";
import { resolveWorkspace } from "../policy/workspace.js";
import { appendBounded, delay, errorText } from "../util/errors.js";
import { workspaceKey } from "../util/ids.js";
import { ensureRuntimePackage, RuntimePackageError, type EnsuredRuntimePackage } from "./runtime-package.js";
import { resolveNpmCli } from "./npm-cli.js";
import { hasExited, isProcessAlive, readProcessIdentity, reapProcessTree, reapProcessTreeByPid, waitForExit } from "./process-tree.js";
import { ReadinessWatcher, startupFailureMessage, type StartupFailureCause } from "./readiness.js";
import { buildHarnessLaunch, spawnHarness, type HarnessLaunch } from "./launch.js";
import { openInDefaultBrowser } from "./browser.js";
import { redactFailure, registerLaunchUrl } from "./credentials.js";
import { DshClient } from "../dsh/client.js";
import type { ServiceSnapshot, ServiceStatus, StartServiceInput } from "./types.js";

/** Inputs `ServiceSupervisor` passes to runtime-package acquisition. */
export interface EnsureRuntimeInput {
  dataDir: string;
  spec: string;
  timeoutMs: number;
  onProgress: (line: string) => void;
}

/** Seam for resolving/installing the runtime package (tests inject a fake). */
export type EnsureRuntimeImpl = (input: EnsureRuntimeInput) => Promise<EnsuredRuntimePackage>;

/** Options for replacing process, browser, and runtime acquisition in tests. */
export interface SupervisorOptions {
  /**
   * Root of the persistent service state. Required on purpose: this layer must never derive
   * it from the environment, because a missing value would silently target the user's real
   * home directory. Only `app/container.ts` resolves it (from `config/resolve.ts`).
   */
  dataDirectory: string;
  allowedRoots?: string[];
  /** Startup budget: maximum silence between child outputs (activity resets it). */
  startupTimeoutMs?: number;
  /** One-off runtime-package install budget, independent of startup. */
  installTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Grace period between the graceful kill and the platform tree kill. */
  stopGraceMs?: number;
  /** Extra wait after the platform tree kill before declaring the exit unconfirmed. */
  forceStopGraceMs?: number;
  harnessPackage?: string;
  npmCli?: string;
  ensureRuntime?: EnsureRuntimeImpl;
  spawnProcess?: (launch: HarnessLaunch) => ChildProcess;
  /** Extra environment merged into the harness child (tests and callers). */
  launchEnv?: NodeJS.ProcessEnv;
  openBrowser?: (url: string) => Promise<void>;
  /**
   * The OS-reported command line of one pid, or `null` when it cannot be established (P0-1).
   * `null` must never be treated as ownership: orphan reclamation is fail-closed.
   */
  processIdentity?: (pid: number) => string | null;
  /** Resolves `true` while a loopback port still accepts connections (P0-1 self-healing). */
  portProbe?: (port: number) => Promise<boolean>;
  /** Overrides the home directory the P0-5 safety check compares against (tests). */
  homeDirectory?: string;
  /** Reaps one child's tree (defaults to `process-tree.ts`); a seam so tests never signal pids. */
  reapProcessTree?: (child: ChildProcess) => Promise<void>;
  /** Reaps one recorded pid's tree (orphan reclamation); seam for the same reason. */
  reapOrphan?: (pid: number) => Promise<void>;
  /** Liveness probe for a recorded pid (defaults to `kill(pid, 0)` semantics). */
  isAlive?: (pid: number) => boolean;
}

/** Internal service record (never returned to callers; `snapshot()` projects it). */
export interface ServiceRecord {
  serviceId: string;
  workspace: string;
  /** Per-workspace `DSH_HOME`, `<dataDirectory>/services/<key>`. */
  serviceHome: string;
  /** Bound port once ready (from the launch URL); `null` while starting. */
  port: number | null;
  /** Resolved runtime entry (`lib/bin.js`), the identity anchor of the pidfile. */
  binPath: string | null;
  /** The outcome of the startup reconciliation against a previous pidfile, if there was one. */
  orphan: OrphanReport | null;
  status: ServiceStatus;
  webUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  stopUnconfirmed: boolean;
  child: ChildProcess | null;
  watcher: ReadinessWatcher | null;
  runtimeRoot: string | null;
  npmStderrTail: string | null;
  /** Live credential slots shared with the session's {@link DshClient}. */
  credentials: { webUrl: string; cookie?: string | null; pending?: Promise<string> | null };
  client: DshClient | null;
}

/** What the run layer is allowed to see of one service. */
export interface ServiceAccess {
  readonly record: ServiceRecord;
  readonly client: DshClient;
  /** True while the service is the one currently serving its workspace. */
  readonly running: boolean;
}

/** Owns the local Harness Web services of one MCP server process. */
export class ServiceSupervisor {
  private readonly services = new Map<string, ServiceRecord>();
  private readonly serviceByWorkspace = new Map<string, string>();
  private readonly starts = new Map<string, Promise<ServiceRecord>>();
  private readonly dataDirectory: string;
  private readonly allowedRoots: string[];
  private readonly startupTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopGraceMs: number;
  private readonly forceStopGraceMs: number;
  private readonly harnessPackage: string;
  private readonly npmCliOverride: string | undefined;
  private readonly ensureRuntimeImpl: EnsureRuntimeImpl;
  private readonly spawnProcess: NonNullable<SupervisorOptions["spawnProcess"]>;
  private readonly launchEnv: NodeJS.ProcessEnv | undefined;
  private readonly openBrowserImpl: NonNullable<SupervisorOptions["openBrowser"]>;
  private readonly processIdentity: (pid: number) => string | null;
  private readonly portProbe: (port: number) => Promise<boolean>;
  private readonly homeDirectory: string;
  private readonly reapImpl: (child: ChildProcess) => Promise<void>;
  private readonly reapOrphanImpl: (pid: number) => Promise<void>;
  private readonly isAlive: (pid: number) => boolean;

  public constructor(options: SupervisorOptions) {
    this.dataDirectory = join(options.dataDirectory, "");
    this.allowedRoots = (options.allowedRoots ?? resolveAllowedRoots()).map((root) => join(root, ""));
    this.startupTimeoutMs = options.startupTimeoutMs ?? resolveStartupTimeoutMs();
    this.installTimeoutMs = options.installTimeoutMs ?? resolveInstallTimeoutMs();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.forceStopGraceMs = options.forceStopGraceMs ?? DEFAULT_FORCE_STOP_GRACE_MS;
    this.harnessPackage = options.harnessPackage ?? resolveHarnessPackage();
    this.npmCliOverride = options.npmCli;
    this.ensureRuntimeImpl = options.ensureRuntime ?? (async (input) => await ensureRuntimePackage({
      dataDir: input.dataDir,
      spec: input.spec,
      npmCli: this.npmCliOverride ?? resolveNpmCli().path,
      timeoutMs: input.timeoutMs,
      onProgress: input.onProgress,
    }));
    this.spawnProcess = options.spawnProcess ?? spawnHarness;
    this.launchEnv = options.launchEnv;
    this.openBrowserImpl = options.openBrowser ?? openInDefaultBrowser;
    this.processIdentity = options.processIdentity ?? ((pid) => readProcessIdentity(pid));
    this.portProbe = options.portProbe ?? defaultPortProbe;
    this.homeDirectory = options.homeDirectory ?? homedir();
    this.reapImpl = options.reapProcessTree ?? (async (child) => await reapProcessTree(child));
    this.reapOrphanImpl = options.reapOrphan ?? (async (pid) => await reapProcessTreeByPid(pid));
    this.isAlive = options.isAlive ?? ((pid) => isProcessAlive(pid));
  }

  /** Starts or reuses the Harness Web service for an absolute workspace. */
  public async start(input: StartServiceInput): Promise<ServiceSnapshot> {
    const workspace = await resolveWorkspace(input.workspace, this.allowedRoots);
    let service = this.serviceForWorkspace(workspace);
    if (service === undefined) {
      const pending = this.starts.get(workspace) ?? this.launchService(workspace);
      this.starts.set(workspace, pending);
      try {
        service = await pending;
      } finally {
        this.starts.delete(workspace);
      }
    }
    if ((input.openBrowser ?? false) && service.webUrl !== null) {
      try {
        await this.openBrowserImpl(service.webUrl);
        service.browserOpened = true;
        service.browserError = null;
      } catch (error) {
        // The browser command carries the login URL; the raw error would carry the token.
        service.browserError = redactFailure(error);
      }
    }
    return this.snapshot(service);
  }

  /** Opens an already running service in the user's default browser. */
  public async open(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.require(serviceId);
    if (service.status !== "running" || service.webUrl === null) throw new Error("Harness Web service is not running.");
    await this.openBrowserImpl(service.webUrl);
    service.browserOpened = true;
    service.browserError = null;
    return this.snapshot(service);
  }

  /** Lists services owned by the current MCP server. */
  public list(): ServiceSnapshot[] {
    return [...this.services.values()].map((service) => this.snapshot(service));
  }

  /**
   * The data directory every service home lives under.
   *
   * Read by the run journal (R3-3): per-run records live in
   * `<dataDirectory>/services/<key>/runs/<runId>.json`, so a later MCP process must be able to
   * find them without being handed the path twice.
   */
  public getDataDirectory(): string {
    return this.dataDirectory;
  }

  /** The per-workspace service home of a known service (the journal's root, R3-3). */
  public serviceHomeOf(serviceId: string): string | null {
    return this.services.get(serviceId)?.serviceHome ?? null;
  }

  /** Every service home this process knows about (one per workspace it served). */
  public serviceHomes(): string[] {
    return [...new Set([...this.services.values()].map((service) => service.serviceHome))];
  }

  /** The live, running service for a workspace, or `null` when this process has none. */
  public runningServiceForWorkspace(workspace: string): ServiceRecord | null {
    for (const service of this.services.values()) {
      if (service.status === "running" && samePath(service.workspace, workspace)) return service;
    }
    return null;
  }

  /** Stops one Web service. Idempotent: every state converges. */
  public async stop(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.require(serviceId);
    await this.terminate(service);
    return this.snapshot(service);
  }

  /** Stops every owned Web service before the MCP server exits. */
  public async dispose(): Promise<void> {
    await Promise.all([...this.services.values()].map(async (service) => await this.terminate(service)));
  }

  /** Resolves one service id to its record plus its RPC client (run-layer accessor). */
  public access(serviceId: string): ServiceAccess {
    const record = this.require(serviceId);
    return { record, client: this.dshClient(record), running: record.status === "running" };
  }

  /** Resolves one service id or throws the caller-facing error. */
  public require(serviceId: string): ServiceRecord {
    const service = this.services.get(serviceId);
    if (service === undefined) throw new Error(`Unknown serviceId: ${serviceId}`);
    return service;
  }

  /** The service currently serving a workspace, or `undefined` when it is not running. */
  public serviceForWorkspace(workspace: string): ServiceRecord | undefined {
    const id = this.serviceByWorkspace.get(workspace);
    const service = id === undefined ? undefined : this.services.get(id);
    return service?.status === "running" ? service : undefined;
  }

  /** The RPC surface of one service, as a thin adapter over `dsh/client.ts`. */
  private dshClient(service: ServiceRecord): DshClient {
    service.client ??= new DshClient({ serviceId: service.serviceId, credentialSlots: service.credentials });
    if (service.credentials.webUrl !== (service.webUrl ?? "")) service.credentials.webUrl = service.webUrl ?? "";
    return service.client;
  }

  private async launchService(workspace: string): Promise<ServiceRecord> {
    const serviceId = randomUUID();
    // The per-workspace service home is only *named* here. Creating it is the real spawn
    // path's job (`service/launch.ts`), so an injected spawn seam stays filesystem-free.
    const serviceHome = serviceHomeFor(this.dataDirectory, workspace);
    const service: ServiceRecord = {
      serviceId,
      workspace,
      serviceHome,
      port: null,
      binPath: null,
      orphan: null,
      status: "starting",
      webUrl: null,
      browserOpened: false,
      browserError: null,
      startedAt: new Date(),
      stoppedAt: null,
      stopUnconfirmed: false,
      child: null,
      watcher: null,
      runtimeRoot: null,
      npmStderrTail: null,
      credentials: { webUrl: "", cookie: null, pending: null },
      client: null,
    };
    this.services.set(serviceId, service);
    this.serviceByWorkspace.set(workspace, serviceId);
    try {
      // P0-5, fail-closed: refuse an unsafe data location *before* any filesystem write. This
      // also covers injected spawn seams, which bypass `launch.ts#spawnHarness`.
      const unsafe = dataLocationProblems({
        dataDirectory: this.dataDirectory,
        serviceHome,
        home: this.homeDirectory,
      });
      if (unsafe.length > 0) {
        throw new Error(["refusing to start the Harness with an unsafe data location", ...unsafe].join("\n"));
      }
      // P0-1: reconcile against the pidfile a previous (possibly killed) run left behind. This
      // runs before the install so a reclaimed orphan frees its port early.
      service.orphan = await this.reclaimOrphan(serviceHome);
      // Phase 1: acquire the runtime (one-off install, independent budget, never part of
      // the readiness budget). Phase 2: start the resolved entry directly.
      const ensured = await this.ensureRuntimeImpl({
        dataDir: this.dataDirectory,
        spec: this.harnessPackage,
        timeoutMs: this.installTimeoutMs,
        onProgress: (line) => this.onInstallProgress(service, line),
      });
      service.runtimeRoot = ensured.root;
      service.binPath = ensured.binPath;
      const launch = buildHarnessLaunch({
        binPath: ensured.binPath,
        workspace,
        serviceHome,
        env: process.env,
        extraEnv: this.launchEnv,
      });
      const child = this.spawnProcess(launch);
      service.child = child;
      // Record the child as soon as it exists: an MCP host killed between spawn and readiness
      // must still leave evidence. The port is unknown at this point, so it is written as null
      // and rewritten atomically once the ready URL tells us the real one.
      this.writePidFile(service, ensured, null);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      const watcher = new ReadinessWatcher({ timeoutMs: this.startupTimeoutMs });
      service.watcher = watcher;
      const url = await this.waitForReadiness(child, watcher, service);
      // Register the launch token before the URL is stored anywhere: from here on every outward
      // string passes through the redaction boundary (`util/redaction.ts`).
      registerLaunchUrl(url);
      service.webUrl = url;
      service.credentials.webUrl = url;
      service.port = portOfUrl(url);
      this.writePidFile(service, ensured, service.port);
      service.status = "running";
      service.npmStderrTail = null;
      return service;
    } catch (error) {
      // Every failure branch converges the record: no service is left `starting`, and the
      // failure keeps the runtime path plus both log tails for diagnosis.
      if (service.child !== null) {
        await this.terminate(service);
      } else {
        service.stoppedAt = new Date();
        this.serviceByWorkspace.delete(workspace);
      }
      service.status = "failed";
      throw this.launchFailure(error, service);
    }
  }

  /** Wraps runtime-package failures so the caller sees the path and the npm stderr tail. */
  private launchFailure(error: unknown, service: ServiceRecord): Error {
    if (error instanceof RuntimePackageError) {
      return new Error(startupFailureMessage({
        cause: "install-failed",
        detail: error.describe(),
        runtimeRoot: service.runtimeRoot,
        npmStderrTail: error.stderrTail,
      }));
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private onInstallProgress(service: ServiceRecord, line: string): void {
    // Install progress is retained so a later readiness failure can quote the npm tail.
    service.npmStderrTail = appendBounded(service.npmStderrTail, line, 4_000);
  }

  private waitForReadiness(child: ChildProcess, watcher: ReadinessWatcher, service: ServiceRecord): Promise<string> {
    const failure = (init: {
      cause: StartupFailureCause;
      exit?: { code: number | null; signal: string | null } | undefined;
      detail?: string | undefined;
    }): Error => new Error(startupFailureMessage({
      cause: init.cause,
      timeoutMs: this.startupTimeoutMs,
      log: watcher.rawLog,
      runtimeRoot: service.runtimeRoot,
      npmStderrTail: service.npmStderrTail,
      ...(init.exit === undefined ? {} : { exit: init.exit }),
      ...(init.detail === undefined ? {} : { detail: init.detail }),
    }));

    return new Promise<string>((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        child.stdout?.removeListener("data", onChunk);
        child.stderr?.removeListener("data", onChunk);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        settle();
      };
      const onChunk = (chunk: string): void => {
        watcher.push(chunk);
        if (watcher.readyUrl !== null) {
          const url = watcher.readyUrl;
          finish(() => resolveReady(url));
        }
      };
      const onError = (error: Error): void => {
        finish(() => rejectReady(failure({ cause: "spawn-error", detail: error.message })));
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() => rejectReady(failure({ cause: "exit-before-ready", exit: { code, signal } })));
      };
      // The budget measures silence: any output resets it (ADR-0002/架构 §4).
      const timer = setInterval(() => {
        if (watcher.readyUrl !== null) {
          const url = watcher.readyUrl;
          finish(() => resolveReady(url));
          return;
        }
        if (watcher.budget.expired()) {
          finish(() => rejectReady(failure({ cause: watcher.cause() })));
        }
      }, DEFAULT_READINESS_POLL_MS);
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("error", onError);
      child.once("close", onClose);
    });
  }

  /**
   * Stops a service and **every** branch converges `status`/`stoppedAt` and releases the
   * workspace index — including the "process already exited" early case. When the exit
   * cannot be confirmed the snapshot says `stopUnconfirmed: true` instead of lying.
   */
  public async terminate(service: ServiceRecord): Promise<void> {
    const child = service.child;
    let portReleased = service.port === null;
    try {
      if (child !== null && !hasExited(child)) {
        child.kill();
        const graceful = await waitForExit(child, this.stopGraceMs);
        if (!graceful) {
          await this.reapImpl(child);
          await waitForExit(child, this.forceStopGraceMs);
        }
      }
      // P0-1: a dead process is not proof that the service is gone — the field incident was a
      // tree whose parent exited while a descendant kept the port. Verify the port itself and
      // only then call the stop confirmed.
      if (!portReleased) {
        portReleased = !(await this.portStillListening(service.port, this.forceStopGraceMs));
        if (!portReleased && child !== null) {
          await this.reapImpl(child);
          portReleased = !(await this.portStillListening(service.port, this.forceStopGraceMs));
        }
      }
    } finally {
      const processGone = child === null || hasExited(child);
      const confirmed = processGone && portReleased;
      service.status = "stopped";
      service.stopUnconfirmed = !confirmed;
      service.stoppedAt = new Date();
      this.serviceByWorkspace.delete(service.workspace);
      // The pidfile is evidence for the *next* start: drop it only when the stop is confirmed,
      // so an unconfirmed stop is still visible to `doctor` and reclaimable later.
      if (confirmed) this.removePidFile(service.serviceHome);
    }
  }

  /**
   * Reclaims the process a previous run recorded for this service home (P0-1).
   *
   * Fail-closed in three steps: a pidfile is parsed (never guessed), the pid is only signalled
   * when the OS reports a command line that proves it is our `binPath` **and** our `--port`
   * argument, and a missing identity means "report, do not kill" — a recycled pid belongs to
   * somebody else. Returns what was found, for the record and for `doctor`'s independent scan.
   */
  private async reclaimOrphan(serviceHome: string): Promise<OrphanReport | null> {
    const path = pidFilePath(serviceHome);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null; // no pidfile: nothing to reconcile
    }
    const record = parsePidFile(text);
    if (record === null) {
      // Corrupt evidence: no pid may be signalled, so only the file is discarded.
      this.removePidFile(serviceHome);
      return { pid: null, port: null, serviceHome, state: "stale-pidfile" };
    }
    const alive = this.isAlive(record.pid);
    const owned = alive ? identityOwnsRecord(this.processIdentity(record.pid), record) : null;
    const state = orphanState({ alive, owned });
    if (state === "stale-pidfile") {
      this.removePidFile(serviceHome);
      return { pid: record.pid, port: record.port, serviceHome, state };
    }
    if (state === "unverified") {
      // Keep the pidfile: the state is still unexplained, and a later run may be able to verify.
      return { pid: record.pid, port: record.port, serviceHome, state };
    }
    await this.reapOrphanImpl(record.pid);
    const released = record.port === null || !(await this.portStillListening(record.port, this.forceStopGraceMs));
    if (released) {
      this.removePidFile(serviceHome);
      return { pid: record.pid, port: record.port, serviceHome, state: "alive" };
    }
    // Verified ours, but stubborn: keep the evidence so the next attempt (or a human) can act.
    return { pid: record.pid, port: record.port, serviceHome, state: "alive" };
  }

  /** Atomically writes `<serviceHome>/dsh.pid` (best effort: recovery must not break a start). */
  private writePidFile(service: ServiceRecord, ensured: EnsuredRuntimePackage, port: number | null): void {
    const pid = service.child?.pid;
    if (pid === undefined || service.binPath === null) return;
    const record: PidFileRecord = {
      pid,
      port,
      version: ensured.version,
      binPath: ensured.binPath,
      startedAt: service.startedAt.toISOString(),
      dataDirectory: this.dataDirectory,
      workspace: service.workspace,
      serviceHome: service.serviceHome,
    };
    try {
      // Only where the real spawn path already created the directory: the supervisor must never
      // create the service home itself, so an injected spawn seam stays filesystem-free.
      if (!existsSync(service.serviceHome)) return;
      const path = pidFilePath(service.serviceHome);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, serializePidFile(record), { mode: 0o600 });
      renameSync(temporary, path);
    } catch {
      // A pidfile is recovery evidence, not a prerequisite: a read-only data directory must not
      // stop a service that is otherwise healthy.
    }
  }

  /** Removes the pidfile of one service home, if it exists. */
  private removePidFile(serviceHome: string): void {
    try {
      rmSync(pidFilePath(serviceHome), { force: true });
    } catch {
      // Nothing to do: the file is best-effort evidence.
    }
  }

  /** Resolves `true` while the port still accepts loopback connections, bounded by `timeoutMs`. */
  private async portStillListening(port: number | null, timeoutMs: number): Promise<boolean> {
    if (port === null) return false;
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    while (true) {
      if (!(await this.portProbe(port))) return false;
      if (Date.now() >= deadline) return true;
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  /** Projects the internal record into the immutable public snapshot. */
  public snapshot(service: ServiceRecord): ServiceSnapshot {
    return {
      serviceId: service.serviceId,
      workspace: service.workspace,
      status: service.status,
      webUrl: service.webUrl,
      browserOpened: service.browserOpened,
      browserError: service.browserError,
      startedAt: service.startedAt.toISOString(),
      stoppedAt: service.stoppedAt?.toISOString() ?? null,
      processId: service.child?.pid ?? null,
      stopUnconfirmed: service.stopUnconfirmed,
      runtimeRoot: service.runtimeRoot,
      logTail: service.watcher?.logTail ?? "",
    };
  }
}

/** Digest used for the per-workspace service home directory. */
function workspaceDigest(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex");
}

/** The bound port of a ready URL, or `null` when the URL carries none. */
function portOfUrl(url: string): number | null {
  try {
    const port = new URL(url).port;
    return port === "" ? null : Number(port);
  } catch {
    return null;
  }
}

/** The per-workspace service home (`DSH_HOME`) below one data directory. */
export function serviceHomeFor(dataDirectory: string, workspace: string): string {
  return join(dataDirectory, "services", workspaceKey(workspaceDigest(workspace)));
}

/** Default loopback port probe: a TCP connect is the same evidence `listens()` uses in the smoke. */
async function defaultPortProbe(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(listening);
    };
    socket.setTimeout(1_500);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}
