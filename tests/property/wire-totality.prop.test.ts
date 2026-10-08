// Property: `dsh/wire.ts` classification is **total** and never guesses a class from prose.
//
// This is the module ADR-0003 §3.2 makes the single classifier, so every failure path in the run
// layer funnels through it. The properties below are the ones a *degradation* would break:
//
//   * the class must stay inside the vocabulary, whatever the thrown value looks like;
//   * a value with no `kind` must never be classified as `auth-expired`/`protocol-drift`/`rpc`
//     (that is the message-regex regression R1 removed, restated as an invariant);
//   * the `cause` walk must terminate (a cyclic chain must not hang the classifier);
//   * the envelope guard and the path reader must never throw.
//
// Sweeps are seeded (`tests/property/support/generators.ts`), so a red case is reproducible.
import { describe, expect, it } from "vitest";
import {
  TRANSPORT_CODES,
  classifyHttpStatus,
  classifyThrownFailure,
  describeParseFailure,
  isRpcEnvelope,
  isWireFailureKind,
  parseFailurePath,
  transportErrorCode,
  type WireFailureKind,
} from "../../src/dsh/wire.js";
import {
  arbitraryTypedFailure,
  arbitraryUnknown,
  forAll,
  forEachValue,
  repr,
  SYMBOL_SAMPLE,
  untypedFailure,
} from "./support/generators.js";
import "../support/isolation.js";

const WIRE_KINDS: readonly WireFailureKind[] = ["auth-expired", "transport", "protocol-drift", "not-found", "rpc"];
const ALL_KINDS: readonly string[] = [...WIRE_KINDS, "unknown"];
/** Classes that may only be produced by reading a typed `kind`, never by inspecting text. */
const TYPED_ONLY: readonly string[] = ["auth-expired", "protocol-drift", "rpc"];

const SWEEP = 1_000;
/** Depth at which the `cause` walk stops looking (`wire.ts` bounds it at 4 levels). */
const CAUSE_DEPTH = 4;

describe("property: classifyThrownFailure is total", () => {
  it("returns a vocabulary member and well-typed fields for any reachable thrown value", () => {
    forAll(SWEEP, (rng) => {
      // A top-level symbol is included on purpose: `String(symbol)` is legal, so the classifier
      // must handle it. A symbol *nested* in an aggregate is excluded, and that exclusion is
      // asserted in `known-gaps.prop.test.ts`.
      const input = rng.bool(0.1)
        ? SYMBOL_SAMPLE
        : rng.bool(0.5)
          ? arbitraryUnknown(rng)
          : arbitraryTypedFailure(rng);
      const result = classifyThrownFailure(input);

      expect(ALL_KINDS, `kind for ${repr(input)}`).toContain(result.kind);
      expect(typeof result.message, `message for ${repr(input)}`).toBe("string");
      expect(result.method === null || typeof result.method === "string").toBe(true);
      expect(result.path === null || typeof result.path === "string").toBe(true);
      expect(result.code === null || typeof result.code === "string").toBe(true);
    });
  });

  it("never derives auth, drift, or rpc from a value that carries no typed kind", () => {
    forAll(SWEEP, (rng) => {
      const input = untypedFailure(rng);
      const result = classifyThrownFailure(input);

      expect(TYPED_ONLY, `text-derived class for ${repr(input)}`).not.toContain(result.kind);
      expect(["not-found", "transport", "unknown"], `class for ${repr(input)}`).toContain(result.kind);
    });
  });

  it("surfaces the errno of every known transport code through the cause chain", () => {
    forEachValue(TRANSPORT_CODES, (code) => {
      // The shape undici produces: `TypeError: fetch failed` wrapping the real errno.
      const error = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("inner"), { code }) });

      const result = classifyThrownFailure(error);

      expect(result.kind).toBe("transport");
      expect(result.code).toBe(code);
    });
  });

  it("prefers the typed rpcCode over the underlying errno", () => {
    const error = Object.assign(new Error("business failure"), {
      kind: "rpc",
      rpcCode: "MISSING_CREDENTIAL",
      code: "ECONNREFUSED",
    });

    expect(classifyThrownFailure(error)).toMatchObject({ kind: "rpc", code: "MISSING_CREDENTIAL" });
  });

  it("enriches a drift message with the method and the anchored field path", () => {
    const error = Object.assign(new Error("drifted"), {
      kind: "protocol-drift",
      method: "session/page",
      path: "records.0.event.seq",
    });

    expect(classifyThrownFailure(error)).toMatchObject({ kind: "protocol-drift", path: "records.0.event.seq" });
    expect(classifyThrownFailure(error).message).toContain("records.0.event.seq");

    // Idempotent: a message that already names both is not tagged twice.
    const already = Object.assign(new Error("drifted at session/page records.0.event.seq"), {
      kind: "protocol-drift",
      method: "session/page",
      path: "records.0.event.seq",
    });
    expect(classifyThrownFailure(already).message).toBe("drifted at session/page records.0.event.seq");
  });
});

describe("property: the cause walk is bounded", () => {
  it("finds a code at most three levels up and stops there", () => {
    for (let depth = 0; depth <= CAUSE_DEPTH + 1; depth++) {
      let node: Record<string, unknown> = { code: "ECONNRESET" };
      for (let level = 0; level < depth; level++) node = { cause: node };

      expect(transportErrorCode(node), `code at depth ${String(depth)}`).toBe(depth < CAUSE_DEPTH ? "ECONNRESET" : null);
    }
  });

  it("terminates on a cyclic cause chain instead of hanging", () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { cause: first };
    first["cause"] = second;

    expect(transportErrorCode(first)).toBeNull();
    expect(parseFailurePath(first)).toBeNull();
    expect(classifyThrownFailure(first)).toMatchObject({ kind: "unknown", code: null });
  });

  it("ignores empty and non-string codes", () => {
    expect(transportErrorCode({ code: "" })).toBeNull();
    expect(transportErrorCode({ code: 42 })).toBeNull();
    expect(transportErrorCode({ code: "ECONNRESET" })).toBe("ECONNRESET");
  });
});

