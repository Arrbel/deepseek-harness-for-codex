// Suite-level isolation net.
//
// `tests/support/isolation.ts` fails a test file when the run creates or removes a real data
// directory. That only helps if every test file actually imports it, so this file makes the
// import mandatory: a new test file that forgets it turns the suite red here instead of
// silently regaining write access to the user's home directory.
//
// The remaining cases pin the two halves of the fix: the guard's detector really fires, and the
// shared assembly entry hands the composition root a temporary data directory no matter what
// the environment says.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RunManager } from "./support/manager.js";
import {
  assertRealDataDirectoriesUnchanged,
  dataDirectoryViolations,
  DEFAULT_DATA_DIRECTORY,
  observeRealDataDirectories,
  realDataDirectories,
  watchedDataDirectories,
} from "./support/isolation.js";

const testsRoot = dirname(fileURLToPath(import.meta.url));
const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-isolation-probe-"));
  scratchRoots.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Every `*.test.ts` under `tests/`, relative to the repository root. */
function testFiles(directory = testsRoot, prefix = "tests"): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const label = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...testFiles(path, label));
    else if (entry.name.endsWith(".test.ts")) files.push(label);
  }
  return files;
}

describe("test-suite isolation guard", () => {
  it("is imported by every test file", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(10);

    const unguarded = files.filter((file) => {
      const source = readFileSync(join(testsRoot, "..", file), "utf8");
      return !/["'][^"']*support\/isolation\.js["']/u.test(source);
    });

    expect(unguarded, "add `import \"./support/isolation.js\";` (path-adjusted) to these files").toEqual([]);
  });

  it("watches the default data directory and any configured one", () => {
    expect(DEFAULT_DATA_DIRECTORY).toBe(join(homedir(), ".deep-seek-harness-mcp"));
    expect(realDataDirectories({})).toEqual([DEFAULT_DATA_DIRECTORY]);
    expect(realDataDirectories({ DSH_MCP_DATA_DIR: "C:\\configured" })).toEqual(["C:\\configured", DEFAULT_DATA_DIRECTORY]);
    expect(realDataDirectories({ DSH_MCP_DATA_DIR: "   ", PLUGIN_DATA: "C:\\plugin" })).toEqual(["C:\\plugin", DEFAULT_DATA_DIRECTORY]);
  });

  it("detects both an appearance and a disappearance", () => {
    const root = scratch();
    const appeared = root;
    const vanished = join(root, "never-created");

    expect(() => assertRealDataDirectoriesUnchanged([{ path: appeared, existed: false, allowCreation: false }]))
      .toThrow(/was created during the test run/u);
    expect(() => assertRealDataDirectoriesUnchanged([{ path: vanished, existed: true, allowCreation: false }]))
      .toThrow(/disappeared during the test run/u);

    // A matching observation is not a violation, which is what every guarded file relies on.
    const observed = observeRealDataDirectories();
    expect(() => assertRealDataDirectoriesUnchanged(observed)).not.toThrow();
  });

  it("lets a configured directory be created, but never deleted (real filesystem)", () => {
    const root = scratch();
    const configured = join(root, "live-data");

    // The live smoke's shape: the directory does not exist yet and the run installs into it.
    const before = observeRealDataDirectories({
      DSH_MCP_DATA_DIR: configured,
    } as NodeJS.ProcessEnv);
    expect(before).toEqual([
      { path: configured, existed: false, allowCreation: true },
      { path: DEFAULT_DATA_DIRECTORY, existed: existsSync(DEFAULT_DATA_DIRECTORY), allowCreation: false },
    ]);

    mkdirSync(configured);
    expect(() => assertRealDataDirectoriesUnchanged(before)).not.toThrow();

    // Having been created by the run, it must survive the run.
    const after = observeRealDataDirectories({ DSH_MCP_DATA_DIR: configured } as NodeJS.ProcessEnv);
    rmSync(configured, { recursive: true, force: true });
    expect(() => assertRealDataDirectoriesUnchanged(after)).toThrow(/disappeared during the test run/u);
  });
});

