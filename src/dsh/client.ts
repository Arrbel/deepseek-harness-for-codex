// Authenticated RPC client for the Harness Web surface.
//
// One client instance per service: it owns the cookie exchange, the request envelope, and
// the paging cursor walk. It is deliberately *not* a state machine — it holds the cookie and
// reports typed failures; retry/recovery policy belongs to `run/state.ts` and the
// orchestrator (ADR-0003 §3.2).

import { randomUUID } from "node:crypto";
import { METHODS, type ArgOf, type MethodName, type ResOf } from "./contract.js";
import {
  API_PREFIX,
  classifyHttpStatus,
  describeParseFailure,
  isRpcEnvelope,
  parseExpectedType,
  parseFailurePath,
  rpcErrorCode,
  rpcErrorMessage,
  type WireFailureKind,
} from "./wire.js";
import { recordDrift } from "./drift.js";
import type { HistoryEvent, SessionPage } from "./types.js";
import { readSetCookieHeader, redactLaunchToken, rememberCookie } from "../service/credentials.js";
import { isLoopbackUrl } from "../policy/trusted-input.js";

/** Maximum number of `session/page` windows walked for one read. */
const MAX_PAGE_WINDOWS = 100;

/**
 * Where a validator's JSON path sits in the wire envelope, one anchor per direction.
 *
 * A drift failure has to be locatable without reading the client: the request travels as
 * `payload.args`, so a bad `request.sessionId` is `payload.args.request.sessionId` on the wire.
 */
const REQUEST_ANCHOR = "payload.args";
const RESPONSE_ANCHOR = "result.value";

/** Renders a validator path as a wire path; a root-level mismatch names only the anchor. */
function wirePath(anchor: string, path: string | null): string | null {
  if (path === null) return null;
  return path === "(root)" ? anchor : `${anchor}.${path}`;
}

/** Per-call HTTP budget (unchanged from the pre-refactor client). */
const RPC_TIMEOUT_MS = 15_000;

/** Minimal fetch shape, injectable so the client is unit-testable without a server. */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Mutable slots the client exchanges credentials through.
 *
 * Keeping the slots outside the client lets the service record stay the single owner of the
 * cookie (and lets a test observe the exchange count without reimplementing it).
 */
export interface CredentialSlots {
  webUrl: string;
  cookie?: string | null;
  pending?: Promise<string> | null;
}

export interface DshClientOptions {
  readonly serviceId: string;
  /** The live credential slots of the owning service. */
  readonly credentialSlots: CredentialSlots;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Upper bound on `session/page` windows walked per read. */
  readonly maxPageWindows?: number;
}

/**
 * Typed client failure; the message text is part of the observable surface.
 *
 * `kind` is the classification (ADR-0003 §3.2) and the *only* input the recovery policy reads:
 * the client never guesses a class from the message, and callers never re-derive one.
 */
export class DshRpcError extends Error {
  /** Which recovery class this failure belongs to. */
  public readonly kind: WireFailureKind;
  /** The RPC method that failed, when the failure belongs to one call. */
  public readonly method: string | null;
  /** Business error code the Host supplied, when any. */
  public readonly rpcCode: string | null;
  /**
   * The offending field's path inside the wire envelope, for a drift failure.
   *
   * Structured on purpose: `describeParseFailure` puts the same location in the message for a
   * human, while this is what `classifyThrownFailure` re-exposes as a field.
   */
  public readonly path: string | null;

  public constructor(
    message: string,
    options: {
      kind: WireFailureKind;
      method?: string | null;
      rpcCode?: string | null;
      path?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DshRpcError";
    this.kind = options.kind;
    this.method = options.method ?? null;
    this.rpcCode = options.rpcCode ?? null;
    this.path = options.path ?? null;
  }
}

/**
 * Reads bounded pages from the current durable cursor back to a run's start.
 *
 * `throughSeq` is the current projection cursor; `beforeSeq` walks backwards one message
 * window at a time. The walk stops on `hasMore: false`, on a window that produced no usable
 * sequence, or when the window would not move past the run's start.
 */
export async function collectEventsSince(
  readPage: (beforeSeq: number | undefined) => Promise<SessionPage>,
  input: { startEventSeq: number; throughSeq: number; maxPageWindows?: number },
): Promise<HistoryEvent[]> {
  if (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < -1) {
    throw new DshRpcError(`Harness returned an invalid session cursor: ${String(input.throughSeq)}`, {
      kind: "protocol-drift",
    });
  }
  const events = new Map<number, HistoryEvent>();
  let beforeSeq: number | undefined;
  for (let pageIndex = 0; pageIndex < (input.maxPageWindows ?? MAX_PAGE_WINDOWS); pageIndex++) {
    const page = await readPage(beforeSeq);
    const pageEvents = page.records
      .filter((record) => record.type === "event" && record.event.seq > input.startEventSeq)
      .map((record) => ({ event: record.event }));
    for (const entry of pageEvents) events.set(entry.event.seq, entry);

    const firstSeq = page.records.reduce(
      (first, record) => Math.min(first, record.event.seq),
      Number.POSITIVE_INFINITY,
    );
    if (!page.hasMore || firstSeq === Number.POSITIVE_INFINITY || firstSeq <= input.startEventSeq + 1) break;
    beforeSeq = firstSeq;
  }
  return [...events.values()].sort((left, right) => left.event.seq - right.event.seq);
}

/** One authenticated connection to a local Harness Web host. */
export class DshClient {
  public readonly serviceId: string;
  private readonly slots: CredentialSlots;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxPageWindows: number;

