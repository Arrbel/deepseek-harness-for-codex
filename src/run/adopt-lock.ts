// Cross-process adopt lock (R3-3).
//
// Two MCP server processes can share one data directory (double-open, a stale editor session, a
// supervisor restarting the host). Exactly one of them may reconcile — and, more importantly,
// **write terminal state for** — the runs recorded under one service home. This lock is that
// "who speaks for this data directory" marker:
//
//   * held while the winning process owns non-terminal runs of that service home;
//   * taken (and released) around a reconciliation pass;
//   * **never** stolen from a live holder: a process that cannot take the lock skips, and skipping
//     is reported as a problem instead of being papered over with a terminal state it has no
//     evidence for (the task's red line: 抢不到锁的进程不许写终态).
//
// A holder is "stale" only when we can *prove* it is gone: same host and the pid is not alive, or
// the file cannot be parsed at all. Liveness uses the frozen `isProcessAlive` (kill(pid, 0)
// semantics — liveness only, never an identity judgement). A holder on another host is treated as
// live, because we cannot check it and stealing would be a guess.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive } from "../service/process-tree.js";

/** The lock file's name inside a service home's `runs/` directory. */
export const ADOPT_LOCK_NAME = ".adopt.lock";

/** Lock payload version; an unknown version is treated as unprovable and broken with a warning. */
export const ADOPT_LOCK_VERSION = 1;

/** The holder information stored in the lock file. */
export interface AdoptLockHolder {
  version: number;
  /** Random per-acquisition token: only the acquirer may delete the file it wrote. */
  token: string;
  pid: number;
  host: string;
  startedAt: string;
}

/** A held lock. `release()` is idempotent and refuses to delete somebody else's file. */
export interface AdoptLease {
  readonly token: string;
  readonly path: string;
  release(): void;
}

/** Injection points; every one has a production default so tests never touch real processes. */
export interface AdoptLockOptions {
  now?: () => Date;
  pid?: () => number;
  hostname?: () => string;
  isAlive?: (pid: number) => boolean;
  randomToken?: () => string;
  onProblem?: (message: string) => void;
}

function parseHolder(text: string): AdoptLockHolder | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw["version"] !== ADOPT_LOCK_VERSION) return null;
  if (typeof raw["token"] !== "string" || raw["token"] === "") return null;
  if (typeof raw["pid"] !== "number" || !Number.isSafeInteger(raw["pid"]) || raw["pid"] <= 0) return null;
  if (typeof raw["host"] !== "string" || raw["host"] === "") return null;
  if (typeof raw["startedAt"] !== "string" || Number.isNaN(Date.parse(raw["startedAt"]))) return null;
  return {
    version: ADOPT_LOCK_VERSION,
    token: raw["token"],
    pid: raw["pid"],
    host: raw["host"],
    startedAt: raw["startedAt"],
  };
}

/** The adopt lock of one service home. */
export class AdoptLock {
  private readonly now: () => Date;
  private readonly pid: () => number;
  private readonly hostname: () => string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly randomToken: () => string;
  private readonly onProblem: (message: string) => void;

  public constructor(
    private readonly serviceHome: string,
    options: AdoptLockOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? (() => process.pid);
    this.hostname = options.hostname ?? (() => osHostname());
    this.isAlive = options.isAlive ?? ((pid) => isProcessAlive(pid));
    this.randomToken = options.randomToken ?? (() => randomUUID());
    this.onProblem = options.onProblem ?? (() => undefined);
  }

  public get path(): string {
    return join(this.serviceHome, "runs", ADOPT_LOCK_NAME);
  }

  /**
   * Tries to take the lock. Returns `null` when somebody else provably holds it — the caller must
   * then skip its reconciliation pass rather than force an outcome.
   */
  public acquire(): AdoptLease | null {
    try {
      // `wx` needs the directory to exist; the first run of a workspace creates it here.
      mkdirSync(join(this.serviceHome, "runs"), { recursive: true, mode: 0o700 });
    } catch (error) {
      this.onProblem(`adopt lock directory could not be created under ${this.serviceHome}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    // Two attempts at most: one direct, one after breaking a provably stale lock.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = this.randomToken();
      const holder: AdoptLockHolder = {
        version: ADOPT_LOCK_VERSION,
        token,
        pid: this.pid(),
        host: this.hostname(),
        startedAt: this.now().toISOString(),
      };
      try {
        writeFileSync(this.path, `${JSON.stringify(holder, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return this.leaseFor(token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.onProblem(`adopt lock could not be created at ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      }
      // The lock exists: decide whether its holder is still there.
      const existing = this.readHolder();
      if (existing === null) {
        if (attempt === 0) {
          this.onProblem(`adopt lock at ${this.path} is unreadable; treating it as stale and breaking it`);
          this.breakLock();
          continue;
        }
        return null;
      }
      if (existing.host !== this.hostname()) {
        this.onProblem(
          `adopt lock at ${this.path} is held on another host (${existing.host}, pid ${String(existing.pid)}); leaving it alone`,
        );
        return null;
      }
      if (this.isAlive(existing.pid)) {
        this.onProblem(
          `another MCP process (pid ${String(existing.pid)}) owns the runs in ${this.serviceHome}; skipping reconciliation`,
        );
        return null;
      }
      if (attempt === 0) {
        this.onProblem(
          `adopt lock at ${this.path} was left by pid ${String(existing.pid)} (started ${existing.startedAt}), which is gone; breaking it`,
        );
        this.breakLock();
        continue;
      }
      return null;
    }
    return null;
  }

  private leaseFor(token: string): AdoptLease {
    return {
      token,
      path: this.path,
      release: () => {
        this.release(token);
      },
    };
  }

  private release(token: string): void {
    const holder = this.readHolder();
    // Only the writer may delete the file: if another process broke ours as stale and re-created
    // it, that process's lock must survive our release.
    if (holder === null || holder.token !== token) return;
    try {
      rmSync(this.path, { force: true });
    } catch (error) {
      this.onProblem(`adopt lock at ${this.path} could not be released: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readHolder(): AdoptLockHolder | null {
    try {
      return parseHolder(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  /** Moves the stale lock aside instead of deleting it: the evidence stays on disk. */
  private breakLock(): void {
    const aside = `${this.path}.stale-${String(this.now().getTime())}`;
    try {
      renameSync(this.path, aside);
    } catch (error) {
      this.onProblem(`stale adopt lock at ${this.path} could not be moved aside: ${error instanceof Error ? error.message : String(error)}`);
      try {
        rmSync(this.path, { force: true });
      } catch {
        // The failure above is the actionable part.
      }
    }
  }
}