// The B1 fix, stated as four rules. Every case drives the pure judge with synthetic observations
// and a stub probe, so asserting "this must fail" never risks creating a real directory.
describe("data-directory policy: default is strict, configured may be created", () => {
  const configured = "C:\\scratch\\live-data";
  const present = (): boolean => true;
  const absent = (): boolean => false;

  it("passes when a configured directory appears (the live-smoke shape)", () => {
    expect(dataDirectoryViolations([{ path: configured, existed: false, allowCreation: true }], present)).toEqual([]);
  });

  it("fails when the default directory appears (D-07 protection is not weakened)", () => {
    expect(dataDirectoryViolations([{ path: DEFAULT_DATA_DIRECTORY, existed: false, allowCreation: false }], present))
      .toEqual([`${DEFAULT_DATA_DIRECTORY} was created during the test run`]);
  });

  it("fails when a configured directory disappears", () => {
    expect(dataDirectoryViolations([{ path: configured, existed: true, allowCreation: true }], absent))
      .toEqual([`${configured} disappeared during the test run`]);
  });

  it("fails when a configured directory disappears even though creation was allowed", () => {
    // Both directions in one observation: creation is legal, deletion is not.
    expect(dataDirectoryViolations([{ path: configured, existed: true, allowCreation: true }], absent))
      .toHaveLength(1);
    expect(dataDirectoryViolations([{ path: configured, existed: false, allowCreation: true }], present))
      .toHaveLength(0);
  });

  it("applies the strict rule when the configured path is the default one", () => {
    const watched = watchedDataDirectories({ DSH_MCP_DATA_DIR: DEFAULT_DATA_DIRECTORY } as NodeJS.ProcessEnv);
    expect(watched).toEqual([{ path: DEFAULT_DATA_DIRECTORY, allowCreation: false }]);

    const observed = observeRealDataDirectories({ DSH_MCP_DATA_DIR: DEFAULT_DATA_DIRECTORY } as NodeJS.ProcessEnv);
    expect(observed).toHaveLength(1);
    expect(dataDirectoryViolations(observed.map((entry) => ({ ...entry, existed: false })), present))
      .toEqual([`${DEFAULT_DATA_DIRECTORY} was created during the test run`]);
  });

  it("treats a differently-spelled default path as the same directory on Windows", () => {
    if (process.platform !== "win32") return;
    const watched = watchedDataDirectories({ DSH_MCP_DATA_DIR: DEFAULT_DATA_DIRECTORY.toUpperCase() } as NodeJS.ProcessEnv);
    expect(watched).toEqual([{ path: DEFAULT_DATA_DIRECTORY, allowCreation: false }]);
  });
});

describe("test-suite isolation guard: assembly entries", () => {
  it("gives an assembly entry without a data directory its own temporary one", async () => {
    const before = observeRealDataDirectories();
    const manager = new RunManager({ allowedRoots: [] });
    const dataDirectory = manager.container.dataDirectory;

    expect(dataDirectory).not.toBe(DEFAULT_DATA_DIRECTORY);
    expect(existsSync(dataDirectory)).toBe(true);
    expect(relative(tmpdir(), dataDirectory)).not.toMatch(/^\.\./u);

    await manager.close();

    // `close()` owns the temporary directory, so a suite cannot leave it behind either.
    expect(existsSync(dataDirectory)).toBe(false);
    assertRealDataDirectoriesUnchanged(before);
  });

  it("keeps the real data directory out of the assembly entry even when the environment points at it", async () => {
    const before = observeRealDataDirectories();
    const manager = new RunManager({ allowedRoots: [], env: { DSH_MCP_DATA_DIR: DEFAULT_DATA_DIRECTORY } });

    expect(manager.container.dataDirectory).not.toBe(DEFAULT_DATA_DIRECTORY);

    await manager.close();
    assertRealDataDirectoriesUnchanged(before);
  });
});
