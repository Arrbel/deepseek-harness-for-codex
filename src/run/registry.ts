// Run registry: run records, the active-session lock, and snapshot projection.
//
// `run/*` is the only layer that decides *which run owns which session*, so the lock lives
// here rather than in the service layer. Records are mutable internally; callers only ever
// see the projected {@link RunSnapshot}.

import type { FailureReason, RunSnapshot, RunStatus } from "./types.js";

/** One run as this process tracks it. */
export interface RunRecord {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  startEventSeq: number;
  task: string;
  workspace: string;
  webUrl: string;
  status: RunStatus;
  /** Set by `settle()`; a second terminal write is dropped instead of overwriting this one. */
  settled: boolean;
  /** Why the run failed; `null` unless `status === "failed"`. */
  reason: FailureReason | null;
  cancelRequested: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  assistantText: string;
  lastEventSeq: number;
  /** True once `session/list` reported this session as running (fail-closed marker check). */
  sawRunningSession: boolean;
  error: string | null;
}

/** Creates a fresh `running` record. */
export function createRunRecord(
  init: Omit<
    RunRecord,
    "status" | "settled" | "reason" | "cancelRequested" | "finishedAt" | "assistantText" | "error" | "sawRunningSession"
  > &
    Partial<Pick<RunRecord, "sawRunningSession">>,
): RunRecord {
  return {
    ...init,
    status: "running",
    settled: false,
    reason: null,
    cancelRequested: false,
    finishedAt: null,
    assistantText: "",
    sawRunningSession: init.sawRunningSession ?? false,
    error: null,
  };
}

/** Owns the runs of one MCP server process plus the active-session lock. */
export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly activeSessions = new Set<string>();

  /** Registers a new run record. */
  public add(run: RunRecord): RunRecord {
    this.runs.set(run.runId, run);
    return run;
  }

  /** All runs, insertion-ordered. */
  public list(): RunRecord[] {
    return [...this.runs.values()];
  }

  /** One run or the caller-facing error. */
  public require(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  /** The composed lock key of one service session. */
  public static sessionKey(serviceId: string, sessionId: string): string {
    return `${serviceId}:${sessionId}`;
  }

  /** Claims an active session for a run; throws when another run holds it. */
  public acquireSession(serviceId: string, sessionId: string): void {
    const key = RunRegistry.sessionKey(serviceId, sessionId);
    if (this.activeSessions.has(key)) throw new Error(`Harness session already has an active MCP run: ${sessionId}`);
    this.activeSessions.add(key);
  }

  /** Releases a session claim (idempotent). */
  public releaseSession(serviceId: string, sessionId: string): void {
    this.activeSessions.delete(RunRegistry.sessionKey(serviceId, sessionId));
  }

  /** Releases every session claim of one service (service stop / crash). */
  public releaseService(serviceId: string): void {
    for (const key of [...this.activeSessions]) {
      if (key.startsWith(`${serviceId}:`)) this.activeSessions.delete(key);
    }
  }

  /** Run identifiers of every run that has not reached a terminal status. */
  public runningRunIds(): string[] {
    return this.list().filter((run) => run.status === "running").map((run) => run.runId);
  }

  /** Projects a record into the immutable snapshot returned to callers. */
  public static snapshot(run: RunRecord): RunSnapshot {
    return {
      runId: run.runId,
      serviceId: run.serviceId,
      sessionId: run.sessionId,
      sessionReused: run.sessionReused,
      task: run.task,
      workspace: run.workspace,
      webUrl: run.webUrl,
      status: run.status,
      reason: run.reason,
      cancelRequested: run.cancelRequested,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      assistantText: run.assistantText,
      lastEventSeq: run.lastEventSeq,
      error: run.error,
    };
  }
}
