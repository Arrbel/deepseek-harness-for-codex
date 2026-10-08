// Pure policy for the two external specs this project pins: the Harness npm package and
// the Node engine range it runs on.
//
// Nothing here touches the filesystem, a process, or the network: "is this spec legal" is
// decided from the string alone, so the answer is deterministic and unit-testable. Actually
// resolving a candidate path or running npm is the service layer's job
// (`service/runtime-package.ts`).

/** Failure classes produced while acquiring the runtime package. */
export type RuntimePackageFailureKind =
  | "invalid-spec"
  | "unsupported-node"
  | "npm-cli-missing"
  | "version-not-found"
  | "offline-or-cache-missing"
  | "network"
  | "install-timeout"
  | "bin-missing"
  | "version-mismatch"
  | "lock-timeout"
  | "unknown";

/** Extra diagnosis carried by a {@link RuntimePackageError}. */
export interface RuntimePackageErrorInit {
  stderrTail?: string;
  stdoutTail?: string;
  hint?: string;
  cause?: unknown;
}

const STDERR_TAIL_CHARACTERS = 4_000;

/** Typed runtime-package failure that always keeps the raw npm streams for diagnosis. */
export class RuntimePackageError extends Error {
  public readonly kind: RuntimePackageFailureKind;
  public readonly stderrTail: string;
  public readonly stdoutTail: string;
  public readonly hint: string | null;

  public constructor(kind: RuntimePackageFailureKind, message: string, init: RuntimePackageErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "RuntimePackageError";
    this.kind = kind;
    this.stderrTail = init.stderrTail === undefined ? "" : tail(init.stderrTail);
    this.stdoutTail = init.stdoutTail === undefined ? "" : tail(init.stdoutTail);
    this.hint = init.hint ?? null;
  }

  /** Multi-line, actionable diagnosis for `doctor` and tool errors. */
  public describe(): string {
    const parts = [`[${this.kind}] ${this.message}`];
    if (this.hint !== null) parts.push(`hint: ${this.hint}`);
    if (this.stderrTail !== "") parts.push(`npm stderr tail: ${this.stderrTail}`);
    return parts.join("\n");
  }
}

function tail(value: string, max = STDERR_TAIL_CHARACTERS): string {
  return value.length <= max ? value : value.slice(-max);
}

// --- exact spec parsing -----------------------------------------------------------------

/** A parsed package spec that is guaranteed to name one exact version. */
export interface ExactPackageSpec {
  readonly raw: string;
  readonly name: string;
  readonly version: string;
}

const EXACT_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
// Range syntax that must never be resolved. Dist-tags (`latest`, `next`, …) cannot satisfy
// EXACT_VERSION_PATTERN in the first place, and legitimate prerelease identifiers such as
// `0.2.1-alpha.1` must keep working, so only range characters are rejected here.
const RANGE_SYNTAX_PATTERN = /[~^*><=]|\bx\b/iu;

/**
 * Parses `@scope/name@x.y.z` and rejects everything that could resolve to a different
 * version than requested: bare names, ranges (`^`, `~`, `>`, `<`, `*`, `x`) and dist-tags
 * (`latest`, `next`). The registry's `latest` is older than this project's pin, so a range
 * would silently downgrade the Harness.
 */
export function parseExactPackageSpec(spec: string): ExactPackageSpec {
  const raw = spec.trim();
  const reject = (reason: string): never => {
    throw new RuntimePackageError(
      "invalid-spec",
      `Invalid harness package spec ${JSON.stringify(spec)}: ${reason}. 请写 name@x.y.z（例如 @deepseek-ai/dsh@0.2.1-alpha.1）`,
      {
        hint: "Write an exact version: name@x.y.z. Ranges (^ ~ > < = * x) and dist-tags (latest/next) are rejected because they resolve to whatever the registry currently publishes.",
      },
    );
  };

  if (raw === "") return reject("the spec is empty");
  const at = raw.lastIndexOf("@");
  if (at <= 0) return reject("a version is required after the package name");
  const name = raw.slice(0, at);
  const version = raw.slice(at + 1);
  if (!PACKAGE_NAME_PATTERN.test(name)) return reject(`"${name}" is not a valid npm package name`);
  if (version === "") return reject("the version after '@' is empty");
  if (!EXACT_VERSION_PATTERN.test(version) || RANGE_SYNTAX_PATTERN.test(version)) {
    return reject(`"${version}" is not an exact semantic version`);
  }
  return { raw, name, version };
}

