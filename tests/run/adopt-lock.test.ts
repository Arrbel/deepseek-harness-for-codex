// The adopt lock (R3-3): exactly one MCP process may speak for one data directory.
//
// The rule the tests pin: a process that cannot prove the holder is gone must **not** take the
// lock. "Cannot prove" covers a live holder, a holder on another host (we cannot check it), and a
// malformed file that names no checkable pid (we break it, with a warning, and keep the old file
// as evidence).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADOPT_LOCK_NAME, ADOPT_LOCK_VERSION, AdoptLock } from "../../src/run/adopt-lock.js";
import "../support/isolation.js";

const scratch: string[] = [];
const problems: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-adopt-"));
  scratch.push(home);
  return home;
}

interface Options {
  pid?: number;
  hostname?: string;
  alive?: (pid: number) => boolean;
  token?: string;
}

function lockFor(home: string, options: Options = {}): AdoptLock {
  let counter = 0;
  return new AdoptLock(home, {
    pid: () => options.pid ?? 4321,
    hostname: () => options.hostname ?? "host-a",
    isAlive: options.alive ?? (() => true),
    randomToken: () => options.token ?? `token-${String((counter += 1))}`,
    onProblem: (message) => problems.push(message),
  });
}

function writeHolder(home: string, holder: unknown): void {
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "runs", ADOPT_LOCK_NAME), typeof holder === "string" ? holder : `${JSON.stringify(holder)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
}

afterEach(() => {
  problems.length = 0;
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AdoptLock", () => {
  it("acquires when nobody holds the lock and writes a checkable holder", () => {
    const home = tempHome();
    const lease = lockFor(home).acquire();

    expect(lease).not.toBeNull();
    expect(existsSync(join(home, "runs", ADOPT_LOCK_NAME))).toBe(true);
    const holder = JSON.parse(readFileSync(join(home, "runs", ADOPT_LOCK_NAME), "utf8")) as Record<string, unknown>;
    expect(holder["version"]).toBe(ADOPT_LOCK_VERSION);
    expect(holder["pid"]).toBe(4321);
    expect(holder["host"]).toBe("host-a");
    expect(holder["token"]).toBe(lease?.token);
  });

  it("releases only its own lock and is idempotent", () => {
    const home = tempHome();
    const lease = lockFor(home, { token: "mine" }).acquire();
    lease?.release();
    expect(existsSync(join(home, "runs", ADOPT_LOCK_NAME))).toBe(false);
    lease?.release(); // second release: nothing to do, nothing to report
    expect(problems).toEqual([]);
  });

  it("refuses to take a lock held by a live process on this host", () => {
    const home = tempHome();
    const first = lockFor(home, { pid: 1111, alive: () => true }).acquire();
    expect(first).not.toBeNull();
    // A second process sees the same file (its own acquire must fail).
    const second = lockFor(home, { pid: 2222, alive: (pid) => pid === 1111 }).acquire();

    expect(second).toBeNull();
    expect(problems.join("\n")).toContain("another MCP process (pid 1111)");
    // The winner's lock is untouched.
    first?.release();
    expect(existsSync(join(home, "runs", ADOPT_LOCK_NAME))).toBe(false);
  });

  it("does not release a lock somebody else re-created under the same path", () => {
    const home = tempHome();
    const mine = lockFor(home, { token: "mine" }).acquire();
    writeHolder(home, { version: ADOPT_LOCK_VERSION, token: "theirs", pid: 999, host: "host-a", startedAt: "2026-10-09T00:00:00.000Z" });

    mine?.release();

    expect(existsSync(join(home, "runs", ADOPT_LOCK_NAME))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "runs", ADOPT_LOCK_NAME), "utf8"))).toMatchObject({ token: "theirs" });
  });

  it("breaks a stale lock whose holder is gone, keeping the old file as evidence", () => {
    const home = tempHome();
    lockFor(home, { pid: 3333, alive: () => true }).acquire();
    // The holder died: only its file remains.
    const next = lockFor(home, { pid: 4444, alive: () => false }).acquire();

    expect(next).not.toBeNull();
    expect(problems.join("\n")).toContain("was left by pid 3333");
    expect(problems.join("\n")).toContain("which is gone; breaking it");
    const aside = readdirSync(join(home, "runs")).filter((entry) => entry.startsWith(`${ADOPT_LOCK_NAME}.stale-`));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, "runs", ADOPT_LOCK_NAME), "utf8"))).toMatchObject({ pid: 4444 });
  });

  it("breaks an unreadable lock with a warning", () => {
    const home = tempHome();
    writeHolder(home, "{ this is not json");
    const lease = lockFor(home).acquire();

    expect(lease).not.toBeNull();
    expect(problems.join("\n")).toContain("is unreadable; treating it as stale");
    expect(readdirSync(join(home, "runs")).some((entry) => entry.startsWith(`${ADOPT_LOCK_NAME}.stale-`))).toBe(true);
  });

  it("breaks a lock whose payload names no checkable pid", () => {
    const home = tempHome();
    writeHolder(home, { version: ADOPT_LOCK_VERSION, token: "x", pid: 0, host: "host-a", startedAt: "2026-10-09T00:00:00.000Z" });
    expect(lockFor(home).acquire()).not.toBeNull();
    expect(problems.join("\n")).toContain("is unreadable");
  });

  it("leaves a lock held on another host alone: liveness there cannot be checked", () => {
    const home = tempHome();
    lockFor(home, { pid: 5555, hostname: "host-b", alive: () => true }).acquire();
    const mine = lockFor(home, { pid: 6666, hostname: "host-a", alive: () => false }).acquire();

    expect(mine).toBeNull();
    expect(problems.join("\n")).toContain("held on another host (host-b, pid 5555)");
    expect(existsSync(join(home, "runs", `${ADOPT_LOCK_NAME}.stale-`))).toBe(false);
  });

  it("moves an unusable lock path aside and still acquires (self-healing, with a warning)", () => {
    const home = tempHome();
    // A directory where the lock file must go: it can be neither read nor replaced in place.
    mkdirSync(join(home, "runs", ADOPT_LOCK_NAME), { recursive: true });

    const lease = lockFor(home).acquire();

    expect(lease).not.toBeNull();
    expect(problems.join("\n")).toContain("is unreadable");
    expect(readdirSync(join(home, "runs")).some((entry) => entry.startsWith(`${ADOPT_LOCK_NAME}.stale-`))).toBe(true);
  });

  it("reports and returns null when the runs directory cannot be created at all", () => {
    const home = tempHome();
    writeFileSync(join(home, "runs"), "not a directory");

    expect(lockFor(home).acquire()).toBeNull();
    expect(problems.join("\n")).toContain("adopt lock directory could not be created");
  });
});
