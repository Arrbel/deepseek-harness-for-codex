// Unit coverage for the ADR-0002 acquisition half: exact-version specs, idempotent reuse,
// the install lock, atomic promotion, and the npm failure classification.
//
// The npm side is a real child process (`tests/fixtures/fake-npm-cli.mjs`) invoked exactly
// like the real CLI, so argv shape, exit codes, and stderr parsing are exercised for real
// while the registry stays out of the loop. `FAKE_NPM_COUNTER` records every invocation:
// the idempotency assertion is "npm was never spawned", not "a function was called".

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RuntimePackageError,
  SUPPORTED_NODE_RANGE,
  classifyNpmFailure,
  ensureRuntimePackage,
  inspectInstalledRuntime,
  parseExactPackageSpec,
  planVersionPrune,
  pruneEnabledByEnvironment,
  pruneRuntimeVersions,
  resolveRuntimeLayout,
  satisfiesNodeRange,
  type PruneVersionsResult,
  type VersionPruneObservation,
} from "../../src/service/runtime-package.js";
import { pidFilePath, serializePidFile } from "../../src/policy/orphans.js";
import "../support/isolation.js";

const fakeNpm = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-npm-cli.mjs");
const SPEC = "@deepseek-ai/dsh@0.2.1-alpha.1";
const INSTALL_TIMEOUT_MS = 15_000;

interface NpmCall {
  argv: string[];
  prefix: string | null;
  spec: string;
}

