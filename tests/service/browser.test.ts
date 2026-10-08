// Unit tests for `service/browser.ts`: the three platform openers and the spawn seam.
//
// The seam is what makes this testable at all — the module used to read `process.platform` inline,
// so on this host the darwin and Linux branches could never run and nothing referenced the file.
// No process is started here: the injected spawn records the vector and answers like a child.
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

const URL_UNDER_TEST = "http://127.0.0.1:1234/?token=fixture-token";

interface Recorded {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: BrowserSpawnOptions;
}

/** An injected spawn that records its vector and settles the way a real opener would. */
function stubSpawn(outcome: "close-0" | "close-1" | "error" = "close-0"): {
  spawnImpl: BrowserSpawnImpl;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const spawnImpl: BrowserSpawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess;
    setImmediate(() => {
      if (outcome === "error") child.emit("error", new Error("opener missing"));
      else child.emit("close", outcome === "close-0" ? 0 : 1);
    });
    return child;
  };
  return { spawnImpl, calls };
}

describe("service/browser openers", () => {
  it("names the vector for every platform without reading process.platform", () => {
    expect(browserLaunch("darwin", URL_UNDER_TEST)).toEqual({ command: "open", args: [URL_UNDER_TEST] });
    expect(browserLaunch("win32", URL_UNDER_TEST)).toEqual({
      command: "cmd",
      args: ["/c", "start", "", URL_UNDER_TEST],
    });
    expect(browserLaunch("linux", URL_UNDER_TEST)).toEqual({ command: "xdg-open", args: [URL_UNDER_TEST] });
    // Anything that is neither of the two named platforms falls back to the freedesktop opener.
    expect(browserLaunch("freebsd", URL_UNDER_TEST)).toEqual({ command: "xdg-open", args: [URL_UNDER_TEST] });
  });

  it.each([
    { platform: "darwin" as const, command: "open", args: [URL_UNDER_TEST] },
    { platform: "win32" as const, command: "cmd", args: ["/c", "start", "", URL_UNDER_TEST] },
    { platform: "linux" as const, command: "xdg-open", args: [URL_UNDER_TEST] },
  ])("opens the page through the $platform vector with no shell", async ({ platform, command, args }) => {
    const stub = stubSpawn("close-0");

    await openInDefaultBrowser(URL_UNDER_TEST, { platform, spawnImpl: stub.spawnImpl });

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    expect(call?.command).toBe(command);
    expect(call?.args).toEqual(args);
    // The URL is one argv element, never something a shell gets to interpret.
    expect(call?.args).toContain(URL_UNDER_TEST);
    expect(call?.options).toEqual({ shell: false, stdio: "ignore", windowsHide: true });
  });

  it("resolves only after the opener exits successfully", async () => {
    const stub = stubSpawn("close-0");
    await expect(openInDefaultBrowser(URL_UNDER_TEST, { platform: "linux", spawnImpl: stub.spawnImpl })).resolves.toBeUndefined();
  });

  it("rejects when the opener cannot be started and when it exits non-zero", async () => {
    const missing = stubSpawn("error");
    await expect(
      openInDefaultBrowser(URL_UNDER_TEST, { platform: "linux", spawnImpl: missing.spawnImpl }),
    ).rejects.toThrow("opener missing");

    const failed = stubSpawn("close-1");
    await expect(
      openInDefaultBrowser(URL_UNDER_TEST, { platform: "linux", spawnImpl: failed.spawnImpl }),
    ).rejects.toThrow("xdg-open exited with code 1");

    // The failing vectors are still the ones we chose per platform — a rejection is not a fallback.
    expect(failed.calls[0]?.command).toBe("xdg-open");
  });

  it("uses the host platform when no platform is injected", async () => {
    const stub = stubSpawn("close-0");
    await openInDefaultBrowser(URL_UNDER_TEST, { spawnImpl: stub.spawnImpl });
    expect(stub.calls[0]?.command).toBe(browserLaunch(process.platform, URL_UNDER_TEST).command);
  });
});
