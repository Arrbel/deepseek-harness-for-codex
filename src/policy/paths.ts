// Pure path predicates (no filesystem access, no `realpath`).

import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

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

/**
 * Lower-cases `value` when `platform` compares names case-insensitively under `policy`.
 *
 * **Neither parameter has a default (R5-5).** `policy` used to default to `"filesystem"` — the
 * *widest* rule — so a future call site on a kill/delete path could silently inherit "fold
 * everything" and widen its irreversible action surface with nothing to catch it. Now a missing
 * argument is a **compile error**, which is a structural answer instead of a runtime default.
 * The high-level predicates (`samePath`, `isWithin`, `dataLocationProblems`) still default their
 * *platform* to the host — that choice is about which filesystem we are talking to, not about how
 * much matching to allow, and it is visible at every call site in this file.
 */
export function foldForComparison(
  value: string,
  platform: NodeJS.Platform,
  policy: FoldPolicy,
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
    foldForComparison(resolve(root), platform, "filesystem"),
    foldForComparison(resolve(candidate), platform, "filesystem"),
  );
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Absolute-path comparison that is case-insensitive on platforms whose filesystem is. */
export function samePath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return foldForComparison(resolve(left), platform, "filesystem")
    === foldForComparison(resolve(right), platform, "filesystem");
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
 * filesystem is case-insensitive (see {@link FoldPolicy}). Always the **protective** policy: every
 * comparison this file makes decides whether to refuse, never whether to act.
 */
function canonicalPath(path: string, platform: NodeJS.Platform): string {
  return foldForComparison(resolve(path), platform, "filesystem");
}

/**
 * Why a data directory / `DSH_HOME` must not be used, or `[]` when it is acceptable.
 *
 * This is the **spelling** layer: it compares the paths exactly as the operator wrote them. It is
 * pure (no filesystem), which is why it can be exercised as a decision table on any host — and why
 * it cannot see a junction/symlink that points at the home directory. Production uses
 * {@link dataLocationAliasProblems}, which adds the on-disk identity (R5-1).
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
  return ruleProblems(input, spelledForms(input, platform), platform);
}

/**
 * The on-disk identity of one path, or why it could not be established.
 *
 * `code` is the errno string the OS gave (`ENOENT`, `ELOOP`, `EACCES`, …), or `null` when it did
 * not give one. The guard needs the *difference*: "this path does not exist yet" is ordinary (the
 * data directory is usually created later), while "this path exists but cannot be resolved" is a
 * reason to refuse.
 */
export type RealpathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: string | null };

/**
 * Resolves one path to its on-disk identity (`node:fs`'s `realpath`).
 *
 * Injected rather than imported: `policy/paths.ts` is pure by contract — the boundary test allows
 * it `node:path` only (`tests/module-boundaries.test.ts:76`). `policy/workspace.ts` and
 * `service/supervisor.ts` own the filesystem side.
 */
export type RealpathLookup = (path: string) => RealpathResult;

/** Inputs of the alias-aware guard: the lexical input plus the resolver. */
export interface DataLocationAliasInput extends DataLocationInput {
  /** Required: a guard that cannot look at the disk must not pretend it did. */
  readonly realpath: RealpathLookup;
}

/** The three comparison forms of one evaluation: what the operator spelled. */
interface LocationForms {
  readonly dataDirectory: string;
  readonly serviceHome: string;
  readonly home: string;
}

function spelledForms(input: DataLocationInput, platform: NodeJS.Platform): LocationForms {
  return {
    dataDirectory: canonicalPath(input.dataDirectory, platform),
    serviceHome: canonicalPath(input.serviceHome, platform),
    home: canonicalPath(input.home, platform),
  };
}

