// Pure decisions about the per-service pidfile and the orphan processes it can reveal.
//
// The defect this exists for: an MCP host that is killed (SIGKILL, client crash, task-manager
// kill) leaves the single-layer `node …/lib/bin.js` child alive *with its listening port*, and
// nothing ever reconciles the next start against it. Observed in the field: 26 orphaned DSH Web
// services each holding a port.
//
// Everything here is pure: reading, signalling, and probing live in `service/process-tree.ts`
// and `service/supervisor.ts`, so the two security decisions below are unit-testable without
// touching a process:
//
//   * a pidfile is only evidence that *some* pid was recorded — never permission to kill, and
//   * a live pid is only reclaimed when the OS reports a command line that proves it is ours.

import { join, normalize } from "node:path";

/** The pidfile name inside one service home (`<dataDir>/services/<key>/dsh.pid`). */
export const PID_FILE_NAME = "dsh.pid";

/** What we wrote down about a running Harness Web child. */
export interface PidFileRecord {
  pid: number;
  /** Bound port, or `null` while the child is still starting (the port is only known later). */
  port: number | null;
  version: string;
  binPath: string;
  /** ISO timestamp. */
  startedAt: string;
  dataDirectory: string;
  workspace: string;
  serviceHome: string;
}

/** How one recorded process looks to `doctor`. */
export type OrphanState = "alive" | "unverified" | "stale-pidfile";

/** One entry of `doctor.orphans`. */
export interface OrphanReport {
  pid: number | null;
  port: number | null;
  serviceHome: string;
  state: OrphanState;
}

/** The pidfile path of one service home. */
export function pidFilePath(serviceHome: string): string {
  return join(serviceHome, PID_FILE_NAME);
}

/** Serializes a record for the atomic write (`.tmp` + rename). */
export function serializePidFile(record: PidFileRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Parses a pidfile, returning `null` for anything malformed.
 *
 * Nothing is repaired: a corrupt pidfile is evidence of an interrupted write, and the caller
 * reports it as `stale-pidfile` instead of guessing a pid it must not signal.
 */
export function parsePidFile(text: string): PidFileRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record["pid"];
  const port = record["port"];
  const pidValid = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  const portValid = port === null || (typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535);
  const stringsValid = ["version", "binPath", "startedAt", "dataDirectory", "workspace", "serviceHome"]
    .every((key) => nonEmptyString(record[key]));
  if (!pidValid || !portValid || !stringsValid) return null;
  return {
    pid: pid as number,
    port: port as number | null,
    version: record["version"] as string,
    binPath: record["binPath"] as string,
    startedAt: record["startedAt"] as string,
    dataDirectory: record["dataDirectory"] as string,
    workspace: record["workspace"] as string,
    serviceHome: record["serviceHome"] as string,
  };
}

/**
 * The state to report for one pidfile, given liveness and ownership.
 *
 * Fail-closed by construction: `owned === false` (or `null`, meaning "the OS would not tell us")
 * becomes `unverified`, which every caller must treat as "do not kill, report instead".
 */
export function orphanState(input: { alive: boolean; owned: boolean | null }): OrphanState {
  if (!input.alive) return "stale-pidfile";
  return input.owned === true ? "alive" : "unverified";
}

/** Normalizes a path or command line for ownership comparison (case-insensitive on Windows). */
function canonical(value: string, platform: NodeJS.Platform): string {
  const slashed = normalize(value).replaceAll("\\", "/");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

/**
 * True only when the OS-reported command line proves the process is the one we recorded.
 *
 * Two independent facts are required — the recorded `binPath` **and** the `--port` argument we
 * always pass — so a recycled pid that happens to run some other node script is never mistaken
 * for ours. `identity === null` (query failed, permissions, unknown platform) is *not* proof.
 */
export function identityOwnsRecord(
  identity: string | null,
  record: Pick<PidFileRecord, "binPath" | "version">,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (identity === null || identity.trim() === "") return false;
  const commandLine = canonical(identity, platform);
  return commandLine.includes(canonical(record.binPath, platform)) && commandLine.includes("--port");
}

/**
 * The actionable line `doctor` adds to `problems` when orphaned service state is found.
 *
 * The wording must match the evidence (N-2): a record with `port: null` was written before the
 * child bound a port (it was killed during startup), so claiming it "still holds a port" would be
 * a claim the pidfile cannot support. Ports and pids are only stated when they are known.
 */
export function orphanProblem(orphans: readonly OrphanReport[]): string | null {
  if (orphans.length === 0) return null;
  const alive = orphans.filter((orphan) => orphan.state !== "stale-pidfile");
  const pids = alive.map((orphan) => orphan.pid).filter((pid): pid is number => pid !== null);
  let detail: string;
  if (alive.length === 0) {
    detail = "leftover pid files (no process is holding a port)";
  } else {
    const withPort = alive.filter((orphan) => orphan.port !== null);
    const unknownPorts = alive.length - withPort.length;
    if (withPort.length === 0) {
      detail = `${String(alive.length)} process(es) still running, port unknown`
        + `${pids.length > 0 ? ` (pid ${pids.join(", ")})` : ""}`;
    } else {
      const ports = withPort.map((orphan) => String(orphan.port)).join(", ");
      detail = `${String(alive.length)} process(es) still holding port(s) ${ports}`
        + (unknownPorts > 0 ? ` (port unknown for ${String(unknownPorts)} of them)` : "")
        + `${pids.length > 0 ? ` (pid ${pids.join(", ")})` : ""}`;
    }
  }
  return `orphaned Harness Web service state found: ${detail}. The next start_service reclaims `
    + "verified orphans automatically; to stop them by hand use `stop_service`, or end those pids. "
    + "This does not block `ready`.";
}
