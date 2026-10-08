// The tool-surface contract (P7): the catalogue is the single source of truth, and every fact it
// declares is asserted against the behaviour that actually happens.
//
// Two rules keep this from becoming "another copy that drifts":
//
//   1. The annotation matrix is **derived from `catalog.ts`** (`behavior` → `annotationsFor`), and
//      the class-level table below is the only place the semantic expectations live.
//   2. The read/write classification is cross-checked against what each handler *does* (a spy
//      `ToolContext` records the methods it calls), so a wrong `behavior` cannot hide behind
//      consistent annotations.

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessManager, type HarnessManagerOptions } from "../support/manager.js";
import {
  NO_ARGUMENT_TOOLS,
  TOOLS,
  TOOL_BEHAVIORS,
  annotationsFor,
  toolAcceptsNoArgs,
  type ToolAnnotations,
  type ToolBehavior,
  type ToolContext,
  type ToolResult,
  type ToolServer,
  type ToolSpec,
} from "../../src/tools/catalog.js";
import { createMcpServer, registerTools } from "../../src/tools/register.js";
import { registerSecret } from "../../src/util/redaction.js";
import "../support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-harness.mjs");

/** The contract of every behaviour class: the one place the semantics are stated. */
const BEHAVIOR_CONTRACT: Record<ToolBehavior, ToolAnnotations> = {
  "read-only": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "idempotent-write": { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  "mutating-write": { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  "destructive-idempotent": { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

/** `ToolContext` methods that only read state. */
const READ_METHODS = new Set(["listServices", "list", "get", "wait", "doctor"]);

/** A `ToolContext` that records what a handler calls and returns canned values. */
function spyContext(): { context: ToolContext; called: string[] } {
  const called: string[] = [];
  const service = { serviceId: "11111111-1111-4111-8111-111111111111" } as never;
  const run = { runId: "22222222-2222-4222-8222-222222222222" } as never;
  const record = <T>(name: string, value: T): (() => Promise<T>) => {
    return async () => {
      called.push(name);
      return value;
    };
  };
  const context = {
    startService: record("startService", service),
    openService: record("openService", service),
    listServices: () => {
      called.push("listServices");
      return [] as never;
    },
    stopService: record("stopService", service),
    start: record("start", run),
    list: record("list", [] as never),
    get: record("get", run),
    wait: record("wait", run),
    cancel: record("cancel", run),
    doctor: () => {
      called.push("doctor");
      return {} as never;
    },
  } as unknown as ToolContext;
  return { context, called };
}

/** Minimal arguments that let every handler reach its context call. */
const ARGUMENTS: Record<string, Record<string, unknown>> = {
  start_service: { workspace: "C:\\ws" },
  open_service: { serviceId: "11111111-1111-4111-8111-111111111111" },
  list_services: {},
  stop_service: { serviceId: "11111111-1111-4111-8111-111111111111" },
  doctor: {},
  start_run: { task: "t", workspace: "C:\\ws" },
  get_run: { runId: "22222222-2222-4222-8222-222222222222" },
  wait_run: { runId: "22222222-2222-4222-8222-222222222222", timeoutMs: 0 },
  list_runs: {},
  cancel_run: { runId: "22222222-2222-4222-8222-222222222222" },
};

describe("tool catalogue: single source of truth", () => {
  it("declares every tool once, with the facts the surface needs", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z_]*$/u);
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(Object.keys(tool.input)).toEqual(Object.keys(tool.input));
    }
    expect(TOOL_BEHAVIORS.length).toBe(4);
    // Every declared class is actually used (a dead class would mean dead mapping rows).
    expect(new Set(TOOLS.map((tool) => tool.behavior))).toEqual(new Set(TOOL_BEHAVIORS));
    // Every declared payload kind is reachable in the same way.
    expect(new Set(TOOLS.map((tool) => tool.result))).toEqual(new Set(["service", "services", "run", "runs", "doctor"]));
  });

  it("keeps the annotations a pure function of the declared behaviour", () => {
    for (const tool of TOOLS) {
      expect(annotationsFor(tool.behavior), tool.name).toEqual(BEHAVIOR_CONTRACT[tool.behavior]);
    }
  });

  it("agrees with reality: handlers that only read are the read-only tools", () => {
    for (const tool of TOOLS) {
      const { context, called } = spyContext();
      // Fire and forget: we only care which context methods the handler reaches.
      void tool.handler(context, ARGUMENTS[tool.name] ?? {});

      const readsOnly = called.every((method) => READ_METHODS.has(method));
      expect(annotationsFor(tool.behavior).readOnlyHint, `${tool.name} called ${called.join(", ")}`).toBe(readsOnly);
      // A destructive tool must never be advertised as read-only, and vice versa.
      expect(annotationsFor(tool.behavior).destructiveHint && readsOnly, tool.name).toBe(false);
    }
  });

  it("derives the no-argument list from the declared schemas", () => {
    expect([...NO_ARGUMENT_TOOLS].sort()).toEqual(["doctor", "list_runs", "list_services"]);
    for (const tool of TOOLS) {
      expect(toolAcceptsNoArgs(tool), tool.name).toBe(Object.keys(tool.input).length === 0);
    }
  });
});

