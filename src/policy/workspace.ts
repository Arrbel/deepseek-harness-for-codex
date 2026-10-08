// Workspace policy: which absolute directory the Harness may inspect and modify.
//
// Fail-closed by construction: the path must be absolute, must resolve through `realpath`,
// must be a directory, and — when an allow-list is configured — must resolve to a path
// inside one of the allowed roots.

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isWithin } from "./paths.js";

/** Resolves and validates one workspace path against an optional allow-list. */
export async function resolveWorkspace(input: string, allowedRoots: readonly string[] = []): Promise<string> {
  if (!isAbsolute(input)) throw new Error("workspace must be an absolute path.");
  const workspace = await realpath(input);
  if (!(await stat(workspace)).isDirectory()) throw new Error("workspace must point to a directory.");
  if (allowedRoots.length > 0) {
    const roots = await Promise.all(allowedRoots.map(async (root) => await realpath(root)));
    if (!roots.some((root) => isWithin(root, workspace))) throw new Error("workspace is outside DSH_MCP_WORKSPACE_ROOTS.");
  }
  return workspace;
}
