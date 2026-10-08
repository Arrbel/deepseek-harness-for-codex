// Run orchestration: submit a task into a visible Web session, then project the session's
// durable event log back into a run outcome.
//
// This layer owns the *ordering* of the whole flow (workspace → service → session → prompt →
// event projection). It reaches the Harness only through `dsh/client.ts`, and it owns the run
// record only through `run/registry.ts` and `run/state.ts`.
//
// P5 invariant (ADR-0003 §3.2): **every** path that observes a failure settles the run. The only
// exception is the caller boundary — before a run record exists (`start()`), a failure is
// propagated as the original error, because there is nothing to converge yet.

import { randomUUID } from "node:crypto";
import { optionalSessionId, requireTask } from "../policy/trusted-input.js";
import { lastTurnEndOutcome, projectAssistantText } from "../dsh/events.js";
import { classifyThrownFailure, type ClassifiedWireFailure } from "../dsh/wire.js";
import { samePath } from "../policy/paths.js";
import type { HistoryEvent, SessionSummary } from "../dsh/types.js";
import { delay, errorText } from "../util/errors.js";
import { redactFailure } from "../service/credentials.js";
import type { ServiceAccess, ServiceSupervisor } from "../service/supervisor.js";
import { RunRegistry, createRunRecord, type RunRecord } from "./registry.js";
import {
  isTerminal,
  outcomeFor,
  recoveryPolicyFor,
  settle,
  type RunOutcome,
} from "./state.js";
import type { RunSnapshot, StartRunInput } from "./types.js";

/** How the orchestrator waits and what it treats as a hard failure by default. */
export interface OrchestratorOptions {
  /** Poll interval while waiting on a session. */
  pollIntervalMs?: number;
  /** Extra environment merged into the harness child (service layer owns the process). */
  launchEnv?: NodeJS.ProcessEnv;
  /** Open the page after a run is accepted (the service layer owns the browser). */
  openBrowser?: boolean;
}

/** One RPC attempt sequence: either a value, or the classified failure that ended it. */
type PerformResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ClassifiedWireFailure; readonly error: unknown };

/** Owns the runs of one MCP server process. */
export class RunOrchestrator {
  private readonly supervisor: ServiceSupervisor;
  private readonly registry = new RunRegistry();
  private readonly pollIntervalMs: number;
  private readonly allowedRoots: readonly string[];

  public constructor(supervisor: ServiceSupervisor, options: OrchestratorOptions = {}, allowedRoots: readonly string[] = []) {
    this.supervisor = supervisor;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.allowedRoots = allowedRoots;
  }

  /** Starts or continues a Web session and submits the task through Harness RPC. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    const task = requireTask(input.task);
    const serviceSnapshot = await this.supervisor.start({ workspace: input.workspace, openBrowser: false });
    if (serviceSnapshot.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
    const access = this.supervisor.access(serviceSnapshot.serviceId);
    const workspaceResult = await this.callOrThrow(access, () =>
      access.client.call("workspace/create", { request: { path: access.record.workspace } }),
    );
    const requestedSessionId = optionalSessionId(input.sessionId);
    let sessionId: string;
    let startEventSeq: number;
    if (requestedSessionId === undefined) {
      const session = await this.callOrThrow(access, () =>
        access.client.call("session/create", { request: { workspaceId: workspaceResult.workspace.workspaceId } }),
      );
      sessionId = session.sessionId;
      const projections = await this.callOrThrow(access, () =>
        access.client.call("session/projections", { request: { sessionId } }),
      );
      if (projections === null) throw new Error(`Harness did not publish the new session: ${sessionId}`);
      startEventSeq = projections.asOfSeq;
    } else {
      const [list, projections] = await Promise.all([
        this.callOrThrow(access, () => access.client.call("session/list", { _request: {} })),
        this.callOrThrow(access, () =>
          access.client.call("session/projections", { request: { sessionId: requestedSessionId } }),
        ),
      ]);
      const summary = list.items.find((item: SessionSummary) => item.sessionId === requestedSessionId);
      if (summary === undefined) throw new Error(`Unknown sessionId for this workspace: ${requestedSessionId}`);
      // Fail closed: without a usable `cwd` there is no proof that this session belongs to the
      // requested workspace, and reusing it would run the task in someone else's directory.
      const summaryCwd = typeof summary.cwd === "string" && summary.cwd !== "" ? summary.cwd : null;
      if (summaryCwd === null) {
        throw new Error(
          `Cannot prove Harness session ${requestedSessionId} belongs to workspace ${access.record.workspace}: the Host reported no cwd for it. Omit sessionId to create a new session instead of reusing it.`,
        );
      }
      if (!samePath(summaryCwd, access.record.workspace)) {
        throw new Error(`Harness session belongs to a different workspace: ${requestedSessionId}`);
      }
      if (summary.running) throw new Error(`Harness session is still running: ${requestedSessionId}`);
      if (projections === null) throw new Error(`Harness session history is unavailable: ${requestedSessionId}`);
      sessionId = requestedSessionId;
      startEventSeq = projections.asOfSeq;
    }
    this.registry.acquireSession(access.record.serviceId, sessionId);
    try {
      await this.callOrThrow(access, () =>
        access.client.call("session/prompt", {
          request: {
            requestId: randomUUID(),
            sessionId,
            mode: "queue",
            content: [{ type: "text", text: task }],
          },
        }),
      );
    } catch (error) {
      this.registry.releaseSession(access.record.serviceId, sessionId);
      throw error;
    }
    if (input.openBrowser ?? false) {
      try {
        await this.supervisor.open(access.record.serviceId);
      } catch (error) {
        // Same rule as the supervisor's own open path: never store an unredacted error.
        access.record.browserError = redactFailure(error);
      }
    }
    const run = this.registry.add(
      createRunRecord({
        runId: randomUUID(),
        serviceId: access.record.serviceId,
        sessionId,
        sessionReused: requestedSessionId !== undefined,
        startEventSeq,
        task,
        workspace: access.record.workspace,
        webUrl: serviceSnapshot.webUrl,
        startedAt: new Date(),
        lastEventSeq: startEventSeq,
        sawRunningSession: true,
      }),
    );
    return await this.refresh(run);
  }

  /** Lists runs and refreshes their observable Web session state. */
  public async list(): Promise<RunSnapshot[]> {
    return await Promise.all(this.registry.list().map(async (run) => await this.refresh(run)));
  }

