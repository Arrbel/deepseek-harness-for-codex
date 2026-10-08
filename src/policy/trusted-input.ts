// Input boundaries: which caller-supplied values are used verbatim and which are rejected.
//
// External commands are started as argv with `shell:false`, so there is no command line to
// escape; these predicates cover the values that reach a path or a session identifier.

/** Maximum accepted task length (mirrors the MCP tool schema). */
export const MAX_TASK_CHARACTERS = 100_000;

/** Trimmed task text, or a typed error when it is empty or over the limit. */
export function requireTask(task: string): string {
  const trimmed = task.trim();
  if (!trimmed) throw new Error("task must not be empty.");
  if (trimmed.length > MAX_TASK_CHARACTERS) {
    throw new Error("task exceeds the 100,000 character limit.");
  }
  return trimmed;
}

/** Optional session identifier: `undefined`/empty means "create a new session". */
export function optionalSessionId(sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * True for the only Hosts this project will send a credential to.
 *
 * The launch URL carries a bearer token, and the cookie that replaces it is authority-bound: a
 * non-loopback Host (a LAN address, a hostname, `0.0.0.0`, anything non-`http`) must never receive
 * either. This is a predicate, so the refusal happens where the credential would be used.
 */
export function isLoopbackUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.hostname === "localhost" || parsed.hostname === "::1" || parsed.hostname === "[::1]") return true;
  // `127.0.0.0/8` is the loopback block; a dotted-number check keeps a DNS name out.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(parsed.hostname);
}
