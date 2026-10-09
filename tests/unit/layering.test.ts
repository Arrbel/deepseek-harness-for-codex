// Unit tests for the pure policy layer: path predicates, workspace resolution, spec
// legality, input boundaries, and shared helpers.
//
// These modules are "no IO" by construction; the only IO here is the temporary directory the
// workspace cases need in order to exercise `realpath` and the directory check.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataLocationAliasProblems, isWithin, samePath } from "../../src/policy/paths.js";
import { parseExactPackageSpec, satisfiesNodeRange, SUPPORTED_NODE_RANGE, RuntimePackageError } from "../../src/policy/package-spec.js";
import { optionalSessionId, requireTask } from "../../src/policy/trusted-input.js";
import { resolveWorkspace } from "../../src/policy/workspace.js";
import { realpathOnDisk } from "../../src/service/supervisor.js";
import { workspaceKey, WORKSPACE_KEY_LENGTH } from "../../src/util/ids.js";
import { appendBounded, errorText, tail } from "../../src/util/errors.js";
import "../support/isolation.js";

const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-layering-"));
  scratchRoots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("policy/paths", () => {
  it("treats a root as within itself and rejects siblings and parents", () => {
    const root = resolve("/tmp/root");

    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(root, join(root, "child", "deep"))).toBe(true);
    expect(isWithin(root, resolve("/tmp/other"))).toBe(false);
    expect(isWithin(join(root, "child"), root)).toBe(false);
  });

  it("never mistakes a shared prefix for containment", () => {
    const root = resolve("/tmp/root");
    // `/tmp/root-other` shares characters with `/tmp/root` but is not inside it.
    expect(isWithin(root, resolve("/tmp/root-other"))).toBe(false);
  });

  it("compares paths with the platform's case sensitivity", () => {
    const upper = resolve("/tmp/WorkSpace");
    const lower = resolve("/tmp/workspace");

    expect(samePath(upper, upper)).toBe(true);
    // Explicit platforms (the helper takes one, so no `process.platform` override is needed):
    // Windows (NTFS) and macOS (default APFS) fold; Linux does not.
    expect(samePath(upper, lower, "win32")).toBe(true);
    expect(samePath(upper, lower, "darwin")).toBe(true);
    expect(samePath(upper, lower, "linux")).toBe(false);
    expect(samePath(upper, resolve("/tmp/other"), "win32")).toBe(false);
    // The default stays the host platform.
    expect(samePath(upper, lower)).toBe(process.platform === "win32" || process.platform === "darwin");
  });
});

describe("policy/workspace", () => {
  it("resolves an absolute directory with no allow-list", async () => {
    const root = scratch();
    const nested = join(root, "workspace");
    mkdirSync(nested);

    await expect(resolveWorkspace(nested)).resolves.toBe(nested);
  });

  it("rejects relative paths and missing paths", async () => {
    const root = scratch();

    await expect(resolveWorkspace(".")).rejects.toThrow("absolute path");
    await expect(resolveWorkspace(join(root, "missing"))).rejects.toThrow();
  });

  it("rejects a path that points at a file", async () => {
    const root = scratch();
    const file = join(root, "not-a-directory.txt");
    writeFileSync(file, "content", "utf8");

    await expect(resolveWorkspace(file)).rejects.toThrow("must point to a directory");
  });

  it("enforces the allow-list against the real path", async () => {
    const root = scratch();
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    const inside = join(allowed, "nested");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside);

    await expect(resolveWorkspace(inside, [allowed])).resolves.toBe(inside);
    await expect(resolveWorkspace(outside, [allowed])).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
  });

  it("resolves symlinks before deciding containment", async () => {
    const root = scratch();
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const link = join(allowed, "escape");

    try {
      symlinkSync(outside, link, "junction");
    } catch {
      // Creating links needs privileges on some Windows configurations; the allow-list case
      // above already covers containment without a link.
      return;
    }

    await expect(resolveWorkspace(link, [allowed])).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
  });

  it("agrees with the data-directory guard about the on-disk target (R5-1 consistency)", async () => {
    // The two guards must not disagree about what a path *is*. Both resolve through the OS
    // (`node:fs`'s realpath) before comparing, and both fail closed when resolution fails; they
    // differ only in the fallback — a workspace must exist, while a data directory legitimately
    // may not exist yet, which is why the data guard walks to the nearest existing ancestor.
    const root = scratch();
    const allowed = join(root, "allowed");
    const decoyHome = join(root, "home");
    mkdirSync(allowed);
    mkdirSync(decoyHome);
    const alias = join(root, "alias");
    try {
      symlinkSync(decoyHome, alias, "junction");
    } catch {
      return; // no link privileges on this host
    }

    // Workspace guard: the alias is judged (and returned) as its real target …
    await expect(resolveWorkspace(alias, [allowed])).rejects.toThrow("outside DSH_MCP_WORKSPACE_ROOTS");
    await expect(resolveWorkspace(alias, [decoyHome])).resolves.toBe(decoyHome);

    // … and the data-directory guard refuses the very same alias as "the user's home directory".
    expect(dataLocationAliasProblems({
      dataDirectory: alias,
      serviceHome: join(alias, "services", "a"),
      home: decoyHome,
      realpath: realpathOnDisk,
    }).join("\n")).toMatch(/must not be the user's home directory/u);
  });
});

