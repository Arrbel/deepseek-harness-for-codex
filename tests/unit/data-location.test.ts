// P0-5: the data directory / `DSH_HOME` safety rules, as a pure decision table.
//
// The accident behind them: a script pointed `DSH_HOME` at `C:\Users\<user>`, and the Harness
// populated the user's home with `profiles/`, `storages/`, and `.credentials.yaml`.
// Every rule is checked *before* any directory is created (see the supervisor tests).
//
// R5-1 added the second half: the rules above compare *spellings*, so a junction/symlink pointed at
// the home directory used to be accepted (reproduced by two independent verifiers). The
// `alias-aware guard` suite below creates real links — always inside a temporary directory, with a
// decoy "home" — and asserts the refusal, the nearest-existing-ancestor walk, and that removing the
// link restores the accepted verdict.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dataLocationAliasProblems, dataLocationProblems } from "../../src/policy/paths.js";
import { realpathOnDisk } from "../../src/service/supervisor.js";
import "../support/isolation.js";

const home = join(resolve("C:\\Users\\tester"));
const dataDirectory = join(home, ".deep-seek-harness-mcp");
const serviceHome = join(dataDirectory, "services", "abc");

describe("data location safety (P0-5)", () => {
  it("accepts a dedicated data directory with the service home inside it", () => {
    expect(dataLocationProblems({ dataDirectory, serviceHome, home })).toEqual([]);
  });

  it("folds case where the filesystem does, and only there", () => {
    // The same three directories, spelled in capitals. On a case-insensitive filesystem (Windows
    // NTFS, **default macOS APFS**) that is one location, so the legitimate setup must stay
    // accepted; on Linux it is a different, equally legitimate location. `platform` is explicit so
    // the assertion no longer depends on the host that runs the suite — the previous shape only
    // proved "a differently spelled path that is still structurally inside is accepted", which is
    // true everywhere and therefore proved nothing (task-35 defect B; see
    // `tests/platform/path-platform.test.ts` for the pre-fix behaviour this replaced).
    const shouted = { dataDirectory: dataDirectory.toUpperCase(), serviceHome: serviceHome.toUpperCase(), home };
    for (const platform of ["win32", "darwin"] as const) {
      expect(dataLocationProblems({ ...shouted, platform }), platform).toEqual([]);
    }
    expect(dataLocationProblems({ ...shouted, platform: "linux" })).toEqual([]);

    // Containment follows the same rule: on a folding platform `/data/root/services/a` is inside
    // `/data/ROOT`. (Only the folding platform is asserted: `isWithin` compares through
    // `node:path`'s **host** implementation, and `path.win32.relative` is case-insensitive on its
    // own, so a "linux does not fold" containment assertion would silently pass on a Windows host
    // and only mean something on POSIX CI. The linux half is proven by the equality rules below,
    // which use no `relative` at all. See `tests/platform/path-platform.test.ts` for the same
    // caveat about the separator half.)
    const caseOnlyContainment = { dataDirectory: "/data/root", serviceHome: "/DATA/ROOT/services/a", home: "/users/bob" };
    expect(dataLocationProblems({ ...caseOnlyContainment, platform: "darwin" })).toEqual([]);
  });

  it("rejects a case-variant of the user's home on macOS as well as on Windows (defect B)", () => {
    // The bypass this pins: `DSH_MCP_DATA_DIR=/Users/Bob` with home `/Users/bob`. On default APFS
    // those are the *same* directory, so the pre-fix guard (which folded only on win32) let the
    // Harness populate the user's real home with `profiles/`, `storages/` and `.credentials.yaml`.
    const variant = { dataDirectory: "/Users/Bob", serviceHome: "/Users/Bob/services/a", home: "/Users/bob" };
    for (const platform of ["win32", "darwin"] as const) {
      expect(dataLocationProblems({ ...variant, platform }).join("\n"), platform)
        .toMatch(/must not be the user's home directory/u);
    }
    // Linux is genuinely case-sensitive: two different directories, nothing to refuse.
    expect(dataLocationProblems({ ...variant, platform: "linux" })).toEqual([]);

    // Rule 3's other half — the *parent* of home — must fold the same way.
    const parentVariant = { dataDirectory: "/Users", serviceHome: "/Users/services/a", home: "/users/bob" };
    expect(dataLocationProblems({ ...parentVariant, platform: "darwin" }).join("\n"))
      .toMatch(/must not be the parent of the user's home directory/u);
    expect(dataLocationProblems({ ...parentVariant, platform: "win32" }).join("\n"))
      .toMatch(/must not be the parent of the user's home directory/u);
    expect(dataLocationProblems({ ...parentVariant, platform: "linux" })).toEqual([]);
  });

  it("rejects the user's home directory as the data directory", () => {
    const problems = dataLocationProblems({ dataDirectory: home, serviceHome: join(home, "services", "a"), home });
    expect(problems.join("\n")).toMatch(/must not be the user's home directory/u);
    expect(problems.join("\n")).toContain("DSH_MCP_DATA_DIR");
  });

  it("rejects the direct parent of the user's home directory", () => {
    const parent = resolve(join(home, ".."));
    const problems = dataLocationProblems({
      dataDirectory: parent,
      serviceHome: join(parent, "services", "a"),
      home,
    });
    expect(problems.join("\n")).toMatch(/must not be the parent of the user's home directory/u);
  });

  it("rejects a filesystem root", () => {
    const root = parse(resolve(home)).root;
    const problems = dataLocationProblems({ dataDirectory: root, serviceHome: join(root, "services", "a"), home });
    expect(problems.join("\n")).toMatch(/must not be a filesystem root/u);
  });

  it("rejects a relative data directory", () => {
    const problems = dataLocationProblems({ dataDirectory: ".\\data", serviceHome, home });
    expect(problems.join("\n")).toMatch(/must be an absolute path/u);
  });

  it("rejects a DSH_HOME that is the user's home directory", () => {
    const problems = dataLocationProblems({ dataDirectory, serviceHome: home, home });
    expect(problems.join("\n")).toMatch(/DSH_HOME must not be the user's home directory/u);
  });

  it("rejects a DSH_HOME outside the data directory or equal to it", () => {
    const outside = dataLocationProblems({
      dataDirectory,
      serviceHome: join(home, "elsewhere"),
      home,
    });
    expect(outside.join("\n")).toMatch(/DSH_HOME must live underneath/u);

    const equal = dataLocationProblems({ dataDirectory, serviceHome: dataDirectory, home });
    expect(equal.join("\n")).toMatch(/DSH_HOME must live underneath/u);
  });

  it("rejects a DSH_HOME that is a filesystem root", () => {
    const root = parse(resolve(home)).root;
    const problems = dataLocationProblems({ dataDirectory, serviceHome: root, home });
    expect(problems.join("\n")).toMatch(/DSH_HOME must not be a filesystem root/u);
  });

  it("accepts a real temporary data directory (the shape every test uses)", () => {
    // Uses this machine's real home so the rule is exercised against the actual value the
    // supervisor compares with, not a synthetic one.
    const realData = join(homedir(), ".deep-seek-harness-mcp");
    expect(dataLocationProblems({
      dataDirectory: realData,
      serviceHome: join(realData, "services", "k"),
      home: homedir(),
    })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// R5-1: the alias-aware guard, exercised against real junctions/symlinks. Everything here lives
// inside a temporary directory; the "home" is a decoy directory, never the real one.
// ---------------------------------------------------------------------------------------------

const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-alias-"));
  scratchRoots.push(directory);
  return directory;
}

/** Removes the link itself, never what it points at (works for junctions and POSIX symlinks). */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

/** Creates a directory link; `false` when this host refuses (some Windows configurations). */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "junction");
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("alias-aware guard: real junctions and symlinks (R5-1)", () => {
  it("is the entry point the supervisor actually calls (structural guard)", () => {
    // The unit tests above prove the *mechanism*; this pins the *wiring*, so a future refactor
    // cannot quietly go back to the spelling-only guard in production.
    const source = readFileSync(fileURLToPath(new URL("../../src/service/supervisor.ts", import.meta.url)), "utf8");

    expect(source).toContain("dataLocationAliasProblems({");
    expect(/\bdataLocationProblems\(\{/u.test(source)).toBe(false);
  });

  it("refuses a data directory that reaches the home directory through a link", () => {
    const root = scratch();
    const decoyHome = join(root, "home");
    const alias = join(root, "alias");
    mkdirSync(decoyHome);
    if (!link(decoyHome, alias)) return; // no link privileges: the fake-resolver cases cover this

    const input = { dataDirectory: alias, serviceHome: join(alias, "services", "a"), home: decoyHome };
    // The spelling layer is the defect: it accepts, because the two strings are different.
    expect(dataLocationProblems(input)).toEqual([]);

    const problems = dataLocationAliasProblems({ ...input, realpath: realpathOnDisk });

    expect(problems.join("\n")).toMatch(/must not be the user's home directory/u);
    // Nothing was written into the decoy home: the guard is a decision, not a cleanup.
    expect(readdirSync(decoyHome)).toEqual([]);
  });

  it("refuses a not-yet-existing directory below such a link (nearest existing ancestor)", () => {
    const root = scratch();
    const decoyHome = join(root, "home");
    const alias = join(root, "alias");
    mkdirSync(decoyHome);
    if (!link(decoyHome, alias)) return;

    // The data directory does not exist yet — which is the normal case for a first start, and the
    // reason a plain `realpath` of it would fail with ENOENT and conclude "nothing to check".
    const dataUnderAlias = join(alias, "data");
    const input = { dataDirectory: dataUnderAlias, serviceHome: join(dataUnderAlias, "services", "a"), home: decoyHome };
    expect(dataLocationProblems(input)).toEqual([]);

    const problems = dataLocationAliasProblems({ ...input, realpath: realpathOnDisk });

    expect(problems.join("\n")).toMatch(/resolves into the user's home directory through an alias/u);
    expect(problems.join("\n")).toContain(dataUnderAlias);
  });

  it("accepts the same path again once the link is gone", () => {
    const root = scratch();
    const decoyHome = join(root, "home");
    const alias = join(root, "alias");
    mkdirSync(decoyHome);
    if (!link(decoyHome, alias)) return;

    const input = { dataDirectory: alias, serviceHome: join(alias, "services", "a"), home: decoyHome };
    expect(dataLocationAliasProblems({ ...input, realpath: realpathOnDisk })).not.toEqual([]);

    removeLink(alias);

    // The path is now an ordinary (not yet existing) directory outside the home: acceptable.
    expect(dataLocationAliasProblems({ ...input, realpath: realpathOnDisk })).toEqual([]);
    expect(readdirSync(decoyHome)).toEqual([]);
  });

  it("catches a DSH_HOME that escapes the data directory through a link", () => {
    const root = scratch();
    const decoyHome = join(root, "home");
    const data = join(root, "data");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(decoyHome);
    mkdirSync(data);
    mkdirSync(elsewhere);
    const escape = join(data, "escape");
    if (!link(elsewhere, escape)) return;

    const input = { dataDirectory: data, serviceHome: escape, home: decoyHome };
    // Spelled inside the data directory, but that is a link to somewhere else.
    expect(dataLocationProblems(input)).toEqual([]);

    expect(dataLocationAliasProblems({ ...input, realpath: realpathOnDisk }).join("\n"))
      .toMatch(/DSH_HOME must live underneath/u);
  });

  it("accepts the documented home-relative layout even when the home itself is a link", () => {
    const root = scratch();
    const realHome = join(root, "real-home");
    const homeLink = join(root, "home-link");
    mkdirSync(realHome);
    if (!link(realHome, homeLink)) return;

    const data = join(homeLink, ".deep-seek-harness-mcp");
    const problems = dataLocationAliasProblems({
      dataDirectory: data,
      serviceHome: join(data, "services", "a"),
      home: homeLink,
      realpath: realpathOnDisk,
    });

    // `<home>/.deep-seek-harness-mcp` is the recommended default: the operator spelled the home
    // path out, so this is not the "hidden alias" the rule refuses.
    expect(problems).toEqual([]);
    expect(readdirSync(realHome)).toEqual([]);
  });
});
