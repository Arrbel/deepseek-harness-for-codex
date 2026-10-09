// Platform-conditioned process reaping: the **other side** of every OS branch, driven through the
// injection seams that `src/service/process-tree.ts` already exposes on a Windows host.
//
// This is **simulated** evidence, not real POSIX execution. `reports/r4-cross-platform.md` §4 lists
// exactly what only a real ubuntu/mac host can prove (whether `pgrep -P` exists, whether `ps -o
// command=` truncates, whether `kill(-pid)` really reaches the `dsh-subprocess-local` grandchild).
//
// Gaps this file closes (no test in `tests/` referenced them before):
//   * `readProcessIdentity(pid, "linux")` — the `/proc/<pid>/cmdline` branch
//     (`src/service/process-tree.ts:239-246`); the existing suite covered win32 and darwin only;
//   * the linux default child probe (`:80-88`) reached through the **real** default, i.e. without
//     injecting `listChildren`, which is the shape that runs on ubuntu;
//   * cross-branch exclusion, which the existing per-branch assertions do not state: POSIX reaping
//     must never reach `taskkill.exe`, and Windows reaping must never signal a POSIX group or walk
//     descendants.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  reapProcessTree,
  reapProcessTreeByPid,
  readProcessIdentity,
  type KillerHandle,
} from "../../src/service/process-tree.js";
import "../support/isolation.js";

/** No real process can hold this pid (Linux `pid_max` is at most 2^22), so `/proc` has no entry. */
const ABSENT_PID = 999_999_999;

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

/** A `taskkill` stand-in that records the argv it was handed and closes without touching the fake. */
function recordingKiller(calls: string[][]): (command: string, args: readonly string[]) => KillerHandle {
  return (command, args) => {
    calls.push([command, ...args]);
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit("close"));
    return emitter as unknown as KillerHandle;
  };
}

/** Collects the pids signalled through one seam. */
function recorder(): { calls: number[]; push: (pid: number) => void } {
  const calls: number[] = [];
  return { calls, push: (pid: number) => calls.push(pid) };
}

