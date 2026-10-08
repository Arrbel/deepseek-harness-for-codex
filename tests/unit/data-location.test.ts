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
    // Case differences are the same location on Windows.
    expect(dataLocationProblems({
      dataDirectory: dataDirectory.toUpperCase(),
      serviceHome: serviceHome.toUpperCase(),
      home,
    })).toEqual([]);
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
