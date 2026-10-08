// The explicit contract with DeepSeek Harness: method names, wire argument names, request
// and response validation, the HTTP prefix, and the supported version line.
//
// This is the one place that declares "what we depend on". Validation is intentionally
// **lenient**: it asserts the fields this project reads and preserves unknown keys, so a
// stricter schema can never turn a working call into a failure (that would be a behaviour
// change, and protocol tightening belongs to a later phase).

import { z } from "zod";
import type {
  AcceptedValue,
  PromptRequest,
  SessionPage,
  SessionPageRequest,
  SessionProjectionSnapshot,
  SessionSummary,
} from "./types.js";

/** One RPC method: its wire name plus the request and response validators. */
export interface MethodSpec<Req, Res> {
  readonly method: string;
  /** Validates the `payload.args` object exactly as this project sends it. */
  readonly request: z.ZodType<Req>;
  /** Validates the `result.value` object; throws on drift. */
  readonly response: z.ZodType<Res>;
}

const workspaceCreateRequest = z.object({ request: z.object({ path: z.string() }) });
const workspaceCreateResponse = z.object({ workspace: z.object({ workspaceId: z.string() }) });

const sessionCreateRequest = z.object({ request: z.object({ workspaceId: z.string() }) });
const sessionCreateResponse = z.object({ sessionId: z.string() });

const sessionListRequest = z.object({ _request: z.record(z.string(), z.never()) });
const sessionSummary = z.object({
  sessionId: z.string(),
  running: z.boolean(),
  blank: z.boolean(),
  // Required: `cwd` is the only proof that this session belongs to the requested workspace
  // (ADR-0004: a field we depend on must exist and be typed).
  cwd: z.string(),
});
const sessionListResponse = z.object({ items: z.array(sessionSummary) });

const sessionProjectionsRequest = z.object({ request: z.object({ sessionId: z.string() }) });
// `null` is a documented answer ("unknown session"), not drift.
const sessionProjectionsResponse = z.object({ asOfSeq: z.number() }).nullable();

const sessionPageRequest = z.object({
  request: z.object({
    address: z.object({ kind: z.literal("session"), sessionId: z.string() }),
    throughSeq: z.number(),
    maxMessages: z.number(),
  }),
});
/**
 * The durable events we read, typed; every other event type stays open.
 *
 * Rationale (ADR-0004): we *do* depend on `turn/end#data.reason.kind` (the run outcome) and on
 * `assistant/message#data.message.content[].text` (the answer text), so those two shapes are
 * validated. Event types we merely skip (there are dozens: `step/*`, `system/message`, …) keep
 * `data: unknown`, and unknown keys inside a known shape are stripped, never rejected — extra
 * fields are how the wire evolves; a *missing or mistyped* field we read is drift.
 */
const turnEndEvent = z.object({
  type: z.literal("turn/end"),
  seq: z.number(),
  data: z.object({
    turn: z.number().optional(),
    reason: z.object({
      kind: z.string(),
      reason: z.object({ kind: z.string() }).nullish(),
      error: z.unknown().optional(),
    }),
  }),
});
const assistantMessageEvent = z.object({
  type: z.literal("assistant/message"),
  seq: z.number(),
  data: z.object({
    turn: z.number().optional(),
    step: z.number().optional(),
    message: z
      .object({
        role: z.string().optional(),
        content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
      })
      .optional(),
  }),
});
const otherEvent = z.object({
  type: z.string().refine(
    (type) => type !== "turn/end" && type !== "assistant/message",
    "an event type we read must satisfy its declared shape",
  ),
  seq: z.number(),
  data: z.unknown(),
});
const sessionEvent = z.union([turnEndEvent, assistantMessageEvent, otherEvent]);

const sessionPageResponse = z.object({
  records: z.array(z.object({
    type: z.string(),
    event: sessionEvent,
  })),
  hasMore: z.boolean(),
});

const sessionPromptRequest = z.object({
  request: z.object({
    requestId: z.string(),
    sessionId: z.string(),
    mode: z.literal("queue"),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  }),
});
const acceptedResponse = z.object({ accepted: z.literal(true) });

const sessionCancelRequest = z.object({ request: z.object({ sessionId: z.string() }) });

/** Every method this project calls, with the wire argument names the Host expects. */
export const METHODS = {
  "workspace/create": {
    method: "workspace/create",
    request: workspaceCreateRequest,
    response: workspaceCreateResponse,
  } satisfies MethodSpec<{ request: { path: string } }, { workspace: { workspaceId: string } }>,
  "session/create": {
    method: "session/create",
    request: sessionCreateRequest,
    response: sessionCreateResponse,
  } satisfies MethodSpec<{ request: { workspaceId: string } }, { sessionId: string }>,
  "session/list": {
    method: "session/list",
    request: sessionListRequest,
    response: sessionListResponse,
  } satisfies MethodSpec<{ _request: Record<string, never> }, { items: SessionSummary[] }>,
  "session/projections": {
    method: "session/projections",
    request: sessionProjectionsRequest,
    response: sessionProjectionsResponse,
  } satisfies MethodSpec<{ request: { sessionId: string } }, SessionProjectionSnapshot | null>,
  "session/page": {
    method: "session/page",
    request: sessionPageRequest,
    response: sessionPageResponse,
  } satisfies MethodSpec<{ request: SessionPageRequest }, SessionPage>,
  "session/prompt": {
    method: "session/prompt",
    request: sessionPromptRequest,
    response: acceptedResponse,
  } satisfies MethodSpec<{ request: PromptRequest }, AcceptedValue>,
  "session/cancel": {
    method: "session/cancel",
    request: sessionCancelRequest,
    response: acceptedResponse,
  } satisfies MethodSpec<{ request: { sessionId: string } }, AcceptedValue>,
} as const;

/** Method name union derived from {@link METHODS}. */
export type MethodName = keyof typeof METHODS;

/** Wire argument type of one method. */
export type ArgOf<M extends MethodName> = z.infer<(typeof METHODS)[M]["request"]>;

/** Validated response value type of one method. */
export type ResOf<M extends MethodName> = z.infer<(typeof METHODS)[M]["response"]>;

/**
 * What we rely on beyond the method table.
 *
 * The engine range is declared here because the published `@deepseek-ai/dsh` has no
 * `engines` field (see `policy/package-spec.ts` for the check itself).
 */
export const CAPABILITIES = {
  apiPrefix: "/api",
  engineRange: "^22.19.0 || >=24.0.0",
  dshLine: "0.2.1-alpha.1",
  /** `GET /?token=` answers 303 with `set-cookie`; everything else is an auth failure. */
  authExchange: { status: 303, cookieHeader: "set-cookie" },
} as const;
