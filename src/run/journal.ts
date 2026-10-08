// Run journal: the durable record that lets a **later** MCP process reconcile a run (R3-3).
//
// Why it exists: a run lives in this process's memory (`run/registry.ts`). If the MCP host is
// killed or restarted, the Harness-side turn may still be running or may already have finished,
// and the caller would get *no* conclusion at all. The journal is written before that can matter
// and is read back by `run/reconcile.ts`.
//
// Two rules, both from the task's red lines:
//
//   1. **Atomic**: every write goes to a `.tmp` file first and is then `rename`d over the target,
//      so a crash can never leave a half-written journal that a later process would trust. A
//      leftover `.tmp` is never read as a record (see {@link RunJournal.list}).
//   2. **Advisory**: a journal write that fails (read-only data directory, full disk, a path we
//      refuse) must never break the run itself — every method reports the problem and returns a
//      falsy value instead of throwing.
//
// A third rule is about *what* is allowed to reach the disk (R3-3b): the record's `webUrl` carries
// the launch token, so it is kept **only while the token is live** — a `running` record keeps the
// full link (adoption must be able to hand it back), a terminal record keeps origin + path only.
// `docs/operations.md` §8.3 states the same contract for callers.
//
// `runId` is validated as a plain file name: a corrupt or hostile journal must not be able to
// steer a read/write outside `runs/`.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "../util/redaction.js";
import type { FailureReason, RunStatus } from "./types.js";

/** Journal format version. A record whose version we do not know is refused, never guessed. */
export const JOURNAL_VERSION = 1;

/** Directory holding one record per run, inside a service home. */
export const RUNS_DIR_NAME = "runs";

/** Suffix of the temporary file an atomic write goes through. */
export const JOURNAL_TMP_SUFFIX = ".tmp";

/** The persisted shape of one run. */
export interface JournalRecord {
  version: number;
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  workspace: string;
  task: string;
  webUrl: string;
  /** ISO timestamp of the run's creation. */
  startedAt: string;
  /** ISO timestamp of the terminal write; `null` while the run is not settled. */
  finishedAt: string | null;
  status: RunStatus;
  /** Why the run failed; `null` unless `status === "failed"`. */
  reason: FailureReason | null;
  /** Highest event sequence this process observed; the polling baseline after a restart. */
  lastKnownSeq: number;
  /** Sequence the run started reading from (so a recovered run does not replay history). */
  startEventSeq: number;
  /** True once the Host reported the session as running (the fail-closed marker). */
  sawRunningSession: boolean;
  cancelRequested: boolean;
  error: string | null;
}

/**
 * True when a URL still carries the launch credential DSH hands out (`?token=…`).
 *
 * Exported so the invariant can be asserted from the outside (a test, a future audit) without
 * duplicating the pattern that `util/redaction.ts` already owns.
 */
export function urlCarriesCredential(webUrl: string): boolean {
  return /[?&]token=/iu.test(webUrl);
}

/**
 * The `webUrl` a record is allowed to keep on disk (R3-3b, `docs/operations.md` §8.3).
 *
 * * `running` → the **full** link. The token is live, and adoption must be able to hand the caller
 *   a clickable page. Keeping it costs nothing that is not already true.
 * * terminal → **origin + path only**. By then the credential opens nothing the user still needs,
 *   and a dead credential must not stay on disk.
 */
export function journalWebUrl(webUrl: string, status: RunStatus): string {
  if (status === "running") return webUrl;
  return stripUrlCredential(webUrl);
}

/** Removes the credential from a URL, falling back to cutting the query/fragment when unparseable. */
function stripUrlCredential(webUrl: string): string {
  let stripped: string;
  try {
    const parsed = new URL(webUrl);
    stripped = `${parsed.origin}${parsed.pathname}`;
  } catch {
    stripped = webUrl.replace(/[?#].*$/u, "");
  }
  // Belt and braces: if a registered secret ended up anywhere else in the string (a path segment,
  // userinfo), the project's single redactor still catches it.
  return redactSecrets(stripped);
}

/** A problem the journal could not act on; surfaced, never thrown. */
export interface JournalProblem {
  readonly path: string;
  readonly message: string;
}
const RUN_STATUSES: readonly RunStatus[] = ["running", "succeeded", "failed", "cancelled"];
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** True when a string can be used as a journal file name (no separators, no traversal). */
export function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId) && !runId.includes("..");
}