describe("runtime package acquisition", () => {
  let root: string;
  let dataDir: string;
  let counterPath: string;

  function calls(): NpmCall[] {
    if (!existsSync(counterPath)) return [];
    return readFileSync(counterPath, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as NpmCall);
  }

  function ensure(spec = SPEC): ReturnType<typeof ensureRuntimePackage> {
    return ensureRuntimePackage({ dataDir, spec, npmCli: fakeNpm, timeoutMs: INSTALL_TIMEOUT_MS });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-runtime-package-"));
    dataDir = join(root, "data");
    counterPath = join(root, "npm-calls.log");
    process.env.FAKE_NPM_COUNTER = counterPath;
    delete process.env.FAKE_NPM_MODE;
    delete process.env.FAKE_NPM_DELAY_MS;
  });

  afterEach(async () => {
    delete process.env.FAKE_NPM_COUNTER;
    delete process.env.FAKE_NPM_MODE;
    delete process.env.FAKE_NPM_DELAY_MS;
    await rm(root, { recursive: true, force: true });
  });

  it("installs once into a temporary prefix and promotes the resolved bin", async () => {
    const ensured = await ensure();

    expect(ensured.installedNow).toBe(true);
    expect(ensured.version).toBe("0.2.1-alpha.1");
    expect(ensured.root).toBe(join(dataDir, "versions", "0.2.1-alpha.1"));
    expect(ensured.binPath).toBe(join(ensured.root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));
    expect(existsSync(ensured.binPath)).toBe(true);

    const recorded = calls();
    expect(recorded).toHaveLength(1);
    const call = recorded[0]!;
    expect(call.prefix).not.toBeNull();
    expect(call.prefix!.startsWith(join(dataDir, "versions", ".tmp-"))).toBe(true);
    expect(call.argv).toEqual([
      fakeNpm,
      "install",
      "--prefix",
      call.prefix,
      "--no-save",
      "--no-audit",
      "--no-fund",
      SPEC,
    ]);
    // The temporary prefix is gone after the atomic rename.
    expect(existsSync(call.prefix!)).toBe(false);
    expect(existsSync(join(dataDir, "versions", ".install.lock"))).toBe(false);
  });

  it("reuses an installed tree without invoking npm at all", async () => {
    const first = await ensure();
    expect(first.installedNow).toBe(true);

    const second = await ensure();
    expect(second.installedNow).toBe(false);
    expect(second.binPath).toBe(first.binPath);
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ["a bare package name", "@deepseek-ai/dsh"],
    ["a caret range", "@deepseek-ai/dsh@^1.2.3"],
    ["a tilde range", "@deepseek-ai/dsh@~1.2.3"],
    ["an x-range", "@deepseek-ai/dsh@1.x"],
    ["a comparator", "@deepseek-ai/dsh@>1.0.0"],
    ["a wildcard", "@deepseek-ai/dsh@*"],
    ["the latest dist-tag", "@deepseek-ai/dsh@latest"],
    ["the next dist-tag", "dsh@next"],
    ["an empty spec", ""],
  ] as Array<[string, string]>)("rejects %s instead of resolving it", async (_label, spec) => {
    const error = await ensure(spec).then(() => null, (thrown: unknown) => thrown as RuntimePackageError);

    expect(error).toBeInstanceOf(RuntimePackageError);
    expect(error!.kind).toBe("invalid-spec");
    expect(error!.message).toMatch(/name@x\.y\.z/u);
    expect(calls()).toHaveLength(0);
    expect(existsSync(join(dataDir, "versions"))).toBe(false);
  });

  it("accepts the exact pinned spec", () => {
    expect(parseExactPackageSpec(SPEC)).toEqual({
      raw: SPEC,
      name: "@deepseek-ai/dsh",
      version: "0.2.1-alpha.1",
    });
  });

  it("reinstalls when the version directory holds a different version", async () => {
    const layout = resolveRuntimeLayout(dataDir, SPEC);
    mkdirSync(join(layout.packageDir, "lib"), { recursive: true });
    writeFileSync(
      join(layout.packageDir, "package.json"),
      JSON.stringify({ name: layout.name, version: "9.9.9", bin: { dsh: "lib/bin.js" } }),
      "utf8",
    );
    writeFileSync(join(layout.packageDir, "lib", "bin.js"), "", "utf8");

    const ensured = await ensure();

    expect(ensured.installedNow).toBe(true);
    expect(calls()).toHaveLength(1);
    const inspected = inspectInstalledRuntime(layout);
    expect(inspected.ok).toBe(true);
    if (inspected.ok) expect(inspected.value.version).toBe("0.2.1-alpha.1");
  });

  it.each([
    ["no bin field", "no-bin"],
    ["a declared bin file that is missing", "missing-bin-file"],
    ["a mismatched package.json version", "wrong-version"],
  ] as Array<[string, string]>)("fails when npm succeeds but the tree is unusable (%s)", async (_label, mode) => {
    process.env.FAKE_NPM_MODE = mode;

    const error = await ensure().then(() => null, (thrown: unknown) => thrown as RuntimePackageError);

    expect(error).toBeInstanceOf(RuntimePackageError);
    expect(["bin-missing", "version-mismatch"]).toContain(error!.kind);
    expect(calls()).toHaveLength(1);
  });

  it("installs exactly once when two callers race", async () => {
    process.env.FAKE_NPM_DELAY_MS = "400";

    const [left, right] = await Promise.all([ensure(), ensure()]);

    expect([left.installedNow, right.installedNow].filter(Boolean)).toHaveLength(1);
    expect(calls()).toHaveLength(1);
    expect(left.binPath).toBe(right.binPath);
  });

  it("breaks a stale lock left by a dead process", async () => {
    const versions = join(dataDir, "versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(
      join(versions, ".install.lock"),
      JSON.stringify({ pid: 0x7fff_fffe, startedAt: 0, host: "some-other-host" }),
      "utf8",
    );

    const ensured = await ensure();

    expect(ensured.installedNow).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ["etarget", "version-not-found", 1],
    ["e404", "version-not-found", 1],
    ["enotcached", "offline-or-cache-missing", 1],
    ["network", "network", 2],
    ["unknown-failure", "network", 2],
  ] as Array<[string, string, number]>)("classifies npm failure %s as %s (npm calls: %i)", async (mode, kind, expectedCalls) => {
    process.env.FAKE_NPM_MODE = mode;

    const error = await ensure().then(() => null, (thrown: unknown) => thrown as RuntimePackageError);

    expect(error).toBeInstanceOf(RuntimePackageError);
    expect(error!.kind).toBe(kind);
    expect(error!.stderrTail).not.toBe("");
    expect(error!.hint).not.toBeNull();
    expect(calls()).toHaveLength(expectedCalls);
    // A failed install never promotes anything.
    expect(existsSync(join(dataDir, "versions", "0.2.1-alpha.1"))).toBe(false);
    expect(existsSync(join(dataDir, "versions", ".install.lock"))).toBe(false);
  });

  it("reports an unclassified failure as unknown when npm cannot even be spawned", async () => {
    const error = await ensureRuntimePackage({
      dataDir,
      spec: SPEC,
      npmCli: fakeNpm,
      timeoutMs: INSTALL_TIMEOUT_MS,
      spawnImpl: () => {
        throw new Error("spawn exploded");
      },
    }).then(() => null, (thrown: unknown) => thrown as RuntimePackageError);

    expect(error?.kind).toBe("unknown");
    expect(error?.message).toContain("spawn exploded");
    expect(calls()).toHaveLength(0);
  });

  it("resets the install budget on every line of npm progress", async () => {
    // Ten progress lines 300 ms apart take ~3 s: with a 1 s budget this only succeeds if
    // output resets the silence window instead of counting as one wall-clock deadline.
    process.env.FAKE_NPM_MODE = "chatty";

    const ensured = await ensureRuntimePackage({ dataDir, spec: SPEC, npmCli: fakeNpm, timeoutMs: 1_000 });

    expect(ensured.installedNow).toBe(true);
    expect(calls()).toHaveLength(1);
  }, 20_000);

  it("fails with install-timeout when npm goes silent past the budget", async () => {
    process.env.FAKE_NPM_DELAY_MS = "30000";
    const started = Date.now();

    const error = await ensureRuntimePackage({ dataDir, spec: SPEC, npmCli: fakeNpm, timeoutMs: 800 })
      .then(() => null, (thrown: unknown) => thrown as RuntimePackageError);

    expect(error?.kind).toBe("install-timeout");
    expect(error?.hint).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(join(dataDir, "versions", ".install.lock"))).toBe(false);
  }, 30_000);
});

