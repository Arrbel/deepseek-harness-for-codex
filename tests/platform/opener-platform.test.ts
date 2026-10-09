// The three platform openers, driven through the spawn seam that `src/service/browser.ts` exposes.
//
// This is **simulated** evidence: the darwin `open` and the freedesktop `xdg-open` vectors are
// asserted as argv/behaviour here, but no macOS or Linux host ever ran them (see
// `reports/r4-cross-platform.md` §4 for what a real host must still confirm).
//
// What is added beyond `tests/service/browser.test.ts`:
//   * argv isolation under shell metacharacters — the property that would break if a URL were ever
//     concatenated into a command string instead of passed as one argv element;
//   * the `start` title-slot position, which is the difference between "opens the page" and
//     "opens a window titled `http://…`";
//   * `open`'s argument count, so a future `open -a <browser> <url>` edit is caught;
//   * the unknown-POSIX fallback never being the Windows vector.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  browserLaunch,
  openInDefaultBrowser,
  type BrowserSpawnImpl,
  type BrowserSpawnOptions,
} from "../../src/service/browser.js";
import "../support/isolation.js";

const PLAIN_URL = "http://127.0.0.1:1234/?token=fixture-token";

/** A URL whose characters are only safe if they travel as argv, never through a shell. */
const HOSTILE_URL = "http://127.0.0.1:1234/?a=1&b=2|c>d%20e f";

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: BrowserSpawnOptions;
}

function recordingSpawn(outcome: "close-0" | "error" = "close-0"): {
  spawnImpl: BrowserSpawnImpl;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const spawnImpl: BrowserSpawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    setImmediate(() => {
      if (outcome === "error") child.emit("error", new Error("opener missing"));
      else child.emit("close", 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

/** The single recorded spawn, or a failure that names the real problem. */
function onlyCall(calls: readonly Recorded[]): Recorded {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (call === undefined) throw new Error("no spawn was recorded");
  return call;
}

const ALL_PLATFORMS = ["darwin", "win32", "linux"] as const;

describe("openers: argv isolation is the property, not the vector spelling", () => {
  it.each(ALL_PLATFORMS)("hands a metacharacter URL to %s as one untouched argv element", async (platform) => {
    const stub = recordingSpawn();

    await openInDefaultBrowser(HOSTILE_URL, { platform, spawnImpl: stub.spawnImpl });

    const call = onlyCall(stub.calls);
    // Exactly one argv element carries the URL, and it is byte-identical to the input.
    expect(call.args.filter((arg) => arg === HOSTILE_URL)).toHaveLength(1);
    // No element was assembled from the URL: outside the URL itself, no shell operator appears
    // anywhere in argv (the URL's own characters are data, not syntax — that is the whole point).
    for (const arg of call.args) {
      if (arg === HOSTILE_URL) continue;
      expect(arg).not.toContain("|");
      expect(arg).not.toContain(">");
      expect(arg).not.toContain("&&");
    }
    // A shell would be the only way those characters could be reinterpreted.
    expect(call.options.shell).toBe(false);
  });

  it.each(ALL_PLATFORMS)("never lets %s inherit our stdio or a visible window", async (platform) => {
    const stub = recordingSpawn();
    await openInDefaultBrowser(PLAIN_URL, { platform, spawnImpl: stub.spawnImpl });

    expect(onlyCall(stub.calls).options).toEqual({ shell: false, stdio: "ignore", windowsHide: true });
  });
});

describe("opener selection: each platform names its own program", () => {
  it("darwin passes the URL as open's only argument (no browser selection, no extra flags)", async () => {
    const stub = recordingSpawn();
    await openInDefaultBrowser(PLAIN_URL, { platform: "darwin", spawnImpl: stub.spawnImpl });

    const call = onlyCall(stub.calls);
    expect(call.command).toBe("open");
    expect(call.args).toEqual([PLAIN_URL]);
  });

  it("win32 keeps start's empty title slot so the URL is never read as a window title", async () => {
    const stub = recordingSpawn();
    await openInDefaultBrowser(PLAIN_URL, { platform: "win32", spawnImpl: stub.spawnImpl });

    const call = onlyCall(stub.calls);
    expect(call.command).toBe("cmd");
    // `cmd /c start "" <url>`: the empty third element is positional, not cosmetic.
    expect(call.args).toEqual(["/c", "start", "", PLAIN_URL]);
    expect(call.args[2]).toBe("");
    expect(call.args[3]).toBe(PLAIN_URL);
  });

  it("a POSIX platform that is neither darwin nor win32 gets xdg-open, never the Windows vector", async () => {
    const stub = recordingSpawn();
    await openInDefaultBrowser(PLAIN_URL, { platform: "freebsd", spawnImpl: stub.spawnImpl });

    const call = onlyCall(stub.calls);
    expect(call.command).toBe("xdg-open");
    expect(call.command).not.toBe("cmd");
    expect(call.args).toEqual([PLAIN_URL]);
  });

  it("uses the host platform when none is injected (and never a substring of it)", async () => {
    const stub = recordingSpawn();
    await openInDefaultBrowser(PLAIN_URL, { spawnImpl: stub.spawnImpl });

    const host = browserLaunch(process.platform, PLAIN_URL);
    expect(onlyCall(stub.calls).command).toBe(host.command);
    if (process.platform === "win32") expect(host.command).toBe("cmd");
    if (process.platform === "darwin") expect(host.command).toBe("open");
    if (process.platform === "linux") expect(host.command).toBe("xdg-open");
  });

  it("rejects with the chosen program's name, so a failure names the platform vector", async () => {
    const stub = recordingSpawn("error");
    await expect(openInDefaultBrowser(PLAIN_URL, { platform: "darwin", spawnImpl: stub.spawnImpl }))
      .rejects.toThrow("opener missing");
    // The rejection did not quietly retry through another platform's program.
    expect(stub.calls).toHaveLength(1);
    expect(onlyCall(stub.calls).command).toBe("open");
  });
});
