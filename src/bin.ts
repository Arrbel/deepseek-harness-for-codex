#!/usr/bin/env node
// bin entry: stdio transport assembly plus process-signal handling. No orchestration logic
// lives here — the container owns the lifecycle and every tool lives in `tools/catalog.ts`.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HarnessContainer } from "./app/container.js";
import { createMcpServer } from "./tools/register.js";

const container = new HarnessContainer();
const server = createMcpServer(container);
const transport = new StdioServerTransport();
let closing = false;

async function close(): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  await container.dispose();
  await server.close();
}

server.server.onclose = () => void container.dispose();
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGHUP", () => void close());
process.once("beforeExit", () => void container.dispose());

try {
  await server.connect(transport);
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