describe("cross-branch exclusion: the two reaping strategies never cross over", () => {
  it("POSIX reaping never reaches the Windows tree killer", async () => {
    const killerCalls: string[][] = [];
    const groups = recorder();
    const child = new FakeChild(600);

    await reapProcessTree(asChild(child), {
      platform: "linux",
      killGroup: (pid) => groups.push(pid),
      spawnKiller: recordingKiller(killerCalls),
      listChildren: () => {
        throw new Error("the descendant walk must not run when the group kill succeeded");
      },
    });

    // The behavioural claim: on POSIX the process group is the mechanism, so `taskkill.exe` is not
    // merely "not first" — it is never consulted, even though the seam is available.
    expect(killerCalls).toEqual([]);
    expect(groups.calls).toEqual([600]);
    expect(child.kills).toEqual([]);
  });

  it("darwin takes the same POSIX group path as Linux, not the Windows one", async () => {
    const killerCalls: string[][] = [];
    const groups = recorder();
    const child = new FakeChild(601);

    await reapProcessTree(asChild(child), {
      platform: "darwin",
      killGroup: (pid) => groups.push(pid),
      spawnKiller: recordingKiller(killerCalls),
      listChildren: () => [],
    });

    expect(killerCalls).toEqual([]);
    expect(groups.calls).toEqual([601]);
    expect(child.kills).toEqual([]);
  });

  it("Windows reaping never signals a POSIX process group and never walks descendants", async () => {
    const killerCalls: string[][] = [];
    const groups = recorder();
    const directKills = recorder();
    const child = new FakeChild(700);

    await reapProcessTree(asChild(child), {
      platform: "win32",
      spawnKiller: recordingKiller(killerCalls),
      killGroup: (pid) => groups.push(pid),
      kill: (pid) => directKills.push(pid),
      listChildren: () => {
        directKills.push(-1); // a sentinel: if the walk ran, this shows up
        return [];
      },
    });

    expect(killerCalls).toEqual([["taskkill.exe", "/PID", "700", "/T", "/F"]]);
    expect(groups.calls).toEqual([]);
    expect(directKills.calls).toEqual([]);
    // `taskkill` reported close without touching the fake, so the documented fallback ran.
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("orphan reclamation by pid keeps the same split", async () => {
    const killerCalls: string[][] = [];
    await reapProcessTreeByPid(31338, { platform: "win32", spawnKiller: recordingKiller(killerCalls) });
    expect(killerCalls).toEqual([["taskkill.exe", "/PID", "31338", "/T", "/F"]]);

    const groups = recorder();
    const directKills = recorder();
    await reapProcessTreeByPid(31339, {
      platform: "linux",
      spawnKiller: recordingKiller(killerCalls),
      killGroup: (pid) => groups.push(pid),
      kill: (pid) => directKills.push(pid),
    });

    // Still exactly one `taskkill` call: the POSIX reclamation added none.
    expect(killerCalls).toHaveLength(1);
    expect(groups.calls).toEqual([31339]);
    expect(directKills.calls).toEqual([]);
  });
});

describe("the linux identity probe is a /proc read, not a subprocess call", () => {
  it("returns null for an absent pid and never delegates to the injected runner", () => {
    const seen: string[][] = [];
    const identity = readProcessIdentity(ABSENT_PID, "linux", (command, args) => {
      seen.push([command, ...args]);
      return "SHOULD-NOT-BE-USED";
    });

    // On Linux `/proc/<pid>/cmdline` does not exist for this pid, so the probe fails closed. On
    // Windows the same call proves the branch never fell through to `ps`/`powershell.exe`.
    expect(identity).toBeNull();
    expect(seen).toEqual([]);
  });

  it("keeps the darwin probe on `ps -o command=` so the linux branch cannot shadow it", () => {
    const seen: string[][] = [];
    readProcessIdentity(ABSENT_PID, "darwin", (command, args) => {
      seen.push([command, ...args]);
      return null;
    });

    expect(seen).toEqual([["ps", "-o", "command=", "-p", String(ABSENT_PID)]]);
  });

  it("keeps the win32 probe on PowerShell so neither POSIX branch shadows it", () => {
    const seen: string[][] = [];
    readProcessIdentity(ABSENT_PID, "win32", (command, args) => {
      seen.push([command, ...args]);
      return null;
    });

    expect(seen[0]?.[0]).toBe("powershell.exe");
    expect(seen).toHaveLength(1);
  });
});

describe("the real default child probe (no injection) degrades safely off its own platform", () => {
  it("reclaims the recorded pid on POSIX when /proc and the process group are both unavailable", async () => {
    const groups = recorder();
    const directKills = recorder();

    // `listChildren` is deliberately NOT injected: this drives `defaultListChildren` with
    // `platform: "linux"`, i.e. the `/proc/<pid>/task/<pid>/children` read at
    // `src/service/process-tree.ts:81-88`, on a host that has no `/proc`.
    await expect(reapProcessTreeByPid(ABSENT_PID, {
      platform: "linux",
      killGroup: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
      kill: (pid) => directKills.push(pid),
    })).resolves.toBeUndefined();

    expect(groups.calls).toEqual([]);
    expect(directKills.calls).toEqual([ABSENT_PID]);
  });

  it("reclaims the recorded pid on darwin when its child probe cannot be run either", async () => {
    const directKills = recorder();

    // darwin's default probe shells out to `pgrep -P` (`:89-97`). On this host that binary does
    // not exist, which is the failure mode the code must absorb rather than surface.
    await expect(reapProcessTreeByPid(ABSENT_PID, {
      platform: "darwin",
      killGroup: () => {
        throw new Error("no process group");
      },
      kill: (pid) => directKills.push(pid),
    })).resolves.toBeUndefined();

    expect(directKills.calls).toEqual([ABSENT_PID]);
  });
});
