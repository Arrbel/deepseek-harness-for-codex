// Deterministic generators for the property suite.
//
// Deliberately hand-rolled: see `reports/r3-coverage-and-properties.md` §3 for the argument
// against a `fast-check` devDependency. The short version is that these properties are small
// enough that a seeded sweep plus explicit boundary enumeration is auditable line by line,
// while a shrinking framework would be a second supply-chain surface and a second vocabulary
// for the same job.
//
// Two rules make a failing sweep reproducible:
//
//   * every iteration gets its own seed (`baseSeed + index`), printed in the failure message,
//     so a counterexample can be re-run alone;
//   * generators only build values from the space this project's failure paths can actually
//     throw — no hostile getters, no Proxies.
//
// **One deliberate exclusion, pinned by a failing test.** `Symbol` values are generated at the
// top level but not *inside* an array or object. The reason is a real, separate defect found by
// this suite: `classifyThrownFailure([Symbol("x")])` throws, because the message fallback is
// `String(error)` and `String([sym])` throws natively. Keeping a Symbol nested in an aggregate
// would make the totality sweep red for a reason that has nothing to do with the sweep, so the
// exclusion is stated here and asserted in `known-gaps.prop.test.ts` instead of being hidden.

/** Minimal deterministic PRNG (mulberry32) — no dependency, stable across platforms. */
export interface Rng {
  /** Next float in `[0, 1)`. */
  next(): number;
  /** Uniform integer in `[min, max]` (inclusive). */
  int(min: number, max: number): number;
  /** True with `trueProbability` (default 0.5). */
  bool(trueProbability?: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(values: readonly T[]): T;
}

export function rngFor(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (trueProbability = 0.5) => next() < trueProbability,
    pick: (values) => values[Math.floor(next() * values.length)]!,
  };
}

/** Default base seed: fixed so a red sweep is reproducible, and easy to re-roll deliberately. */
export const BASE_SEED = 0x5eed_1a7e;

/** Message-safe rendering of a counterexample (never throws, bounded depth). */
export function repr(value: unknown, depth = 0): string {
  if (depth > 3) return "…";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof Error) return `${value.name}(${JSON.stringify(value.message)})`;
  if (Array.isArray(value)) return `[${value.slice(0, 4).map((entry) => repr(entry, depth + 1)).join(", ")}]`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "function":
      return "[function]";
    default: {
      const keys = Object.keys(value as object).slice(0, 6);
      const body = keys.map((key) => `${key}: ${repr((value as Record<string, unknown>)[key], depth + 1)}`);
      return `{${body.join(", ")}}`;
    }
  }
}

/**
 * Runs `body` `count` times, each with its own seed.
 *
 * A thrown assertion is re-thrown with the index, the seed, and a rendering of the failing
 * input, so the counterexample can be reproduced by re-running a single index.
 */
export function forAll<T>(
  count: number,
  body: (rng: Rng, index: number) => T,
  baseSeed: number = BASE_SEED,
): void {
  for (let index = 0; index < count; index++) {
    const seed = baseSeed + index;
    try {
      body(rngFor(seed), index);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`property counterexample at index ${String(index)} (seed ${String(seed)}): ${detail}`);
    }
  }
}

/** Runs `body` once per value of `values`, tagging failures with the value. */
export function forEachValue<T>(values: readonly T[], body: (value: T, index: number) => void): void {
  values.forEach((value, index) => {
    try {
      body(value, index);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`counterexample at values[${String(index)}] = ${repr(value)}: ${detail}`);
    }
  });
}

const PRIMITIVES: readonly unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  "",
  " ",
  "boom",
  "ECONNREFUSED",
  "[object Object]",
  "\u0000",
  "x".repeat(64),
  "🔥",
  0n,
  123n,
  (): number => 1,
];

/**
 * A `Symbol`, valid only as a **top-level** thrown value.
 *
 * `String(symbol)` is legal, but `String([symbol])` is not, so a symbol nested inside an
 * aggregate must not enter the sweep — see the header note and `known-gaps.prop.test.ts`.
 */
export const SYMBOL_SAMPLE: symbol = Symbol("sym");

