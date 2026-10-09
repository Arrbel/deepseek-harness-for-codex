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
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { optionalSessionId, requireTask } from "../policy/trusted-input.js";
import { resolveWorkspace } from "../policy/workspace.js";
import { lastTurnEndOutcome, projectAssistantText, projectStepProgress } from "../dsh/events.js";
import { classifyThrownFailure, type ClassifiedWireFailure } from "../dsh/wire.js";
import { samePath } from "../policy/paths.js";
import type { HistoryEvent, SessionSummary } from "../dsh/types.js";
import { delay, errorText } from "../util/errors.js";
import { redactFailure } from "../service/credentials.js";
import type { ServiceAccess, ServiceSupervisor } from "../service/supervisor.js";
import { AdoptLock, type AdoptLease } from "./adopt-lock.js";
import { admitRun, capacityVerdict, resolveRunLimit, type ActiveRun, type Occupancy, type RunAdmission } from "./concurrency.js";
import { RunJournal, serviceHomesUnder, type JournalProblem, type JournalRecord } from "./journal.js";
import {
  INITIAL_POLL_STATE,
  advancePollState,
  nextPollDelayMs,
  pollScheduleFor,
} from "./polling.js";
import {
  journalRecordAfterOutcome,
  journalRecordFor,
  reconcileDecision,
  resolveClaims,
  restoredRecord,
  supersededOutcome,
  type ReconcileObservation,
} from "./reconcile.js";
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
  /** Journal handle for one service home (tests inject a temporary directory). */
  journalFor?: (serviceHome: string) => RunJournal;
  /** Adopt lock for one service home (tests inject a fake owner/liveness seam). */
  adoptLockFor?: (serviceHome: string) => AdoptLock;
  /** Where journal/lock/reconciliation problems are reported (they never throw). */
  onProblem?: (message: string) => void;
  /** Concurrency slot count for this process (defaults to `DSH_MCP_RUN_LIMIT`, then 4). */
  runLimit?: number;
}

/** One RPC attempt sequence: either a value, or the classified failure that ended it. */
type PerformResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ClassifiedWireFailure; readonly error: unknown };

/**
 * A concurrency slot taken by an admitted submission, before it has a run record (N-R3-1).
 *
 * `refusal` marks a submission whose verdict is *already decided* because it named a session (the
 * session rules answer first there): it holds no slot, because it will never run — but it still
 * carries the reservation sequence so the release path stays uniform.
 */
interface Reservation {
  readonly seq: number;
  readonly workspace: string;
  readonly refusal?: Error | undefined;
}

/** Owns the runs of one MCP server process. */
export class RunOrchestrator {
  private readonly supervisor: ServiceSupervisor;
  private readonly registry = new RunRegistry();
  private readonly pollIntervalMs: number;
  private readonly allowedRoots: readonly string[];
  private readonly journals = new Map<string, RunJournal>();
  private readonly leases = new Map<string, AdoptLease>();
  /** Slots taken by admitted submissions that have no run record yet (see `reserve`). */
  private readonly reservations = new Map<number, Reservation>();
  private reservationSeq = 0;
  private readonly problems: string[] = [];
  private readonly options: OrchestratorOptions;
  private readonly runLimit: number;
  private reconciled = false;

  public constructor(supervisor: ServiceSupervisor, options: OrchestratorOptions = {}, allowedRoots: readonly string[] = []) {
    this.supervisor = supervisor;
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    this.allowedRoots = allowedRoots;
    // Read once: the limit is operator configuration, not per-call input.
    this.runLimit = options.runLimit ?? resolveRunLimit();
  }

  /**
   * Journal/lock/reconciliation problems, in order.
   *
   * They are *reported*, never thrown: the journal is advisory (a read-only data directory must
   * not stop a run), and a skipped reconciliation is a fact the operator should see rather than a
   * terminal state we invent.
   */
  public journalProblems(): readonly string[] {
    return this.problems;
  }

  /** Runs that still occupy a concurrency slot (terminal runs do not). */
  public activeRuns(): ActiveRun[] {
    return this.registry
      .list()
      .filter((run) => !isTerminal(run))
      .map((run) => ({ runId: run.runId, workspace: run.workspace, status: run.status }));
  }

