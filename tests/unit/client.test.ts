// Unit tests for `dsh/client.ts`: the credential exchange, the request/response contract,
// and the backwards page walk.
//
// `fetchImpl` is injected, so these cases exercise the real client code paths without a
// server, a child process, or a cookie jar.
import { describe, expect, it } from "vitest";
import { DshClient, DshRpcError, collectEventsSince, type FetchLike } from "../../src/dsh/client.js";
import { isRpcEnvelope, classifyHttpStatus, classifyThrownFailure, rpcErrorCode, type ClassifiedWireFailure } from "../../src/dsh/wire.js";
import type { HistoryEvent } from "../../src/dsh/types.js";
import "../support/isolation.js";

const WEB_URL = "http://127.0.0.1:1234/?token=fixture-token";

interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Builds a fetch stub that answers the launch exchange and then the RPC surface. */
function stubFetch(options: {
  exchange?: { status: number; setCookie?: string | null };
  rpc?: (method: string, calls: Recorded[]) => Response;
} = {}): { fetchImpl: FetchLike; calls: Recorded[]; exchanges: number } {
  const calls: Recorded[] = [];
  let exchanges = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url === WEB_URL) {
      exchanges += 1;
      const exchange = options.exchange ?? { status: 303, setCookie: "dsh-auth=fixture; HttpOnly" };
      return new Response(null, {
        status: exchange.status,
        headers: exchange.setCookie === undefined || exchange.setCookie === null ? {} : { "set-cookie": exchange.setCookie },
      });
    }
    // `/api/<namespace>/<method>`: the wire method keeps its namespace prefix.
    const method = url.slice(url.indexOf("/api/") + "/api/".length);
    if (options.rpc !== undefined) return options.rpc(method, calls);
    // Minimal well-formed answers for the methods the cases below call by default.
    const defaults: Record<string, unknown> = {
      "session/list": { items: [] },
      "session/page": { records: [], hasMore: false },
      "session/projections": null,
      "session/create": { sessionId: "session-1" },
      "workspace/create": { workspace: { workspaceId: "workspace-1" } },
    };
    // `in` keeps an explicit `null` default (the documented "unknown session" answer)
    // instead of falling through to the generic accepted value.
    const value = Object.hasOwn(defaults, method) ? defaults[method] : { accepted: true };
    return Response.json({ result: { ok: true, value } });
  };
  return { fetchImpl, calls, get exchanges() { return exchanges; } };
}

function client(fetchImpl: FetchLike, slots: { webUrl: string; cookie?: string | null; pending?: Promise<string> | null }): DshClient {
  return new DshClient({ serviceId: "svc-1", credentialSlots: slots, fetchImpl });
}

describe("dsh/client credentials", () => {
  it("exchanges the launch URL for the cookie exactly once across many calls", async () => {
    const stub = stubFetch();
    const slots = { webUrl: WEB_URL, cookie: null, pending: null };
    const session = client(stub.fetchImpl, slots);

    await session.call("session/list", { _request: {} });
    await session.call("session/list", { _request: {} });
    await session.call("session/cancel", { request: { sessionId: "s" } });

    expect(stub.exchanges).toBe(1);
    expect(slots.cookie).toBe("dsh-auth=fixture");
    expect(session.currentCookie).toBe("dsh-auth=fixture");
  });

  it("shares one in-flight exchange between concurrent callers", async () => {
    const slots = { webUrl: WEB_URL, cookie: null, pending: null };
    const stub = stubFetch();
    const session = client(stub.fetchImpl, slots);

    await Promise.all([
      session.ensureCredentials(),
      session.ensureCredentials(),
      session.ensureCredentials(),
    ]);

    expect(stub.exchanges).toBe(1);
  });

  it.each([
    ["a plain 200", { status: 200, setCookie: "dsh-auth=x" }, "HTTP 200"],
    ["a 303 without a cookie", { status: 303, setCookie: null }, "HTTP 303"],
    ["a 500", { status: 500, setCookie: "dsh-auth=x" }, "HTTP 500"],
  ])("rejects %s", async (_label, exchange, expected) => {
    const stub = stubFetch({ exchange });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: null, pending: null });

    await expect(session.ensureCredentials()).rejects.toThrow(new RegExp(`authentication failed with ${expected}`, "u"));
  });

  it("re-exchanges after invalidateCredentials", async () => {
    const stub = stubFetch();
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: null, pending: null });

    await session.ensureCredentials();
    session.invalidateCredentials();
    expect(session.currentCookie).toBeNull();
    await session.ensureCredentials();

    expect(stub.exchanges).toBe(2);
  });
});