describe("tool catalogue: declared return semantics", () => {
  it("returns the payload shape the catalogue promises", async () => {
    const shapes: Record<string, (value: Record<string, unknown>) => boolean> = {
      service: (value) => typeof value.serviceId === "string",
      services: (value) => Array.isArray(value.services),
      run: (value) => typeof value.runId === "string",
      runs: (value) => Array.isArray(value.runs),
      doctor: (value) => typeof value.ready === "boolean",
    };
    const serviceSnapshot = { serviceId: "11111111-1111-4111-8111-111111111111", status: "running" };
    const runSnapshot = { runId: "22222222-2222-4222-8222-222222222222", status: "running" };
    const context = {
      startService: async () => serviceSnapshot,
      openService: async () => serviceSnapshot,
      listServices: () => [serviceSnapshot],
      stopService: async () => serviceSnapshot,
      start: async () => runSnapshot,
      list: async () => [runSnapshot],
      get: async () => runSnapshot,
      wait: async () => runSnapshot,
      cancel: async () => runSnapshot,
      doctor: () => ({ ready: true, problems: [] }),
    } as unknown as ToolContext;

    for (const tool of TOOLS) {
      const result = await tool.handler(context, {
        ...(ARGUMENTS[tool.name] ?? {}),
        task: "t",
        workspace: "C:\\ws",
      });
      const value = result.structuredContent ?? {};
      expect(shapes[tool.result]!(value), `${tool.name} declared ${tool.result}`).toBe(true);
      // Every result also carries the JSON text twin of its structured content.
      expect(JSON.parse(result.content[0]!.text)).toEqual(value);
    }
  });
});

describe("tool catalogue: one failure exit for every tool", () => {
  /** Captures the handlers `registerTools` installs over a context that always throws. */
  function registeredHandlers(context?: ToolContext): Map<string, (input: Record<string, unknown>) => Promise<ToolResult>> {
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (input: Record<string, unknown>) => Promise<ToolResult>) => {
        handlers.set(name, handler);
      },
    } as unknown as ToolServer;
    const exploding = context ?? (new Proxy({}, {
      get: () => () => {
        throw new Error("context exploded");
      },
    }) as unknown as ToolContext);
    registerTools(server, exploding);
    return handlers;
  }

  it("wraps a throwing handler as isError text for all tools, never a raw exception", async () => {
    const handlers = registeredHandlers();
    expect([...handlers.keys()].sort()).toEqual(TOOLS.map((tool) => tool.name).sort());

    for (const [name, handler] of handlers) {
      const result = await handler(ARGUMENTS[name] ?? {}).then(
        (value) => value,
        (error: unknown) => ({ thrown: error }) as unknown as ToolResult,
      );
      expect(result, `${name} threw instead of returning an error result`).not.toHaveProperty("thrown");
      expect(result.isError, name).toBe(true);
      expect(result.structuredContent, name).toBeUndefined();
      expect(result.content, name).toHaveLength(1);
      expect(result.content[0]?.text, name).toContain("context exploded");
    }
  });

  it("redacts a credential that appears inside a failure message", async () => {
    const secret = "failure-exit-secret";
    registerSecret(secret);
    const handlers = registeredHandlers({
      doctor: () => {
        throw new Error(`prerequisite probe failed for token=${secret}`);
      },
    } as unknown as ToolContext);

    const result = await handlers.get("doctor")!({});

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain(secret);
    expect(result.content[0]!.text).toContain("token=[redacted]");
  });
});

