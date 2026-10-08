// Boundary and comparator-form coverage for the two spec policies this project pins.
//
// Why this file exists (P0-3 in `reports/plan-p0-p1.md`): before it, only two shapes ever
// reached these functions — `SUPPORTED_NODE_RANGE` (which uses `^` and `>=` only) and the
// exact-version happy path. Every other comparator branch and both `major === 0` caret
// branches were dead code that no test executed, so an edit to the declared range (or to
// `nextAfterCaret`) could change behaviour silently. This file executes them and fails when
// the declared range starts using a form no test covers.

import "../support/isolation.js";
import { describe, expect, it } from "vitest";
import {
  RuntimePackageError,
  SUPPORTED_NODE_RANGE,
  parseExactPackageSpec,
  satisfiesNodeRange,
} from "../../src/policy/package-spec.js";

function invalidSpec(spec: string): RuntimePackageError {
  try {
    parseExactPackageSpec(spec);
  } catch (error) {
    if (error instanceof RuntimePackageError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(spec)} to be rejected`);
}

describe("parseExactPackageSpec — accepted shapes", () => {
  const accepted: ReadonlyArray<readonly [string, string, string]> = [
    ["@deepseek-ai/dsh@0.2.1-alpha.1", "@deepseek-ai/dsh", "0.2.1-alpha.1"],
    ["dsh@1.2.3", "dsh", "1.2.3"],
    ["dsh@0.0.0-0", "dsh", "0.0.0-0"],
    ["dsh@1.2.3+build.5", "dsh", "1.2.3+build.5"],
    ["dsh@1.2.3-rc.1.2", "dsh", "1.2.3-rc.1.2"],
    // Surrounding whitespace is trimmed; inner whitespace is not.
    ["  dsh@1.2.3  ", "dsh", "1.2.3"],
  ];

  it.each(accepted)("accepts %s", (spec, name, version) => {
    const parsed = parseExactPackageSpec(spec);
    expect(parsed).toEqual({ raw: spec.trim(), name, version });
  });

  it("keeps the raw spec trimmed but otherwise verbatim", () => {
    expect(parseExactPackageSpec("  @a/b@1.0.0-p1 ").raw).toBe("@a/b@1.0.0-p1");
  });

  it("documents case-insensitive package names (npm treats names case-insensitively)", () => {
    expect(parseExactPackageSpec("Dsh@1.2.3").name).toBe("Dsh");
  });
});

describe("parseExactPackageSpec — rejected shapes", () => {
  const rejected: ReadonlyArray<readonly [string, string]> = [
    ["", "empty"],
    ["    ", "empty"],
    ["dsh", "a version is required"],
    ["@scope/name", "a version is required"],
    ["dsh@", "the version after '@' is empty"],
    ["dsh@1.2", "not an exact semantic version"],
    ["dsh@1.2.3.4", "not an exact semantic version"],
    ["dsh@v1.2.3", "not an exact semantic version"],
    ["dsh@^1.2.3", "not an exact semantic version"],
    ["dsh@~1.2.3", "not an exact semantic version"],
    ["dsh@>1.2.3", "not an exact semantic version"],
    ["dsh@>=1.2.3", "not an exact semantic version"],
    ["dsh@*", "not an exact semantic version"],
    ["dsh@latest", "not an exact semantic version"],
    ["dsh@next", "not an exact semantic version"],
    ["dsh@1.2.x", "not an exact semantic version"],
    ["dsh @1.2.3", "not a valid npm package name"],
    ["@a/b@c@1.2.3", "not a valid npm package name"],
    ["dsh@1.2.3-rc..1", "not an exact semantic version"],
    ["dsh@ 1.2.3", "not an exact semantic version"],
  ];

  it.each(rejected)("rejects %s (%s)", (spec, expectedFragment) => {
    const error = invalidSpec(spec);
    expect(error.kind).toBe("invalid-spec");
    expect(error.message).toContain("Invalid harness package spec");
    expect(error.message).toContain(expectedFragment);
    // The hint is what the caller surfaces; it must stay actionable.
    expect(error.hint ?? "").toContain("exact version");
  });

  it("documents the one over-rejection: a prerelease identifier literally named `x`", () => {
    // RANGE_SYNTAX_PATTERN's `\bx\b` also rejects `1.2.3-x.1`, which semver would allow.
    // Recorded so the behaviour is a decision, not a surprise: it is fail-closed and the
    // project's pin (`0.2.1-alpha.1`) is unaffected.
    expect(invalidSpec("dsh@1.2.3-alpha.x.1").kind).toBe("invalid-spec");
    expect(parseExactPackageSpec("dsh@1.2.3-alphax.1").version).toBe("1.2.3-alphax.1");
  });
});

describe("satisfiesNodeRange — every comparator form", () => {
  const caret: ReadonlyArray<readonly [string, string, boolean]> = [
    // major > 0: floor at the base, ceiling at the next major.
    ["1.2.3", "^1.2.3", true],
    ["1.9.9", "^1.2.3", true],
    ["1.2.2", "^1.2.3", false],
    ["2.0.0", "^1.2.3", false],
    // major === 0, minor > 0: ceiling at the next minor.
    ["0.2.3", "^0.2.3", true],
    ["0.2.99", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.1.9", "^0.2.3", false],
    // major === 0, minor === 0: ceiling at the next patch.
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
  ];

  const comparators: ReadonlyArray<readonly [string, string, boolean]> = [
    [">=1.2.3", "1.2.3", true],
    [">=1.2.3", "1.2.2", false],
    [">1.2.3", "1.2.4", true],
    [">1.2.3", "1.2.3", false],
    ["<=1.2.3", "1.2.3", true],
    ["<=1.2.3", "1.2.4", false],
    ["<1.2.3", "1.2.2", true],
    ["<1.2.3", "1.2.3", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
  ];

  it.each(caret)("caret %s in %s === %s", (version, range, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });

  it.each(comparators)("comparator %s against %s === %s", (range, version, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });

  it("honours || alternatives and whitespace inside a clause", () => {
    expect(satisfiesNodeRange("1.5.0", "^1.0.0 || >=2.3.0 <2.5.0")).toBe(true);
    expect(satisfiesNodeRange("2.4.0", "^1.0.0 || >=2.3.0 <2.5.0")).toBe(true);
    expect(satisfiesNodeRange("2.5.0", "^1.0.0 || >=2.3.0 <2.5.0")).toBe(false);
    expect(satisfiesNodeRange("3.0.0", ">= 2.3.0")).toBe(true);
  });

  const garbage: ReadonlyArray<readonly [string, string]> = [
    ["1.2.3", ""],
    ["1.2.3", "   "],
    ["1.2.3", "foo"],
    ["1.2.3", "^"],
    ["1.2.3", ">="],
    ["1.2.3", "=1.2.3"],
    ["1.2.3", "v1.2.3"],
    ["1.2.3", "1.2.3 - 1.3.0"],
    ["", "^1.2.3"],
    ["abc", "^1.2.3"],
    ["1.2", "^1.2.3"],
  ];

  it.each(garbage)("garbage %j in %j === false", (version, range) => {
    expect(satisfiesNodeRange(version, range)).toBe(false);
  });

  it("rejects suffixed or over-long target versions (fail-closed, P0-3 regression)", () => {
    // Before the fix, `parseVersion` matched a prefix, so a suffixed target was judged as its
    // numeric core. Only exact triples are accepted now; a nightly Node reads as unsupported,
    // which is the honest answer rather than a silent "supported".
    expect(satisfiesNodeRange("1.2.3-junk", "^1.2.3")).toBe(false);
    expect(satisfiesNodeRange("1.2.3.4", "^1.2.3")).toBe(false);
  });
});

describe("satisfiesNodeRange — compound clauses keep every bound (P0-3 regression)", () => {
  // The bug these tests pin: `parseVersion` was unanchored, so `">=2.3.0 <2.5.0"` parsed as
  // `2.3.0` and the upper bound was silently dropped — the range reported versions as
  // supported that it excluded. Both clauses must now be evaluated.
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ["2.3.0", ">=2.3.0 <2.5.0", true],
    ["2.4.9", ">=2.3.0 <2.5.0", true],
    ["2.5.0", ">=2.3.0 <2.5.0", false],
    ["2.2.9", ">=2.3.0 <2.5.0", false],
    ["2.4.0", ">= 2.3.0   < 2.5.0", true],
    ["2.5.0", ">= 2.3.0   < 2.5.0", false],
    ["2.6.0", "^1.0.0 || >=2.3.0 <2.5.0", false],
    ["2.4.0", "^1.0.0 || >=2.3.0 <2.5.0", true],
  ];

  it.each(cases)("%s in %s === %s", (version, range, expected) => {
    expect(satisfiesNodeRange(version, range)).toBe(expected);
  });

  it("treats an unimplemented hyphen range as unsatisfied instead of as its lower bound", () => {
    // Also a prefix-match artifact: `"1.2.3 - 1.3.0"` used to compare equal to `1.2.3`.
    expect(satisfiesNodeRange("1.2.3", "1.2.3 - 1.3.0")).toBe(false);
    expect(satisfiesNodeRange("1.9.9", "1.2.3 - 1.3.0")).toBe(false);
  });
});

describe("satisfiesNodeRange — the declared range", () => {
  it("pins the declared range literally", () => {
    expect(SUPPORTED_NODE_RANGE).toBe("^22.19.0 || >=24.0.0");
  });

  const declared: ReadonlyArray<readonly [string, boolean]> = [
    ["22.19.0", true],
    ["22.18.99", false],
    ["22.22.2", true],
    ["23.0.0", false],
    ["23.99.99", false],
    ["24.0.0", true],
    ["24.9.0", true],
    ["25.0.0", true],
    ["21.7.3", false],
  ];

  it.each(declared)("node %s supported === %s", (version, expected) => {
    expect(satisfiesNodeRange(version)).toBe(expected);
  });

  it("excludes the odd-numbered 23.x line between the two alternatives", () => {
    // Documented consequence of `^22.19.0 || >=24.0.0`: 23.x is not covered by either clause.
    expect(satisfiesNodeRange("23.11.1")).toBe(false);
  });
});

describe("guard — the declared range only uses comparator forms this file covers", () => {
  // If SUPPORTED_NODE_RANGE gains a clause shape (e.g. `<=25.0.0`), this fails until that
  // shape is added to the table above. Keeps "declared policy" and "tested policy" in sync.
  const COVERED_FORMS = ["^", ">="] as const;

  function formsOf(range: string): string[] {
    return range
      .split("||")
      .map((clause) => clause.trim())
      .filter((clause) => clause !== "")
      .map((clause) => {
        const match = /^(>=|<=|\^|>|<)/u.exec(clause);
        return match === null ? "exact" : (match[1] ?? "exact");
      });
  }

  it("recognizes exactly the covered forms in the declared range", () => {
    const forms = formsOf(SUPPORTED_NODE_RANGE);
    expect(forms).toEqual([...COVERED_FORMS]);
    expect(new Set(forms)).toEqual(new Set(COVERED_FORMS));
  });

  it("would flag an uncovered form", () => {
    expect(formsOf("^1.0.0 || <=3.0.0")).toContain("<=");
    expect(COVERED_FORMS as readonly string[]).not.toContain("<=");
  });
});
