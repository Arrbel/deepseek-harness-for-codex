// The child-process side of one local Harness Web service.
//
// `supervisor.ts` owns the lifecycle; this module owns the two things that decide *how* the
// process is started: the argv/env shape and the optional browser hand-off.
//
// It also owns the one filesystem write the launch needs: the per-workspace service home
// (`DSH_HOME`) is created here, immediately before `spawn`, and nowhere else. Keeping it on
// the real spawn path means an injected `spawnProcess` seam cannot create directories — the
// defect where a test run wrote hundreds of empty directories into the user's real data
// directory (see `reports/fix-test-isolation.md`).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

/** The argv and environment of one local Harness Web process. */
export interface HarnessLaunch {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Per-workspace `DSH_HOME` the spawned Harness process owns. */
  readonly serviceHome: string;
  readonly shell: false;
  readonly windowsHide: true;
  /**
   * POSIX: `true`, so the child leads its own process group and `kill(-pid)` can reach the whole
   * tree (P0-2). Windows: `false`, because detaching there would flash a new console window.
   */
  readonly detached: boolean;
}

const RUNTIME_ARGS = ["web", "--no-open", "--port", "0"] as const;

/** Spawn options derived from a {@link HarnessLaunch}; argv-only, never a shell. */
export function launchSpawnOptions(launch: HarnessLaunch): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: boolean;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
  windowsHide: boolean;
} {
  return {
    cwd: launch.cwd,
    env: launch.env,
    shell: launch.shell,
    detached: launch.detached,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: launch.windowsHide,
  };
}

/**
 * Builds the direct launch vector: `process.execPath <binPath> web --no-open --port 0`.
 *
 * `shell` is `false` on every platform (ADR-0002/P2): the entrance is a real js file
 * resolved from the installed package, so no `.cmd` shim and no PATH lookup are involved.
 */
export function buildHarnessLaunch(input: {
  binPath: string;
  workspace: string;
  serviceHome: string;
  env?: NodeJS.ProcessEnv;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform;
}): HarnessLaunch {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  return {
    command: process.execPath,
    args: [input.binPath, ...RUNTIME_ARGS],
    cwd: input.workspace,
    serviceHome: input.serviceHome,
    env: {
      ...env,
      ...(input.extraEnv ?? {}),
      DSH_CWD: input.workspace,
      DSH_HOME: input.serviceHome,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
      DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1",
      NO_COLOR: "1",
    },
    shell: false,
    windowsHide: true,
    detached: platform !== "win32",
  };
}

/**
 * Spawns the launch vector exactly as described: argv-only, no shell, hidden window.
 *
 * Creating `serviceHome` here is deliberate and is the last filesystem write before the
 * child exists: the Harness process populates `profiles/`, `sessions/`, and `storages/`
 * itself, but it needs the `DSH_HOME` parent to already exist.
 *
 * The P0-5 safety check lives in `supervisor.ts`, one layer up: every spawn — injected seam or
 * this real one — goes through `ServiceSupervisor#launchService`, which is the only place that
 * knows the resolved data directory. Keeping it there also keeps this module a leaf (it may not
 * import `../policy/*`, see `tests/module-boundaries.test.ts`).
 */
export function spawnHarness(launch: HarnessLaunch): ChildProcess {
  mkdirSync(launch.serviceHome, { recursive: true, mode: 0o700 });
  return spawn(launch.command, launch.args, launchSpawnOptions(launch));
}
