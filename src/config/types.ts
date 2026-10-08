// Configuration types. Every tunable default resolves into one of these shapes; nothing
// outside `config/` invents a default.

/** Where the running npm CLI was found, for `doctor` output. */
export interface NpmCliResolution {
  /** Absolute path of `npm-cli.js` (never a `.cmd`/`.ps1` shim). */
  readonly path: string;
  /** Human-readable origin of that path. */
  readonly source: string;
}

/** Environment-derived configuration of one MCP server process. */
export interface RuntimeConfig {
  /** Persistent data directory: runtime packages plus per-workspace service homes. */
  readonly dataDirectory: string;
  /** Optional allow-list of workspace roots; empty means "no restriction". */
  readonly allowedRoots: readonly string[];
  /** Exact npm spec of the Harness runtime package. */
  readonly harnessPackage: string;
  /** Optional absolute `npm-cli.js` override (`DSH_MCP_NPM_CLI`). */
  readonly npmCliOverride: string | null;
  /** One-off runtime-package install budget (never part of startup). */
  readonly installTimeoutMs: number;
  /** Startup budget, measured as silence between child outputs. */
  readonly startupTimeoutMs: number;
}
