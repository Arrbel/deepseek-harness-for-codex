// Process-tree reaping (P0-2).
//
// `src/service/process-tree.ts` had **zero** test references before this file, which is how the
// POSIX grandchild leak survived: `kill(-pid)` silently degrades to `child.kill()` when the child
// was not detached, so `dsh-subprocess-local` kept running and kept the port.
//
// This machine is Windows, so the POSIX branches are covered through the injection seams only —
// see `reports/fix-process-lifecycle.md` for that honest boundary (real POSIX behavior is for a
// mac CI job).

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  hasExited,
  isProcessAlive,
  readProcessIdentity,
  reapProcessTree,
  reapProcessTreeByPid,
  waitForExit,
  type KillerHandle,
} from "../../src/service/process-tree.js";
import "../support/isolation.js";

class FakeChild extends EventEmitter {
  public pid: number | undefined;
  public exitCode: number | null = null;
  public signalCode: NodeJS.Signals | null = null;
  public readonly kills: (NodeJS.Signals | undefined)[] = [];

  public constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  public kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    this.exitCode = 0;
    return true;
  }
}

function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

/** A killer that reports "close" on the next microtask. */
function closingKiller(calls: string[][]): (command: string, args: readonly string[]) => KillerHandle {
  return (command, args) => {
    calls.push([command, ...args]);
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit("close"));
    return emitter as unknown as KillerHandle;
  };
}