/** The path of one run's journal inside a service home. */
export function journalPath(serviceHome: string, runId: string): string {
  return join(serviceHome, RUNS_DIR_NAME, `${runId}.json`);
}

/** Serializes a record exactly as it is written (stable key order, trailing newline). */
export function serializeJournal(record: JournalRecord): string {
  const ordered: JournalRecord = {
    version: record.version,
    runId: record.runId,
    serviceId: record.serviceId,
    sessionId: record.sessionId,
    sessionReused: record.sessionReused,
    workspace: record.workspace,
    task: record.task,
    webUrl: record.webUrl,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    status: record.status,
    reason: record.reason,
    lastKnownSeq: record.lastKnownSeq,
    startEventSeq: record.startEventSeq,
    sawRunningSession: record.sawRunningSession,
    cancelRequested: record.cancelRequested,
    error: record.error,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function finiteSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses one journal record, strictly.
 *
 * Returns `null` for anything malformed — a corrupt journal is *evidence*, and the caller's job is
 * to decide from the facts it can still establish, never from a guessed field.
 */
export function parseJournal(text: string): JournalRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw["version"] !== JOURNAL_VERSION) return null;
  if (!nonEmptyString(raw["runId"]) || !isSafeRunId(raw["runId"])) return null;
  if (!nonEmptyString(raw["serviceId"]) || !nonEmptyString(raw["sessionId"])) return null;
  if (!nonEmptyString(raw["workspace"]) || typeof raw["task"] !== "string") return null;
  if (typeof raw["webUrl"] !== "string") return null;
  if (!nonEmptyString(raw["startedAt"]) || Number.isNaN(Date.parse(raw["startedAt"]))) return null;
  const finishedAt = raw["finishedAt"];
  if (finishedAt !== null && !(nonEmptyString(finishedAt) && !Number.isNaN(Date.parse(finishedAt)))) return null;
  const status = raw["status"];
  if (typeof status !== "string" || !RUN_STATUSES.includes(status as RunStatus)) return null;
  const reason = raw["reason"];
  if (reason !== null && !nonEmptyString(reason)) return null;
  // A terminal record must carry its finish time and a `running` record must not: the two fields
  // are written together by `journalRecordFor`, so a mismatch means the file is not ours.
  if (status === "running" && (finishedAt !== null || reason !== null)) return null;
  if (status !== "running" && (finishedAt === null || (status === "failed") !== (reason !== null))) return null;
  if (!finiteSeq(raw["lastKnownSeq"]) || !finiteSeq(raw["startEventSeq"])) return null;
  if (typeof raw["sawRunningSession"] !== "boolean" || typeof raw["cancelRequested"] !== "boolean") return null;
  const error = raw["error"];
  if (error !== null && typeof error !== "string") return null;

  return {
    version: JOURNAL_VERSION,
    runId: raw["runId"],
    serviceId: raw["serviceId"],
    sessionId: raw["sessionId"],
    sessionReused: raw["sessionReused"] === true,
    workspace: raw["workspace"],
    task: raw["task"],
    webUrl: journalWebUrl(raw["webUrl"] as string, status as RunStatus),
    startedAt: raw["startedAt"],
    finishedAt: finishedAt as string | null,
    status: status as RunStatus,
    // An unknown reason string is kept: the vocabulary is merge-extensible upstream, and an
    // unrecognized reason degrades to `nextAction: "report-only"` rather than to a guess.
    reason: reason as FailureReason | null,
    lastKnownSeq: raw["lastKnownSeq"],
    startEventSeq: raw["startEventSeq"],
    sawRunningSession: raw["sawRunningSession"],
    cancelRequested: raw["cancelRequested"],
    error: error as string | null,
  };
}

/**
 * Every service home under a data directory (`<dataDir>/services/<key>`).
 *
 * Used by reconciliation to find journals of workspaces this process never served. A missing
 * `services/` directory (nothing installed yet) is an empty list, not an error.
 */
