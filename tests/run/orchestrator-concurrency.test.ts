// Concurrency end to end (R3-4), through `start_run` itself.
//
// The supervisor and the Host client are injected seams: the point here is the *admission* path
// (what the caller gets when it asks for too much) and that refusing never disturbs a running run.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunOrchestrator } from "../../src/run/orchestrator.js";
import { RUN_LIMIT_ENV } from "../../src/run/concurrency.js";
import type { ServiceAccess, ServiceRecord, ServiceSupervisor } from "../../src/service/supervisor.js";
import type { ServiceSnapshot } from "../../src/service/types.js";
import type { DshClient } from "../../src/dsh/client.js";
import type { HistoryEvent } from "../../src/dsh/types.js";
import type { RunSnapshot } from "../../src/run/types.js";
import "../support/isolation.js";

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeSession {
  running: boolean;
  events: HistoryEvent[];
}

/** A Host that answers exactly the calls `start_run`/`refresh`/`cancel_run` make. */
class FakeHost {
  public readonly sessions = new Map<string, FakeSession>();
  public readonly calls: string[] = [];
  private counter = 0;
  private readonly workspaceOf = new Map<string, string>();
  private readonly workspaceIds = new Map<string, string>();

  public seed(sessionId: string, session: FakeSession, workspace: string): void {
    this.sessions.set(sessionId, session);
    this.workspaceOf.set(sessionId, workspace);
  }

  public sessionEvents(sessionId: string): HistoryEvent[] | undefined {
    return this.sessions.get(sessionId)?.events;
  }

  public stopRunning(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session !== undefined) session.running = false;
  }

  public readonly call = async (method: string, params: unknown): Promise<unknown> => {
    this.calls.push(method);
    switch (method) {
      case "workspace/create": {
        const path = (params as { request?: { path?: string } }).request?.path ?? "C:\\ws";
        const existing = this.workspaceIds.get(path);
        const workspaceId = existing ?? `wsp-${String(this.workspaceIds.size + 1)}`;
        this.workspaceIds.set(path, workspaceId);
        return { workspace: { workspaceId } };
      }
      case "session/create": {
        this.counter += 1;
        const sessionId = `ses-${String(this.counter)}`;
        const workspaceId = (params as { request?: { workspaceId?: string } }).request?.workspaceId;
        const workspace = [...this.workspaceIds.entries()].find(([, id]) => id === workspaceId)?.[0] ?? "C:\\ws";
        this.seed(sessionId, { running: true, events: [] }, workspace);
        return { sessionId };
      }
      case "session/projections":
        return { asOfSeq: 1 };
      case "session/prompt":
        return {};
      case "session/cancel": {
        const request = (params as { request?: { sessionId?: string } }).request;
        if (request?.sessionId !== undefined) this.stopRunning(request.sessionId);
        return {};
      }
      case "session/list":
        return {
          items: [...this.sessions.entries()].map(([sessionId, session]) => ({
            sessionId,
            running: session.running,
            blank: false,
            cwd: this.workspaceOf.get(sessionId) ?? "C:\\ws",
          })),
        };
      default:
        throw new Error(`unexpected call: ${method}`);
    }
  };

  public readonly readEvents = async (sessionId: string): Promise<HistoryEvent[]> =>
    this.sessions.get(sessionId)?.events ?? [];

  public readonly client = { call: this.call, readEvents: this.readEvents } as unknown as DshClient;
}

interface Harness {
  readonly orchestrator: RunOrchestrator;
  readonly host: FakeHost;
  /** Lets the test hold every `service.start()` open, so two calls really overlap. */
  readonly gate: { open: () => void; readonly release: Promise<void>; readonly entered: () => number };
  /** Every `runs/` directory the fake created (i.e. every journal home in use). */
  readonly runsDirectories: () => string[];
}

