// Composition root: the one place that reads configuration and constructs the concrete
// implementations. Every other layer receives its collaborators through a constructor.

import { ServiceSupervisor, type EnsureRuntimeImpl, type SupervisorOptions } from "../service/supervisor.js";
import { RunOrchestrator } from "../run/orchestrator.js";
import type { RunSnapshot, StartRunInput } from "../run/types.js";
import type { ServiceSnapshot, StartServiceInput } from "../service/types.js";
import type { HarnessLaunch } from "../service/launch.js";
import { openInDefaultBrowser } from "../service/browser.js";
import { DEFAULT_POLL_INTERVAL_MS, resolveAllowedRoots, resolveDataDirectory, resolveHarnessPackage, resolveInstallTimeoutMs, resolveStartupTimeoutMs } from "../config/resolve.js";
import { inspectRuntime } from "../diagnostics/doctor.js";
import { configureDriftTelemetry } from "../dsh/drift.js";
import { versionOfSpec } from "../dsh/matrix.js";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Everything the composition root accepts from the process environment or from a test. */
export interface ContainerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dataDirectory?: string;
  readonly allowedRoots?: string[];
  readonly startupTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly stopGraceMs?: number;
  readonly forceStopGraceMs?: number;
  readonly harnessPackage?: string;
  readonly npmCli?: string;
  readonly ensureRuntime?: EnsureRuntimeImpl;
  readonly spawnProcess?: (launch: HarnessLaunch) => ChildProcess;
  readonly launchEnv?: NodeJS.ProcessEnv;
  readonly openBrowser?: (url: string) => Promise<void>;
}

/** The orchestration surface the MCP tools are registered against. */
export interface OrchestrationContainer {
  startService(input: StartServiceInput): Promise<ServiceSnapshot>;
  openService(serviceId: string): Promise<ServiceSnapshot>;
  listServices(): ServiceSnapshot[];
  stopService(serviceId: string): Promise<ServiceSnapshot>;
  start(input: StartRunInput): Promise<RunSnapshot>;
  list(): Promise<RunSnapshot[]>;
  get(runId: string): Promise<RunSnapshot>;
  wait(runId: string, timeoutMs: number): Promise<RunSnapshot>;
  cancel(runId: string): Promise<RunSnapshot>;
  doctor(): Record<string, unknown>;
  dispose(): Promise<void>;
}

/** Wires one MCP server process: config → supervisor → orchestrator. */
export class HarnessContainer implements OrchestrationContainer {
  private readonly supervisor: ServiceSupervisor;
  private readonly orchestrator: RunOrchestrator;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pollIntervalMs: number;
  /**
   * The data directory this process resolved and injected into the service layer.
   *
   * Exposed so a caller can assert which directory the process actually owns; the service
   * layer never derives it itself.
   */
  public readonly dataDirectory: string;

  public constructor(options: ContainerOptions = {}) {
    const env = options.env ?? process.env;
    this.environment = env;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.dataDirectory = join(options.dataDirectory ?? resolveDataDirectory(env), "");
    const allowedRoots = options.allowedRoots ?? resolveAllowedRoots(env);
    const supervisorOptions: SupervisorOptions = {
      dataDirectory: this.dataDirectory,
      allowedRoots: allowedRoots.map((root) => join(root, "")),
      startupTimeoutMs: options.startupTimeoutMs ?? resolveStartupTimeoutMs(env),
      installTimeoutMs: options.installTimeoutMs ?? resolveInstallTimeoutMs(env),
      pollIntervalMs: this.pollIntervalMs,
      stopGraceMs: options.stopGraceMs ?? 5_000,
      forceStopGraceMs: options.forceStopGraceMs ?? 2_000,
      harnessPackage: options.harnessPackage ?? resolveHarnessPackage(env),
      openBrowser: options.openBrowser ?? openInDefaultBrowser,
      ...(options.npmCli === undefined ? {} : { npmCli: options.npmCli }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      ...(options.launchEnv === undefined ? {} : { launchEnv: options.launchEnv }),
      ...(options.ensureRuntime === undefined ? {} : { ensureRuntime: options.ensureRuntime }),
    };
    this.supervisor = new ServiceSupervisor(supervisorOptions);
    this.orchestrator = new RunOrchestrator(this.supervisor, { pollIntervalMs: this.pollIntervalMs }, allowedRoots);
    // R3-2: drift telemetry is wired here because this is the only layer that resolves
    // configuration. It stores nothing until a drift actually happens, and the sink is a no-op
    // when `DSH_MCP_DRIFT_LOG` disables it — so a process that never drifts never creates `logs/`.
    configureDriftTelemetry({
      dataDirectory: this.dataDirectory,
      dshVersion: versionOfSpec(supervisorOptions.harnessPackage),
      env,
    });
  }

  // --- service surface ------------------------------------------------------------------

  public async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    return await this.supervisor.start(input);
  }

  public async openService(serviceId: string): Promise<ServiceSnapshot> {
    return await this.supervisor.open(serviceId);
  }

  public listServices(): ServiceSnapshot[] {
    return this.supervisor.list();
  }

  public async stopService(serviceId: string): Promise<ServiceSnapshot> {
    await this.orchestrator.stopService(serviceId);
    return this.supervisor.snapshot(this.supervisor.require(serviceId));
  }

  // --- run surface ----------------------------------------------------------------------

  public async start(input: StartRunInput): Promise<RunSnapshot> {
    return await this.orchestrator.start(input);
  }

  public async list(): Promise<RunSnapshot[]> {
    return await this.orchestrator.list();
  }

  public async get(runId: string): Promise<RunSnapshot> {
    return await this.orchestrator.get(runId);
  }

  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    return await this.orchestrator.wait(runId, timeoutMs);
  }

  public async cancel(runId: string): Promise<RunSnapshot> {
    return await this.orchestrator.cancel(runId);
  }

  // --- diagnostics and shutdown ---------------------------------------------------------

  /** `doctor` reads the live environment, so a changed env is reflected on the next call. */
  public doctor(): Record<string, unknown> {
    return inspectRuntime(this.environment);
  }

  /** Stops every owned service, converging runs first. */
  public async dispose(): Promise<void> {
    await this.orchestrator.dispose();
  }

  /** Alias kept for callers that speak of "closing" the server. */
  public async close(): Promise<void> {
    await this.dispose();
  }
}