  /** Reads a run from the same Web session shown to the user. */
  public async get(runId: string): Promise<RunSnapshot> {
    return await this.refresh(this.registry.require(runId));
  }

  /** Polls the Web session for up to 30 seconds. */
  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    const run = this.registry.require(runId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    let snapshot = await this.refresh(run);
    while (snapshot.status === "running" && Date.now() < deadline) {
      await delay(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
      snapshot = await this.refresh(run);
    }
    return snapshot;
  }

  /** Cancels the Harness agent turn without stopping the visible Web service. */
  public async cancel(runId: string): Promise<RunSnapshot> {
    const run = this.registry.require(runId);
    if (isTerminal(run)) return RunRegistry.snapshot(run);
    run.cancelRequested = true;
    let access: ServiceAccess;
    try {
      access = this.supervisor.access(run.serviceId);
    } catch (error) {
      this.failRun(run, classifyThrownFailure(error));
      return RunRegistry.snapshot(run);
    }
    const result = await this.perform(access, () =>
      access.client.call("session/cancel", { request: { sessionId: run.sessionId } }),
    );
    if (!result.ok) {
      // The Host no longer knows the session: there is no turn left to cancel, so honouring the
      // caller's request is accurate. Anything else means the cancel could not be confirmed, and
      // reporting `cancelled` there would be a lie.
      if (result.failure.kind === "not-found" || result.failure.code === "session/not-found") {
        this.settleRun(run, { kind: "cancelled" });
      } else {
        this.failRun(run, result.failure);
      }
      return RunRegistry.snapshot(run);
    }
    return await this.refresh(run);
  }

  /** Cancels every running run of a service and converges the rest (service stop path). */
  public async stopService(serviceId: string): Promise<void> {
    let cancelFailure: unknown = null;
    try {
      await this.cancelRunsOfService(serviceId);
    } catch (error) {
      cancelFailure = error;
    }
    try {
      await this.supervisor.stop(serviceId);
    } finally {
      // Whatever happened above, no run of this service may stay `running`.
      this.failRunsOfService(serviceId, "Harness Web service was stopped before the task completed.");
    }
    if (cancelFailure !== null) {
      throw new Error(`stopped ${serviceId}, but cancelling its runs failed: ${errorText(cancelFailure)}`);
    }
  }

  /** Stops every service owned by this process, converging runs first and aggregating errors. */
  public async dispose(): Promise<void> {
    const problems: string[] = [];
    for (const service of this.supervisor.list()) {
      try {
        await this.stopService(service.serviceId);
      } catch (error) {
        problems.push(`${service.serviceId}: ${errorText(error)}`);
      }
    }
    if (problems.length > 0) {
      throw new Error(`failed to stop ${String(problems.length)} service(s): ${problems.join("; ")}`);
    }
  }

  /** Settles every run that belongs to a service (service stop / crash convergence). */
  public failRunsOfService(serviceId: string, message: string): void {
    const outcome: RunOutcome = { kind: "failed", reason: "service-unreachable", message };
    for (const run of this.registry.list()) {
      if (run.serviceId !== serviceId) continue;
      this.settleRun(run, outcome);
    }
  }

  /** Cancels every running run of a service before the service is terminated. */
  public async cancelRunsOfService(serviceId: string): Promise<void> {
    for (const run of this.registry.list()) {
      if (run.serviceId === serviceId && run.status === "running") await this.cancel(run.runId);
    }
  }

  /** Writes the terminal state once and releases the session lock with it. */
  private settleRun(run: RunRecord, outcome: RunOutcome): void {
    if (settle(run, outcome)) this.registry.releaseSession(run.serviceId, run.sessionId);
  }

  /** Settles a run as failed with the terminal reason its failure class implies. */
  private failRun(run: RunRecord, failure: ClassifiedWireFailure): void {
    this.settleRun(run, outcomeFor(failure.kind, failure.code, failure.message));
  }

  /**
   * Runs one RPC action, applying the recovery policy for its failure class.
   *
   * Auth: the stale cookie is cleared so the next attempt re-exchanges the launch URL, then one
   * retry. Transport: bounded backoff retries. Protocol drift and business errors: no retry.
   * A caller error (`not-found`) is returned immediately without a retry.
   */
  private async perform<T>(access: ServiceAccess, action: () => Promise<T>): Promise<PerformResult<T>> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return { ok: true, value: await action() };
      } catch (error) {
        const failure = classifyThrownFailure(error);
        const policy = recoveryPolicyFor(failure.kind, failure.code);
        if (policy.propagates || attempt >= policy.attempts) return { ok: false, failure, error };
        if (policy.reauthenticate) access.client.invalidateCredentials();
        const backoff = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0;
        if (backoff > 0) await delay(backoff);
      }
    }
  }

  /** Performs one call at the caller boundary, where a failure propagates as the original error. */
  private async callOrThrow<T>(access: ServiceAccess, action: () => Promise<T>): Promise<T> {
    const result = await this.perform(access, action);
    if (!result.ok) throw result.error;
    return result.value;
  }

  private async refresh(run: RunRecord): Promise<RunSnapshot> {
    if (isTerminal(run)) return RunRegistry.snapshot(run);
    let access: ServiceAccess;
    try {
      access = this.supervisor.access(run.serviceId);
    } catch (error) {
      this.failRun(run, classifyThrownFailure(error));
      return RunRegistry.snapshot(run);
    }
    if (!access.running) {
      this.settleRun(run, {
        kind: "failed",
        reason: "service-unreachable",
        message: "Harness Web service stopped before the task completed.",
      });
      return RunRegistry.snapshot(run);
    }
    const listResult = await this.perform(access, () => access.client.call("session/list", { _request: {} }));
    if (!listResult.ok) {
      this.failRun(run, listResult.failure);
      return RunRegistry.snapshot(run);
    }
    const projectionsResult = await this.perform(access, () =>
      access.client.call("session/projections", { request: { sessionId: run.sessionId } }),
    );
    if (!projectionsResult.ok) {
      this.failRun(run, projectionsResult.failure);
      return RunRegistry.snapshot(run);
    }
    const projections = projectionsResult.value;
    const summary = listResult.value.items.find((item: SessionSummary) => item.sessionId === run.sessionId);
    if (summary?.running === true) run.sawRunningSession = true;
    if (projections === null) {
      this.settleRun(run, {
        kind: "failed",
        reason: "service-unreachable",
        message: `Harness session disappeared: ${run.sessionId}`,
      });
      return RunRegistry.snapshot(run);
    }
    const eventsResult = await this.perform(access, () =>
      access.client.readEvents(run.sessionId, run.startEventSeq, projections.asOfSeq),
    );
    if (!eventsResult.ok) {
      this.failRun(run, eventsResult.failure);
      return RunRegistry.snapshot(run);
    }
    const events: HistoryEvent[] = eventsResult.value;
    run.lastEventSeq = events.reduce((highest, entry) => Math.max(highest, entry.event.seq), run.lastEventSeq);
    run.assistantText = projectAssistantText(events);
    const outcome = lastTurnEndOutcome(events, { cancelRequested: run.cancelRequested });
    if (outcome !== null) {
      this.settleRun(run, outcome);
      return RunRegistry.snapshot(run);
    }
    const idle = summary === undefined || summary.running !== true;
    if (run.cancelRequested && idle) {
      this.settleRun(run, { kind: "cancelled" });
      return RunRegistry.snapshot(run);
    }
    if (run.sawRunningSession && idle) {
      // The Host stopped reporting the session as running without ever publishing a terminal
      // turn. Leaving the run `running` forever is exactly the state ADR-0003 removes, so this
      // fails closed with the unrecognized-marker reason.
      this.settleRun(run, {
        kind: "failed",
        reason: "turn-unknown:missing-turn-end",
        message: `Harness session stopped running without a terminal turn marker: ${run.sessionId}`,
      });
      return RunRegistry.snapshot(run);
    }
    return RunRegistry.snapshot(run);
  }
}
