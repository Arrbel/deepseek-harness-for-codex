// Pure path predicates (no filesystem access, no `realpath`).

import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

/**
 * Which platforms a comparison folds case on.
 *
 *   * `"filesystem"` — the platform's **default** filesystem compares names case-insensitively:
 *     Windows (NTFS) and macOS (default APFS). Use this for comparisons where matching *more*
 *     means **refusing more** (a guard): on a case-insensitive volume two spellings really are the
 *     same directory, so not folding is a bypass, not caution.
 *   * `"win32-only"` — Windows only. Use this **only** where folding would *widen an irreversible
 *     surface* (signalling a process, deleting a directory): there, macOS keeps today's
 *     case-sensitive verdict until the change is reviewed (task-35 §3 in
 *     `reports/r4-cross-platform-fixes.md`).
 *
 * This is the **single** place that knows the case rule; every comparison in `src/` goes through
 * it (directly or through {@link samePath}/{@link isWithin}) so the two directions can never drift.
 */
export type FoldPolicy = "filesystem" | "win32-only";

const CASE_FOLDING: Readonly<Record<FoldPolicy, readonly NodeJS.Platform[]>> = {
  filesystem: ["win32", "darwin"],
  "win32-only": ["win32"],
};

/** Lower-cases `value` when `platform` compares names case-insensitively under `policy`. */
export function foldForComparison(
  value: string,
  platform: NodeJS.Platform = process.platform,
  policy: FoldPolicy = "filesystem",
): string {
  return CASE_FOLDING[policy].includes(platform) ? value.toLowerCase() : value;
}

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Comparison is lexical (`.`/`..` are normalised, no symlinks): callers that must not be fooled by
 * symlinks resolve both sides with `realpath` first (`policy/workspace.ts` does exactly that).
 * Case is folded on platforms whose default filesystem is case-insensitive ({@link FoldPolicy}):
 * on macOS `/Users/bob/x` **is** inside `/Users/Bob`, and treating it as "outside" would be the
 * wrong answer for both the P0-5 guard and the `DSH_MCP_WORKSPACE_ROOTS` allow-list.
 */
export function isWithin(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const child = relative(
    foldForComparison(resolve(root), platform),
    foldForComparison(resolve(candidate), platform),
  );
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Absolute-path comparison that is case-insensitive on platforms whose filesystem is. */
export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return foldForComparison(resolve(left), platform) === foldForComparison(resolve(right), platform);
}

/** Inputs of the data-location safety check (P0-5). */
export interface DataLocationInput {
  /** The persistent data directory the MCP server owns. */
  dataDirectory: string;
  /** The per-workspace `DSH_HOME` that will be handed to the child. */
  serviceHome: string;
  /** The user's home directory (`os.homedir()`). */
  home: string;
  platform?: NodeJS.Platform;
}

/**
 * The comparison form of one path: absolute, `.`/`..` folded, and case-folded where the platform's
 * filesystem is case-insensitive (see {@link FoldPolicy}).
 */
function canonicalPath(path: string, platform: NodeJS.Platform): string {
  return foldForComparison(resolve(path), platform);
}

/**
 * Why a data directory / `DSH_HOME` must not be used, or `[]` when it is acceptable.
 *
 * This is fail-closed by design: the caller throws *before* creating anything. The real accident
 * behind it: a script pointed `DSH_HOME` at `C:\Users\<user>`, and the Harness populated the
 * user's home with `profiles/`, `storages/`, and `.credentials.yaml`.
 *
 * Every comparison below is on {@link canonicalPath} values, so **rule 3 (the home guard) rejects
 * more, not fewer, spellings on a case-insensitive filesystem**: `DSH_MCP_DATA_DIR=/Users/Bob` with
 * home `/Users/bob` is the same directory on default macOS APFS and is refused (task-35 defect B).
 * On `linux` nothing folds — a case-different path is a genuinely different directory there and
 * must stay legal.
 *
 * Rules:
 *   1. both paths must be absolute;
 *   2. neither may be a filesystem root (`C:\`, `/`);
 *   3. neither may be `home`, and neither may be the *direct parent* of `home`;
 *   4. `serviceHome` must live strictly underneath `dataDirectory`.
 */
export function dataLocationProblems(input: DataLocationInput): string[] {
  const platform = input.platform ?? process.platform;
  const problems: string[] = [];
  const dataDirectory = canonicalPath(input.dataDirectory, platform);
  const serviceHome = canonicalPath(input.serviceHome, platform);
  const home = canonicalPath(input.home, platform);

  const suggestion = "point DSH_MCP_DATA_DIR at a dedicated directory "
    + `(for example ${join(input.home, ".deep-seek-harness-mcp")}) and never at a home directory or a drive root`;

  if (!isAbsolute(input.dataDirectory)) {
    problems.push(`the data directory must be an absolute path: ${input.dataDirectory}`);
  } else {
    if (dataDirectory === canonicalPath(parse(input.dataDirectory).root, platform)) {
      problems.push(`the data directory must not be a filesystem root: ${input.dataDirectory} — ${suggestion}`);
    }
    if (dataDirectory === home) {
      problems.push(`the data directory must not be the user's home directory: ${input.dataDirectory} — ${suggestion}`);
    } else if (dataDirectory === canonicalPath(dirname(input.home), platform)) {
      problems.push(`the data directory must not be the parent of the user's home directory: ${input.dataDirectory} — ${suggestion}`);
    }
  }

  if (!isAbsolute(input.serviceHome)) {
    problems.push(`the service home must be an absolute path: ${input.serviceHome}`);
  } else {
    if (serviceHome === home) {
      problems.push(`DSH_HOME must not be the user's home directory: ${input.serviceHome} — ${suggestion}`);
    }
    if (serviceHome === canonicalPath(parse(input.serviceHome).root, platform)) {
      problems.push(`DSH_HOME must not be a filesystem root: ${input.serviceHome} — ${suggestion}`);
    }
    if (isAbsolute(input.dataDirectory)) {
      // Canonical values, not the raw spelling: on a case-insensitive filesystem the containment
      // rule must read `/data/ROOT/services/a` as inside `/data/root` (the raw comparison would
      // refuse a legitimate service home, and on Windows it always did).
      const inside = isWithin(dataDirectory, serviceHome, platform);
      if (!inside || serviceHome === dataDirectory) {
        problems.push(`DSH_HOME must live underneath the data directory: ${input.serviceHome} is not inside ${input.dataDirectory} — ${suggestion}`);
      }
    }
  }

  return problems;
}
