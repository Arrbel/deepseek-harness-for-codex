// Pure path predicates (no filesystem access, no `realpath`).

import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Comparison is lexical: callers that must not be fooled by symlinks resolve both sides
 * with `realpath` first (`policy/workspace.ts` does exactly that).
 */
export function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Absolute-path comparison that is case-insensitive on Windows. */
export function samePath(left: string, right: string): boolean {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
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

function canonicalPath(path: string, platform: NodeJS.Platform): string {
  const absolute = resolve(path);
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Why a data directory / `DSH_HOME` must not be used, or `[]` when it is acceptable.
 *
 * This is fail-closed by design: the caller throws *before* creating anything. The real accident
 * behind it: a script pointed `DSH_HOME` at `C:\Users\<user>`, and the Harness populated the
 * user's home with `profiles/`, `storages/`, and `.credentials.yaml`.
 *
 * Rules (all comparisons are case-insensitive on Windows):
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
      const inside = isWithin(input.dataDirectory, input.serviceHome);
      if (!inside || serviceHome === dataDirectory) {
        problems.push(`DSH_HOME must live underneath the data directory: ${input.serviceHome} is not inside ${input.dataDirectory} — ${suggestion}`);
      }
    }
  }

  return problems;
}
