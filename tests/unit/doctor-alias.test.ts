// N-R5-1: `doctor` (pre-flight) and `start_run` (enforcement) must agree about an aliased data
// directory.
//
// The defect an independent verifier found: for the *same* junction pointing at the home directory,
// `doctor` said `ready:true / problems:[]` while `start_run` refused to start. Root cause: R5-1's
// alias-aware entry point was wired into `service/supervisor.ts` only; `doctor` never asked the
// P0-5 question at all.
//
// The direction of the fix is **refuse-aligned**: the pre-flight reports the problem, the runner is
// never relaxed. A location `doctor` clears must still pass the runner's own guard, and both
// surfaces reuse the same message text so they cannot drift apart.
//
// A second finding came out of writing this file: `doctor`'s writability probe used to run *before*
// any safety verdict, so for a link pointing at the home directory it created (and deleted) a probe
// file **inside the real home** — the very write the guard exists to prevent. The probe is now
// skipped for an unsafe location, and the test below asserts the real home is untouched.
//
// Every link is created inside a temporary directory and removed before the file finishes. The
// "home" is either a decoy directory inside that temporary tree or the operator's real home, and in
// the latter case the tests only ever *read* it. Nothing is ever written into it.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataLocationPrerequisiteProblems, inspectRuntime } from "../../src/diagnostics/doctor.js";
import type { RealpathLookup } from "../../src/policy/paths.js";
import { ServiceSupervisor } from "../../src/service/supervisor.js";
import "../support/isolation.js";

const scratchRoots: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-doctor-alias-"));
  scratchRoots.push(directory);
  return directory;
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

/** Removes the link itself, never what it points at. */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