/** The rule table, evaluated against one set of comparison forms. */
function ruleProblems(
  input: DataLocationInput,
  forms: LocationForms,
  platform: NodeJS.Platform,
): string[] {
  const problems: string[] = [];
  const { dataDirectory, serviceHome, home } = forms;

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

/** One path's on-disk form (R5-1), or why it could not be established. */
interface OnDiskForm {
  /** The comparison form of the realpath (folded), `null` when nothing on the chain exists. */
  readonly path: string | null;
  /** The same realpath unfolded, for operator-facing messages (`null` like {@link path}). */
  readonly display: string | null;
  /** The errno that stopped the walk (fail-closed), or `null` when the walk was conclusive. */
  readonly failure: string | null;
}

/**
 * Resolves a path to the identity it *will* have on disk, walking up to the nearest existing
 * ancestor when it does not exist yet (R5-1).
 *
 * The walk is the point: `DSH_MCP_DATA_DIR=/tmp/alias/data` where `/tmp/alias` is a symlink to the
 * user's home **does not exist yet as a data directory**, so a plain `realpath` of it would fail
 * with `ENOENT` and a careless guard would conclude "nothing to check". Resolving `/tmp/alias`
 * instead yields the home directory, which is exactly what must be refused.
 *
 * Fail-closed: any errno other than "not there" (`ENOENT`/`ENOTDIR`) — `ELOOP` for a symlink
 * cycle, `EACCES` for permissions, an unknown throw — stops the walk and is reported so the caller
 * can refuse.
 */
function onDiskForm(
  spelled: string,
  platform: NodeJS.Platform,
  lookup: RealpathLookup,
): OnDiskForm {
  let current = spelled;
  let suffix = "";
  for (;;) {
    let result: RealpathResult;
    try {
      result = lookup(current);
    } catch {
      // A resolver that throws tells us nothing about the path: refuse rather than assume.
      return { path: null, display: null, failure: "unresolvable" };
    }
    if (result.ok) {
      const joined = suffix === "" ? result.path : join(result.path, suffix);
      return { path: canonicalPath(joined, platform), display: joined, failure: null };
    }
    if (result.code !== null && result.code !== "ENOENT" && result.code !== "ENOTDIR") {
      return { path: null, display: null, failure: result.code };
    }
    const parent = dirname(current);
    if (parent === current) {
      // Reached the root with nothing existing: there is no alias to traverse.
      return { path: null, display: null, failure: null };
    }
    suffix = suffix === "" ? basename(current) : join(basename(current), suffix);
    current = parent;
  }
}

/**
 * The P0-5 rules **plus** the on-disk identity of every path (R5-1): the guard production uses.
 *
 * `dataLocationProblems` compares spellings, so a junction/symlink pointing at the user's home is
 * accepted and the Harness then writes `profiles/`, `storages/` and `.credentials.yaml` **into the
 * real home** — the same accident the guard exists for, one alias deep. This entry point closes it:
 *
 *   1. the rule table runs on the **spelled** forms (unchanged behaviour, unchanged messages);
 *   2. it runs again on the **on-disk** forms — so "is this home, or the parent of home?" and "is
 *      `DSH_HOME` really underneath the data directory?" are answered about the real directories;
 *   3. a data directory that reaches the home **through an alias** is refused even when the alias
 *      target is a *subdirectory* of home (`/tmp/alias/data` → `<home>/data`). Spelling the home
 *      path explicitly stays allowed — the documented default is `<home>/.deep-seek-harness-mcp`
 *      — because then the operator can see what they are pointing at; the refusal is about being
 *      surprised by an alias, not about forbidding a home-relative layout.
 *   4. anything the resolver cannot explain (`ELOOP`, `EACCES`, an unknown throw) is refused.
 *
 * Messages are the same strings as the spelling layer, so a violation visible in both layers is
 * reported once.
 */
export function dataLocationAliasProblems(input: DataLocationAliasInput): string[] {
  const platform = input.platform ?? process.platform;
  const spelled = spelledForms(input, platform);
  const problems = ruleProblems(input, spelled, platform);
  const suggestion = "point DSH_MCP_DATA_DIR at a dedicated directory "
    + `(for example ${join(input.home, ".deep-seek-harness-mcp")}) and never at a home directory or a drive root`;

  const dataOnDisk = onDiskForm(input.dataDirectory, platform, input.realpath);
  const homeOnDisk = onDiskForm(input.home, platform, input.realpath);
  const serviceOnDisk = onDiskForm(input.serviceHome, platform, input.realpath);

  for (const [label, form, value] of [
    ["the data directory", dataOnDisk, input.dataDirectory],
    ["the user's home directory", homeOnDisk, input.home],
    ["DSH_HOME", serviceOnDisk, input.serviceHome],
  ] as const) {
    if (form.failure !== null) {
      problems.push(
        `${label} could not be resolved on disk (${form.failure}): ${value} — refusing rather than guessing; `
          + `use a path this process can resolve, or ${suggestion}`,
      );
    }
  }

  // (2) the same rule table against the real directories. A path with no on-disk form (nothing on
  // its chain exists) keeps its spelled form: there is no alias to resolve, and identity == spelling.
  const onDisk: LocationForms = {
    dataDirectory: dataOnDisk.path ?? spelled.dataDirectory,
    serviceHome: serviceOnDisk.path ?? spelled.serviceHome,
    home: homeOnDisk.path ?? spelled.home,
  };
  for (const message of ruleProblems(input, onDisk, platform)) {
    if (!problems.includes(message)) problems.push(message);
  }

  // (3) an alias that lands in the home directory, without the operator spelling it that way.
  const aliasTraversed = dataOnDisk.path !== null
    && dataOnDisk.path !== spelled.dataDirectory
    && isAbsolute(input.dataDirectory);
  // The on-disk rule pass already names this violation when the alias resolves *onto* the home
  // directory (or its parent); only the "hidden subdirectory of home" case is new, and a violation
  // must be reported once.
  const alreadyHome = dataOnDisk.path !== null
    && (dataOnDisk.path === onDisk.home || dataOnDisk.path === canonicalPath(dirname(onDisk.home), platform));
  if (
    aliasTraversed
    && !alreadyHome
    && dataOnDisk.path !== null
    && homeOnDisk.path !== null
    && isWithin(homeOnDisk.path, dataOnDisk.path, platform)
    && !isWithin(spelled.home, spelled.dataDirectory, platform)
  ) {
    const message =
      `the data directory resolves into the user's home directory through an alias: ${input.dataDirectory}`
      + ` is ${dataOnDisk.display ?? dataOnDisk.path} on disk — ${suggestion}; if you really mean a directory inside`
      + " the home directory, spell that path out (aliases into it are refused because they hide the target)";
    if (!problems.includes(message)) problems.push(message);
  }

  return problems;
}
