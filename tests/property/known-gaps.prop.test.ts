// Regression pins for two gaps the R3-6 property sweeps found in `classifyThrownFailure`.
//
// History matters here: these started as `it.fails` pins (an expected failure turns into a **loud
// error** the moment the behaviour changes, so a finding cannot be quietly forgotten). Both were
// closed in the same Wave by the Lead, so they are now ordinary assertions of the *promised*
// behaviour — the opposite of a weakened test.
//
//  1. `thrownText`'s fallback used to be `String(error)`, which is not total: `String([Symbol()])`
//     throws because `Array.prototype.join` converts elements with ToString, which rejects symbols.
//     `classifyThrownFailure` promises to classify *any* thrown value, so a hostile value must come
//     out as text. Fixed with a symbol-aware, fully guarded renderer (`renderUnknown`).
//  2. `ClassifiedWireFailure.message` is documented as "Operator-facing text; never empty", but a
//     thrown `""` (or an `Error` whose `message` and `name` are both empty) produced `""`.
//     Fixed with an explicit non-empty fallback at both entry points.
//
// Both were found by the seeded sweeps in the sibling files, not by reading the code.
//
// **Deliberately NOT pinned here:** `describeParseFailure(undefined | null)` also throws
// (`Cannot read properties of undefined (reading 'issues')`). It remains a reported robustness gap,
// but its own documentation makes no totality claim and both call sites (`dsh/client.ts`) catch a
// zod `.parse()` failure, which is always an object with `issues`. Padding the suite with a case the
// contract never promised would be worse than leaving it in the report — see
// `reports/r3-coverage-and-properties.md` §5.
import { describe, expect, it } from "vitest";
import { classifyThrownFailure } from "../../src/dsh/wire.js";
import { SYMBOL_SAMPLE } from "./support/generators.js";
import "../support/isolation.js";

describe("classifyThrownFailure is total for symbol-bearing aggregates", () => {
  it("classifies a thrown array that contains a Symbol", () => {
    expect(classifyThrownFailure([Symbol("x")])).toMatchObject({ kind: "unknown" });
    expect(classifyThrownFailure([Symbol("x")]).message).toContain("Symbol(x)");
  });

  it("classifies a thrown array that contains a Symbol beyond the first position", () => {
    expect(classifyThrownFailure(["ok", 1, Symbol("x"), null])).toMatchObject({ kind: "unknown" });
  });

  it("classifies nested aggregates and never throws", () => {
    const nested = [[Symbol("deep")], { toString: () => Symbol("hostile") }];

    expect(classifyThrownFailure(nested)).toMatchObject({ kind: "unknown" });
    expect(classifyThrownFailure(nested).message).not.toBe("");
  });

  it("documents the boundary that always worked: a top-level Symbol", () => {
    expect(classifyThrownFailure(SYMBOL_SAMPLE).message).toBe("Symbol(sym)");
    expect(classifyThrownFailure(SYMBOL_SAMPLE).kind).toBe("unknown");
  });
});

describe("`message` is never empty", () => {
  it("keeps `message` non-empty for a thrown empty string", () => {
    expect(classifyThrownFailure("").message).not.toBe("");
  });

  it("keeps `message` non-empty for an Error whose message and name are both empty", () => {
    const error = Object.assign(new Error(""), { name: "" });

    expect(classifyThrownFailure(error).message).not.toBe("");
  });

  it("documents the boundary: a named Error falls back to its name", () => {
    const error = Object.assign(new Error(""), { name: "TimeoutError" });

    expect(classifyThrownFailure(error).message).toBe("TimeoutError");
    expect(classifyThrownFailure(error).kind).toBe("transport");
  });

  it("keeps `message` non-empty for values with no text at all", () => {
    expect(classifyThrownFailure(null).message).not.toBe("");
    expect(classifyThrownFailure(undefined).message).not.toBe("");
    expect(classifyThrownFailure({}).message).not.toBe("");
  });
});