describe("reapProcessTree: platform branches", () => {
  it("uses taskkill /T /F on Windows and then the child kill if it is still alive", async () => {
    const calls: string[][] = [];
    const child = new FakeChild(4321);

    await reapProcessTree(asChild(child), { platform: "win32", spawnKiller: closingKiller(calls) });

    expect(calls).toEqual([["taskkill.exe", "/PID", "4321", "/T", "/F"]]);
    // `taskkill` did not touch our fake, so the fallback must have run.
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("does not signal again when the tree killer already removed the child", async () => {
    const calls: string[][] = [];
    const child = new FakeChild(9);
    await reapProcessTree(asChild(child), {
      platform: "win32",
      spawnKiller: (command, args) => {
        calls.push([command, ...args]);
        child.exitCode = 1; // the killer worked
        const emitter = new EventEmitter();
        queueMicrotask(() => emitter.emit("close"));
        return emitter as unknown as KillerHandle;
      },
    });

    expect(calls).toHaveLength(1);
    expect(child.kills).toEqual([]);
  });

  it("kills the process group on POSIX when the group exists (the detached child)", async () => {
    const groups: [number, NodeJS.Signals][] = [];
    const killed: number[] = [];
    const child = new FakeChild(500);

    await reapProcessTree(asChild(child), {
      platform: "linux",
      killGroup: (pid, signal) => groups.push([pid, signal]),
      kill: (pid) => killed.push(pid),
      listChildren: () => {
        throw new Error("the fallback must not run when the group kill succeeded");
      },
    });

    expect(groups).toEqual([[500, "SIGKILL"]]);
    expect(killed).toEqual([]);
  });

  it("falls back to a depth-first descendant walk when there is no process group", async () => {
    const killed: number[] = [];
    const childrenOf: Record<number, number[]> = { 10: [11], 11: [12], 12: [] };
    const child = new FakeChild(10);

    await reapProcessTree(asChild(child), {
      platform: "linux",
      killGroup: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      kill: (pid) => killed.push(pid),
      listChildren: (pid) => childrenOf[pid] ?? [],
    });

    // Leaves first (12 → 11), then the recorded pid itself: killing the parent first is exactly
    // how the grandchildren survived in the field.
    expect(killed).toEqual([12, 11, 10]);
  });

  it("still kills the parent when the child list cannot be read", async () => {
    const killed: number[] = [];
    const child = new FakeChild(77);
    await reapProcessTree(asChild(child), {
      platform: "darwin",
      killGroup: () => {
        throw new Error("no group");
      },
      kill: (pid) => killed.push(pid),
      listChildren: () => {
        throw new Error("pgrep missing");
      },
    });

    expect(killed).toEqual([77]);
  });

  it("kills without a pid when the child never got one", async () => {
    const calls: string[][] = [];
    const child = new FakeChild(undefined);

    await reapProcessTree(asChild(child), { platform: "win32", spawnKiller: closingKiller(calls) });

    expect(calls).toEqual([]);
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("resolves when the tree killer cannot even be spawned", async () => {
    const child = new FakeChild(8);
    await expect(reapProcessTree(asChild(child), {
      platform: "win32",
      spawnKiller: () => {
        throw new Error("ENOENT taskkill.exe");
      },
    })).resolves.toBeUndefined();
    expect(child.kills).toEqual(["SIGKILL"]);
  });
});

describe("reapProcessTreeByPid: orphan reclamation without a ChildProcess handle", () => {
  it("uses taskkill on Windows", async () => {
    const calls: string[][] = [];
    await reapProcessTreeByPid(31337, { platform: "win32", spawnKiller: closingKiller(calls) });
    expect(calls).toEqual([["taskkill.exe", "/PID", "31337", "/T", "/F"]]);
  });

  it("uses the group kill on POSIX when it works", async () => {
    const groups: number[] = [];
    const killed: number[] = [];
    await reapProcessTreeByPid(444, {
      platform: "linux",
      killGroup: (pid) => groups.push(pid),
      kill: (pid) => killed.push(pid),
      listChildren: () => [],
    });
    expect(groups).toEqual([444]);
    expect(killed).toEqual([]);
  });

  it("walks the tree and then kills the recorded pid when the group is gone", async () => {
    const killed: number[] = [];
    await reapProcessTreeByPid(1000, {
      platform: "linux",
      killGroup: () => {
        throw new Error("no group");
      },
      kill: (pid) => killed.push(pid),
      listChildren: (pid) => (pid === 1000 ? [1001] : []),
    });
    expect(killed).toEqual([1001, 1000]);
  });
});

describe("hasExited / waitForExit", () => {
  it("reports exit from codes and signals, and resolves on the first event", async () => {
    const child = new FakeChild(1);
    expect(hasExited(asChild(child))).toBe(false);

    const pending = waitForExit(asChild(child), 50);
    child.emit("exit", 0, null);
    child.emit("close", 0, null); // both events arrive: the promise must settle once
    child.exitCode = 0;
    await expect(pending).resolves.toBe(true);

    const bySignal = new FakeChild(2);
    bySignal.signalCode = "SIGTERM";
    expect(hasExited(asChild(bySignal))).toBe(true);
    await expect(waitForExit(asChild(bySignal), 5)).resolves.toBe(true);
  });

  it("returns the observed state when the deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const never = new FakeChild(3);
      const pendingNever = waitForExit(asChild(never), 25);
      await vi.advanceTimersByTimeAsync(30);
      await expect(pendingNever).resolves.toBe(false);

      const exited = new FakeChild(4);
      const pendingExited = waitForExit(asChild(exited), 25);
      exited.exitCode = 0; // exited during the window, but no event was delivered
      await vi.advanceTimersByTimeAsync(30);
      await expect(pendingExited).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("liveness and identity probes", () => {
  it("treats a throwing kill(pid, 0) as dead and a resolving one as alive", () => {
    expect(isProcessAlive(4242, () => undefined)).toBe(true);
    expect(isProcessAlive(4242, () => {
      throw new Error("ESRCH");
    })).toBe(false);
  });

  it("reads the Windows command line through PowerShell", () => {
    const seen: string[][] = [];
    const identity = readProcessIdentity(4242, "win32", (command, args) => {
      seen.push([command, ...args]);
      return "node C:\\runtime\\lib\\bin.js web --no-open --port 0";
    });

    expect(seen[0]?.[0]).toBe("powershell.exe");
    expect(seen[0]?.join(" ")).toContain("ProcessId=4242");
    expect(identity).toContain("bin.js");
  });

  it("falls back to ps on macOS and reports null when the OS will not tell us", () => {
    const seen: string[][] = [];
    readProcessIdentity(5150, "darwin", (command, args) => {
      seen.push([command, ...args]);
      return null;
    });

    expect(seen).toEqual([["ps", "-o", "command=", "-p", "5150"]]);
    expect(readProcessIdentity(5150, "win32", () => null)).toBeNull();
  });
});
