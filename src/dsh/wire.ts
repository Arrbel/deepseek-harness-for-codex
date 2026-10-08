// Envelope codec and error classification for the Harness Web RPC surface.
//
// This module is the **single** classification implementation (ADR-0003 §3.2, P5): every layer
// that has to answer "retry, recover, or fail?" reads a `WireFailureKind` produced here.
// `run/state.ts` owns the *policy* (how many attempts, which terminal reason); this file only
// names what happened.
//
// Pure by construction: it turns parsed JSON, HTTP statuses, and thrown errors into typed
// outcomes. It never fetches, never holds a cookie, and never decides whether to retry.

import type { RpcEnvelope } from "./types.js";

/** The Host's own paths for the `/api/<method>` surface. */
export const API_PREFIX = "/api";

/** HTTP statuses that mean "the cookie is missing, stale, or not bound to this authority". */
const AUTH_STATUSES = new Set([401, 403]);

/** HTTP statuses that mean "the thing you named does not exist" — a caller error, not a run failure. */
const NOT_FOUND_STATUSES = new Set([404]);

/** Business error code carried by an accepted envelope with `result.ok === false`. */
export function rpcErrorCode(envelope: RpcEnvelope<unknown>): string | null {
  return envelope.result.ok ? null : envelope.result.error.code;
}

/** Business error message carried by an accepted envelope with `result.ok === false`. */
export function rpcErrorMessage(envelope: RpcEnvelope<unknown>): string | null {
  return envelope.result.ok ? null : envelope.result.error.message;
}

/** Envelope the Host must answer with; anything else is protocol drift. */
export function isRpcEnvelope(value: unknown): value is RpcEnvelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const result = (value as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return false;
  const record = result as { ok?: unknown; value?: unknown; error?: unknown };
  if (record.ok === true) return "value" in record;
  if (record.ok !== false) return false;
  const error = record.error;
  if (typeof error !== "object" || error === null) return false;
  const shape = error as { code?: unknown; message?: unknown };
  return typeof shape.code === "string" && typeof shape.message === "string";
}

/** Failure classes the client distinguishes (the recovery table in `docs/architecture.md` §3.2). */
export type WireFailureKind = "auth-expired" | "transport" | "protocol-drift" | "not-found" | "rpc";

const WIRE_FAILURE_KINDS: readonly WireFailureKind[] = ["auth-expired", "transport", "protocol-drift", "not-found", "rpc"];

/** Narrows an arbitrary value to a {@link WireFailureKind} (used for error duck-typing). */
export function isWireFailureKind(value: unknown): value is WireFailureKind {
  return typeof value === "string" && (WIRE_FAILURE_KINDS as readonly string[]).includes(value);
}

/**
 * Classifies one failed HTTP call without deciding what to do about it.
 *
 * `404` is `not-found` rather than `transport`: retrying a name that does not exist would be a
 * lie, and ADR-0003 §3.2 requires that class to surface as a caller error.
 */
export function classifyHttpStatus(status: number): WireFailureKind {
  if (AUTH_STATUSES.has(status)) return "auth-expired";
  if (NOT_FOUND_STATUSES.has(status)) return "not-found";
  return "transport";
}

/** Known Node/undici network error codes that name a transport failure. */
export const TRANSPORT_CODES: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ABORT_ERR",
];

const TRANSPORT_CODE_SET = new Set(TRANSPORT_CODES);

/** True when `code` is one of the network error codes this project recognizes. */
export function isKnownTransportCode(code: string): boolean {
  return TRANSPORT_CODE_SET.has(code);
}

/**
 * The `code` property of a thrown error, or `null` when it carries none.
 *
 * The `cause` chain is walked because the fetch layer wraps the real failure: undici throws
 * `TypeError: fetch failed` and puts `ECONNREFUSED`/`UND_ERR_SOCKET` on `error.cause`.
 */
export function transportErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True for the abort/timeout shapes Node throws when a request is cancelled or times out. */
export function isAbortOrTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Classifies a thrown fetch/transport error.
 *
 * A *thrown* error on this surface can only be the transport: authentication problems arrive as
 * HTTP statuses (`classifyHttpStatus`) and protocol problems as envelopes or validation failures
 * (`isRpcEnvelope`, `describeParseFailure`). So this function has exactly one possible answer —
 * a property of the design, not a missing branch. `transportErrorCode()` and
 * `isKnownTransportCode()` expose the underlying cause for diagnostics and tests.
 */
export function classifyTransportError(error: unknown): WireFailureKind {
  void error;
  return "transport";
}

/**
 * Describes a validation failure as `path: message` pairs, e.g. `records.0.event.seq: Expected number`.
 *
 * The JSON path is what ADR-0003 §3.2 requires a `ProtocolDrift` failure to carry: without it
 * "the contract changed" is not actionable.
 */