afterEach(() => {
  for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The report fields these tests read (the other keys are covered by `tests/diagnostics`). */
function reportFor(dataDirectory: string): { ready: boolean; problems: string[]; writable: string } {
  const report = inspectRuntime({ DSH_MCP_DATA_DIR: dataDirectory });
  return {
    ready: report["ready"] === true,
    problems: report["problems"] as string[],
    writable: (report["dataDirectory"] as { writable: string }).writable,
  };
}

describe("doctor agrees with start_run about an aliased data directory (N-R5-1)", () => {
  it("reports the problem for a directory that is the home through a link (pinned resolver)", () => {
    const root = scratch();
    const decoyHome = join(root, "home");
    const alias = join(root, "alias");
    mkdirSync(decoyHome);
    if (!link(decoyHome, alias)) return; // no link privileges: the policy-level cases cover this

    // A resolver that reports "the alias resolves to the decoy home" for every probe, so the
    // assertion does not depend on this machine's real home.
    const pinned: RealpathLookup = () => ({ ok: true, path: decoyHome });
    const problems = dataLocationPrerequisiteProblems(alias, pinned);

    expect(problems.join("\n")).toMatch(/Unsafe data location/u);
    expect(problems.join("\n")).toMatch(/must not be the user's home directory/u);
  });

  it("reports the problem for a not-yet-existing directory below such a link (real resolver)", () => {
    const root = scratch();
    const alias = join(root, "alias");
    // A link to the *real* home, created inside the temporary root. Creating it is a write into the
    // temporary directory only; nothing is ever written through it.
    if (!link(homedir(), alias)) return;

    // The data directory does not exist yet, so the walk must resolve the nearest existing ancestor
    // (the link → home) — the case a plain `realpath` of the data directory reports as ENOENT.
    const nested = join(alias, "data");
    const problems = dataLocationPrerequisiteProblems(nested);

    expect(problems.join("\n")).toMatch(/resolves into the user's home directory through an alias/u);
    expect(problems.join("\n")).toContain(nested);
  });

  it("does not probe a location it will refuse — the real home is never written to", () => {
    const root = scratch();
    const alias = join(root, "alias");
    if (!link(homedir(), alias)) return;

    const before = readdirSync(homedir());
    const report = reportFor(alias);
    const after = readdirSync(homedir());

    expect(report.ready).toBe(false);
    expect(report.problems.join("\n")).toMatch(/must not be the user's home directory/u);
    // `unknown` is "not measured", and it is the proof the probe branch was skipped: before the fix
    // this location was probed (and a probe file appeared in the real home for a moment).
    expect(report.writable).toBe("unknown");
    expect(after).toEqual(before);
    expect(before).not.toContain(undefined);
  });

  it("refuses to start the very same location, in the same words (enforcement side)", async () => {
    const root = scratch();
    const alias = join(root, "alias");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    if (!link(homedir(), alias)) return; // the runner side is also covered by tests/service

    // Pre-flight verdict for this path …
    const preflight = dataLocationPrerequisiteProblems(alias);
    expect(preflight.join("\n")).toMatch(/must not be the user's home directory/u);

    // … and the enforcement verdict: `start` must reject before any write.
    const supervisor = new ServiceSupervisor({
      dataDirectory: alias,
      allowedRoots: [workspace],
      homeDirectory: homedir(),
      ensureRuntime: async () => {
        throw new Error("must never be reached");
      },
      spawnProcess: () => {
        throw new Error("must never be reached");
      },
    });
    const rejection = await supervisor.start({ workspace }).then(() => null, (error: unknown) => error as Error);

    expect(rejection).toBeInstanceOf(Error);
    expect(rejection?.message).toMatch(/unsafe data location/u);
    // The two surfaces name the same defect: the guard's own sentence appears verbatim in both.
    const guardSentence = preflight[0]?.replace(/^Unsafe data location: /u, "") ?? "";
    expect(guardSentence).not.toBe("");
    expect(rejection?.message).toContain(guardSentence);
  });

  it("stays ready for a plain temporary directory and for the explicit home-relative default", () => {
    const plain = scratch();
    expect(reportFor(plain).ready).toBe(true);
    expect(reportFor(plain).problems).toEqual([]);

    // The documented default layout: home-relative and spelled out. It must stay accepted —
    // refusing it would break the recommended installation.
    const explicit = join(homedir(), ".deep-seek-harness-mcp");
    expect(dataLocationPrerequisiteProblems(explicit)).toEqual([]);
    expect(reportFor(explicit).ready).toBe(true);
  });

  it("returns to ready once the link is gone", () => {
    const root = scratch();
    const alias = join(root, "alias");
    if (!link(homedir(), alias)) return;

    expect(dataLocationPrerequisiteProblems(alias)).not.toEqual([]);

    removeLink(alias);

    // The path is now an ordinary (not yet existing) directory: nothing left to report.
    expect(dataLocationPrerequisiteProblems(alias)).toEqual([]);
    expect(reportFor(alias).ready).toBe(true);
  });

  it("fails closed when the location cannot be resolved (ELOOP / EACCES / a throwing resolver)", () => {
    const root = scratch();
    const loop = join(root, "loop");
    const denied: RealpathLookup = (path) => (path === loop
      ? { ok: false, code: "EACCES" }
      : { ok: false, code: "ENOENT" });
    const looping: RealpathLookup = (path) => (path === loop
      ? { ok: false, code: "ELOOP" }
      : { ok: false, code: "ENOENT" });
    const throwing: RealpathLookup = () => {
      throw new Error("resolver exploded");
    };

    for (const [label, resolver] of [["EACCES", denied], ["ELOOP", looping], ["throwing", throwing]] as const) {
      const problems = dataLocationPrerequisiteProblems(loop, resolver);
      expect(problems.join("\n"), label).toMatch(/Unsafe data location/u);
      expect(problems.join("\n"), label).toMatch(/could not be resolved on disk/u);
    }

    // A path that simply does not exist yet is not a failure: it is the normal first start.
    expect(dataLocationPrerequisiteProblems(join(root, "plain"))).toEqual([]);
  });
});