describe("dsh/client contract", () => {
  it("carries the client-request envelope and the cookie header", async () => {
    const stub = stubFetch();
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: null, pending: null });

    await session.call("session/page", {
      request: { address: { kind: "session", sessionId: "s-1" }, throughSeq: 4, maxMessages: 100 },
    });

    const call = stub.calls.find((entry) => entry.url.endsWith("/api/session/page"));
    expect(call).toBeDefined();
    expect(call!.url).toBe("http://127.0.0.1:1234/api/session/page");
    expect(call!.init?.method).toBe("POST");
    const envelope = JSON.parse(String(call!.init?.body)) as Record<string, unknown>;
    expect(envelope).toMatchObject({ type: "client-request", method: "session/page" });
    expect(String(envelope.rpcId)).toMatch(/^mcp-/u);
  });

  it("reports an HTTP failure with the method name and body", async () => {
    const stub = stubFetch({ rpc: () => new Response("unauthorized", { status: 401 }) });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    await expect(session.call("session/list", { _request: {} }))
      .rejects.toThrow("session/list failed over HTTP 401: unauthorized");
    await expect(session.call("session/list", { _request: {} })).rejects.toMatchObject({
      kind: "auth-expired",
      method: "session/list",
    });
  });

  it("classifies the HTTP statuses the recovery policy distinguishes", async () => {
    const cases = [
      { status: 401, kind: "auth-expired" },
      { status: 403, kind: "auth-expired" },
      { status: 404, kind: "not-found" },
      { status: 500, kind: "transport" },
    ] as const;
    for (const entry of cases) {
      const stub = stubFetch({ rpc: () => new Response("body", { status: entry.status }) });
      const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });
      await expect(session.call("session/list", { _request: {} })).rejects.toMatchObject({ kind: entry.kind });
    }
  });

  it("reports a business error code and message", async () => {
    const stub = stubFetch({
      rpc: () => Response.json({ result: { ok: false, error: { code: "session/workspace-attach-failed", message: "no attach" } } }),
    });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    await expect(session.call("session/create", { request: { workspaceId: "w" } }))
      .rejects.toThrow("session/create failed: session/workspace-attach-failed: no attach");
    await expect(session.call("session/create", { request: { workspaceId: "w" } })).rejects.toMatchObject({
      kind: "rpc",
      rpcCode: "session/workspace-attach-failed",
    });
  });

  it("refuses an unrecognized envelope instead of trusting the body", async () => {
    const stub = stubFetch({ rpc: () => Response.json({ anything: true }) });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    await expect(session.call("session/list", { _request: {} }))
      .rejects.toThrow(/unrecognized envelope/u);
    await expect(session.call("session/list", { _request: {} })).rejects.toMatchObject({ kind: "protocol-drift" });
  });

  it("refuses a response that drifts from the contract and names the JSON path", async () => {
    const stub = stubFetch({ rpc: () => Response.json({ result: { ok: true, value: { items: "not-an-array" } } }) });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    await expect(session.call("session/list", { _request: {} })).rejects.toThrow(/items: /u);
    await expect(session.call("session/list", { _request: {} })).rejects.toMatchObject({
      kind: "protocol-drift",
      method: "session/list",
      rpcCode: null,
      path: "result.value.items",
    });
  });

  it("validates the request before any network call", async () => {
    const stub = stubFetch();
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    // `session/list` takes `_request`, not `request`.
    await expect(session.call("session/list", { request: {} } as never)).rejects.toThrow();
    expect(stub.calls.filter((entry) => entry.url.includes("/api/"))).toHaveLength(0);
  });

  it("accepts a null projection as a documented answer", async () => {
    const stub = stubFetch({ rpc: () => Response.json({ result: { ok: true, value: null } }) });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    await expect(session.call("session/projections", { request: { sessionId: "s" } })).resolves.toBeNull();
  });
});

/**
 * Runs a call that must fail and returns the classified failure.
 *
 * R2-4 is about what a *caller* can see, so these assertions go through `classifyThrownFailure`
 * instead of reading the thrown `DshRpcError` directly.
 */
async function driftOf(call: () => Promise<unknown>): Promise<ClassifiedWireFailure> {
  try {
    await call();
  } catch (error) {
    return classifyThrownFailure(error);
  }
  throw new Error("expected the call to fail as protocol drift");
}

describe("dsh/client protocol drift carries the method and the wire path", () => {
  it.each([
    {
      shape: "a missing required field",
      value: { items: [{ running: false, blank: false, cwd: "/w" }] },
      path: "result.value.items.0.sessionId",
    },
    { shape: "a field of the wrong type", value: { items: "not-an-array" }, path: "result.value.items" },
    { shape: "a top-level shape mismatch", value: null, path: "result.value" },
  ])("locates $shape at $path", async ({ value, path }) => {
    const stub = stubFetch({ rpc: () => Response.json({ result: { ok: true, value } }) });
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    const classified = await driftOf(() => session.call("session/list", { _request: {} }));

    expect(classified).toMatchObject({ kind: "protocol-drift", method: "session/list", path });
    // Both facts must also reach an operator reading the text, not only the code.
    expect(classified.message).toContain("session/list");
    expect(classified.message).toContain(path);
  });

  it("treats an invalid request as drift and anchors its path in the request envelope", async () => {
    const stub = stubFetch();
    const session = client(stub.fetchImpl, { webUrl: WEB_URL, cookie: "dsh-auth=fixture", pending: null });

    const classified = await driftOf(() => session.call("session/list", { request: {} } as never));

    expect(classified).toMatchObject({ kind: "protocol-drift", method: "session/list", path: "payload.args._request" });
    expect(classified.message).toContain("payload.args._request");
    // Still a caller-side failure: nothing reached the wire.
    expect(stub.calls.filter((entry) => entry.url.includes("/api/"))).toHaveLength(0);
  });
});

