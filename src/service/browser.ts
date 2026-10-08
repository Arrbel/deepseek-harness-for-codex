// Opening the Harness page in the user's default browser — the single browser side effect.
//
// The platform decision and the spawn are both seams: `browserLaunch` is pure (it names the
// vector for a platform without touching `process.platform`), and `openInDefaultBrowser` takes
// the spawn implementation so a test can assert the vector without starting a process.

import { spawn, type ChildProcess } from "node:child_process";

/** The opener and argv one platform uses. */
export interface BrowserLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Picks the platform's browser opener.
 *
 * `win32` goes through `cmd /c start` because it is the only built-in opener there; the empty
 * third argument is `start`'s own title slot, which stops a URL from being read as a window
 * title. `platform` is a parameter rather than a `process.platform` read, so all three branches
 * are reachable on any host.
 */
export function browserLaunch(platform: NodeJS.Platform, url: string): BrowserLaunch {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/**
 * Spawn options this module is allowed to use.
 *
 * The literals are the point: `shell` cannot be widened to `boolean`, so neither a caller nor a
 * later edit can reintroduce a shell without a type error — and `tests/security-invariants`
 * enforces the same promise from the outside by scanning the source.
 */
export interface BrowserSpawnOptions {
  readonly shell: false;
  readonly stdio: "ignore";
  readonly windowsHide: true;
}

/** The spawn seam; tests inject one to observe the vector without starting a process. */
export type BrowserSpawnImpl = (command: string, args: readonly string[], options: BrowserSpawnOptions) => ChildProcess;

export interface OpenBrowserOptions {
  /** Defaults to `process.platform`; injectable so every branch is reachable in a test. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `node:child_process#spawn`. */
  readonly spawnImpl?: BrowserSpawnImpl;
}

/**
 * Opens `url` in the platform's default browser. Rejects when the opener fails.
 *
 * The URL travels as one argv element with no shell in front of it, and the child is detached
 * from our stdio, so opening the page can never let the child's output reach the MCP transport.
 */
export async function openInDefaultBrowser(url: string, options: OpenBrowserOptions = {}): Promise<void> {
  const { command, args } = browserLaunch(options.platform ?? process.platform, url);
  const spawnImpl: BrowserSpawnImpl = options.spawnImpl ?? ((cmd, argv, spawnOptions) => spawn(cmd, argv, spawnOptions));
  const spawnOptions: BrowserSpawnOptions = { shell: false, stdio: "ignore", windowsHide: true };
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnImpl(command, args, spawnOptions);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${String(code)}`)));
  });
}
