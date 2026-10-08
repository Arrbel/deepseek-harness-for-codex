// Reconciliation end to end (R3-3): the passes a *new* MCP process performs on journals that a
// dead one left behind.
//
// The supervisor and the Host client are injected seams, so the three branches (still running →
// adopt, idle without a `turn/end` → failed, service gone → failed) are exercised deterministically
// without spawning anything. The crash is injected the honest way: a real journal file on disk,
// written as if the previous process had died after its last successful write.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JOURNAL_VERSION, RunJournal, type JournalRecord } from "../../src/run/journal.js";
import { RunOrchestrator } from "../../src/run/orchestrator.js";
import { AdoptLock } from "../../src/run/adopt-lock.js";
import type { ServiceAccess, ServiceRecord, ServiceSupervisor } from "../../src/service/supervisor.js";
import type { DshClient } from "../../src/dsh/client.js";
import type { HistoryEvent } from "../../src/dsh/types.js";
import "../support/isolation.js";

const scratch: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dsh-recovery-"));
  scratch.push(root);
  return root;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: JOURNAL_VERSION,
    runId: "11111111-1111-4111-8111-111111111111",
    serviceId: "svc-old",
    sessionId: "ses-1",
    sessionReused: false,
    workspace: "C:\\ws",
    task: "the task that was running",
    webUrl: "http://127.0.0.1:51234/?token=old",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: null,
    status: "running",
    reason: null,
    lastKnownSeq: 5,
    startEventSeq: 3,
    sawRunningSession: true,
    cancelRequested: false,
    error: null,
    ...overrides,
  };
}

interface FakeHost {
  running: boolean;
  asOfSeq: number;
  events: HistoryEvent[];
  projections: { asOfSeq: number } | null;
  calls: string[];
}

function fakeSupervisor(root: string, host: FakeHost | null): ServiceSupervisor {
  const serviceHome = join(root, "services", "ws-key");
  const dataDirectory = root;
  const record = {
    serviceId: "svc-new",
    workspace: "C:\\ws",
    serviceHome,
    status: "running",
    webUrl: "http://127.0.0.1:60000/?token=new",
  } as unknown as ServiceRecord;
  const client = {
    call: async (method: string): Promise<unknown> => {
      host?.calls.push(method);
      if (method === "session/list") {
        return { items: [{ sessionId: "ses-1", running: host?.running ?? false, blank: false, cwd: "C:\\ws" }] };
      }
      if (method === "session/projections") return host?.projections ?? null;
      throw new Error(`unexpected call: ${method}`);
    },
    readEvents: async (): Promise<HistoryEvent[]> => host?.events ?? [],
  } as unknown as DshClient;

  const fake = {
    getDataDirectory: () => dataDirectory,
    serviceHomes: () => [serviceHome],
    runningServiceForWorkspace: (workspace: string) =>
      host === null ? null : { ...record, workspace } as ServiceRecord,
    access: (): ServiceAccess => ({ record, client, running: true }),
    serviceHomeOf: (serviceId: string) => (serviceId === "svc-new" || serviceId === "svc-old" ? serviceHome : null),
    list: () => [],
  };
  return fake as unknown as ServiceSupervisor;
}

function journalFor(serviceHome: string, problems: string[] = []): RunJournal {
  return new RunJournal(serviceHome, (problem) => problems.push(`${problem.path}: ${problem.message}`));
}

/** Writes the journal a crashed process would have left behind. */
function seedJournal(root: string, entry: JournalRecord, options: { halfWritten?: boolean } = {}): RunJournal {
  const serviceHome = join(root, "services", "ws-key");
  const journal = journalFor(serviceHome);
  expect(journal.write(entry)).toBe(true);
  if (options.halfWritten === true) {
    // The writer died between the temporary write and the rename.
    const runs = join(serviceHome, "runs");
    writeFileSync(join(runs, `${entry.runId}.json.999.tmp`), "{ half written");
    writeFileSync(join(runs, "orphan.tmp"), "{ half written");
  }
  return journal;
}