function makeHarness(options: { runLimit?: number; gate?: boolean } = {}): Harness {
  const dataDirectory = tempDir("dsh-conc-data-");
  const host = new FakeHost();
  const services = new Map<string, ServiceRecord>();
  const clients = new Map<string, DshClient>();
  /** One service per workspace, exactly like the real supervisor. */
  const servicesByWorkspace = new Map<string, ServiceRecord>();
  let counter = 0;
  let entered = 0;
  let openGate = (): void => undefined;
  const release = new Promise<void>((resolveGate) => {
    openGate = () => {
      resolveGate();
    };
  });

  const supervisor = {
    getDataDirectory: () => dataDirectory,
    serviceHomes: () => [...services.values()].map((service) => service.serviceHome),
    serviceHomeOf: (serviceId: string) => services.get(serviceId)?.serviceHome ?? null,
    runningServiceForWorkspace: () => null, // no reconciliation activity in these tests
    list: () => {},
    start: async (input: { workspace: string; openBrowser?: boolean }): Promise<ServiceSnapshot> => {
      entered += 1;
      // Opt-in: when the test wants two submissions to *really* overlap, every call that reaches
      // the service waits here until the test opens the gate.
      if (options.gate === true) await release;
      const existing = servicesByWorkspace.get(input.workspace);
      if (existing !== undefined) {
        return { serviceId: existing.serviceId, workspace: input.workspace, webUrl: existing.webUrl, status: "running" } as unknown as ServiceSnapshot;
      }
      counter += 1;
      const serviceId = `svc-${String(counter)}`;
      const record = {
        serviceId,
        workspace: input.workspace,
        serviceHome: join(dataDirectory, "services", `k${String(counter)}`),
        status: "running",
        webUrl: `http://127.0.0.1:${String(60000 + counter)}/?token=fixture`,
      } as unknown as ServiceRecord;
      services.set(serviceId, record);
      clients.set(serviceId, host.client);
      servicesByWorkspace.set(input.workspace, record);
      return { serviceId, workspace: input.workspace, webUrl: record.webUrl, status: "running" } as unknown as ServiceSnapshot;
    },
    access: (serviceId: string): ServiceAccess => {
      const record = services.get(serviceId);
      const client = clients.get(serviceId);
      if (record === undefined || client === undefined) throw new Error(`Unknown serviceId: ${serviceId}`);
      return { record, client, running: true };
    },
  } as unknown as ServiceSupervisor;

  const orchestrator = new RunOrchestrator(
    supervisor,
    options.runLimit === undefined ? {} : { runLimit: options.runLimit, pollIntervalMs: 1 },
    [],
  );
  return {
    orchestrator,
    host,
    gate: { open: () => { openGate(); }, release, entered: () => entered },
    runsDirectories: () => [...new Set([...services.values()].map((service) => join(service.serviceHome, "runs")))],
  };
}

function turnEnd(kind: string, seq: number, extra: Record<string, unknown> = {}): HistoryEvent {
  return { event: { type: "turn/end", seq, data: { turn: 1, reason: { kind, ...extra } } } };
}

describe("one run per workspace", () => {
  it("refuses a second run in the same workspace, naming the run to wait for", async () => {
    const { orchestrator, host } = makeHarness();
    const workspace = tempDir("dsh-ws-a-");
    const first = await orchestrator.start({ workspace, task: "first task" });
    const creates = host.calls.filter((call) => call === "session/create").length;

    await expect(orchestrator.start({ workspace, task: "second task" })).rejects.toThrow(/already has a run in flight/u);
    await expect(orchestrator.start({ workspace, task: "second task" })).rejects.toThrow(new RegExp(first.runId, "u"));

    // No second session was created and no run was recorded for the refusal.
    expect(host.calls.filter((call) => call === "session/create")).toHaveLength(creates);
    expect(await orchestrator.list()).toHaveLength(1);
    expect(orchestrator.activeRuns().map((run) => run.runId)).toEqual([first.runId]);
    expect((await orchestrator.get(first.runId)).status).toBe("running");
  });

  it("admits a new run in that workspace once the first one is done", async () => {
    const { orchestrator, host } = makeHarness();
    const workspace = tempDir("dsh-ws-b-");
    const first = await orchestrator.start({ workspace, task: "first task" });
    host.sessionEvents(first.sessionId)?.push(turnEnd("completed", 5));
    host.stopRunning(first.sessionId);

    expect((await orchestrator.get(first.runId)).status).toBe("succeeded");

    const second = await orchestrator.start({ workspace, task: "second task" });
    expect(second.status).toBe("running");
    expect(await orchestrator.list()).toHaveLength(2);
  });
});

