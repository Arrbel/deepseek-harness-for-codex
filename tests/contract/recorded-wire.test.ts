import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RunManager } from "../support/manager.js";
import "../support/isolation.js";

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordedDir = join(testsRoot, "fixtures", "recorded");
const fakeHarness = join(testsRoot, "fixtures", "fake-harness.mjs");
const projectRoot = join(testsRoot, "..");
const sourceCheckout = join(projectRoot, "..", "deepseek-harness");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(join(recordedDir, name), "utf8")) as T;
}

interface WireEvent {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
}

interface WireRecord {
  type: string;
  event: WireEvent;
}

interface WirePage {
  records: WireRecord[];
  hasMore: boolean;
}

interface WireSessionItem {
  sessionId: string;
  updatedAt: number;
  agentAvailable: boolean;
  running: boolean;
  blank: boolean;
  cwd: string;
  projections: { kind: string; asOfSeq: number; values: Record<string, unknown> };
}

interface WireProjections {
  asOfSeq: number;
  values: Record<string, unknown>;
}

interface WireContract {
  provenance: Record<string, string>;
  launch: Record<string, unknown>;
  unauthenticated: Record<string, unknown>;
  workspace: { createValueKeys: string[]; created: boolean };
  session: { createValueKeys: string[]; workingDirectoryShape: Record<string, unknown> };
  projections: { freshAsOfSeq: number; afterPromptAsOfSeq: number; valueKeys: string[]; unknownSession: unknown };
  pagination: {
    fullPage: { recordCount: number; hasMore: boolean };
    windowOne: { hasMore: boolean; firstSeq: number; lastSeq: number; types: string[] };
    windowTwo: { hasMore: boolean; firstSeq: number; lastSeq: number; types: string[] };
    badThroughSeq: { ok: boolean; error: { code: string; message: string } };
    badBeforeSeq: { ok: boolean; error: { code: string; message: string } };
    badMaxMessages: { ok: boolean; error: { code: string; message: string } };
  };
  turnEnd: { event: WireEvent };
  assistantAttempt: { event: WireEvent };
  cancel: { acceptedValue: Record<string, unknown>; note: string };
}

interface WireMeta {
  version: string;
  files: string[];
  authority: Record<string, string>;
}

const page = load<WirePage>("session-page.json");
const list = load<{ items: WireSessionItem[] }>("session-list.json");
const projectionsStart = load<WireProjections>("projections-start.json");
const projectionsAfter = load<WireProjections>("projections-after.json");
const contract = load<WireContract>("contract.json");
const meta = load<WireMeta>("meta.json");