describe("startup reconciliation from a journal (three branches)", () => {
  it("adopts a run whose Harness session is still running", async () => {
    const root = tempRoot();
    const journal = seedJournal(root, record());
    const problems: string[] = [];
    const host: FakeHost = { running: true, asOfSeq: 9, events: [{ event: { type: "assistant/message", seq: 9, data: {} } }], projections: { asOfSeq: 9 }, calls: [] };
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, host), {
      journalFor: (home) => journalFor(home, problems),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    const snapshots = await orchestrator.list();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ runId: record().runId, status: "running", serviceId: "svc-new" });
    // Progress is durable again, through the new service.
    const persisted = journal.read(record().runId);
    expect(persisted).toMatchObject({ status: "running", serviceId: "svc-new", lastKnownSeq: 9 });
    expect(problems.join("\n")).toContain("adopted run");
    // The half-written temporary files are never records, and the sweeper is allowed to drop them.
    expect(readdirSync(join(root, "services", "ws-key", "runs")).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed when the session is idle and no terminal turn was recorded", async () => {
    const root = tempRoot();
    const journal = seedJournal(root, record(), { halfWritten: true });
    const problems: string[] = [];
    const host: FakeHost = { running: false, asOfSeq: 9, events: [], projections: { asOfSeq: 9 }, calls: [] };
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, host), {
      journalFor: (home) => journalFor(home, problems),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    const persisted = journal.read(record().runId);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.reason).toBe("turn-unknown:missing-turn-end");
    expect(persisted?.finishedAt).not.toBeNull();
    // The conclusion is visible on the normal surface too.
    const snapshot = (await orchestrator.list())[0];
    expect(snapshot).toMatchObject({ status: "failed", reason: "turn-unknown:missing-turn-end" });
    expect(snapshot?.nextAction).toBe("report-only");
    expect(snapshot?.webUrlStale).toBe(false);
  });

  it("takes the recorded outcome when the Host finished the turn before the crash", async () => {
    const root = tempRoot();
    const journal = seedJournal(root, record());
    const host: FakeHost = {
      running: false,
      asOfSeq: 12,
      events: [{ event: { type: "turn/end", seq: 12, data: { turn: 1, reason: { kind: "completed" } } } }],
      projections: { asOfSeq: 12 },
      calls: [],
    };
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, host), { journalFor: (home) => journalFor(home) });

    await orchestrator.reconcile();

    expect(journal.read(record().runId)?.status).toBe("succeeded");
    expect((await orchestrator.list())[0]).toMatchObject({ status: "succeeded", reason: null, webUrlStale: false });
  });

  it("fails with a stale link when no service serves the workspace any more", async () => {
    const root = tempRoot();
    const journal = seedJournal(root, record());
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, null), { journalFor: (home) => journalFor(home) });

    await orchestrator.reconcile();

    const snapshot = (await orchestrator.list())[0];
    expect(snapshot).toMatchObject({ status: "failed", reason: "service-unreachable", webUrlStale: true });
    expect(snapshot?.nextAction).toBe("restart-service");
    expect(journal.read(record().runId)?.reason).toBe("service-unreachable");
  });
});

describe("duplicate ownership claims never get two owners (U-3, defensive)", () => {
  it("lets only the newest claim act and converges the duplicate to a terminal state", async () => {
    const root = tempRoot();
    // Two non-terminal records for the *same* Harness session, as the pre-fix race could leave.
    const older = record({ runId: "aaaaaaaa-0000-4000-8000-000000000001", startedAt: "2026-10-09T00:00:00.000Z", lastKnownSeq: 5 });
    const newer = record({ runId: "bbbbbbbb-0000-4000-8000-000000000002", startedAt: "2026-10-09T00:00:30.000Z", lastKnownSeq: 9 });
    const journal = seedJournal(root, older);
    expect(journal.write(newer)).toBe(true);
    const host: FakeHost = { running: false, asOfSeq: 9, events: [], projections: { asOfSeq: 9 }, calls: [] };
    const problems: string[] = [];
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, host), {
      journalFor: (home) => journalFor(home, problems),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    // Exactly one claim acted — the newer one — and it settled by the ordinary idle rule.
    const newest = journal.read(newer.runId);
    expect(newest?.status).toBe("failed");
    expect(newest?.reason).toBe("turn-unknown:missing-turn-end");
    // The duplicate is converged, not left as non-terminal evidence.
    const duplicate = journal.read(older.runId);
    expect(duplicate?.status).toBe("failed");
    expect(duplicate?.reason).toBe("turn-unknown:superseded-duplicate-journal");
    expect(duplicate?.error).toContain(newer.runId);
    expect(duplicate?.finishedAt).not.toBeNull();
    expect(problems.join("\n")).toContain(`converged duplicate journal record ${older.runId}`);
    // Nothing on disk is left running, and only one run was ever adopted/registered.
    expect(journal.list().filter((entry) => entry.status === "running")).toEqual([]);
    expect(await orchestrator.list()).toHaveLength(1);
    expect((await orchestrator.list())[0]?.runId).toBe(newer.runId);
  });
});