export function describeParseFailure(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const described = issues.slice(0, 3).map((issue) => {
      const record = issue as { path?: unknown; message?: unknown; code?: unknown };
      const path = Array.isArray(record.path) && record.path.length > 0 ? record.path.join(".") : "(root)";
      const message =
        typeof record.message === "string"
          ? record.message
          : typeof record.code === "string"
            ? record.code
            : "invalid value";
      return `${path}: ${message}`;
    });
    const remaining = issues.length - described.length;
    return remaining > 0 ? `${described.join("; ")} (+${String(remaining)} more)` : described.join("; ");
  }
  const message = error instanceof Error ? error.message : String(error);
  return message === "" ? "unrecognized value" : message;
}

/**
 * The JSON path of the field a validation failure names, or `null` when there is none.
 *
 * Unlike {@link describeParseFailure} (which renders up to three `path: message` pairs for humans),
 * this returns the *single* first offending path in machine-readable form, so a drift failure can
 * carry its location as a field instead of only inside prose. The `cause` chain is walked for the
 * same reason {@link transportErrorCode} walks it: the client rethrows a typed error whose `cause`
 * is the validator's own failure. An empty path (a root-level shape mismatch) renders as
 * `(root)`, matching the text.
 */
export function parseFailurePath(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const own = (current as { path?: unknown }).path;
    if (typeof own === "string" && own !== "") return own;
    const issues = (current as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as { path?: unknown };
      return Array.isArray(first.path) && first.path.length > 0 ? first.path.join(".") : "(root)";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** A thrown failure, classified. `unknown` is deliberately not retryable. */
export interface ClassifiedWireFailure {
  readonly kind: WireFailureKind | "unknown";
  /** Business or errno code the failure carried, when any. */
  readonly code: string | null;
  /** Operator-facing text; never empty. */
  readonly message: string;
  /**
   * The RPC method that failed, when the failure belongs to one call.
   *
   * Read for every class (an expired cookie on `session/page` is as useful to name as drift), so a
   * caller no longer has to reach back into the error object to say *which* call broke.
   */
  readonly method: string | null;
  /**
   * The JSON path of the offending field for a `protocol-drift` failure, else `null`.
   *
   * Deliberately restricted to drift: an errno failure also has a `path` property, but it names a
   * filesystem location, not a field in the wire contract, and conflating the two would make the
   * field mean two things.
   */
  readonly path: string | null;
}

/** Operator-facing text of an arbitrary throw. */
function thrownText(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** A non-empty string property of an unknown value, or `null`. */
function readText(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found !== "" ? found : null;
}

/**
 * Adds the structured drift context to `message` when the text does not already name it.
 *
 * The client's drift message already names the failed method (so it is never repeated) but renders
 * the offending path relative to the value that was validated; the anchored wire path is what the
 * operator needs, so it is appended. The guard makes the enrichment idempotent: a message that
 * already carries the anchored path comes back unchanged.
 */
function withDriftContext(message: string, method: string | null, path: string | null): string {
  const missing: string[] = [];
  if (method !== null && !message.includes(method)) missing.push(`method ${method}`);
  if (path !== null && !message.includes(path)) missing.push(`path ${path}`);
  return missing.length === 0 ? message : `${message} (${missing.join(", ")})`;
}

/**
 * Classifies any thrown failure into the recovery vocabulary.
 *
 * The typed client error (`DshRpcError`) is the primary source — read by duck-typing `kind`, so
 * this stays a pure classifier with no dependency on the client module. Two errno-based rules
 * remain because they carry meaning no HTTP status can express: a missing path is a *caller*
 * error (`not-found`), and an aborted/timed-out request is the transport. Everything else is
 * `unknown`, which the policy does not retry: an unrecognized failure must never be papered over.
 *
 * A `protocol-drift` failure additionally carries the failed `method` and the offending field's
 * JSON `path` as fields — "the contract changed" is only actionable with both (ADR-0003 §3.2).
 */
export function classifyThrownFailure(error: unknown): ClassifiedWireFailure {
  const message = thrownText(error);
  const record = typeof error === "object" && error !== null ? (error as { kind?: unknown; rpcCode?: unknown }) : null;
  const method = readText(error, "method");
  const typedKind = record?.kind;
  if (isWireFailureKind(typedKind)) {
    const rpcCode = record?.rpcCode;
    const code = typeof rpcCode === "string" && rpcCode !== "" ? rpcCode : transportErrorCode(error);
    if (typedKind === "protocol-drift") {
      const path = readText(error, "path") ?? parseFailurePath(error);
      return { kind: typedKind, code, message: withDriftContext(message, method, path), method, path };
    }
    return { kind: typedKind, code, message, method, path: null };
  }
  const code = transportErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return { kind: "not-found", code, message, method, path: null };
  if (code !== null && isKnownTransportCode(code)) return { kind: "transport", code, message, method, path: null };
  if (isAbortOrTimeout(error)) return { kind: "transport", code, message, method, path: null };
  return { kind: "unknown", code, message, method, path: null };
}
