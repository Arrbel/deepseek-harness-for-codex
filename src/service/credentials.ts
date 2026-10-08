// The single credential value object. It is a pure module: no IO, no state machine, no
// decision about *when* to refresh (that belongs to `dsh/client.ts`).
//
// Two rules make leaks structurally impossible rather than a matter of discipline:
//
//   1. Constructing a credential **registers** its secret literals in `util/redaction.ts`, so
//      every outward boundary can scrub them without knowing where the secret came from.
//   2. The object's default stringification (`toString`, `toJSON`, `` `${credential}` ``) is the
//      **redacted** form. Only the two explicitly named accessors (`loginUrl`, `cookieHeader`)
//      hand out the real values, so "print the credential" is safe by default and a leak has to
//      be written on purpose.

import { REDACTED, redactErrorText, redactSecrets, registerSecret } from "../util/redaction.js";

/** A cookie value shorter than this is only scrubbed as a whole `name=value` pair. */
const MIN_BARE_COOKIE_LENGTH = 8;

/** Hides the launch token wherever a URL can leak into a log or error message. */
export function redactLaunchToken(value: string): string {
  return redactSecrets(value);
}

/** Redacted tail of a child log, bounded so errors stay readable. */
export function logTail(value: string, max = 4_000): string {
  return redactSecrets(value.slice(-max));
}

/** Operator-facing text of a thrown browser/launch failure, with credentials removed. */
export function redactFailure(error: unknown): string {
  return redactErrorText(error);
}

/**
 * The launch credential as one value object.
 *
 * `loginUrl` is the one-time URL the user is *meant* to receive (it is the bearer credential the
 * tool returns); everything else about this object — logs, errors, snapshots, `JSON.stringify` —
 * is redacted. Treating it as a value object is what keeps the intentional carrier and the
 * accidental carriers apart.
 */
export class LaunchCredentials {
  readonly #loginUrl: string;
  #cookie: string | null;

  public constructor(loginUrl: string, cookie: string | null = null) {
    this.#loginUrl = loginUrl;
    registerLaunchUrl(loginUrl);
    this.#cookie = cookie;
    if (cookie !== null) rememberCookie(cookie);
  }

  /** The real one-time URL. Only the login-link output path may read this. */
  public get loginUrl(): string {
    return this.#loginUrl;
  }

  /** The real cookie header value for the wire. Never for logs or snapshots. */
  public get cookieHeader(): string | null {
    return this.#cookie;
  }

  /** True once the login URL was exchanged for a cookie. */
  public get authenticated(): boolean {
    return this.#cookie !== null;
  }

  /** Attaches the cookie from the exchange and registers it as a secret. */
  public withCookie(cookie: string | null): LaunchCredentials {
    if (cookie !== null) rememberCookie(cookie);
    this.#cookie = cookie;
    return this;
  }

  /** Drops the cookie (the next call re-exchanges the URL); the secret stays registered. */
  public invalidate(): void {
    this.#cookie = null;
  }

  /** The only form that may leave the process. */
  public get redacted(): { url: string; cookie: string } {
    return { url: redactLaunchToken(this.#loginUrl), cookie: this.#cookie === null ? "(none)" : "(set)" };
  }

  /** Scrubs arbitrary text with this credential's secrets. */
  public redact(text: string): string {
    return redactSecrets(text);
  }

  /** Scrubbed: template interpolation and logs can never print the credential. */
  public toString(): string {
    return `url=${this.redacted.url} cookie=${this.redacted.cookie}`;
  }

  /** Scrubbed: `JSON.stringify(credentials)` is safe. */
  public toJSON(): { url: string; cookie: string } {
    return this.redacted;
  }
}

/** Registers the `token=` value (and the whole URL) carried by a launch URL. */
export function registerLaunchUrl(loginUrl: string): void {
  try {
    const token = new URL(loginUrl).searchParams.get("token");
    if (token !== null && token !== "") registerSecret(token);
  } catch {
    // Not a parseable URL: the `token=` rewrite in `redactSecrets` still covers its text form.
  }
}

/** Registers a cookie pair (and its value when that value is long enough to be unambiguous). */
export function rememberCookie(cookie: string | null | undefined): void {
  if (typeof cookie !== "string") return;
  const pair = parseSetCookie(cookie);
  if (pair === null) return;
  registerSecret(pair);
  const value = pair.slice(pair.indexOf("=") + 1);
  if (value.length >= MIN_BARE_COOKIE_LENGTH) registerSecret(value);
}

/** What the Host handed back when the launch URL was exchanged for authority. */
export interface LaunchCredentialView {
  /** The launch URL exactly as printed by `dsh web` (the caller's one-time credential). */
  readonly url: string;
  /** The authority-bound cookie header value, or `null` before the exchange. */
  readonly cookie: string | null;
}

/** Redacted view of a credential for logs and diagnostic surfaces. */
export function describeCredentials(credentials: LaunchCredentialView): string {
  return `url=${redactLaunchToken(credentials.url)} cookie=${credentials.cookie === null ? "(none)" : "(set)"}`;
}

/**
 * Extracts the cookie pair from one `set-cookie` header value, or `null` when it is unusable.
 *
 * A pair needs a non-empty name before the `=`: an attribute-only or nameless entry (`"=; Path=/"`
 * or `"HttpOnly"`) must never be sent as the cookie header, which is what made the single-header
 * fallback silently send garbage instead of failing.
 */
export function parseSetCookie(setCookie: string | null): string | null {
  const pair = setCookie?.split(";", 1)[0]?.trim();
  if (pair === undefined || pair.length === 0) return null;
  return pair.indexOf("=") > 0 ? pair : null;
}

/** The part of the fetch `Headers` API the cookie read needs (keeps this module testable). */
export interface SetCookieHeaders {
  get(name: string): string | null;
  /** Present on Node's `Headers` (undici) and in browsers; absent on older shims. */
  getSetCookie?: (() => string[]) | undefined;
}

/**
 * Reads the login cookie, preferring the array API.
 *
 * Why: a `set-cookie` value may contain a comma inside an attribute (`Expires=Wed, 21 Oct...`),
 * so the single-header form cannot be split reliably — the old fallback truncated such a value.
 * `Headers#getSetCookie()` (Node 19.7+, undici) returns each cookie separately; the single-header
 * read stays only as a documented fallback for a runtime without that method.
 */
export function readSetCookieHeader(headers: SetCookieHeaders): string | null {
  const list = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const candidates = list.length > 0 ? list : [headers.get("set-cookie")];
  for (const candidate of candidates) {
    const pair = parseSetCookie(candidate);
    if (pair !== null) return pair;
  }
  return null;
}

/** True when the login exchange answered a cookie-bearing 303 (the only accepted shape). */
export function isCookieBearing303(status: number, cookie: string | null): boolean {
  return status === 303 && cookie !== null;
}

/** Re-exported so callers get the marker from the credential module too. */
export { REDACTED };
