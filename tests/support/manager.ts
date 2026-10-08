// Shared test helpers.
//
// The production composition root is `src/app/container.ts`. Tests need the same thing with
// the process/browser/runtime seams replaced by fixtures, plus the few assertions that
// inspect the container's public surface. Nothing here is allowed to reach into `src/`
// internals: everything goes through the public container API.
//
// Isolation is structural, not conventional: a manager constructed without a `dataDirectory`
// gets its own temporary one, and `close()` removes it. A suite cannot leak into the user's
// real data directory by forgetting an argument.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessContainer, type ContainerOptions } from "../../src/app/container.js";
import type { RunSnapshot, StartRunInput } from "../../src/run/types.js";
import type { ServiceSnapshot, StartServiceInput } from "../../src/service/types.js";
import "./isolation.js";

/** Temporary data directories this module owns, removed by `close()` or at process exit. */
const ownedDataDirectories = new Set<string>();
let exitCleanupRegistered = false;

function ownTemporaryDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-test-data-"));
  ownedDataDirectories.add(directory);
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    // `close()` is the intended path; this only catches a suite that forgets to call it.
    process.once("exit", () => {
      for (const path of ownedDataDirectories) rmSync(path, { recursive: true, force: true });
    });
  }
  return directory;
}

/** Container options the integration suites override, plus the test-only browser spy. */
export interface HarnessManagerOptions extends ContainerOptions {
  openBrowser?: (url: string) => Promise<void>;
}

/** Backwards-compatible name for the option shape the suites already speak. */
export type RunManagerOptions = HarnessManagerOptions;

/** Backwards-compatible name for the delegating container wrapper. */
export { HarnessManager as RunManager };

/** A container plus the delegating surface the suites talk to. */
export class HarnessManager {
  public readonly container: HarnessContainer;
  private readonly ownedDataDirectory: string | null;

  public constructor(options: HarnessManagerOptions = {}) {
    const owned = options.dataDirectory === undefined ? ownTemporaryDataDirectory() : null;
    this.ownedDataDirectory = owned;
    this.container = new HarnessContainer({
      ...options,
      dataDirectory: options.dataDirectory ?? owned!,
    });
  }

  public async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    return await this.container.startService(input);
  }

  public async openService(serviceId: string): Promise<ServiceSnapshot> {
    return await this.container.openService(serviceId);
  }

  public listServices(): ServiceSnapshot[] {
    return this.container.listServices();
  }

  public async stopService(serviceId: string): Promise<ServiceSnapshot> {
    return await this.container.stopService(serviceId);
  }

  public async start(input: StartRunInput): Promise<RunSnapshot> {
    return await this.container.start(input);
  }

  public async list(): Promise<RunSnapshot[]> {
    return await this.container.list();
  }

  public async get(runId: string): Promise<RunSnapshot> {
    return await this.container.get(runId);
  }

  public async wait(runId: string, timeoutMs: number): Promise<RunSnapshot> {
    return await this.container.wait(runId, timeoutMs);
  }

  public async cancel(runId: string): Promise<RunSnapshot> {
    return await this.container.cancel(runId);
  }

  public doctor(): Record<string, unknown> {
    return this.container.doctor();
  }

  /** Stops every owned service and removes the temporary data directory this helper created. */
  public async close(): Promise<void> {
    await this.container.dispose();
    if (this.ownedDataDirectory === null) return;
    ownedDataDirectories.delete(this.ownedDataDirectory);
    rmSync(this.ownedDataDirectory, { recursive: true, force: true });
  }
}