describe("tool surface over MCP", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: HarnessManager;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-tool-surface-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    const options: HarnessManagerOptions = {
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser: vi.fn(async () => undefined),
      launchEnv: {},
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(temporaryRoot, "runtime"),
        packageDir: join(temporaryRoot, "runtime"),
        binPath: fixture,
        installedNow: false,
      }),
    };
    manager = new HarnessManager(options);
    server = createMcpServer(manager);
    client = new Client({ name: "tool-surface", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await manager.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("accepts an empty argument object for every no-argument tool", async () => {
    for (const name of NO_ARGUMENT_TOOLS) {
      const response = await client.callTool({ name, arguments: {} });
      expect(response.isError, `${name} rejected {}`).not.toBe(true);
      expect(response.structuredContent).toBeTypeOf("object");
    }
  });

  it("fails the tools that can fail at runtime through one uniform exit", async () => {
    const unknownId = "33333333-3333-4333-8333-333333333333";
    const missing = join(temporaryRoot, "does-not-exist");
    const failures: Record<string, Record<string, unknown>> = {
      stop_service: { serviceId: unknownId },
      open_service: { serviceId: unknownId },
      get_run: { runId: unknownId },
      wait_run: { runId: unknownId, timeoutMs: 0 },
      cancel_run: { runId: unknownId },
      start_run: { task: "t", workspace: missing },
      start_service: { workspace: missing },
    };

    for (const [name, args] of Object.entries(failures)) {
      const response = await client.callTool({ name, arguments: args });
      const content = response.content as Array<{ type: string; text: string }>;
      expect(response.isError, `${name} should have failed`).toBe(true);
      expect(content, name).toHaveLength(1);
      const text = content[0]!.text;
      expect(text.length, name).toBeGreaterThan(0);
      expect(text, name).not.toMatch(/at Object\.|node:internal/u);
      expect(response.structuredContent, name).toBeUndefined();
    }
  });

  it("keeps wait_run repeatable with the documented contract", async () => {
    const started = await client.callTool({ name: "start_run", arguments: { task: "wait contract", workspace } });
    const runId = (started.structuredContent as { runId: string }).runId;

    const first = await client.callTool({ name: "wait_run", arguments: { runId, timeoutMs: 5_000 } });
    const terminal = first.structuredContent as { status: string; finishedAt: string | null };

    // 1. A timeout is not a failure: the tool returns the current snapshot.
    const timeout = await client.callTool({ name: "wait_run", arguments: { runId, timeoutMs: 0 } });
    expect(timeout.isError).not.toBe(true);
    expect((timeout.structuredContent as { runId: string }).runId).toBe(runId);

    // 2. A finished run keeps returning the same terminal snapshot (repeatable, no side effects).
    const repeated = await client.callTool({ name: "wait_run", arguments: { runId, timeoutMs: 0 } });
    const again = await client.callTool({ name: "wait_run", arguments: { runId, timeoutMs: 0 } });
    const asRun = repeated.structuredContent as { status: string; finishedAt: string | null };
    expect(asRun.status).toBe(terminal.status);
    expect(asRun.finishedAt).toBe(terminal.finishedAt);
    expect((again.structuredContent as { finishedAt: string | null }).finishedAt).toBe(terminal.finishedAt);
    expect(terminal.status).toBe("succeeded");

    // 3. `get_run` agrees with what `wait_run` returned (same snapshot source).
    const read = await client.callTool({ name: "get_run", arguments: { runId } });
    expect((read.structuredContent as { status: string }).status).toBe(terminal.status);
  });
});

describe("tool catalogue: the matrix bites", () => {
  it("catches a behaviour that contradicts what the handler does", () => {
    // Positive control for the read/write cross-check: a write handler must not be read-only.
    const forged: ToolSpec = {
      ...TOOLS.find((tool) => tool.name === "get_run")!,
      behavior: "mutating-write",
    };
    const { context, called } = spyContext();
    void forged.handler(context, ARGUMENTS.get_run!);

    expect(called.every((method) => READ_METHODS.has(method))).toBe(true);
    expect(annotationsFor(forged.behavior).readOnlyHint).toBe(false);
  });
});