describe("classifyNpmFailure", () => {
  it.each([
    ["npm error code ETARGET\nnpm error notarget No matching version found", "version-not-found"],
    ["npm error code E404\nnpm error 404 No match found for version", "version-not-found"],
    ["npm error code ENOTCACHED\nnpm error cache mode is 'only-if-cached'", "offline-or-cache-missing"],
    ["npm error code ECONNRESET\nnpm error socket hang up", "network"],
    ["npm error code E500\nnpm error something else", "network"],
  ] as Array<[string, string]>)("maps %j", (text, kind) => {
    expect(classifyNpmFailure(text)).toBe(kind);
  });
});

describe("engine range", () => {
  it.each([
    ["22.19.0", true],
    ["22.22.2", true],
    ["23.0.0", false],
    ["24.0.0", true],
    ["25.4.1", true],
    ["22.18.9", false],
    ["21.7.3", false],
  ] as Array<[string, boolean]>)("checks %s", (version, supported) => {
    expect(satisfiesNodeRange(version, SUPPORTED_NODE_RANGE)).toBe(supported);
  });
});

// --- P0-4: version directory prune ---------------------------------------------------------

const PIN_VERSION = "0.2.1-alpha.1";
const OLD_VERSION = "0.2.0-rc.2";
const HOUR_MS = 60 * 60 * 1_000;

/** Creates `<dataDir>/versions/<version>/` as a complete, verified install. */
function writeCompleteInstall(dataDir: string, version: string): string {
  const layout = resolveRuntimeLayout(dataDir, `@deepseek-ai/dsh@${version}`);
  mkdirSync(join(layout.packageDir, "lib"), { recursive: true });
  writeFileSync(
    join(layout.packageDir, "package.json"),
    JSON.stringify({ name: layout.name, version, bin: { dsh: "lib/bin.js" } }),
    "utf8",
  );
  writeFileSync(join(layout.packageDir, "lib", "bin.js"), "", "utf8");
  return layout.root;
}