// --- node engine range ------------------------------------------------------------------

/**
 * Node range supported by the runtime package.
 *
 * The published `@deepseek-ai/dsh` has **no** `engines` field (the range only exists in the
 * monorepo root), so npm can never enforce it for us: this project declares and checks it.
 */
export const SUPPORTED_NODE_RANGE = "^22.19.0 || >=24.0.0";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses an exact `major.minor.patch` triple.
 *
 * **Anchored on purpose.** An unanchored prefix match silently swallowed the rest of a
 * compound clause: `parseVersion("2.3.0 <2.5.0")` returned `2.3.0`, so `">=2.3.0 <2.5.0"`
 * lost its upper bound and reported versions as supported when the range excluded them.
 * Anything that is not exactly a triple now fails to parse, and the caller treats that as
 * "not satisfied" (fail-closed).
 */
function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function nextAfterCaret(base: ParsedVersion): ParsedVersion {
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0 };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: base.patch + 1 };
}

/**
 * Minimal `semver.satisfies` for the comparator shapes this project declares.
 *
 * A clause may hold several whitespace-separated comparators (`>=2.3.0 <2.5.0`, or the same
 * with spaces after the operators); **all** of them must hold. Forms this parser does not
 * implement — hyphen ranges (`A - B`), `v`/`=` prefixes, prerelease-suffixed versions —
 * evaluate to `false` (fail-closed) rather than being silently approximated.
 */
export function satisfiesNodeRange(version: string, range: string = SUPPORTED_NODE_RANGE): boolean {
  const target = parseVersion(version);
  if (target === null) return false;
  return range
    .split("||")
    .some((alternative) => satisfiesClause(target, alternative.trim()));
}

/** Every whitespace-separated comparator inside one `||` alternative must hold. */
function satisfiesClause(target: ParsedVersion, clause: string): boolean {
  if (clause === "") return false;
  // `>= 2.3.0` is the same clause as `>=2.3.0`: normalize the space after an operator before
  // splitting, otherwise the operator would be separated from its operand.
  const normalized = clause.replace(/(\^|>=|<=|>|<)\s+/gu, "$1");
  return normalized
    .split(/\s+/u)
    .filter((comparator) => comparator !== "")
    .every((comparator) => satisfiesComparator(target, comparator));
}

function satisfiesComparator(target: ParsedVersion, comparator: string): boolean {
  if (comparator.startsWith("^")) {
    const base = parseVersion(comparator.slice(1));
    if (base === null) return false;
    return compareVersions(target, base) >= 0 && compareVersions(target, nextAfterCaret(base)) < 0;
  }
  if (comparator.startsWith(">=")) {
    const base = parseVersion(comparator.slice(2));
    return base !== null && compareVersions(target, base) >= 0;
  }
  if (comparator.startsWith(">")) {
    const base = parseVersion(comparator.slice(1));
    return base !== null && compareVersions(target, base) > 0;
  }
  if (comparator.startsWith("<=")) {
    const base = parseVersion(comparator.slice(2));
    return base !== null && compareVersions(target, base) <= 0;
  }
  if (comparator.startsWith("<")) {
    const base = parseVersion(comparator.slice(1));
    return base !== null && compareVersions(target, base) < 0;
  }
  const exact = parseVersion(comparator);
  return exact !== null && compareVersions(target, exact) === 0;
}
