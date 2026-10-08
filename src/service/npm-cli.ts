// Locating the npm CLI.
//
// npm is never taken from `PATH`: `npm.cmd`/`npx.cmd` require `shell:true`, which is the
// injection surface ADR-0002 removes. The CLI is executed as `node <absolute js path>`.
//
// Candidate *shaping* is pure and lives in `config/resolve.ts`; this module owns the two
// things that need the filesystem: testing candidates and producing the typed error.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { npmCliCandidates } from "../config/resolve.js";
import type { NpmCliResolution } from "../config/types.js";
import { RuntimePackageError } from "../policy/package-spec.js";

/** Returns the first existing npm CLI, or `null` when none of the candidates exist. */
export function findNpmCli(env: NodeJS.ProcessEnv = process.env): NpmCliResolution | null {
  try {
    return resolveNpmCli(env);
  } catch {
    return null;
  }
}

/** Resolves the npm CLI or throws with the exact list of probed locations. */
export function resolveNpmCli(env: NodeJS.ProcessEnv = process.env): NpmCliResolution {
  const candidates = npmCliCandidates(env);
  const override = candidates[0];
  if (override !== undefined && override.source === "DSH_MCP_NPM_CLI") {
    if (!isAbsolute(override.path)) {
      throw new RuntimePackageError("npm-cli-missing", `DSH_MCP_NPM_CLI must be an absolute path to npm-cli.js, received ${JSON.stringify(override.path)}.`, {
        hint: "Point it at the real js entry, for example <node>\\node_modules\\npm\\bin\\npm-cli.js — not at npm.cmd, which needs a shell.",
      });
    }
    if (!existsSync(override.path)) {
      throw new RuntimePackageError("npm-cli-missing", `DSH_MCP_NPM_CLI does not exist: ${override.path}`, {
        hint: "Fix the path or unset DSH_MCP_NPM_CLI so it is derived from process.execPath.",
      });
    }
    return override;
  }
  const found = candidates.find((candidate) => existsSync(candidate.path));
  if (found !== undefined) return found;
  throw new RuntimePackageError(
    "npm-cli-missing",
    `Could not locate npm-cli.js. Probed: ${candidates.map((candidate) => candidate.path).join(", ")}`,
    { hint: "Set DSH_MCP_NPM_CLI to the absolute path of npm-cli.js, or install npm next to the running Node." },
  );
}
