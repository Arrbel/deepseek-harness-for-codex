// The MCP tool catalogue: one table that declares name, title, description, schema,
// annotations, and the thin handler for every tool.
//
// `register.ts` only iterates this table, which is what keeps the description and the
// implementation from drifting apart. Business decisions live in `run/`, `service/`, and
// `dsh/`; a handler here only adapts arguments.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redactErrorText } from "../util/redaction.js";
import type { RunSnapshot, StartRunInput } from "../run/types.js";
import type { ServiceSnapshot, StartServiceInput } from "../service/types.js";
import {
  cancelRunShape,
  getRunShape,
  openServiceShape,
  startRunShape,
  startServiceShape,
  stopServiceShape,
  waitRunShape,
} from "./schemas.js";

/** The orchestration surface a tool handler may use (the container implements it). */
export interface ToolContext {
  startService(input: StartServiceInput): Promise<ServiceSnapshot>;
  openService(serviceId: string): Promise<ServiceSnapshot>;
  listServices(): ServiceSnapshot[];
  stopService(serviceId: string): Promise<ServiceSnapshot>;
  start(input: StartRunInput): Promise<RunSnapshot>;
  list(): Promise<RunSnapshot[]>;
  get(runId: string): Promise<RunSnapshot>;
  wait(runId: string, timeoutMs: number): Promise<RunSnapshot>;
  cancel(runId: string): Promise<RunSnapshot>;
  doctor(): Record<string, unknown>;
}

/** Outcome of a tool call, in the shape the MCP SDK expects. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * What a tool does to the world — the **only** declaration of its side-effect semantics.
 *
 * Annotations are *derived* from this (see {@link annotationsFor}) instead of being written twice,
 * so a tool cannot claim `readOnlyHint: true` while its handler writes: the class is what carries
 * the meaning, the three booleans are arithmetic on it.
 */
export type ToolBehavior =
  /** Reads state only: no spawn, no write, safe to repeat. */
  | "read-only"
  /** Writes, but repeating it converges (reusing a service, opening a page). */
  | "idempotent-write"
  /** Writes and repeating it changes the outcome (submitting a task). */
  | "mutating-write"
  /** Writes destructively, idempotently (stopping/cancelling an existing thing). */
  | "destructive-idempotent";

/** The MCP annotation triple, exactly as the SDK takes it. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * The behaviour → annotation table.
 *
 * `openWorldHint` means "interacts with a world beyond this process": the service and run tools
 * spawn (or talk to) the Harness Host, the rest only touch local records.
 */
export function annotationsFor(behavior: ToolBehavior): ToolAnnotations {
  switch (behavior) {
    case "read-only":
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case "idempotent-write":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    case "mutating-write":
      return { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    case "destructive-idempotent":
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
  }
}

/** Every behaviour class, for the matrix test to iterate (no second list to maintain). */
export const TOOL_BEHAVIORS: readonly ToolBehavior[] = [
  "read-only",
  "idempotent-write",
  "mutating-write",
  "destructive-idempotent",
];

/** The kind of payload a tool returns; asserted against the handler's own output. */
export type ToolPayloadKind = "service" | "services" | "run" | "runs" | "doctor";

/** One advertised tool. `input` is a Zod raw shape, exactly as the SDK takes it. */
export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  /** Side-effect semantics; the annotations are derived from it (never declared twice). */
  behavior: ToolBehavior;
  /** Return semantics; the surface test checks the handler really returns this shape. */
  result: ToolPayloadKind;
  handler: (ctx: ToolContext, input: Record<string, unknown>) => Promise<ToolResult>;
}

/** True when this tool is callable with no arguments (derived from its declared schema). */
export function toolAcceptsNoArgs(tool: ToolSpec): boolean {
  return Object.keys(tool.input).length === 0;
}

/** Wraps a value as a structured tool result. */
export function toolResult(value: object): ToolResult {
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * Wraps a thrown value as an `isError` tool result.
 *
 * This is the single failure exit: text only, `isError: true`, and the message is redacted here so
 * `register.ts` does not have to remember to do it (P6's choke point applies to failures too).
 */
export function toolFailure(error: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: redactErrorText(error) }],
    isError: true,
  };
}

