// Process reaping for one local Harness Web child (ADR-0002 §4/§5, architecture §3.1).
//
// The direct-`node` launch is a single process layer, so `child.kill()` is the graceful stop and
// the platform tree killer is only a fallback for a child that ignores it. The Harness itself
// spawns a grandchild (`dsh-subprocess-local`), which is what the tree kill exists for.
//
// POSIX needed more than a signal to the pid (P0-2): `kill(-pid)` is only meaningful when the
// child leads its own process group (`detached: true` in `service/launch.ts`). When that group is
// unavailable — an injected spawn that did not detach, an older child, a platform without the
// group — the previous code fell straight to `child.kill()` and leaked grandchildren. The order
// is now: process group → recursive descendants (leaves first) → the parent itself.
//
// Every OS interaction is injectable, because the POSIX branches cannot be executed on Windows
// (see `reports/fix-process-lifecycle.md` for that honest boundary).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

/** Whether the child has delivered its exit event. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves `true` when the child exited before the deadline. Never rejects. */
export async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await new Promise<boolean>((resolveWait) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("exit", onExit);
      resolveWait(exited);
    };
    const onClose = (): void => finish(true);
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once("close", onClose);
    child.once("exit", onExit);
  });
}

/** The minimal handle of a platform tree killer (`taskkill.exe`); injected in tests. */
export interface KillerHandle {
  once(event: "error" | "close", listener: () => void): unknown;
}

/** Injection seams for every OS interaction in this module. */
export interface ReapOptions {
  readonly platform?: NodeJS.Platform;
  /** Starts the platform tree killer (defaults to `taskkill.exe` on Windows). */
  readonly spawnKiller?: (command: string, args: readonly string[]) => KillerHandle;
  /** Signals one pid (defaults to `process.kill`). */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Signals one process group (defaults to `process.kill(-pid)`). */
  readonly killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Lists the direct children of one pid; used by the POSIX fallback. */
  readonly listChildren?: (pid: number) => readonly number[] | Promise<readonly number[]>;
}

function defaultSpawnKiller(command: string, args: readonly string[]): KillerHandle {
  return spawn(command, [...args], { shell: false, stdio: "ignore", windowsHide: true });
}

function killPid(pid: number, signal: NodeJS.Signals, options: ReapOptions): void {
  (options.kill ?? process.kill)(pid, signal);
}

function killProcessGroup(pid: number, signal: NodeJS.Signals, options: ReapOptions): void {
  if (options.killGroup !== undefined) {
    options.killGroup(pid, signal);
    return;
  }
  process.kill(-pid, signal);
}

/** Reads `/proc/<pid>/task/<pid>/children` (Linux), then `pgrep -P`, then gives up. */
function defaultListChildren(pid: number, platform: NodeJS.Platform = process.platform): readonly number[] {
  if (platform === "linux") {
    try {
      const text = readFileSync(`/proc/${String(pid)}/task/${String(pid)}/children`, "utf8");
      return text.split(/\s+/u).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0);
    } catch {
      return [];
    }
  }
  try {
    const result = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    return (result.stdout ?? "")
      .split(/\s+/u)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/**
 * Kills every descendant of `pid`, leaves first.
 *
 * Depth-first order matters: killing a parent first would reparent its children (or orphan them
 * on Windows), which is exactly how the grandchildren survived in the field.
 */
async function killDescendants(pid: number, options: ReapOptions): Promise<void> {
  const list = options.listChildren ?? ((parent: number) => defaultListChildren(parent, options.platform ?? process.platform));
  let children: readonly number[] = [];
  try {
    children = await list(pid);
  } catch {
    children = [];
  }
  for (const childPid of children) await killDescendants(childPid, options);
  for (const childPid of children) {
    try {
      killPid(childPid, "SIGKILL", options);
    } catch {
      // Already gone: the whole point of the recursive walk is to try, not to be sure.
    }
  }
}

/** Windows: `taskkill /T /F` is the only reliable way to take the whole tree down. */
async function taskkillTree(pid: number, options: ReapOptions): Promise<void> {
  const spawnKiller = options.spawnKiller ?? defaultSpawnKiller;
  await new Promise<void>((resolveKill) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolveKill();
    };
    try {
      const killer = spawnKiller("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
      killer.once("error", finish);
      killer.once("close", finish);
    } catch {
      finish();
    }
  });
}

/** Kills one pid and its descendants without a `ChildProcess` handle (orphan reclamation). */
export async function reapProcessTreeByPid(pid: number, options: ReapOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await taskkillTree(pid, options);
    return;
  }
  try {
    killProcessGroup(pid, "SIGKILL", options);
    return;
  } catch {
    // No process group: walk the tree ourselves, then take the recorded pid itself.
  }
  await killDescendants(pid, options);
  try {
    killPid(pid, "SIGKILL", options);
  } catch {
    // Already gone.
  }
}

/**
 * Force-kills the child and its descendants.
 *
 * Windows needs `taskkill /T /F` because a killed parent does not imply dead children; POSIX
 * tries the process group first (only meaningful when the child was detached) and falls back to
 * the recursive descent, because a missing group previously leaked grandchildren silently.
 */
export async function reapProcessTree(child: ChildProcess, options: ReapOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (platform === "win32") {
    await taskkillTree(pid, options);
    if (!hasExited(child)) child.kill("SIGKILL");
    return;
  }
  try {
    killProcessGroup(pid, "SIGKILL", options);
  } catch {
    await killDescendants(pid, options);
    try {
      killPid(pid, "SIGKILL", options);
    } catch {
      // Already gone; the graceful path already tried `child.kill()`.
    }
  }
}

/** Whether a pid is still alive (`kill(pid, 0)` semantics). */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: NodeJS.Signals | number) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Runs a command and returns its trimmed stdout, or `null` when it cannot be read. */
function commandOutput(command: string, args: readonly string[]): string | null {
  try {
    const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    const text = (result.stdout ?? "").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

/**
 * The OS-reported command line of one pid, or `null` when it cannot be established.
 *
 * `null` is a *result*, not an error: every caller must treat it as "identity unknown" and refuse
 * to kill (fail-closed). Reclaiming a recycled pid would end an unrelated user process.
 */
export function readProcessIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: readonly string[]) => string | null = commandOutput,
): string | null {
  if (platform === "win32") {
    return run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}").CommandLine`,
    ]);
  }
  if (platform === "linux") {
    try {
      const text = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      return text === "" ? null : text;
    } catch {
      return null;
    }
  }
  return run("ps", ["-o", "command=", "-p", String(pid)]);
}