  public constructor(options: DshClientOptions) {
    this.serviceId = options.serviceId;
    this.slots = options.credentialSlots;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
    this.maxPageWindows = options.maxPageWindows ?? MAX_PAGE_WINDOWS;
  }

  /** The cookie currently held by this client, if any. */
  public get currentCookie(): string | null {
    return this.slots.cookie ?? null;
  }

  /** Clears the held cookie so the next call exchanges the launch URL again (401 recovery). */
  public invalidateCredentials(): void {
    this.slots.cookie = null;
    this.slots.pending = null;
  }

  /** Exchanges the launch URL for the Host's authority-bound cookie exactly once. */
  public async ensureCredentials(): Promise<string> {
    if (this.slots.cookie !== null && this.slots.cookie !== undefined) return this.slots.cookie;
    if (this.slots.pending !== null && this.slots.pending !== undefined) return await this.slots.pending;
    const pending = (async () => {
      // The credential is a bearer token: it may only ever be sent to a loopback Host. Refusing
      // here (rather than at the spawn site) makes the check a property of *using* the credential.
      if (!isLoopbackUrl(this.slots.webUrl)) {
        throw new DshRpcError(
          `Refusing to exchange the launch credential with a non-loopback Host: ${redactLaunchToken(this.slots.webUrl)}`,
          { kind: "protocol-drift" },
        );
      }
      // No `dispatcher`/agent is ever passed: Node's global fetch (undici) ignores `HTTP(S)_PROXY`
      // unless one is supplied, which is what keeps the loopback login URL and every `/api` call
      // off the environment proxy. `tests/security-invariants.test.ts` proves it with a dead proxy.
      const response = await this.fetchImpl(this.slots.webUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const cookie = readSetCookieHeader(response.headers);
      if (response.status !== 303 || cookie === null) {
        throw new DshRpcError(`Harness Web authentication failed with HTTP ${String(response.status)}.`, {
          kind: response.status === 303 ? "protocol-drift" : classifyHttpStatus(response.status),
        });
      }
      // Register the cookie as a secret: no outward string may carry it from here on.
      rememberCookie(cookie);
      this.slots.cookie = cookie;
      return cookie;
    })();
    this.slots.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.slots.pending === pending) this.slots.pending = null;
    }
  }

  /** Calls one method, validating the request we send and the value we accept. */
  public async call<M extends MethodName>(method: M, args: ArgOf<M>, opts: { signal?: AbortSignal } = {}): Promise<ResOf<M>> {
    try {
      METHODS[method].request.parse(args);
    } catch (error) {
      // An invalid request is also a contract mismatch, and it must name the field the same way
      // a response drift does — a raw validator error escapes this module unclassified otherwise.
      const path = wirePath(REQUEST_ANCHOR, parseFailurePath(error));
      // Telemetry keeps only `typeNameOf(args)`; the args themselves may hold a token.
      recordDrift({ kind: "protocol-drift", method, path, expectedType: parseExpectedType(error), gotValue: args });
      throw new DshRpcError(
        `${method} failed: the request does not match the contract (${describeParseFailure(error)}).`,
        {
          kind: "protocol-drift",
          method,
          path,
          cause: error,
        },
      );
    }
    const cookie = await this.ensureCredentials();
    const response = await this.fetchImpl(new URL(`${API_PREFIX}/${method}`, new URL(this.slots.webUrl).origin), {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        type: "client-request",
        rpcId: `mcp-${randomUUID()}`,
        method,
        payload: { args },
      }),
      signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new DshRpcError(`${method} failed over HTTP ${String(response.status)}: ${await response.text()}`, {
        kind: classifyHttpStatus(response.status),
        method,
      });
    }
    const body: unknown = await response.json();
    if (!isRpcEnvelope(body)) {
      throw new DshRpcError(`${method} failed: the Host answered with an unrecognized envelope.`, {
        kind: "protocol-drift",
        method,
      });
    }
    if (!body.result.ok) {
      throw new DshRpcError(`${method} failed: ${String(rpcErrorCode(body))}: ${String(rpcErrorMessage(body))}`, {
        kind: "rpc",
        method,
        rpcCode: rpcErrorCode(body),
      });
    }
    try {
      return METHODS[method].response.parse(body.result.value) as ResOf<M>;
    } catch (error) {
      // The JSON path is the actionable part of "the contract changed" (ADR-0003 §3.2).
      const path = wirePath(RESPONSE_ANCHOR, parseFailurePath(error));
      // Telemetry keeps only `typeNameOf(body.result.value)`: the value can carry model output, a
      // token echoed by the Host, or a whole prompt, and none of that may reach the log.
      recordDrift({ kind: "protocol-drift", method, path, expectedType: parseExpectedType(error), gotValue: body.result.value });
      throw new DshRpcError(
        `${method} failed: the Host answered with a value that drifts from the contract (${describeParseFailure(error)}).`,
        {
          kind: "protocol-drift",
          method,
          path,
          cause: error,
        },
      );
    }
  }

  /** Reads the durable events of one session from `startEventSeq` through `throughSeq`. */
  public async readEvents(sessionId: string, startEventSeq: number, throughSeq: number): Promise<HistoryEvent[]> {
    return await collectEventsSince(
      async (beforeSeq) => await this.call("session/page", {
        request: {
          address: { kind: "session", sessionId },
          throughSeq,
          maxMessages: 100,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        },
      }),
      { startEventSeq, throughSeq, maxPageWindows: this.maxPageWindows },
    );
  }
}
