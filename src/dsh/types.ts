// Protocol DTOs for the DeepSeek Harness Web RPC surface.
//
// These are the *shapes* the client and the event projections read. They are type-only: no
// runtime imports, so this module stays a pure data description of the wire vocabulary.

/** Envelope the Host answers every `/api/<method>` call with. */
export interface RpcEnvelope<T> {
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

/** One entry of `session/list#items` (only the fields this client reads are required). */
export interface SessionSummary {
  sessionId: string;
  running: boolean;
  blank: boolean;
  /**
   * Working directory the session runs in — **required**, because it is the only proof that a
   * session may be reused for a given workspace (ADR-0004: a field we depend on must exist and be
   * typed; extra keys we do not read stay allowed). A Host that omits it is drift, and the
   * orchestration layer still refuses to reuse a session whose `cwd` is not a usable string.
   */
  cwd: string;
}

/** `turn/end#data` — the shape the outcome mapping depends on. */
export interface TurnEndData {
  turn?: number | undefined;
  reason: {
    kind: string;
    /** Nested cause of an `aborted` turn (`{ kind: "user" | "parent" | … }`). */
    reason?: { kind: string } | null | undefined;
    error?: unknown;
  };
}

/** `assistant/message#data` — the shape the text projection depends on. */
export interface AssistantMessageData {
  turn?: number | undefined;
  step?: number | undefined;
  message?:
    | {
        role?: string | undefined;
        content?: Array<{ type: string; text?: string | undefined }> | undefined;
      }
    | undefined;
}

/** One durable session event as carried by `session/page` records. */
export interface HistoryEvent {
  event: { type: string; seq: number; data: unknown };
}

/** `session/projections` value; `null` means "unknown session". */
export interface SessionProjectionSnapshot {
  asOfSeq: number;
}

/** `session/page` request cursor and window. */
export interface SessionPageRequest {
  address: { kind: "session"; sessionId: string };
  throughSeq: number;
  maxMessages: number;
  beforeSeq?: number;
}

/** `session/page` response: a backwards window of durable records. */
export interface SessionPage {
  records: Array<{ type: string; event: { type: string; seq: number; data: unknown } }>;
  hasMore: boolean;
}

/** `session/prompt` request. */
export interface PromptRequest {
  requestId: string;
  sessionId: string;
  mode: "queue";
  content: Array<{ type: "text"; text: string }>;
}

/** `session/prompt` and `session/cancel` acceptance value. */
export interface AcceptedValue {
  accepted: true;
}
