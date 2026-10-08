// Property: `policy/package-spec.ts#satisfiesNodeRange` is an interval test, not a prefix match.
//
// This is the module R1 was fixed in: `parseVersion` used to be an unanchored prefix matcher, so
// `satisfiesNodeRange("3.0.0", ">=2.3.0 <2.5.0")` reported a version as supported after the upper
// bound had been silently swallowed. The properties below are that class of bug, stated as law:
//
//   * a `>=` clause is monotone increasing and a `<` clause monotone decreasing in the version;
//   * `^X` means exactly `X <= v < nextAfterCaret(X)` — an interval, with both ends pinned;
//   * a multi-comparator clause is the **conjunction** of its comparators;
//   * `SUPPORTED_NODE_RANGE` reads exactly as `^22.19.0 || >=24.0.0` is defined to read, including
//     the deliberate 23.x gap;
//   * forms the parser does not implement stay fail-closed (`false`), never approximated.
//
// The comparison oracle below is a re-statement of the *semver spec*, not of the implementation:
// triples compare lexicographically, and the caret upper bound is the documented rule
// (major bump for `major > 0`, otherwise minor, otherwise patch).
import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE_RANGE, satisfiesNodeRange } from "../../src/policy/package-spec.js";
import {
  MALFORMED_VERSIONS,
  UNSUPPORTED_RANGES,
  comparatorOf,
  forAll,
  forEachValue,
  versionOf,
  versionTriple,
} from "./support/generators.js";
import "../support/isolation.js";

type Triple = readonly [number, number, number];

/** Lexicographic triple comparison — the definition of "higher version", not a code copy. */
function compare(left: Triple, right: Triple): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** The caret upper bound per the semver spec. */
function upperOfCaret(base: Triple): Triple {
  if (base[0] > 0) return [base[0] + 1, 0, 0];
  if (base[1] > 0) return [0, base[1] + 1, 0];
  return [0, 0, base[2] + 1];
}

/** Two generated triples in ascending order. */
function orderedPair(first: Triple, second: Triple): [Triple, Triple] {
  return compare(first, second) <= 0 ? [first, second] : [second, first];
}

const SWEEP = 800;
/** The documented reading of `SUPPORTED_NODE_RANGE`. */
const RANGE_FLOOR: Triple = [22, 19, 0];
const RANGE_CEILING: Triple = [23, 0, 0];
const SECOND_FLOOR: Triple = [24, 0, 0];

describe("property: comparator clauses are monotone", () => {
  it("`>=L` accepts a version whenever it accepts an equal-or-lower one", () => {
    forAll(SWEEP, (rng) => {
      const lower = versionTriple(rng);
      const [small, large] = orderedPair(versionTriple(rng), versionTriple(rng));
      const range = `>=${versionOf(lower)}`;

      if (satisfiesNodeRange(versionOf(small), range)) {
        expect(satisfiesNodeRange(versionOf(large), range), `${versionOf(small)} <= ${versionOf(large)} under ${range}`)
          .toBe(true);
      }
    });
  });

  it("`<U` accepts a version whenever it accepts an equal-or-higher one", () => {
    // The direction is the opposite of `>=`: `<` is monotone *decreasing* in the version, so
    // satisfying a larger version is the premise and satisfying a smaller one is the conclusion.
    forAll(SWEEP, (rng) => {
      const upper = versionTriple(rng);
      const [small, large] = orderedPair(versionTriple(rng), versionTriple(rng));
      const range = `<${versionOf(upper)}`;

      if (satisfiesNodeRange(versionOf(large), range)) {
        expect(satisfiesNodeRange(versionOf(small), range), `${versionOf(small)} <= ${versionOf(large)} under ${range}`)
          .toBe(true);
      }
    });
  });
});