describe("the adopt lock gates terminal writes (red line #2)", () => {
  it("skips reconciliation entirely when another live process owns the runs", async () => {
    const root = tempRoot();
    const serviceHome = join(root, "services", "ws-key");
    const journal = seedJournal(root, record());
    // A live holder: pid 9999 exists according to the injected seam.
    const holder = new AdoptLock(serviceHome, {
      pid: () => 9999,
      hostname: () => "host-a",
      isAlive: (pid) => pid === 9999,
      onProblem: () => undefined,
    });
    expect(holder.acquire()).not.toBeNull();

    const problems: string[] = [];
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, null), {
      journalFor: (home) => journalFor(home, problems),
      adoptLockFor: (home) =>
        new AdoptLock(home, {
          pid: () => 4321,
          hostname: () => "host-a",
          isAlive: (pid) => pid === 9999, // the other holder is alive
          onProblem: (message) => problems.push(message),
        }),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    // The journal is untouched: no terminal state was written by the loser.
    expect(journal.read(record().runId)).toMatchObject({ status: "running", reason: null, finishedAt: null });
    expect((await orchestrator.list())).toEqual([]);
    expect(problems.join("\n")).toContain("another MCP process (pid 9999)");
  });

  it("breaks a lock whose owner died and then reconciles normally", async () => {
    const root = tempRoot();
    const serviceHome = join(root, "services", "ws-key");
    const journal = seedJournal(root, record());
    const dead = new AdoptLock(serviceHome, {
      pid: () => 1234,
      hostname: () => "host-a",
      isAlive: () => true,
      onProblem: () => undefined,
    });
    expect(dead.acquire()).not.toBeNull();

    const problems: string[] = [];
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, null), {
      journalFor: (home) => journalFor(home, problems),
      adoptLockFor: (home) =>
        new AdoptLock(home, {
          pid: () => 4321,
          hostname: () => "host-a",
          isAlive: () => false, // nobody is alive: the previous holder crashed
          onProblem: (message) => problems.push(message),
        }),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    expect(problems.join("\n")).toContain("which is gone; breaking it");
    expect(journal.read(record().runId)?.status).toBe("failed");
  });
});

describe("the journal never breaks a run", () => {
  it("keeps working when the journal cannot be written at all", async () => {
    const root = tempRoot();
    const serviceHome = join(root, "services", "ws-key");
    const journal = seedJournal(root, record());
    // A directory where this process's temporary file must go: the atomic write cannot complete.
    mkdirSync(join(serviceHome, "runs", `${record().runId}.json.${String(process.pid)}.tmp`), { recursive: true });
    const problems: string[] = [];
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, null), {
      journalFor: (home) => journalFor(home, problems),
      onProblem: (message) => problems.push(message),
    });

    // Reconciliation must complete (and report), not throw. The journal surfaces its own failure
    // through the factory's sink; the orchestrator reports what it concluded.
    await expect(orchestrator.reconcile()).resolves.toBeUndefined();
    expect(problems.join("\n")).toContain("journal write failed");
    expect(orchestrator.journalProblems().join("\n")).toContain("settled run");
    // The conclusion still reaches the caller through the normal surface...
    expect((await orchestrator.list())[0]).toMatchObject({ status: "failed", reason: "service-unreachable" });
    // ...and the previous durable record was left exactly as it was.
    expect(journal.read(record().runId)).toMatchObject({ status: "running", reason: null, finishedAt: null });
  });

  it("reports an unreadable record and keeps going", async () => {
    const root = tempRoot();
    const serviceHome = join(root, "services", "ws-key");
    mkdirSync(join(serviceHome, "runs"), { recursive: true });
    writeFileSync(join(serviceHome, "runs", "broken.json"), "{ not json");
    const problems: string[] = [];
    const orchestrator = new RunOrchestrator(fakeSupervisor(root, null), {
      journalFor: (home) => journalFor(home, problems),
      onProblem: (message) => problems.push(message),
    });

    await orchestrator.reconcile();

    expect(problems.join("\n")).toContain("broken.json");
    expect(readFileSync(join(serviceHome, "runs", "broken.json"), "utf8")).toBe("{ not json");
  });
});