export function serviceHomesUnder(dataDirectory: string): string[] {
  try {
    return readdirSync(join(dataDirectory, "services"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(dataDirectory, "services", entry.name));
  } catch {
    return [];
  }
}

/** A `runs/` directory of one service home. */
export class RunJournal {
  private readonly onProblem: (problem: JournalProblem) => void;

  public constructor(
    private readonly serviceHome: string,
    onProblem: (problem: JournalProblem) => void = () => undefined,
  ) {
    this.onProblem = onProblem;
  }

  public get directory(): string {
    return join(this.serviceHome, RUNS_DIR_NAME);
  }

  public pathFor(runId: string): string {
    return journalPath(this.serviceHome, runId);
  }

  /** Every readable, non-temporary record. Unreadable files are reported and skipped. */
  public list(): JournalRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch {
      return []; // no journal yet: an empty directory is the normal startup state
    }
    const records: JournalRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(JOURNAL_TMP_SUFFIX)) continue;
      const path = join(this.directory, entry);
      const text = this.readText(path);
      if (text === null) continue;
      const record = parseJournal(text);
      if (record === null) {
        this.onProblem({ path, message: "journal record is malformed; ignoring it" });
        continue;
      }
      records.push(record);
    }
    return records;
  }

  /** One record, or `null` when it is absent or unreadable. */
  public read(runId: string): JournalRecord | null {
    if (!isSafeRunId(runId)) return null;
    const text = this.readText(this.pathFor(runId));
    if (text === null) return null;
    const record = parseJournal(text);
    if (record === null) {
      this.onProblem({ path: this.pathFor(runId), message: "journal record is malformed; ignoring it" });
      return null;
    }
    return record;
  }

  /**
   * Writes one record atomically. Returns `false` (and reports) when it could not be persisted —
   * the caller's run must keep working regardless.
   */
  public write(record: JournalRecord): boolean {
    if (!isSafeRunId(record.runId)) {
      this.onProblem({ path: this.pathFor(record.runId), message: "refusing to journal an unsafe runId" });
      return false;
    }
    const target = this.pathFor(record.runId);
    // Last line of defence for the credential rule (R3-3b): whichever caller built this record,
    // a terminal one never carries the launch token to disk.
    const safe: JournalRecord = { ...record, webUrl: journalWebUrl(record.webUrl, record.status) };
    // Per-process temporary name: two processes writing different records never collide on it.
    const temporary = `${target}.${String(process.pid)}${JOURNAL_TMP_SUFFIX}`;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, serializeJournal(safe), { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, target);
      return true;
    } catch (error) {
      this.onProblem({ path: target, message: `journal write failed: ${error instanceof Error ? error.message : String(error)}` });
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Nothing left to do: the failure above is the actionable part.
      }
      return false;
    }
  }

  /** Removes one record (used to drop evidence we can no longer trust). */
  public remove(runId: string): boolean {
    if (!isSafeRunId(runId)) return false;
    try {
      rmSync(this.pathFor(runId), { force: true });
      return true;
    } catch (error) {
      this.onProblem({ path: this.pathFor(runId), message: `journal removal failed: ${error instanceof Error ? error.message : String(error)}` });
      return false;
    }
  }

  /**
   * Deletes leftover `.tmp` files from crashed writers.
   *
   * Only files older than `maxAgeMs` are touched, so a *concurrent* writer's in-flight temporary
   * file is never deleted from under it.
   */
  public sweepTemporaries(maxAgeMs = 60_000, now: Date = new Date()): number {
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith(JOURNAL_TMP_SUFFIX)) continue;
      const path = join(this.directory, entry);
      try {
        if (now.getTime() - statSync(path).mtimeMs < maxAgeMs) continue;
        rmSync(path, { force: true });
        removed += 1;
      } catch (error) {
        this.onProblem({ path, message: `temporary journal cleanup failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return removed;
  }

  private readText(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      // `ENOENT` is the ordinary "no journal for this run" case, not a problem worth reporting.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onProblem({ path, message: `journal read failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      return null;
    }
  }
}