describe("property: classifyHttpStatus partitions every status", () => {
  it("is total and splits auth / not-found / transport by meaning", () => {
    forAll(SWEEP, (rng) => {
      const status = rng.int(-100, 700);
      const kind = classifyHttpStatus(status);
      const expected = status === 401 || status === 403 ? "auth-expired" : status === 404 ? "not-found" : "transport";

      expect(WIRE_KINDS, `status ${String(status)}`).toContain(kind);
      expect(kind, `status ${String(status)}`).toBe(expected);
    });
  });

  it("treats non-finite and fractional statuses as the transport", () => {
    forEachValue([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 401.5, 403.9], (status) => {
      expect(classifyHttpStatus(status), String(status)).toBe("transport");
    });
  });
});

describe("property: envelope and path readers never throw", () => {
  it("isRpcEnvelope answers a boolean for any value", () => {
    forAll(SWEEP, (rng) => {
      const input = arbitraryUnknown(rng);
      expect(typeof isRpcEnvelope(input), repr(input)).toBe("boolean");
    });
  });

  it("isRpcEnvelope accepts every well-formed envelope and rejects near misses", () => {
    forAll(200, (rng) => {
      const value = arbitraryUnknown(rng);

      expect(isRpcEnvelope({ result: { ok: true, value } })).toBe(true);
      expect(isRpcEnvelope({ result: { ok: false, error: { code: "C", message: "M" } } })).toBe(true);

      // Near misses: a success without `value`, a failure without both error fields.
      expect(isRpcEnvelope({ result: { ok: true } })).toBe(false);
      expect(isRpcEnvelope({ result: { ok: false, error: { code: "C" } } })).toBe(false);
      expect(isRpcEnvelope({ result: { ok: false, error: { message: "M" } } })).toBe(false);
      expect(isRpcEnvelope({ result: { ok: false } })).toBe(false);
      expect(isRpcEnvelope({ result: "string" })).toBe(false);
      expect(isRpcEnvelope([])).toBe(false);
    });
  });

  it("parseFailurePath answers null or a string for any value", () => {
    forAll(SWEEP, (rng) => {
      const input = arbitraryUnknown(rng);
      const path = parseFailurePath(input);

      expect(path === null || typeof path === "string", repr(input)).toBe(true);
    });
  });

  it("parseFailurePath reads the single first offending path, walking the cause chain", () => {
    expect(parseFailurePath({ issues: [{ path: ["records", 0, "event", "seq"] }] })).toBe("records.0.event.seq");
    expect(parseFailurePath({ issues: [{ path: [] }] })).toBe("(root)");
    expect(parseFailurePath({ issues: [] })).toBeNull();
    expect(parseFailurePath({ cause: { issues: [{ path: ["a", "b"] }] } })).toBe("a.b");
    expect(parseFailurePath({ path: "explicit" })).toBe("explicit");
    expect(parseFailurePath(new Error("no path"))).toBeNull();
  });

  it("isWireFailureKind narrows exactly the vocabulary", () => {
    forEachValue(WIRE_KINDS, (kind) => expect(isWireFailureKind(kind)).toBe(true));
    forEachValue(
      ["", "unknown", "AUTH-EXPIRED", "auth_expired", "rpcError", null, undefined, 401, {}, [], 0],
      (value) => expect(isWireFailureKind(value), repr(value)).toBe(false),
    );
  });
});

describe("property: describeParseFailure renders the actionable path", () => {
  it("renders path and message pairs, marking a root-level failure", () => {
    expect(describeParseFailure({ issues: [{ path: ["records", 0, "event", "seq"], message: "Expected number" }] }))
      .toBe("records.0.event.seq: Expected number");
    expect(describeParseFailure({ issues: [{ path: [], message: "Expected object" }] })).toBe("(root): Expected object");
    expect(describeParseFailure({ issues: [{ path: ["a"], code: "invalid_type" }] })).toBe("a: invalid_type");
    expect(describeParseFailure({ issues: [{ code: "custom" }] })).toBe("(root): custom");
    expect(describeParseFailure({ issues: [{ path: [] }] })).toBe("(root): invalid value");
    expect(describeParseFailure({ issues: [{ path: ["a"] }] })).toBe("a: invalid value");
  });

  it("caps the rendered pairs at three and counts the remainder", () => {
    const issues = Array.from({ length: 5 }, (_, index) => ({ path: [`f${String(index)}`], message: "bad" }));

    const rendered = describeParseFailure({ issues });

    expect(rendered).toBe("f0: bad; f1: bad; f2: bad (+2 more)");
  });

  it("never returns an empty description for the shapes a validator throws", () => {
    forAll(SWEEP, (rng) => {
      const issues = [
        { path: [rng.pick(["a", "b", "records", "seq"]), rng.int(0, 9)], message: rng.pick(["Expected number", ""]) },
      ];

      expect(describeParseFailure({ issues }).length).toBeGreaterThan(0);
    });
  });

  it("falls back to the message text, and labels an empty one", () => {
    expect(describeParseFailure(new Error("bare failure"))).toBe("bare failure");
    expect(describeParseFailure("plain string")).toBe("plain string");
    expect(describeParseFailure("")).toBe("unrecognized value");
  });
});