/** Keys the classifier reads, so random objects exercise its duck-typing paths. */
const INTERESTING_KEYS = ["code", "cause", "message", "name", "kind", "method", "path", "rpcCode", "issues", "stack"] as const;

/** A value from the space the classifier must survive: primitives, arrays, objects, Errors. */
export function arbitraryUnknown(rng: Rng, depth = 0): unknown {
  const roll = rng.next();
  if (depth >= 2 || roll < 0.45) return rng.pick(PRIMITIVES);
  if (roll < 0.6) {
    return Array.from({ length: rng.int(0, 3) }, () => arbitraryUnknown(rng, depth + 1));
  }
  if (roll < 0.75) {
    const error = new Error(rng.pick(["", "boom", "fetch failed"]));
    if (rng.bool(0.4)) (error as { code?: unknown }).code = rng.pick(["ENOENT", "ENOTDIR", "ECONNREFUSED", "WEIRD", ""]);
    if (rng.bool(0.3)) (error as { cause?: unknown }).cause = arbitraryUnknown(rng, depth + 1);
    if (rng.bool(0.2)) error.name = rng.pick(["Error", "TypeError", "TimeoutError", "AbortError", ""]);
    return error;
  }
  const record: Record<string, unknown> = {};
  const keyCount = rng.int(0, 4);
  for (let index = 0; index < keyCount; index++) {
    record[rng.pick(INTERESTING_KEYS)] = arbitraryUnknown(rng, depth + 1);
  }
  return record;
}

/** A value that has no `kind` property, so no typed class can be read from it. */
export function untypedFailure(rng: Rng): unknown {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = arbitraryUnknown(rng);
    if (typeof value !== "object" || value === null || !("kind" in value)) return value;
  }
  return "fallback-untyped";
}

/**
 * A duck-typed classifier input: exactly the shape `DshRpcError` exposes.
 *
 * `kind` may be from the vocabulary, a near-miss, or absent — the classifier must not care
 * about the difference between "typed" and "typed-looking".
 */
export function arbitraryTypedFailure(rng: Rng): Record<string, unknown> {
  const record: Record<string, unknown> = {
    kind: rng.pick(["auth-expired", "transport", "protocol-drift", "not-found", "rpc", "unknown", "bogus", ""]),
    message: rng.pick(["", "typed failure", "no API key for provider route"]),
  };
  if (rng.bool(0.6)) record["method"] = rng.pick(["session/list", "session/page", ""]);
  if (rng.bool(0.5)) record["rpcCode"] = rng.pick(["MISSING_CREDENTIAL", "session/not-found", ""]);
  if (rng.bool(0.5)) record["path"] = rng.pick(["records.0.event.seq", "(root)", ""]);
  if (rng.bool(0.3)) record["code"] = rng.pick(["ECONNREFUSED", "ENOENT", ""]);
  return record;
}

/** A `major.minor.patch` triple, skewed towards small numbers to keep collisions frequent. */
export function versionTriple(rng: Rng): readonly [number, number, number] {
  const bound = rng.pick([1, 2, 3, 5, 9]);
  return [rng.int(0, bound), rng.int(0, 9), rng.int(0, 9)];
}

export function versionOf(triple: readonly [number, number, number]): string {
  return `${String(triple[0])}.${String(triple[1])}.${String(triple[2])}`;
}

/** One semver comparator the parser claims to implement. */
export function comparatorOf(rng: Rng): string {
  const triple = versionOf(versionTriple(rng));
  return `${rng.pick(["^", ">=", ">", "<=", "<", ""])}${triple}`;
}

/** Versions the parser must reject outright (unimplemented or malformed forms). */
export const MALFORMED_VERSIONS: readonly string[] = [
  "",
  " ",
  "v",
  "1",
  "1.2",
  "1.2.3.4",
  "x.y.z",
  "abc",
  "1.2.x",
  "release",
  "1.2.3-alpha",
  "=1.2.3",
];

/** Ranges the parser must evaluate to `false` for every version (fail-closed forms). */
export const UNSUPPORTED_RANGES: readonly string[] = [
  "1.0.0 - 2.0.0",
  ">=1.0.0 - <2.0.0",
  "v1.2.3",
  "=1.2.3",
  "1.2.3-alpha.1",
  "~1.2.3",
  "*",
  "latest",
];