describe("the cross-workspace limit", () => {
  it("refuses the N+1-th run and explains how to make room", async () => {
    const { orchestrator } = makeHarness({ runLimit: 2 });
    await orchestrator.start({ workspace: tempDir("dsh-ws-1-"), task: "one" });
    await orchestrator.start({ workspace: tempDir("dsh-ws-2-"), task: "two" });

    await expect(orchestrator.start({ workspace: tempDir("dsh-ws-3-"), task: "three" })).rejects.toThrow(
      /Run limit reached \(2\/2 active in 2 workspaces\)/u,
    );
    await expect(orchestrator.start({ workspace: tempDir("dsh-ws-4-"), task: "four" })).rejects.toThrow(
      new RegExp(RUN_LIMIT_ENV, "u"),
    );

    expect(orchestrator.activeRuns()).toHaveLength(2);
    expect(await orchestrator.list()).toHaveLength(2);
  });

  it("frees the slot when a run fails, so another workspace can start", async () => {
    const { orchestrator, host } = makeHarness({ runLimit: 2 });
    const first = await orchestrator.start({ workspace: tempDir("dsh-ws-5-"), task: "one" });
    const second = await orchestrator.start({ workspace: tempDir("dsh-ws-6-"), task: "two" });
    await expect(orchestrator.start({ workspace: tempDir("dsh-ws-7-"), task: "three" })).rejects.toThrow(/Run limit/u);

    // The Host stops running the first session without ever publishing a terminal turn: the
    // existing fail-closed rule settles it, which is what releases its slot.
    host.stopRunning(first.sessionId);
    const failed = await orchestrator.get(first.runId);
    expect(failed).toMatchObject({ status: "failed", reason: "turn-unknown:missing-turn-end", nextAction: "report-only" });

    const third = await orchestrator.start({ workspace: tempDir("dsh-ws-8-"), task: "three" });
    expect(third.status).toBe("running");
    expect(orchestrator.activeRuns().map((run) => run.runId).sort()).toEqual([second.runId, third.runId].sort());
  });

  it("frees the slot when the turn completes (limit of one)", async () => {
    const { orchestrator, host } = makeHarness({ runLimit: 1 });
    const first = await orchestrator.start({ workspace: tempDir("dsh-ws-9-"), task: "one" });

    await expect(orchestrator.start({ workspace: tempDir("dsh-ws-10-"), task: "two" })).rejects.toThrow(/1\/1 active/u);

    host.sessionEvents(first.sessionId)?.push(turnEnd("completed", 9));
    host.stopRunning(first.sessionId);
    expect((await orchestrator.get(first.runId)).status).toBe("succeeded");

    await expect(orchestrator.start({ workspace: tempDir("dsh-ws-11-"), task: "two" })).resolves.toMatchObject({
      status: "running",
    });
  });
});

describe("cancelling one run does not disturb another", () => {
  it("cancels only the requested run and frees only its slot", async () => {
    const { orchestrator, host } = makeHarness({ runLimit: 2 });
    const workspaceA = tempDir("dsh-ws-c1-");
    const first = await orchestrator.start({ workspace: workspaceA, task: "one" });
    const second = await orchestrator.start({ workspace: tempDir("dsh-ws-c2-"), task: "two" });

    expect(await orchestrator.cancel(first.runId)).toMatchObject({ status: "cancelled", reason: null });
    expect((await orchestrator.get(second.runId)).status).toBe("running");
    expect(host.sessions.get(second.sessionId)?.running).toBe(true);
    expect(orchestrator.activeRuns().map((run) => run.runId)).toEqual([second.runId]);

    // The freed slot is usable again in the cancelled run's workspace.
    await expect(orchestrator.start({ workspace: workspaceA, task: "again" })).resolves.toMatchObject({
      status: "running",
    });
  });
});

describe("the vocabulary stays closed", () => {
  it("never reports a status outside running/succeeded/failed/cancelled", async () => {
    const { orchestrator } = makeHarness({ runLimit: 1 });
    const first = await orchestrator.start({ workspace: tempDir("dsh-ws-v1-"), task: "one" });
    const refused = await orchestrator.start({ workspace: tempDir("dsh-ws-v2-"), task: "two" }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Error);
    const snapshots: RunSnapshot[] = await orchestrator.list();
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(["running"]);
    expect(snapshots.map((snapshot) => snapshot.runId)).toEqual([first.runId]);
    for (const snapshot of snapshots) {
      expect(["running", "succeeded", "failed", "cancelled"]).toContain(snapshot.status);
      // A refusal is not a run: `nextAction` describes real runs only.
      expect(["none", "retry-narrower", "new-session", "restart-service", "relogin", "report-only"]).toContain(
        snapshot.nextAction,
      );
    }
    expect(orchestrator.activeRuns()).toHaveLength(1);
  });
});

