// Runtime proof that the generated plugin payload is self-contained.
//
// Codex copies plugin files into its own cache directory, where the checkout's
// node_modules is unreachable. This probe therefore launches the generated entry with
// cwd = plugin root (exactly what `.mcp.json` declares), speaks the MCP handshake over
// stdio, and reports the tool catalogue. A bundle that still needs node_modules fails here.

import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { PLUGIN_DIR_REL, PLUGIN_ENTRY_REL } from "./metadata.mjs";

const EXPECTED_TOOLS = [
  "cancel_run",
  "doctor",
  "get_run",
  "list_runs",
  "list_services",
  "open_service",
  "start_run",
  "start_service",
  "stop_service",
  "wait_run",
];

/** True when the generated plugin payload exists and can be probed. */
export async function pluginPayloadExists(root) {
  try {
    await access(join(root, PLUGIN_DIR_REL, PLUGIN_ENTRY_REL));
    return true;
  } catch {
    return false;
  }
}

/**
 * Launches the generated plugin entry from its own directory and performs an MCP handshake.
 * @param {{root: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, tools: string[], missingTools: string[], error: string|null, serverName: string|null, serverVersion: string|null, stderrTail?: string}>}
 */
export async function probePluginLaunch({ root, timeoutMs = 30_000 }) {
  const pluginDir = resolve(root, PLUGIN_DIR_REL);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`./${PLUGIN_ENTRY_REL}`],
    cwd: pluginDir,
    stderr: "pipe",
    env: {
      ...process.env,
      // Never write state into the generated payload: the gate treats extra files there as drift.
      DSH_MCP_DATA_DIR: join(tmpdir(), "dsh-for-codex-plugin-probe"),
    },
  });
  const client = new Client({ name: "self-contained-probe", version: "0.0.0" });
  let stderrText = "";
  transport.stderr?.on("data", (chunk) => {
    stderrText += chunk.toString();
  });
  const timer = setTimeout(() => {
    void client.close().catch(() => {});
  }, timeoutMs);
  try {
    await client.connect(transport);
    const serverVersion = client.getServerVersion();
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    const missingTools = EXPECTED_TOOLS.filter((tool) => !tools.includes(tool));
    return {
      ok: missingTools.length === 0,
      tools,
      missingTools,
      error: null,
      serverName: serverVersion?.name ?? null,
      serverVersion: serverVersion?.version ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      tools: [],
      missingTools: [...EXPECTED_TOOLS],
      error: error instanceof Error ? error.message : String(error),
      serverName: null,
      serverVersion: null,
      stderrTail: stderrText.slice(-2000),
    };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