  /**
   * Every slot occupied right now: real non-terminal runs **plus** submissions that were admitted
   * but have not produced a run record yet.
   *
   * The pending half is what makes admission atomic (N-R3-1). It is intentionally invisible to
   * callers: `activeRuns()`, `list()`, the journal and the snapshots only ever see real runs, so
   * "no `running` record" still means "no `queued`" and `RunStatus` gains no member.
   */
  private occupancy(exclude?: Reservation): Occupancy {
    return {
      active: this.activeRuns(),
      pending: [...this.reservations.values()]
        .filter((reservation) => reservation !== exclude && reservation.refusal === undefined)
        .map((reservation) => ({ workspace: reservation.workspace })),
    };
  }

  /**
   * Decides **and reserves** a slot, in one synchronous block.
   *
   * This method must be called with no `await` between its entry and its return: the decision and
   * the reservation have to be atomic with respect to other `start_run` calls, and Node's single
   * thread guarantees exactly that for a synchronous block. No mutex, no retry, no queue.
   */
  private reserve(input: string, options: { deferWorkspaceRefusal: boolean }): Reservation {
    const workspace = admissionKey(input);
    const admission = admitRun({ ...this.occupancy(), workspace, limit: this.runLimit });
    if (!admission.ok) {
      if (admission.reason === "workspace-busy" && options.deferWorkspaceRefusal) {
        // The caller named a session: the session rules answer first ("that session is still
        // running" is the more specific refusal), so the verdict is kept and raised after them.
        // No slot is reserved — this call cannot run, so it cannot create a duplicate owner.
        return { seq: (this.reservationSeq += 1), workspace, refusal: new Error(admission.message) };
      }
      throw new Error(admission.message);
    }
    const reservation: Reservation = { seq: (this.reservationSeq += 1), workspace };
    this.reservations.set(reservation.seq, reservation);
    return reservation;
  }

  /** Drops a reservation; every early exit goes through here (see the `finally` in `start`). */
  private releaseReservation(reservation: Reservation): void {
    this.reservations.delete(reservation.seq);
  }

  /**
   * Re-checks admission once the canonical workspace and any adopted runs are known.
   *
   * The reservation already happened; this is the *decisive* verdict after `await`s that could have
   * changed the picture (a workspace resolved differently, or reconciliation adopting a run of the
   * same workspace). It can only refuse.
   */
  private admit(workspace: string, reservation: Reservation): void {
    this.refuse(admitRun({ ...this.occupancy(reservation), workspace, limit: this.runLimit }));
  }

  private refuse(admission: RunAdmission): void {
    if (!admission.ok) throw new Error(admission.message);
  }

  /** Starts or continues a Web session and submits the task through Harness RPC. */
  public async start(input: StartRunInput): Promise<RunSnapshot> {
    const task = requireTask(input.task);
    const requestedSessionId = optionalSessionId(input.sessionId);
    // **Atomic admission.** Everything from here to the first `await` is one synchronous block: the
    // slot for this workspace (and the process capacity) is taken before anything can suspend, so
    // two concurrent `start_run` calls can never both pass the check (N-R3-1). A caller that names
    // a session gets its workspace verdict deferred until after the session rules have answered.
    const reservation = this.reserve(input.workspace, { deferWorkspaceRefusal: requestedSessionId !== undefined });
    try {
      // First tool call of this process: settle or adopt whatever a previous process left behind.
      await this.reconcile();
      const workspace = await resolveWorkspace(input.workspace, this.allowedRoots);
      if (!samePath(reservation.workspace, workspace)) {
        // `admissionKey` could not canonicalise the path synchronously (it did not exist yet, or a
        // symlink resolved differently). Fail closed rather than run under an unreserved key.
        throw new Error(`Workspace ${workspace} could not be reserved under its canonical path; retry the call.`);
      }
      if (requestedSessionId === undefined) {
        // New session: nothing between here and the prompt can change the verdict, so decide now
        // (this also catches a run of the same workspace adopted by `reconcile()`).
        this.admit(workspace, reservation);
      }
      const serviceSnapshot = await this.supervisor.start({ workspace, openBrowser: false });
      if (serviceSnapshot.webUrl === null) throw new Error("Harness Web service did not provide a URL.");
      const access = this.supervisor.access(serviceSnapshot.serviceId);
      const workspaceResult = await this.callOrThrow(access, () =>
        access.client.call("workspace/create", { request: { path: access.record.workspace } }),
      );
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
      // The session rules had their say: now the deferred workspace verdict, then the decisive
      // re-check (an explicitly named *idle* session must not become a second concurrent run).
      if (reservation.refusal !== undefined) throw reservation.refusal;
      this.admit(workspace, reservation);
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
      // Claim the data directory before writing anything into it: if another MCP process owns the
      // runs of this service home, this run still proceeds in-process but must not pretend it can
      // be reconciled later (and that process must not write terminal state for ours).
      this.claimHome(access.record.serviceHome);
      this.journalRun(run);
      return await this.refresh(run);
    } finally {
      // Every early exit (session rules, service failure, prompt error, an unexpected throw) drops
      // the slot here; a reservation must never outlive its submission.
      this.releaseReservation(reservation);
    }
  }