describe("recorded DeepSeek Harness 0.2.1 wire", () => {
  it("keeps the session page contiguous and terminal", () => {
    const records = page.records;
    expect(records.length).toBeGreaterThan(0);
    expect(records.map((record) => record.event.seq)).toEqual(records.map((_, index) => index));
    for (const record of records) {
      expect(record.type).toBe("event");
      expect(typeof record.event.type).toBe("string");
      expect(typeof record.event.seq).toBe("number");
      expect(typeof record.event.time).toBe("number");
      expect(record.event.data).toBeTypeOf("object");
    }

    const terminal = records.at(-1)!;
    expect(terminal.event.type).toBe("turn/end");
    expect(terminal.event.data).toMatchObject({
      turn: 1,
      reason: { kind: "error", error: { code: "MISSING_CREDENTIAL" } },
    });
    expect((terminal.event.data as { reason: { error: { message: string } } }).reason.error.message)
      .toContain("no API key for provider route");
    expect(page.hasMore).toBe(false);
    expect(contract.pagination.fullPage).toEqual({ recordCount: records.length, hasMore: false });
  });

  it("carries the required stream record fields on the assistant attempt", () => {
    const data = contract.assistantAttempt.event.data as { turn: number; step: number; stream: unknown[] };
    expect(Object.keys(data).sort()).toEqual(["step", "stream", "turn"]);
    expect(data.stream.length).toBeGreaterThan(0);

    // assistant/message.stream and assistant/attempt.stream share
    // AssistantStreamRecord; this recorded element is the live evidence for the
    // element fields the synthetic fixture reproduces for assistant/message.
    const frame = data.stream[0] as { type: string; time: number; chunk: unknown };
    expect(typeof frame.type).toBe("string");
    expect(typeof frame.time).toBe("number");
    expect(frame.chunk).toMatchObject({ type: "finish", reason: { kind: "error", failure: { code: "MISSING_CREDENTIAL" } } });

    // The synthetic fixture must publish the same required assistant/message keys.
    const synthetic = readFileSync(fakeHarness, "utf8");
    expect(synthetic).toContain('"assistant/message"');
    expect(synthetic).toMatch(/stream: \[\]/u);
  });

  it("reports the launch exchange as a cookie-bearing 303 and the bare root as 401", () => {
    expect(contract.launch["exchangeHttp"]).toBe(303);
    expect(contract.launch["location"]).toBe("./");
    expect(contract.launch["setCookiePresent"]).toBe(true);
    expect(contract.launch["setCookieNameIsDynamic"]).toBe(true);
    expect(contract.launch["readyLineMatches"]).toBe("dsh web: http://127.0.0.1:<port>/?token=<one-time-token>");
    expect(contract.launch["setCookieAttributes"]).toContain("HttpOnly");
    expect(contract.launch["setCookieAttributes"]).toContain("SameSite=Strict");
    expect(contract.launch["setCookieAttributes"]).toContain("Max-Age=");
    expect(contract.unauthenticated).toMatchObject({
      bareRootGet: 401,
      rpcWithoutCookie: { http: 401, body: "unauthorized" },
    });
  });

  it("lists sessions at the item path the client reads", () => {
    expect(list.items.length).toBeGreaterThan(0);
    const item = list.items[0]!;
    expect(Object.keys(item).sort()).toEqual([
      "agentAvailable", "blank", "cwd", "projections", "running", "sessionId", "updatedAt",
    ]);
    expect(typeof item.sessionId).toBe("string");
    expect(typeof item.cwd).toBe("string");
    expect(typeof item.running).toBe("boolean");
    expect(typeof item.blank).toBe("boolean");
    expect(item.projections.kind).toBe("sequenced");
    expect(typeof item.projections.asOfSeq).toBe("number");
  });

  it("answers an unknown session projection with null and records the prompt title", () => {
    expect(contract.projections.unknownSession).toBeNull();
    expect(projectionsStart.asOfSeq).toBe(2);
    expect(projectionsAfter.asOfSeq).toBe(18);
    expect(projectionsAfter.values["title"]).toBe("contract replay probe");
    expect(projectionsStart.values["title"]).toBeNull();
    expect(Object.keys(projectionsAfter.values).sort()).toEqual(contract.projections.valueKeys);
  });

  it("windows a backwards page at a message boundary and reports hasMore", () => {
    const first = contract.pagination.windowOne;
    expect(first.hasMore).toBe(true);
    expect(first.lastSeq).toBe(18);
    expect(first.firstSeq).toBeLessThan(first.lastSeq);
    // The cut lands on a user/message, not on an arbitrary event index.
    expect((first.types as string[])[0]).toBe("user/message");

    const second = contract.pagination.windowTwo;
    expect(second.hasMore).toBe(true);
    expect(second.firstSeq).toBeLessThan(first.firstSeq);
    expect(second.lastSeq).toBe(first.firstSeq - 1);
  });

  it("rejects invalid pagination inputs with gateway/bad-request", () => {
    for (const key of ["badThroughSeq", "badBeforeSeq", "badMaxMessages"] as const) {
      const failure = contract.pagination[key];
      expect(failure.ok).toBe(false);
      expect(failure.error.code).toBe("gateway/bad-request");
      expect(failure.error.message.length).toBeGreaterThan(0);
    }
    expect(contract.pagination.badThroughSeq.error.message).toContain("past cursor");
    expect(contract.pagination.badBeforeSeq.error.message).toContain("beforeSeq");
    expect(contract.pagination.badMaxMessages.error.message).toContain("maxMessages");
  });

  it("records the accepted cancel envelope and its capture limitation", () => {
    expect(contract.cancel.acceptedValue).toEqual({ accepted: true });
    expect(contract.cancel.note).toContain("types.ts");
  });

  it("names the official sources the fixture is checked against", () => {
    expect(meta.version).toBe("0.2.1-alpha.1");
    expect(meta.files).toContain("session-page.json");
    expect(meta.authority["paginate"]).toContain("history.ts");
    expect(meta.authority["assistantMessage"]).toContain("types.ts");
    expect(contract.provenance["package"]).toBe("@deepseek-ai/dsh@0.2.1-alpha.1");
  });

  it.skipIf(!existsSync(sourceCheckout))("agrees with the checked-out official source", () => {
    const types = readFileSync(join(sourceCheckout, "packages", "core", "session", "src", "types.ts"), "utf8");
    for (const kind of ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"]) {
      expect(types).toContain(kind);
    }
    expect(types).toMatch(/'assistant\/message': \{\s*turn: number\s*step: number/u);

    const history = readFileSync(join(sourceCheckout, "packages", "api", "session-controller", "src", "history.ts"), "utf8");
    expect(history).toContain("function paginate(");
    expect(history).toContain("hasMore: cut > 0");
    expect(history).toContain("const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])");

    // The fixture reproduces the same message-aligned cut and hasMore rule.
    const fixture = readFileSync(fakeHarness, "utf8");
    expect(fixture).toContain('new Set(["user/message", "assistant/message"])');
    expect(fixture).toContain("hasMore: cut > 0");
  });
});

describe("replayed recorded wire through RunManager", () => {
  const managers: RunManager[] = [];
  let root: string | undefined;
  let workspace = "";

  async function replay(extraEnv: Record<string, string> = {}): Promise<RunManager> {
    const created = await mkdtemp(join(tmpdir(), "deepseek-harness-replay-"));
    root = created;
    workspace = join(created, "workspace");
    await mkdir(workspace);
    const resolvedWorkspace = await realpath(workspace);
    const manager = new RunManager({
      dataDirectory: join(root, "data"),
      allowedRoots: [root],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser: async () => undefined,
      // ADR-0002: the runtime package resolves to the protocol fixture instead of npm.
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(root!, "runtime"),
        packageDir: join(root!, "runtime"),
        binPath: fakeHarness,
        installedNow: false,
      }),
      launchEnv: {
        FIXTURE_RECORDED: recordedDir,
        FIXTURE_RECORDED_SPLIT: "1",
        FIXTURE_CWD: resolvedWorkspace,
        ...extraEnv,
      },
    });
    managers.push(manager);
    return manager;
  }

  afterEach(async () => {
    await Promise.all(managers.splice(0).map(async (manager) => manager.close()));
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("projects the recorded keyless turn/end failure into a failed run", async () => {
    const manager = await replay();
    const sessionId = list.items[0]!.sessionId;

    const started = await manager.start({ task: "replay recorded wire", workspace, sessionId });
    expect(started.sessionReused).toBe(true);

    const completed = await manager.wait(started.runId, 5_000);
    expect(completed.status).toBe("failed");
    // recordText() reads TurnEndReason.error.message, so the surface carries the
    // LlmFailure message; the structured `code` is not projected (gap G4).
    expect(completed.error).toContain("no API key for provider route");
    expect(completed.error).toContain("DEEPSEEK_API_KEY");
    expect(completed.assistantText).toBe("");
    expect(completed.lastEventSeq).toBe(18);
    expect(completed.finishedAt).not.toBeNull();
  });

  it("walks the recorded pages backwards without losing the terminal event", async () => {
    const manager = await replay({ FIXTURE_PAGE_LIMIT: "2" });
    const sessionId = list.items[0]!.sessionId;

    const started = await manager.start({ task: "replay paged wire", workspace, sessionId });
    const completed = await manager.wait(started.runId, 5_000);

    expect(completed.status).toBe("failed");
    expect(completed.error).toContain("no API key for provider route");
    expect(completed.lastEventSeq).toBe(18);

    const stats = await (await fetch(new URL("/__fixture/stats", new URL(started.webUrl).origin))).json() as {
      rpc: Record<string, number>;
    };
    expect(stats.rpc["session/page"] ?? 0).toBeGreaterThanOrEqual(3);
  });
});