describe("policy/package-spec", () => {
  it("accepts exact versions, including scoped names and prereleases", () => {
    expect(parseExactPackageSpec("@deepseek-ai/dsh@0.2.1-alpha.1")).toEqual({
      raw: "@deepseek-ai/dsh@0.2.1-alpha.1",
      name: "@deepseek-ai/dsh",
      version: "0.2.1-alpha.1",
    });
    expect(parseExactPackageSpec(" dsh@1.2.3 ").version).toBe("1.2.3");
    expect(parseExactPackageSpec("dsh@1.2.3+build.7").version).toBe("1.2.3+build.7");
  });

  it.each(["", "dsh", "@deepseek-ai/dsh@", "@deepseek-ai/dsh@latest", "^1.2.3", "dsh@~1.2.3", "dsh@>1.0.0", "dsh@1.x"])(
    "rejects %s with an actionable hint",
    (spec) => {
      const error = (() => {
        try {
          parseExactPackageSpec(spec);
          return null;
        } catch (thrown) {
          return thrown as RuntimePackageError;
        }
      })();

      expect(error?.kind).toBe("invalid-spec");
      expect(error?.message).toContain("请写 name@x.y.z");
      expect(error?.hint).not.toBeNull();
    },
  );

  it("checks the declared engine range", () => {
    expect(SUPPORTED_NODE_RANGE).toBe("^22.19.0 || >=24.0.0");
    for (const [version, expected] of [["22.19.0", true], ["23.0.0", false], ["24.0.0", true], ["21.7.3", false]] as const) {
      expect(satisfiesNodeRange(version, SUPPORTED_NODE_RANGE)).toBe(expected);
    }
    expect(satisfiesNodeRange("not-a-version")).toBe(false);
  });
});

describe("policy/trusted-input", () => {
  it("trims tasks and rejects empty or oversized ones", () => {
    expect(requireTask("  implement  ")).toBe("implement");
    expect(() => requireTask("   ")).toThrow("task must not be empty.");
    expect(() => requireTask("x".repeat(100_001))).toThrow("task exceeds the 100,000 character limit.");
  });

  it("treats blank session ids as absent", () => {
    expect(optionalSessionId(undefined)).toBeUndefined();
    expect(optionalSessionId("   ")).toBeUndefined();
    expect(optionalSessionId(" session-1 ")).toBe("session-1");
  });
});

describe("util", () => {
  it("derives the workspace key at the documented length", () => {
    expect(WORKSPACE_KEY_LENGTH).toBe(24);
    expect(workspaceKey("a".repeat(64))).toHaveLength(24);
  });

  it("keeps bounded tails and appends lines without growing", () => {
    expect(tail("abcdef", 3)).toBe("def");
    expect(tail("abc", 3)).toBe("abc");
    expect(appendBounded("first\n", "second", 100)).toBe("first\nsecond\n");
    expect(appendBounded(null, "second", 6)).toBe("econd\n");
  });

  it("extracts messages from unknown throwables", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("boom")).toBe("boom");
  });
});
