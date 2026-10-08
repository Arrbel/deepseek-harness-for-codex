// Unit tests for the single classification implementation (`dsh/wire.ts`).
//
// ADR-0003 §3.2 makes this file the *only* place that names a failure class, so the assertions
// here are what keep `run/state.ts`'s policy table honest: the class comes from `kind`, never
// from the message text, and the vocabularies of the two modules cannot drift apart.
import { describe, expect, it } from "vitest";
import { DshRpcError } from "../../src/dsh/client.js";
import {
  TRANSPORT_CODES,
  classifyHttpStatus,
  classifyThrownFailure,
  classifyTransportError,
  describeParseFailure,
  isAbortOrTimeout,
  isKnownTransportCode,
  isWireFailureKind,
  parseFailurePath,
  transportErrorCode,
  type WireFailureKind,
} from "../../src/dsh/wire.js";
import { recoveryPolicyFor } from "../../src/run/state.js";
import "../support/isolation.js";

describe("dsh/wire classification", () => {
  it("reads the class from the typed client error instead of the message text", () => {
    // The message deliberately contains the words the replaced regexes looked for; the class
    // must still come from `kind`.
    const auth = new DshRpcError("cookie unauthorized", { kind: "auth-expired", method: "session/list" });
    const rpc = new DshRpcError('session/prompt failed: MISSING_CREDENTIAL: no API key for provider route "x"', {
      kind: "rpc",
      method: "session/prompt",
      rpcCode: "MISSING_CREDENTIAL",
    });

    expect(classifyThrownFailure(auth)).toEqual({
      kind: "auth-expired",
      code: null,
      message: "cookie unauthorized",
      method: "session/list",
      path: null,
    });
    expect(classifyThrownFailure(rpc).kind).toBe("rpc");
    expect(classifyThrownFailure(rpc).code).toBe("MISSING_CREDENTIAL");
    expect(classifyThrownFailure(rpc).message).toContain("no API key for provider route");
  });

  it("keeps the protocol-drift class and its JSON path actionable", () => {
    const drift = new DshRpcError("session/page failed: the Host answered with a value that drifts (records: nope)", {
      kind: "protocol-drift",
      method: "session/page",
    });

    expect(classifyThrownFailure(drift)).toMatchObject({ kind: "protocol-drift", code: null, path: null });
    expect(classifyThrownFailure(drift).method).toBe("session/page");
    expect(classifyThrownFailure(drift).message).toContain("records: nope");
  });

  it("treats a missing path as a caller error and a timeout as the transport", () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

    expect(classifyThrownFailure(missing)).toMatchObject({ kind: "not-found", code: "ENOENT" });
    expect(classifyThrownFailure(timeout).kind).toBe("transport");
    expect(isAbortOrTimeout(timeout)).toBe(true);
  });

  it("never guesses a retryable class for an unrecognized failure", () => {
    expect(classifyThrownFailure(new Error("something new")).kind).toBe("unknown");
    expect(classifyThrownFailure("a thrown string")).toEqual({
      kind: "unknown",
      code: null,
      message: "a thrown string",
      method: null,
      path: null,
    });
  });

  it("classifies HTTP statuses, with 404 as a caller error", () => {
    expect(classifyHttpStatus(401)).toBe("auth-expired");
    expect(classifyHttpStatus(403)).toBe("auth-expired");
    expect(classifyHttpStatus(404)).toBe("not-found");
    expect(classifyHttpStatus(500)).toBe("transport");
  });

  it("has exactly one answer for a thrown transport error, and names the cause separately", () => {
    // Not a missing branch: an auth or protocol problem arrives as a status or an envelope.
    expect(classifyTransportError(new Error("anything"))).toBe("transport");
    expect(classifyTransportError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("transport");
    expect(transportErrorCode(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
    expect(transportErrorCode(new Error("no code"))).toBeNull();
  });

  it("recognizes the network error codes it documents", () => {
    expect(TRANSPORT_CODES.length).toBeGreaterThan(0);
    for (const code of TRANSPORT_CODES) expect(isKnownTransportCode(code)).toBe(true);
    expect(isKnownTransportCode("EUNKNOWN")).toBe(false);
    expect(isKnownTransportCode("ENOENT")).toBe(false);
  });

  it("narrows kinds and describes validation failures with their JSON path", () => {
    expect(isWireFailureKind("rpc")).toBe(true);
    expect(isWireFailureKind("something-new")).toBe(false);
    expect(isWireFailureKind(7)).toBe(false);

    const zodLike = {
      issues: [
        { path: ["items", 0, "sessionId"], message: "Expected string, received number" },
        { path: [], code: "invalid_type" },
      ],
    };
    expect(describeParseFailure(zodLike)).toBe("items.0.sessionId: Expected string, received number; (root): invalid_type");
    expect(describeParseFailure(new Error("plain failure"))).toBe("plain failure");
    expect(describeParseFailure("")).toBe("unrecognized value");
  });

  it("keeps the wire vocabulary usable by the run policy table (compile-time sync check)", () => {
    // `run/state.ts` restates these five members because it is a pure module; passing a
    // `WireFailureKind` into `recoveryPolicyFor` only compiles while the two stay in sync.
    const kinds: WireFailureKind[] = ["auth-expired", "transport", "protocol-drift", "not-found", "rpc"];
    for (const kind of kinds) expect(recoveryPolicyFor(kind).attempts).toBeGreaterThanOrEqual(1);
  });
});

describe("dsh/wire structured protocol drift", () => {
  it("adds the anchored wire path when the text only names the bare validator path", () => {
    const drift = new DshRpcError(
      "session/page failed: the Host answered with a value that drifts from the contract (records.0.event.seq: Expected number).",
      { kind: "protocol-drift", method: "session/page", path: "result.value.records.0.event.seq" },
    );

    const classified = classifyThrownFailure(drift);
    expect(classified).toMatchObject({
      kind: "protocol-drift",
      method: "session/page",
      path: "result.value.records.0.event.seq",
    });
    // The method is already in the text, so it is not repeated; the anchor is what gets added.
    expect(classified.message).toBe(`${drift.message} (path result.value.records.0.event.seq)`);
    expect(classified.message).not.toContain("method session/page");
  });

  it("leaves the text alone when it already names the method and the anchored path", () => {
    const message = "session/list failed: the value drifts at result.value.items";
    const drift = new DshRpcError(message, {
      kind: "protocol-drift",
      method: "session/list",
      path: "result.value.items",
    });

    expect(classifyThrownFailure(drift).message).toBe(message);
  });

  it("names the method and the path in the text when the throw does not", () => {
    const drift = new DshRpcError("the contract changed", {
      kind: "protocol-drift",
      method: "session/list",
      path: "result.value.items",
    });

    const classified = classifyThrownFailure(drift);
    expect(classified.message).toBe("the contract changed (method session/list, path result.value.items)");
    expect(classified.method).toBe("session/list");
    expect(classified.path).toBe("result.value.items");
  });

  it("derives the path from the validator failure on the cause chain", () => {
    // The real shape: the client rethrows a typed error whose `cause` is the validator failure.
    const caused = new DshRpcError("session/page failed: drift", {
      kind: "protocol-drift",
      method: "session/page",
      cause: { issues: [{ path: ["records", 0, "event", "seq"], message: "Expected number" }] },
    });

    expect(classifyThrownFailure(caused)).toMatchObject({ method: "session/page", path: "records.0.event.seq" });
    expect(classifyThrownFailure(caused).message).toContain("path records.0.event.seq");
  });

  it("reads a root-level mismatch as the root rather than an empty path", () => {
    expect(parseFailurePath({ issues: [{ path: [], message: "Expected object, received null" }] })).toBe("(root)");
    expect(parseFailurePath({ issues: [{ path: ["items", 0], message: "Expected object" }] })).toBe("items.0");
    expect(parseFailurePath({ issues: [] })).toBeNull();
    expect(parseFailurePath(new Error("no validator"))).toBeNull();
    expect(classifyThrownFailure(new Error("no validator")).path).toBeNull();
  });

  it("keeps the path field drift-only so an errno path cannot be mistaken for a field", () => {
    const missing = Object.assign(new Error("ENOENT: no such file or directory"), {
      code: "ENOENT",
      path: "C:/scratch/missing.json",
    });

    expect(classifyThrownFailure(missing)).toMatchObject({ kind: "not-found", path: null });
  });
});