/** The single table the transport registers from. */
export const TOOLS: readonly ToolSpec[] = [
  {
    name: "start_service",
    title: "Start the local DeepSeek Harness Web UI",
    description:
      "Start or reuse a local Harness Web service for an absolute workspace and return its URL without opening a browser by default.",
    input: startServiceShape,
    behavior: "idempotent-write",
    result: "service",
    handler: async (ctx, input) => toolResult(await ctx.startService({
      workspace: String(input["workspace"]),
      openBrowser: input["openBrowser"] === true,
    })),
  },
  {
    name: "open_service",
    title: "Open the DeepSeek Harness page",
    description: "Open an already running Harness Web service in the user's default browser.",
    input: openServiceShape,
    behavior: "idempotent-write",
    result: "service",
    handler: async (ctx, input) => toolResult(await ctx.openService(String(input["serviceId"]))),
  },
  {
    name: "list_services",
    title: "List local DeepSeek Harness Web services",
    description: "List Web services started by the current MCP server and their visible URLs.",
    input: {},
    behavior: "read-only",
    result: "services",
    handler: async (ctx) => toolResult({ services: ctx.listServices() }),
  },
  {
    name: "stop_service",
    title: "Stop a DeepSeek Harness Web service",
    description: "Cancel active sessions and stop the local Harness Web service process.",
    input: stopServiceShape,
    behavior: "destructive-idempotent",
    result: "service",
    handler: async (ctx, input) => toolResult(await ctx.stopService(String(input["serviceId"]))),
  },
  {
    name: "doctor",
    title: "Check local DeepSeek Harness prerequisites",
    description:
      "Check the Node engine range, the npm CLI entry, the installed runtime package, proxy variables, credentials visibility, the data directory (path, which setting it came from, whether it exists, whether it is writable), and workspace restrictions without installing or downloading anything.",
    input: {},
    behavior: "read-only",
    result: "doctor",
    handler: async (ctx) => toolResult(ctx.doctor()),
  },
  {
    name: "start_run",
    title: "Start a local DeepSeek Harness run",
    description:
      "Start or reuse the Harness Web UI, then create a new session or continue a completed session selected by Codex. Returns runId, sessionId, sessionReused, and webUrl.",
    input: startRunShape,
    behavior: "mutating-write",
    result: "run",
    handler: async (ctx, input) => toolResult(await ctx.start({
      task: String(input["task"]),
      workspace: String(input["workspace"]),
      ...(input["sessionId"] === undefined ? {} : { sessionId: String(input["sessionId"]) }),
      openBrowser: input["openBrowser"] === true,
    })),
  },
  {
    name: "get_run",
    title: "Read a DeepSeek Harness run",
    description:
      "Read the current state and assistant response from the same Harness Web session shown to the user. When the run failed, `nextAction` names the one recovery step and `webUrlStale` says whether the `webUrl` link still works.",
    input: getRunShape,
    behavior: "read-only",
    result: "run",
    handler: async (ctx, input) => toolResult(await ctx.get(String(input["runId"]))),
  },
  {
    name: "wait_run",
    title: "Wait for DeepSeek Harness output",
    description:
      "Poll the visible Harness Web session for up to 30 seconds and return its current status, failure reason, `nextAction`, and assistant response. Safe to call repeatedly (no side effects): a finished run keeps returning the same terminal snapshot, and a timeout returns the current snapshot instead of failing.",
    input: waitRunShape,
    behavior: "read-only",
    result: "run",
    handler: async (ctx, input) => toolResult(await ctx.wait(String(input["runId"]), Number(input["timeoutMs"] ?? 30_000))),
  },
  {
    name: "list_runs",
    title: "List local DeepSeek Harness runs",
    description:
      "List runs started by the current MCP server process, including runs adopted from a previous MCP server process (recovered from the run journal) and the session IDs Codex may choose to continue in a later start_run call.",
    input: {},
    behavior: "read-only",
    result: "runs",
    handler: async (ctx) => toolResult({ runs: await ctx.list() }),
  },
  {
    name: "cancel_run",
    title: "Cancel a local DeepSeek Harness run",
    description: "Cancel the agent turn in its visible Web session while keeping the Harness Web UI running.",
    input: cancelRunShape,
    behavior: "destructive-idempotent",
    result: "run",
    handler: async (ctx, input) => toolResult(await ctx.cancel(String(input["runId"]))),
  },
];

/** The tools callable with `{}`, derived — the list is not a second declaration. */
export const NO_ARGUMENT_TOOLS: readonly string[] = TOOLS
  .filter((tool) => toolAcceptsNoArgs(tool))
  .map((tool) => tool.name);

/** The server object the tools are registered on (narrow view of the SDK type). */
export type ToolServer = Pick<McpServer, "registerTool">;
