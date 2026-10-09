// P0-5: the data directory / `DSH_HOME` safety rules, as a pure decision table.
//
// The accident behind them: a script pointed `DSH_HOME` at `C:\Users\<user>`, and the Harness
// populated the user's home with `profiles/`, `storages/`, and `.credentials.yaml`.
// Every rule is checked *before* any directory is created (see the supervisor tests).

import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLocationProblems } from "../../src/policy/paths.js";
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
