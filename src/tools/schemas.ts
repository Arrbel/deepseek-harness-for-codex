// Input schemas for the MCP tool surface.
//
// Zod lives here (and in `dsh/contract.ts`) and nowhere else in the tool layer, so the
// advertised schema and the runtime validation can never drift apart.

import { z } from "zod";

/** Run identifier returned by `start_run`. */
export const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");

/** Service identifier returned by `start_service` or `start_run`. */
export const serviceIdSchema = z.string().uuid().describe("Service identifier returned by start_service or start_run.");

/** Absolute repository path the Harness may inspect and modify. */
export const workspaceSchema = z.string().min(1).describe("Absolute repository path served by DeepSeek Harness.");

/** Open-the-page switch (explicit opt-in: opening a browser is a side effect). */
export const openBrowserSchema = z
  .boolean()
  .default(false)
  .describe("Open the Harness page after readiness. Keep false unless the user explicitly requested it.");

/** Start/reuse a service. */
export const startServiceShape = {
  workspace: workspaceSchema,
  openBrowser: openBrowserSchema,
} as const;

/** Open an already running service. */
export const openServiceShape = { serviceId: serviceIdSchema } as const;

/** Stop one service. */
export const stopServiceShape = { serviceId: serviceIdSchema } as const;

/** Submit a task into a visible session. */
export const startRunShape = {
  task: z
    .string()
    .min(1)
    .max(100_000)
    .describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
  workspace: z
    .string()
    .min(1)
    .describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Completed Harness session to continue. Pass a sessionId returned by an earlier run in this workspace, or omit it to create a new session."),
  openBrowser: z
    .boolean()
    .default(false)
    .describe("Open the live Harness Web page. Keep false unless the user explicitly requested it."),
} as const;

/** Read one run. */
export const getRunShape = { runId: runIdSchema } as const;

/** Poll one run for up to 30 seconds. */
export const waitRunShape = {
  runId: runIdSchema,
  timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
} as const;

/** Cancel one run. */
export const cancelRunShape = { runId: runIdSchema } as const;

/** Inputs of one started run, inferred from the advertised schema. */
export type StartRunToolInput = {
  task: string;
  workspace: string;
  sessionId?: string | undefined;
  openBrowser: boolean;
};