/** Writes the pidfile `supervisor.writePidFile` writes for one running service. */
function writeServicePidFile(input: {
  dataDir: string;
  key: string;
  version: string;
  pid: number;
  port?: number | null;
}): { home: string; binPath: string } {
  const home = join(input.dataDir, "services", input.key);
  const layout = resolveRuntimeLayout(input.dataDir, `@deepseek-ai/dsh@${input.version}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    pidFilePath(home),
    serializePidFile({
      pid: input.pid,
      port: input.port ?? null,
      version: input.version,
      binPath: layout.binPath,
      startedAt: new Date().toISOString(),
      dataDirectory: input.dataDir,
      workspace: "C:/workspace/example",
      serviceHome: home,
    }),
    "utf8",
  );
  return { home, binPath: layout.binPath };
}

/** Writes the lock record `ensureRuntimePackage` writes while it holds the install lock. */
function writeInstallLock(dataDir: string, pid = process.pid): void {
  const versions = join(dataDir, "versions");
  mkdirSync(versions, { recursive: true });
  writeFileSync(
    join(versions, ".install.lock"),
    JSON.stringify({ pid, startedAt: Date.now(), host: hostname() }),
    "utf8",
  );
}

function observation(overrides: Partial<VersionPruneObservation> = {}): VersionPruneObservation {
  return {
    pinVersion: PIN_VERSION,
    now: 1_000_000_000,
    stagingMaxAgeMs: 24 * HOUR_MS,
    versionDirs: [],
    stagingDirs: [],
    usage: [],
    blockers: [],
    ...overrides,
  };
}

describe("planVersionPrune (pure decisions)", () => {
  it("deletes a complete non-pin version and keeps the current pin", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: PIN_VERSION, path: `/data/versions/${PIN_VERSION}`, versionShaped: true, complete: true },
        { name: OLD_VERSION, path: `/data/versions/${OLD_VERSION}`, versionShaped: true, complete: true },
      ],
    }));

    expect(plan.removeVersions.map((entry) => entry.name)).toEqual([OLD_VERSION]);
    expect(plan.skipped).toEqual([{ path: `/data/versions/${PIN_VERSION}`, reason: "current-pin" }]);
  });

  it("never deletes the current pin, even when it is the only version and looks idle", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: PIN_VERSION, path: `/data/versions/${PIN_VERSION}`, versionShaped: true, complete: false },
      ],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("current-pin");
  });

  it("keeps a version whose pidfile names a live service", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: OLD_VERSION, path: `/data/versions/${OLD_VERSION}`, versionShaped: true, complete: true },
      ],
      usage: [{ version: OLD_VERSION, path: "/data/services/key/dsh.pid", pid: 4242, state: "alive" }],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("in-use:pid 4242");
  });

  it("fails closed when ownership of a live pid cannot be verified", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: OLD_VERSION, path: `/data/versions/${OLD_VERSION}`, versionShaped: true, complete: true },
      ],
      usage: [{ version: OLD_VERSION, path: "/data/services/key/dsh.pid", pid: 4242, state: "unverified" }],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("unverified-owner");
  });

  it("fails every version deletion closed when any evidence is unreadable", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: OLD_VERSION, path: `/data/versions/${OLD_VERSION}`, versionShaped: true, complete: true },
      ],
      stagingDirs: [{ path: "/data/versions/.tmp-old", mtimeMs: 0 }],
      blockers: [{ path: "/data/services/key/dsh.pid", reason: "pidfile-unparseable" }],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped).toContainEqual({ path: `/data/versions/${OLD_VERSION}`, reason: "evidence-unreadable" });
    expect(plan.skipped).toContainEqual({ path: "/data/services/key/dsh.pid", reason: "pidfile-unparseable" });
    // Staging directories are unrelated to service usage, so they are still reclaimed.
    expect(plan.removeStaging).toEqual([{ path: "/data/versions/.tmp-old", reason: "expired-staging" }]);
  });

  it("keeps a directory that is not an exact version of the pinned package", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: "my-manual-copy", path: "/data/versions/my-manual-copy", versionShaped: false, complete: false },
      ],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("not-a-version-directory");
  });

  it("keeps a version-shaped directory without a verified complete install", () => {
    const plan = planVersionPrune(observation({
      versionDirs: [
        { name: OLD_VERSION, path: `/data/versions/${OLD_VERSION}`, versionShaped: true, complete: false },
      ],
    }));

    expect(plan.removeVersions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("unverified-install");
  });

  it("keeps a staging directory that is younger than the threshold", () => {
    const now = 1_000_000_000;
    const plan = planVersionPrune(observation({
      now,
      stagingDirs: [
        { path: "/data/versions/.tmp-fresh", mtimeMs: now - HOUR_MS },
        { path: "/data/versions/.tmp-stale", mtimeMs: now - 25 * HOUR_MS },
      ],
    }));

    expect(plan.removeStaging).toEqual([{ path: "/data/versions/.tmp-stale", reason: "expired-staging" }]);
    expect(plan.skipped).toEqual([{ path: "/data/versions/.tmp-fresh", reason: "recent-staging" }]);
  });
});

describe("pruneRuntimeVersions (IO)", () => {
  let root: string;
  let dataDir: string;
  let versionsDir: string;
  let oldRoot: string;
  let pinRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-prune-"));
    dataDir = join(root, "data");
    versionsDir = join(dataDir, "versions");
    oldRoot = writeCompleteInstall(dataDir, OLD_VERSION);
    pinRoot = writeCompleteInstall(dataDir, PIN_VERSION);
    writeInstallLock(dataDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function prune(overrides: Partial<Parameters<typeof pruneRuntimeVersions>[0]> = {}): Promise<PruneVersionsResult> {
    return pruneRuntimeVersions({
      dataDir,
      spec: "@deepseek-ai/dsh@0.2.1-alpha.1",
      isProcessAliveImpl: () => false,
      processIdentityImpl: () => null,
      ...overrides,
    });
  }

  it("deletes the unused version and keeps the pin while holding the lock", async () => {
    const result = await prune();

    expect(result.ran).toBe(true);
    expect(result.removed).toEqual([{ path: oldRoot, kind: "version", bytes: expect.any(Number) }]);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    expect(result.skipped).toEqual([{ path: pinRoot, reason: "current-pin" }]);
    expect(existsSync(oldRoot)).toBe(false);
    expect(existsSync(pinRoot)).toBe(true);
    // The lock is the caller's, not the prune's: it must survive.
    expect(existsSync(join(versionsDir, ".install.lock"))).toBe(true);
  });

  it("skips the whole run without touching anything when the lock is not ours", async () => {
    writeInstallLock(dataDir, 0x7fff_fffe);

    const result = await prune();

    expect(result).toMatchObject({ ran: false, reason: "install-lock-not-held", removed: [], reclaimedBytes: 0 });
    expect(existsSync(oldRoot)).toBe(true);
    expect(existsSync(pinRoot)).toBe(true);
  });

  it("keeps a version whose recorded service is provably alive", async () => {
    const { binPath } = writeServicePidFile({
      dataDir,
      key: "workspace-key",
      version: OLD_VERSION,
      pid: process.pid,
      port: 51234,
    });

    const result = await prune({
      isProcessAliveImpl: (pid) => pid === process.pid,
      processIdentityImpl: () => `"${process.execPath}" "${binPath}" web --no-open --port 51234`,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ path: oldRoot, reason: `in-use:pid ${String(process.pid)}` });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("keeps a version whose recorded process cannot be identified (fail-closed)", async () => {
    writeServicePidFile({ dataDir, key: "workspace-key", version: OLD_VERSION, pid: process.pid });

    const result = await prune({
      isProcessAliveImpl: () => true,
      processIdentityImpl: () => null,
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ path: oldRoot, reason: "unverified-owner" });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("deletes an old version once its recorded process is gone", async () => {
    writeServicePidFile({ dataDir, key: "workspace-key", version: OLD_VERSION, pid: 0x7fff_fffe });

    const result = await prune({ isProcessAliveImpl: () => false });

    expect(result.removed.map((entry) => entry.path)).toEqual([oldRoot]);
    expect(existsSync(oldRoot)).toBe(false);
  });

  it("fails closed on a malformed pidfile instead of guessing", async () => {
    const home = join(dataDir, "services", "broken");
    mkdirSync(home, { recursive: true });
    writeFileSync(pidFilePath(home), "{ not json", "utf8");

    const result = await prune();

    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ path: pidFilePath(home), reason: "pidfile-unparseable" });
    expect(result.skipped).toContainEqual({ path: oldRoot, reason: "evidence-unreadable" });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("fails closed when the services directory cannot be read", async () => {
    // A *file* where the services directory belongs makes the evidence source unreadable.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "services"), "not a directory", "utf8");

    const result = await prune();

    expect(result).toMatchObject({ ran: false, reason: "services-unreadable", removed: [] });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("keeps a version-shaped directory that holds no complete install", async () => {
    const incomplete = join(versionsDir, "0.1.0-rc.1");
    mkdirSync(incomplete, { recursive: true });

    const result = await prune();

    expect(result.removed.map((entry) => entry.path)).toEqual([oldRoot]);
    expect(result.skipped).toContainEqual({ path: incomplete, reason: "unverified-install" });
    expect(existsSync(incomplete)).toBe(true);
  });

  it("deletes only the staging directory that passed the age threshold", async () => {
    const expired = join(versionsDir, ".tmp-aaaaaaaa");
    const recent = join(versionsDir, ".tmp-bbbbbbbb");
    mkdirSync(expired, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const old = new Date(Date.now() - 48 * HOUR_MS);
    utimesSync(expired, old, old);

    const result = await prune({ stagingMaxAgeMs: 24 * HOUR_MS });

    expect(result.removed.map((entry) => entry.path)).toContain(expired);
    expect(result.removed.map((entry) => entry.path)).not.toContain(recent);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(result.skipped).toContainEqual({ path: recent, reason: "recent-staging" });
  });

  it("reports a locked tree as skipped instead of throwing (Windows EBUSY/EPERM)", async () => {
    const busy = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

    const result = await prune({
      removeImpl: async (path) => {
        if (path === oldRoot) throw busy;
      },
    });

    expect(result.ran).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.skipped).toContainEqual({ path: oldRoot, reason: "remove-failed:EPERM" });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("skips the whole run when disabled", async () => {
    const result = await prune({ enabled: false });

    expect(result).toMatchObject({ ran: false, reason: "disabled", removed: [] });
    expect(existsSync(oldRoot)).toBe(true);
  });

  it("is enabled by default and only disabled by an explicit opt-out", () => {
    expect(pruneEnabledByEnvironment({})).toBe(true);
    expect(pruneEnabledByEnvironment({ DSH_MCP_PRUNE_VERSIONS: "" })).toBe(true);
    expect(pruneEnabledByEnvironment({ DSH_MCP_PRUNE_VERSIONS: "on" })).toBe(true);
    expect(pruneEnabledByEnvironment({ DSH_MCP_PRUNE_VERSIONS: "OFF" })).toBe(false);
    expect(pruneEnabledByEnvironment({ DSH_MCP_PRUNE_VERSIONS: " 0 " })).toBe(false);
  });
});

describe("ensureRuntimePackage → prune wiring", () => {
  let root: string;
  let dataDir: string;
  let counterPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-prune-wiring-"));
    dataDir = join(root, "data");
    counterPath = join(root, "npm-calls.log");
    process.env.FAKE_NPM_COUNTER = counterPath;
    delete process.env.FAKE_NPM_MODE;
    delete process.env.DSH_MCP_PRUNE_VERSIONS;
  });

  afterEach(async () => {
    delete process.env.FAKE_NPM_COUNTER;
    delete process.env.FAKE_NPM_MODE;
    delete process.env.DSH_MCP_PRUNE_VERSIONS;
    await rm(root, { recursive: true, force: true });
  });

  function ensure(): ReturnType<typeof ensureRuntimePackage> {
    return ensureRuntimePackage({ dataDir, spec: SPEC, npmCli: fakeNpm, timeoutMs: INSTALL_TIMEOUT_MS });
  }

  it("prunes unused versions after a successful install and reports it in the result", async () => {
    const staleRoot = writeCompleteInstall(dataDir, OLD_VERSION);
    writeServicePidFile({ dataDir, key: "workspace-key", version: OLD_VERSION, pid: 0x7fff_fffe });
    const progress: string[] = [];

    const ensured = await ensureRuntimePackage({
      dataDir,
      spec: SPEC,
      npmCli: fakeNpm,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onProgress: (line) => progress.push(line),
      prune: { isProcessAliveImpl: () => false },
    });

    expect(ensured.installedNow).toBe(true);
    expect(ensured.prune?.ran).toBe(true);
    expect(ensured.prune?.removed.map((entry) => entry.path)).toEqual([staleRoot]);
    expect(existsSync(staleRoot)).toBe(false);
    expect(existsSync(ensured.root)).toBe(true);
    expect(progress.some((line) => line.includes("prune: reclaimed"))).toBe(true);
    expect(existsSync(join(dataDir, "versions", ".install.lock"))).toBe(false);
  });

  it("does not prune when only reusing an installed runtime", async () => {
    await ensure();
    const second = await ensure();

    expect(second.installedNow).toBe(false);
    expect(second.prune).toBeUndefined();
  });

  it("honours DSH_MCP_PRUNE_VERSIONS=off during a real install", async () => {
    const staleRoot = writeCompleteInstall(dataDir, OLD_VERSION);
    process.env.DSH_MCP_PRUNE_VERSIONS = "off";

    const ensured = await ensureRuntimePackage({ dataDir, spec: SPEC, npmCli: fakeNpm, timeoutMs: INSTALL_TIMEOUT_MS });

    expect(ensured.prune).toMatchObject({ ran: false, reason: "disabled" });
    expect(existsSync(staleRoot)).toBe(true);
  });
});

describe("pruneRuntimeVersions against a really running service", () => {
  let root: string;
  let dataDir: string;
  let child: ChildProcess | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dsh-prune-live-"));
    dataDir = join(root, "data");
    child = null;
  });

  afterEach(async () => {
    child?.kill();
    child = null;
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the version of a live recorded service, then reclaims it once the process exits", async () => {
    // The recorded service is a real child process whose command line carries the recorded
    // `binPath` plus `--port`, i.e. exactly what the production identity probe looks for.
    const oldLayout = resolveRuntimeLayout(dataDir, `@deepseek-ai/dsh@${OLD_VERSION}`);
    mkdirSync(join(oldLayout.packageDir, "lib"), { recursive: true });
    writeFileSync(
      join(oldLayout.packageDir, "package.json"),
      JSON.stringify({ name: oldLayout.name, version: OLD_VERSION, bin: { dsh: "lib/bin.js" } }),
      "utf8",
    );
    writeFileSync(join(oldLayout.packageDir, "lib", "bin.js"), "setTimeout(() => {}, 60_000);\n", "utf8");
    writeCompleteInstall(dataDir, PIN_VERSION);
    writeInstallLock(dataDir);
    child = spawn(process.execPath, [oldLayout.binPath, "web", "--no-open", "--port", "55555"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const running = child;
    writeServicePidFile({ dataDir, key: "workspace-key", version: OLD_VERSION, pid: running.pid ?? 0, port: 55555 });

    // Production seams: the real liveness probe and the real OS identity probe.
    const whileAlive = await pruneRuntimeVersions({ dataDir, spec: SPEC });

    const decision = whileAlive.skipped.find((entry) => entry.path === oldLayout.root);
    expect(whileAlive.removed).toEqual([]);
    expect(decision?.reason.startsWith("in-use:pid ") || decision?.reason === "unverified-owner").toBe(true);
    expect(existsSync(oldLayout.root)).toBe(true);

    const exited = new Promise<void>((resolveExit) => running.once("exit", () => resolveExit()));
    running.kill();
    await exited;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    const afterExit = await pruneRuntimeVersions({ dataDir, spec: SPEC });

    expect(afterExit.removed.map((entry) => entry.path)).toEqual([oldLayout.root]);
    expect(existsSync(oldLayout.root)).toBe(false);
  }, 30_000);
});