  /** Lists runs and refreshes their observable Web session state. */
  public async list(): Promise<RunSnapshot[]> {
    await this.reconcile();
    return await Promise.all(this.registry.list().map(async (run) => await this.refresh(run)));
  }

  /** Reads a run from the same Web session shown to the user. */
  public async get(runId: string): Promise<RunSnapshot> {
    await this.reconcile();
    return await this.refresh(this.registry.require(runId));
  }

  /**
   * Polls the Web session for up to 30 seconds.
   *
   * The interval is adaptive (R3-5): a refresh that brought a new event shortens it to the
   * schedule's floor, and silence walks it back up to the configured `pollIntervalMs`. The
   * schedule is a pure function of the last observation (`run/polling.ts`), the ceiling is still
   * the operator's configured pace, and the deadline is unchanged — acceleration can only make the
   * loop poll sooner, never run longer. The final `Math.min` keeps the last sleep inside the
   * remaining budget, so the method never overshoots by one interval.
   */
  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    await this.reconcile();
    const run = this.registry.require(runId);
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 30_000);
    const schedule = pollScheduleFor(this.pollIntervalMs);
    let state = INITIAL_POLL_STATE;
    let snapshot = await this.refresh(run);
    let observedSeq = snapshot.lastEventSeq;
    while (snapshot.status === "running" && Date.now() < deadline) {
      state = advancePollState(state, snapshot.lastEventSeq > observedSeq);
      observedSeq = snapshot.lastEventSeq;
      await delay(Math.min(nextPollDelayMs(state, schedule), Math.max(1, deadline - Date.now())));
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
    if (!settle(run, outcome)) return;
    this.registry.releaseSession(run.serviceId, run.sessionId);
    // Terminal bookkeeping (R3-3): persist the conclusion, then let go of the data directory when
    // nothing of this service home is pending any more.
    this.journalRun(run);
    const home = this.supervisor.serviceHomeOf(run.serviceId);
    if (home === null) return;
    const pending = this.registry
      .list()
      .some((candidate) => !isTerminal(candidate) && this.supervisor.serviceHomeOf(candidate.serviceId) === home);
    if (!pending) this.releaseHome(home);
  }

  /** Records a journal/lock/reconciliation problem; never throws, never settles anything. */
  private report(message: string): void {
    this.problems.push(message);
    this.options.onProblem?.(message);
  }

  private journalFor(serviceHome: string): RunJournal {
    const existing = this.journals.get(serviceHome);
    if (existing !== undefined) return existing;
    const journal = (this.options.journalFor ?? defaultJournalFor)(serviceHome, (problem) => {
      this.report(`${problem.path}: ${problem.message}`);
    });
    this.journals.set(serviceHome, journal);
    return journal;
  }

  /**
   * Persists one run. A journal that cannot be written is reported and otherwise ignored: the run
   * itself must keep working (task red line #3).
   */
  private journalRun(run: RunRecord): void {
    const home = this.supervisor.serviceHomeOf(run.serviceId);
    if (home === null) return; // service unknown to this process: nothing durable to update
    this.journalFor(home).write(journalRecordFor(run));
  }

  /**
   * Takes (or reuses) this process's claim on a service home.
   *
   * `null` means another live MCP process owns that data directory: this process still runs its
   * tasks, but it must never reconcile (or settle) the runs recorded there.
   */
  private claimHome(serviceHome: string): AdoptLease | null {
    const held = this.leases.get(serviceHome);
    if (held !== undefined) return held;
    const lock = (this.options.adoptLockFor ?? defaultAdoptLockFor)(serviceHome, (message) => {
      this.report(message);
    });
    const lease = lock.acquire();
    if (lease === null) {
      this.report(
        `another MCP process owns the runs in ${serviceHome}; runs started here will not be reconciled after a restart`,
      );
      return null;
    }
    this.leases.set(serviceHome, lease);
    return lease;
  }

  private releaseHome(serviceHome: string): void {
    const lease = this.leases.get(serviceHome);
    if (lease === undefined) return;
    lease.release();
    this.leases.delete(serviceHome);
  }

  /**
   * Reconciles the runs a previous MCP process left behind (R3-3).
   *
   * Runs once per process, triggered by the first tool call. Everything it cannot do (no lock, no
   * service, an unreadable journal) is reported — never converted into a terminal state.
   */
  public async reconcile(): Promise<void> {
    if (this.reconciled) return;
    this.reconciled = true;
    try {
      await this.reconcileJournals();
    } catch (error) {
      this.report(`run reconciliation failed: ${errorText(error)}`);
    }
  }

  private async reconcileJournals(): Promise<void> {
    const homes = new Set<string>(this.supervisor.serviceHomes());
    for (const home of serviceHomesUnder(this.supervisor.getDataDirectory())) homes.add(home);
    for (const home of homes) {
      const journal = this.journalFor(home);
      const pending = journal
        .list()
        .filter((record) => record.status === "running" && this.registry.find(record.runId) === null);
      if (pending.length === 0) continue;
      // Red line: without the claim there is no reconciliation and *no terminal write*.
      if (this.claimHome(home) === null) continue;
      journal.sweepTemporaries();
      // Ownership resolution (U-3): a duplicate claim must never become a second owner of one
      // Harness session. Live runs of this process are the current owners; among disk records the
      // newest claim per session wins and the rest are converged to a terminal state.
      const owned = this.activeRuns().length === 0
        ? []
        : this.registry
          .list()
          .filter((run) => !isTerminal(run))
          .map((run) => ({ sessionId: run.sessionId, runId: run.runId }));
      const { owners, superseded } = resolveClaims(pending, owned);
      for (const entry of superseded) {
        journal.write(journalRecordAfterOutcome(entry.claim, supersededOutcome(entry.supersededBy, entry.claim.sessionId), new Date()));
        this.report(
          `converged duplicate journal record ${entry.claim.runId} (session ${entry.claim.sessionId}) as`
            + ` superseded by run ${entry.supersededBy}`,
        );
      }
      for (const record of owners) {
        try {
          await this.reconcileRecord(journal, record);
        } catch (error) {
          this.report(`reconciliation of run ${record.runId} failed: ${errorText(error)}`);
        }
      }
      const stillPending = this.registry
        .list()
        .some((candidate) => !isTerminal(candidate) && this.supervisor.serviceHomeOf(candidate.serviceId) === home);
      if (!stillPending) this.releaseHome(home);
    }
  }

  private async reconcileRecord(journal: RunJournal, record: JournalRecord): Promise<void> {
    const service = this.supervisor.runningServiceForWorkspace(record.workspace);
    const observation = service === null
      ? ({ serviceAlive: false, session: "missing", events: [], asOfSeq: 0 } satisfies ReconcileObservation)
      : await this.observe(this.supervisor.access(service.serviceId), record);
    const decision = reconcileDecision(record, observation);
    // Bring the recovered run into this process's registry in both cases: `list_runs`/`get_run`
    // must be able to answer for a run that lost its process, and the terminal write stays with
    // `settle()` (the single writer).
    const run = restoredRecord(record, service?.serviceId ?? record.serviceId);
    try {
      this.registry.acquireSession(run.serviceId, run.sessionId);
    } catch (error) {
      // Another run of this process already owns the session: adopting would create two owners.
      this.report(`not adopting run ${record.runId}: ${errorText(error)}`);
      return;
    }
    this.registry.add(run);
    if (decision.kind === "adopt") {
      run.lastEventSeq = Math.max(run.lastEventSeq, decision.lastEventSeq);
      journal.write(journalRecordFor(run));
      this.report(`adopted run ${record.runId} (session ${record.sessionId}) left behind by a previous MCP process`);
      await this.refresh(run);
      return;
    }
    if (service === null) {
      // No live service for that workspace: `journalRun()` cannot resolve a service home from a
      // service id this process never issued, so the record is persisted through the journal we
      // read it from.
      this.settleRun(run, decision.outcome);
      journal.write(journalRecordFor(run));
    } else {
      this.settleRun(run, decision.outcome);
    }
    this.report(
      `settled run ${record.runId} recovered from the run journal as ${run.status}`
        + `${run.reason === null ? "" : ` (${run.reason})`}`,
    );
  }

  /** Observes one journaled session through the service that now serves its workspace. */
  private async observe(access: ServiceAccess, record: JournalRecord): Promise<ReconcileObservation> {
    const listResult = await this.perform(access, () => access.client.call("session/list", { _request: {} }));
    if (!listResult.ok) return observationFromFailure(listResult.failure);
    const summary = listResult.value.items.find((item: SessionSummary) => item.sessionId === record.sessionId);
    if (summary === undefined) return { serviceAlive: true, session: "missing", events: [], asOfSeq: 0 };
    const projectionsResult = await this.perform(access, () =>
      access.client.call("session/projections", { request: { sessionId: record.sessionId } }),
    );
    if (!projectionsResult.ok) return observationFromFailure(projectionsResult.failure);
    const projections = projectionsResult.value;
    if (projections === null) return { serviceAlive: true, session: "missing", events: [], asOfSeq: 0 };
    const eventsResult = await this.perform(access, () =>
      access.client.readEvents(record.sessionId, record.startEventSeq, projections.asOfSeq),
    );
    if (!eventsResult.ok) return observationFromFailure(eventsResult.failure);
    return {
      serviceAlive: true,
      session: summary.running === true ? "running" : "idle",
      events: eventsResult.value,
      asOfSeq: projections.asOfSeq,
    };
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
    // R3-5, additive: progress markers from the same window. Scalars copied from recorded fields
    // only, so no payload text (and therefore no tool parameter) can reach a snapshot.
    run.progress = projectStepProgress(events);
    // Durable progress marker: a later process resumes from here instead of replaying history.
    // Written only when the window actually carried events, so a 400 ms poll loop over a quiet
    // session does not rewrite the same record forever.
    if (events.length > 0) this.journalRun(run);
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

/** Production journal factory: one `runs/` directory inside the service home. */
function defaultJournalFor(
  serviceHome: string,
  onProblem: (problem: JournalProblem) => void,
): RunJournal {
  return new RunJournal(serviceHome, onProblem);
}

/** Production adopt lock: `wx` file + holder-liveness check (see `run/adopt-lock.ts`). */
function defaultAdoptLockFor(serviceHome: string, onProblem: (message: string) => void): AdoptLock {
  return new AdoptLock(serviceHome, { onProblem });
}

/**
 * Canonical key for a concurrency slot.
 *
 * `realpathSync` is what makes the reservation atomic *and* spelling-proof: `C:\ws`, `C:\ws\` and
 * `C:/WS` all collapse onto the same key before any `await`, so two concurrent submissions to "the
 * same workspace" cannot slip past each other by spelling the path differently. It is the same
 * canonicalisation the workspace policy applies asynchronously (`resolveWorkspace`), and it is only
 * a *key*: validation (absolute, directory, allow-list) stays in `resolveWorkspace`.
 */
function admissionKey(workspace: string): string {
  try {
    return realpathSync(workspace);
  } catch {
    // The path does not exist (yet): fall back to a lexical key. `resolveWorkspace` will refuse it
    // if it is not a directory, so no run can start under an unreserved key.
    return resolve(workspace);
  }
}

/**
 * Maps an observation failure onto the reconciliation vocabulary.
 *
 * `not-found` means the Host no longer knows the session — that is "the session disappeared"
 * (the same rule `refresh` applies when projections are `null`), not a reason to propagate a
 * caller error out of a background pass.
 */
function observationFromFailure(failure: ClassifiedWireFailure): ReconcileObservation {
  if (failure.kind === "not-found") return { serviceAlive: true, session: "missing", events: [], asOfSeq: 0 };
  return { serviceAlive: true, session: "missing", events: [], asOfSeq: 0, failure };
}
