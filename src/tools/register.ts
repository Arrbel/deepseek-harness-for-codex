// Transport assembly: create the MCP server, register the catalogue, and pre-close it.
//
// This module owns nothing but the MCP surface. Every tool is registered by iterating
// `TOOLS`; there is no per-tool logic here, which is what keeps descriptions honest.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { redactDeep } from "../util/redaction.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";
import { TOOLS, annotationsFor, toolFailure, type ToolContext, type ToolResult, type ToolServer } from "./catalog.js";

/** The instructions the MCP client receives with the tool list. */
export const SERVER_INSTRUCTIONS =
  "Start the local DeepSeek Harness Web service, return its clickable login URL to the user, submit coding tasks into visible Web sessions, then inspect workspace changes independently. Treat the URL as a local bearer credential and never copy it into a Harness task. Do not open the browser unless the user explicitly requests it.";

/** Registers every catalogue entry on one server object. */
export function registerTools(server: ToolServer, context: ToolContext): void {
  for (const tool of TOOLS) {
    const handler = async (input: Record<string, unknown>): Promise<ToolResult> => {
      try {
        // Single outward boundary: whatever a handler returns is scrubbed of every registered
        // credential here, so a handler that forgets to redact still cannot leak (root cause of
        // the `browserError` defect was exactly "each call site must remember").
        return redactDeep(await tool.handler(context, input));
      } catch (error) {
        // One failure exit for every tool: `toolFailure` builds the `isError` result and redacts
        // the message, so no tool can leak a raw exception or an unredacted credential.
        return toolFailure(error);
      }
    };
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        // Derived, never declared twice: the behaviour class is the single source of the hints.
        annotations: annotationsFor(tool.behavior),
      },
      handler as never,
    );
  }
}

/** Creates the MCP tool surface over an orchestration container. */
export function createMcpServer(
  context: ToolContext,
  identity: { name: string; version: string } = { name: PACKAGE_NAME, version: PACKAGE_VERSION },
): McpServer {
  const server = new McpServer(identity, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, context);
  return server;
}