describe("dsh/client page walk", () => {
  it("walks backwards with beforeSeq across message windows", async () => {
    const pages: Array<{ beforeSeq: number | undefined; records: HistoryEvent[]; hasMore: boolean }> = [
      { beforeSeq: undefined, records: [event(5), event(6)], hasMore: true },
      { beforeSeq: 5, records: [event(3), event(4)], hasMore: true },
      { beforeSeq: 3, records: [event(1), event(2)], hasMore: false },
    ];
    const seen: Array<number | undefined> = [];
    const result = await collectEventsSince(async (beforeSeq) => {
      seen.push(beforeSeq);
      const match = pages.find((page) => page.beforeSeq === beforeSeq);
      if (match === undefined) throw new Error(`unexpected beforeSeq ${String(beforeSeq)}`);
      return { records: match.records.map((entry) => ({ type: "event", event: entry.event })), hasMore: match.hasMore };
    }, { startEventSeq: 0, throughSeq: 6 });

    expect(seen).toEqual([undefined, 5, 3]);
    expect(result.map((entry) => entry.event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps only events after the run's start and stops at the start boundary", async () => {
    let windows = 0;
    const result = await collectEventsSince(async () => {
      windows += 1;
      return {
        records: [event(1), event(2), event(3)].map((entry) => ({ type: "event", event: entry.event })),
        hasMore: true,
      };
    }, { startEventSeq: 2, throughSeq: 3 });

    // The window's first sequence (1) is not past `startEventSeq + 1`, so the walk stops.
    expect(windows).toBe(1);
    expect(result.map((entry) => entry.event.seq)).toEqual([3]);
  });

  it("ignores non-event records and rejects an invalid cursor", async () => {
    const result = await collectEventsSince(async () => ({
      records: [
        { type: "message", event: event(9).event },
        { type: "event", event: event(10).event },
      ],
      hasMore: false,
    }), { startEventSeq: 0, throughSeq: 10 });
    expect(result.map((entry) => entry.event.seq)).toEqual([10]);

    await expect(collectEventsSince(async () => ({ records: [], hasMore: false }), { startEventSeq: 0, throughSeq: -5 }))
      .rejects.toThrow("invalid session cursor: -5");
  });

  it("deduplicates overlapping windows and returns them in sequence order", async () => {
    const result = await collectEventsSince(async () => ({
      records: [event(2), event(3)].map((entry) => ({ type: "event", event: entry.event })),
      hasMore: false,
    }), { startEventSeq: 0, throughSeq: 3 });
    expect(result.map((entry) => entry.event.seq)).toEqual([2, 3]);
  });
});

describe("dsh/wire helpers", () => {
  it("recognizes only well-formed envelopes", () => {
    expect(isRpcEnvelope({ result: { ok: true, value: 1 } })).toBe(true);
    expect(isRpcEnvelope({ result: { ok: true } })).toBe(false);
    expect(isRpcEnvelope({ result: { ok: false, error: { code: "c", message: "m" } } })).toBe(true);
    expect(isRpcEnvelope({ result: { ok: false, error: { code: "c" } } })).toBe(false);
    expect(isRpcEnvelope(null)).toBe(false);
    expect(isRpcEnvelope({ result: "x" })).toBe(false);
  });

  it("classifies auth statuses and reads business error codes", () => {
    expect(classifyHttpStatus(401)).toBe("auth-expired");
    expect(classifyHttpStatus(403)).toBe("auth-expired");
    expect(classifyHttpStatus(500)).toBe("transport");
    expect(rpcErrorCode({ result: { ok: true, value: 1 } })).toBeNull();
    expect(rpcErrorCode({ result: { ok: false, error: { code: "E", message: "m" } } })).toBe("E");
  });
});

function event(seq: number): HistoryEvent {
  return { event: { type: "assistant/message", seq, data: {} } };
}

describe("dsh/client error type", () => {
  it("keeps the client error name stable for callers and carries its class", () => {
    const error = new DshRpcError("x", { kind: "transport" });
    expect(error.name).toBe("DshRpcError");
    expect(error.kind).toBe("transport");
    expect(error.method).toBeNull();
    expect(error.rpcCode).toBeNull();
  });
});