describe("property: `^X` is the interval [X, nextAfterCaret(X))", () => {
  it("matches exactly the versions between the lower bound and the caret ceiling", () => {
    forAll(SWEEP, (rng) => {
      const base = versionTriple(rng);
      const ceiling = upperOfCaret(base);
      const range = `^${versionOf(base)}`;

      for (let sample = 0; sample < 4; sample++) {
        const candidate = versionTriple(rng);
        const expected = compare(candidate, base) >= 0 && compare(candidate, ceiling) < 0;

        expect(satisfiesNodeRange(versionOf(candidate), range), `${versionOf(candidate)} under ${range}`).toBe(expected);
      }
    });
  });

  it("includes the lower bound and excludes the ceiling", () => {
    expect(satisfiesNodeRange("1.2.3", "^1.2.3")).toBe(true);
    expect(satisfiesNodeRange("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfiesNodeRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesNodeRange("1.2.2", "^1.2.3")).toBe(false);

    // The `major === 0` rules bump minor, and for `0.0.x` the patch — so `^0.0.3` is the
    // half-open interval `[0.0.3, 0.0.4)`, which excludes 0.0.4 (as semver specifies).
    expect(satisfiesNodeRange("0.5.9", "^0.5.1")).toBe(true);
    expect(satisfiesNodeRange("0.6.0", "^0.5.1")).toBe(false);
    expect(satisfiesNodeRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesNodeRange("0.0.4", "^0.0.3")).toBe(false);
  });
});

describe("property: a multi-comparator clause is a conjunction", () => {
  it("`c1 c2` holds exactly when both comparators hold", () => {
    forAll(SWEEP, (rng) => {
      const first = comparatorOf(rng);
      const second = comparatorOf(rng);
      const version = versionOf(versionTriple(rng));

      const conjunction = satisfiesNodeRange(version, `${first} ${second}`);
      const separately = satisfiesNodeRange(version, first) && satisfiesNodeRange(version, second);

      expect(conjunction, `${version} under "${first} ${second}"`).toBe(separately);
    });
  });

  it("ignores whitespace after an operator instead of splitting the operand off", () => {
    forAll(200, (rng) => {
      const first = comparatorOf(rng);
      const second = comparatorOf(rng);
      const version = versionOf(versionTriple(rng));

      const spaced = first.replace(/^(\^|>=|<=|>|<)/u, "$1 ") + " " + second.replace(/^(\^|>=|<=|>|<)/u, "$1 ");

      expect(satisfiesNodeRange(version, spaced), `${version} under "${spaced}"`)
        .toBe(satisfiesNodeRange(version, `${first} ${second}`));
    });
  });

  it("`c1 || c2` holds exactly when either comparator holds", () => {
    forAll(SWEEP, (rng) => {
      const first = comparatorOf(rng);
      const second = comparatorOf(rng);
      const version = versionOf(versionTriple(rng));

      expect(satisfiesNodeRange(version, `${first} || ${second}`), `${version} under "${first} || ${second}"`)
        .toBe(satisfiesNodeRange(version, first) || satisfiesNodeRange(version, second));
    });
  });
});

describe("property: SUPPORTED_NODE_RANGE matches its documented reading", () => {
  it("accepts the 22.19+ band and everything from 24 up, and nothing in 23", () => {
    forAll(SWEEP * 2, (rng) => {
      // Bias the sweep towards the interesting band so the boundaries are hit often.
      const [major, minor, patch] = versionTriple(rng);
      const candidate: Triple = [major === 0 ? 22 + rng.int(0, 2) : major, minor, patch];
      const expected = (compare(candidate, RANGE_FLOOR) >= 0 && compare(candidate, RANGE_CEILING) < 0)
        || compare(candidate, SECOND_FLOOR) >= 0;

      expect(satisfiesNodeRange(versionOf(candidate)), `${versionOf(candidate)} under ${SUPPORTED_NODE_RANGE}`)
        .toBe(expected);
    });
  });

  it("pins the boundaries: 22.18.x and 23.x are out, 22.19.0 and 24.0.0 are in", () => {
    forEachValue(
      [
        ["22.18.9", false],
        ["22.19.0", true],
        ["22.19.1", true],
        ["22.99.99", true],
        ["23.0.0", false],
        ["23.9.9", false],
        ["24.0.0", true],
        ["24.0.1", true],
        ["99.0.0", true],
        ["0.0.0", false],
        ["21.0.0", false],
      ] as const,
      ([version, expected]) => {
        expect(satisfiesNodeRange(version), version).toBe(expected);
      },
    );
  });

  it("takes the range as an override, defaulting to the supported range", () => {
    expect(satisfiesNodeRange("22.19.0")).toBe(satisfiesNodeRange("22.19.0", SUPPORTED_NODE_RANGE));
    expect(satisfiesNodeRange("1.2.3", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfiesNodeRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });
});

describe("property: unimplemented and malformed forms stay fail-closed", () => {
  it("rejects every unsupported range for every version", () => {
    forEachValue(UNSUPPORTED_RANGES, (range) => {
      forAll(40, (rng) => {
        const version = versionOf(versionTriple(rng));

        expect(satisfiesNodeRange(version, range), `${version} under ${JSON.stringify(range)}`).toBe(false);
      });
    });
  });

  it("rejects every malformed version for every range", () => {
    forEachValue(MALFORMED_VERSIONS, (version) => {
      expect(satisfiesNodeRange(version), JSON.stringify(version)).toBe(false);
      expect(satisfiesNodeRange(version, ">=1.0.0"), JSON.stringify(version)).toBe(false);
    });
  });

  it("rejects a prerelease or build-suffixed version rather than reading its release core", () => {
    // `parseVersion` is anchored, so the suffix makes the whole token unparseable. Reading the
    // prefix would be exactly the R1 defect in a different costume.
    forEachValue(
      ["22.19.0-rc.1", "1.2.3-alpha.1", "1.2.3+build.7", "24.0.0-nightly.2"],
      (version) => {
        expect(satisfiesNodeRange(version), version).toBe(false);
      },
    );
  });

  it("never throws for arbitrary range text", () => {
    forEachValue(["!!!", " ", "||", "|| ||", ">=", "^", "<", ">= ", "^^1.2.3", "🐍"], (range) => {
      expect(satisfiesNodeRange("22.19.0", range), JSON.stringify(range)).toBe(false);
    });
  });
});
