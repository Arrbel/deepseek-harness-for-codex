import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManager } from "../support/manager.js";
import { TOOLS, annotationsFor } from "../../src/tools/catalog.js";
import { createMcpServer } from "../../src/tools/register.js";
import "../support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-harness.mjs");
const openBrowser = vi.fn(async () => undefined);

describe("MCP server", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: RunManager;
  let client: Client;
  let server: ReturnType<typeof createMcpServer>;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    openBrowser.mockClear();
    temporaryRoot = await mkdtemp(join(tmpdir(), "deep-seek-harness-mcp-server-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    // `doctor` reads the environment, so point it at the scratch data directory instead of
    // the user's real one (which may hold a large installed runtime package).
    previousDataDir = process.env.DSH_MCP_DATA_DIR;
    process.env.DSH_MCP_DATA_DIR = join(temporaryRoot, "data");
    manager = new RunManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser,
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(temporaryRoot, "runtime"),
        packageDir: join(temporaryRoot, "runtime"),
        binPath: fixture,
        installedNow: false,
      }),
    });
    server = createMcpServer(manager);
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await manager.close();
    await server.close();
    if (previousDataDir === undefined) {
      delete process.env.DSH_MCP_DATA_DIR;
    } else {
      process.env.DSH_MCP_DATA_DIR = previousDataDir;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("advertises exactly the catalogue, with derived annotations", async () => {
    const response = await client.listTools();

    // Derived from `catalog.ts`, never re-typed here: the README gate and the catalogue are the
    // only places the surface is stated, so this assertion cannot become a third copy that drifts.
    expect(response.tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    for (const advertised of response.tools) {
      const spec = TOOLS.find((tool) => tool.name === advertised.name);
      expect(spec, `${advertised.name} is advertised but not in the catalogue`).toBeDefined();
      expect(advertised.annotations).toMatchObject(annotationsFor(spec!.behavior));
      expect(advertised.title).toBe(spec!.title);
      expect(advertised.description).toBe(spec!.description);
    }
  });

  it("starts and waits for a local run through MCP", async () => {
    const start = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP task", workspace },
    });
    expect(start.isError).not.toBe(true);
    const runId = (start.structuredContent as { runId: string }).runId;

    const wait = await client.callTool({
      name: "wait_run",
      arguments: { runId, timeoutMs: 2_000 },
    });

    expect(wait.isError).not.toBe(true);
    expect(wait.structuredContent).toMatchObject({
      runId,
      status: "succeeded",
      assistantText: "completed:MCP task",
    });

    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
    const followUp = await client.callTool({
      name: "start_run",
      arguments: { task: "MCP follow-up", workspace, sessionId },
    });
    expect(followUp.isError).not.toBe(true);
    expect(followUp.structuredContent).toMatchObject({ sessionId, sessionReused: true });

    const followUpRunId = (followUp.structuredContent as { runId: string }).runId;
    const followUpWait = await client.callTool({
      name: "wait_run",
      arguments: { runId: followUpRunId, timeoutMs: 2_000 },
    });
    expect(followUpWait.structuredContent).toMatchObject({
      status: "succeeded",
      assistantText: "completed:MCP follow-up",
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("returns a tool error for an invalid workspace", async () => {
    const response = await client.callTool({
      name: "start_run",
      arguments: { task: "task", workspace: "." },
    });

    expect(response.isError).toBe(true);
    expect(response.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("absolute path") }),
    ]);
  });

  it("reports the runtime package and the engine range through doctor", async () => {
    const response = await client.callTool({ name: "doctor", arguments: {} });

    expect(response.isError).not.toBe(true);
    const report = response.structuredContent as Record<string, unknown>;
    expect(report.engines).toMatchObject({ range: "^22.19.0 || >=24.0.0", supported: true });
    expect(report.runtimePackage).toMatchObject({ spec: "@deepseek-ai/dsh@0.2.1-alpha.1", installed: false });
    expect(report.npmCli).toMatchObject({ exists: true });
    expect(report.dataDirectory).toMatchObject({
      path: process.env.DSH_MCP_DATA_DIR,
      source: "DSH_MCP_DATA_DIR",
    });
    expect(report.deprecatedEnv).toEqual([]);
  });

  it("reports DSH_MCP_NPX_COMMAND as deprecated and ignored", async () => {
    process.env.DSH_MCP_NPX_COMMAND = "npx.cmd";
    try {
      const response = await client.callTool({ name: "doctor", arguments: {} });

      const report = response.structuredContent as { deprecatedEnv: string[] };
      expect(report.deprecatedEnv).toEqual(["DSH_MCP_NPX_COMMAND"]);
    } finally {
      delete process.env.DSH_MCP_NPX_COMMAND;
    }
  });
});