/**
 * Marks a promise as handled while it is still in flight.
 *
 * A synchronous refusal rejects before `Promise.allSettled` can attach its handler; without this
 * the refusal would be reported as an unhandled rejection during the gate wait.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Journal records on disk, across every service home the fake created. */function journalRecords(harness: Harness): { runId: string; workspace: string; sessionId: string; status: string }[] {
  const records: { runId: string; workspace: string; sessionId: string; status: string }[] = [];
  for (const runs of harness.runsDirectories()) {
    for (const entry of readdirSync(runs)) {
      if (!entry.endsWith(".json")) continue;
      const record = JSON.parse(readFileSync(join(runs, entry), "utf8")) as {
        runId: string;
        workspace: string;
        sessionId: string;
        status: string;
      };
      records.push(record);
    }
  }
  return records;
}

describe("concurrent submissions are refused atomically (N-R3-1)", () => {
  it("admits exactly one of two same-workspace calls started in the same tick", async () => {
    const harness = makeHarness({ runLimit: 2, gate: true });
    const workspace = tempDir("dsh-ws-race-a-");

    // Both calls are started in the same tick; neither is awaited before the other begins. The
    // reservation block inside `start_run` is synchronous, so the verdict is decided right here.
    const calls = [
      observed(harness.orchestrator.start({ workspace, task: "first" })),
      observed(harness.orchestrator.start({ workspace, task: "second" })),
    ];
    // Let both submissions run up to their first suspension, then release the service gate (in the
    // mutated shape both would be queued behind it, which is exactly the defect this pins).
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.gate.open();
    const outcomes = await Promise.allSettled(calls);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already has (a start_run in progress|a run in flight)/u,
    );

    // Exactly one run, exactly one journal record, and only one session was ever created.
    const runs = await harness.orchestrator.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    const records = journalRecords(harness);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("running");
    expect(harness.host.calls.filter((call) => call === "session/create")).toHaveLength(1);
    harness.gate.open();
  });

  it("admits exactly N of N+1 concurrent cross-workspace calls", async () => {
    const harness = makeHarness({ runLimit: 2, gate: true });
    const workspaces = ["a", "b", "c"].map((suffix) => tempDir(`dsh-ws-race-${suffix}-`));

    const calls = workspaces.map((workspace) => observed(harness.orchestrator.start({ workspace, task: "task" })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    harness.gate.open();
    const outcomes = await Promise.allSettled(calls);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/Run limit reached \(2\/2 active/u);

    // The durable state matches the in-memory state: exactly N records, all non-terminal.
    expect(await harness.orchestrator.list()).toHaveLength(2);
    const records = journalRecords(harness);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.status === "running")).toBe(true);
    expect(harness.gate.entered()).toBe(2);
    harness.gate.open();
  });

  it("releases the slot on every early exit, so the same workspace can start again", async () => {
    const harness = makeHarness({ runLimit: 1 });
    const workspace = tempDir("dsh-ws-race-release-");
    const first = await harness.orchestrator.start({ workspace, task: "first" });

    // Two refusals in a row: the workspace rule, then the session rule (a named session that runs).
    await expect(harness.orchestrator.start({ workspace, task: "again" })).rejects.toThrow(/already has a run in flight/u);
    await expect(
      harness.orchestrator.start({ workspace, task: "again", sessionId: first.sessionId }),
    ).rejects.toThrow(/still running/u);

    // Neither refusal may leave a reservation behind: once the first run is terminal, the same
    // workspace starts again (a leaked reservation would refuse it forever).
    await harness.orchestrator.cancel(first.runId);
    const second = await harness.orchestrator.start({ workspace, task: "after cancel" });
    expect(second).toMatchObject({ status: "running", workspace });
    expect(second.runId).not.toBe(first.runId);
    expect(journalRecords(harness).filter((record) => record.status === "running")).toHaveLength(1);
  });

  it("releases the reservation when the service fails to start", async () => {
    const workspace = tempDir("dsh-ws-race-broken-");
    const orchestrator = new RunOrchestrator(
      {
        getDataDirectory: () => tempDir("dsh-conc-data-broken-"),
        serviceHomes: () => [],
        serviceHomeOf: () => null,
        runningServiceForWorkspace: () => null,
        list: () => {},
        start: async () => {
          throw new Error("service start exploded");
        },
        access: () => {
          throw new Error("unreachable");
        },
      } as unknown as ServiceSupervisor,
      { runLimit: 1 },
      [],
    );

    await expect(orchestrator.start({ workspace, task: "boom" })).rejects.toThrow("service start exploded");
    // A second call must be admitted (the failed one released its slot) and fail the same way.
    await expect(orchestrator.start({ workspace, task: "boom again" })).rejects.toThrow("service start exploded");
    expect(orchestrator.activeRuns()).toEqual([]);
  });
});
