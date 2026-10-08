// The secret registry and the one scrubber every outward string passes through.
//
// Root cause this module removes: redaction used to depend on *remembering to call it* at each
// call site (`browserError = errorText(error)` was the one that forgot). Instead, credentials
// register their secret literals here, and the single boundary every tool result crosses
// (`tools/register.ts#registerTools`) scrubs whatever it returns. A future call site that forgets
// therefore still cannot leak: the secret is not a string to be recognized, it is a registered
// value to be replaced.
//
// Pure by construction: no imports, no IO, no clock.

/** Registered secret literals, longest first when used (see {@link redactSecrets}). */
const secrets = new Set<string>();

/**
 * Registers one secret literal.
 *
 * Callers decide the granularity: a launch token is registered bare (it is random enough to never
 * collide with prose), while a short cookie value is registered as its whole `name=value` pair so
 * ordinary words are not mangled.
 */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) secrets.add(trimmed);
}

/** Number of registered secrets; diagnostics for tests, never for output. */
export function registeredSecretCount(): number {
  return secrets.size;
}

/** Forgets every registered secret (test isolation only). */
export function forgetSecrets(): void {
  secrets.clear();
}

/**
 * Replaces every known secret in `text`, plus the `token=` URL parameter even for a token this
 * process never held (a launch URL forwarded from an error message).
 */
export function redactSecrets(text: string): string {
  let redacted = text.replace(/([?&]token=)[^&#\s]*/gu, "$1[redacted]");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

/**
 * Field names that intentionally carry the one-time login URL.
 *
 * The URL *is* the bearer credential the caller asked for (it is what the user clicks to
 * authorize the local Web UI), so it is the single sanctioned carrier. Naming it here keeps that
 * exception explicit and reviewable instead of implicit in every serializer.
 */
export const LOGIN_URL_KEYS: ReadonlySet<string> = new Set(["webUrl", "loginUrl"]);

/** `redactSecrets` over a whole value: objects and arrays are copied, strings are scrubbed. */
export function redactDeep<T>(value: T, key: string | null = null): T {
  if (typeof value === "string") {
    return (key !== null && LOGIN_URL_KEYS.has(key) ? value : redactSecrets(value)) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, key)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [childKey, entry] of Object.entries(value)) copy[childKey] = redactDeep(entry, childKey);
    return copy as T;
  }
  return value;
}

/** Operator-facing text of an arbitrary throw, scrubbed. The choke point for every error exit. */
export function redactErrorText(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message === ""
        ? error.name
        : error.message
      : typeof error === "string"
        ? error
        : String(error);
  return redactSecrets(text);
}

/** The replacement marker; exported so tests assert on one literal. */
export const REDACTED = "[redacted]";
