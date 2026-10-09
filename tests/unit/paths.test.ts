// The single case-folding rule behind every path comparison (task-35 defect B).
//
// The defect this file pins: comparisons folded case on `win32` only, while macOS's default
// filesystem (APFS) is case-insensitive too. `DSH_MCP_DATA_DIR=/Users/Bob` with home `/Users/bob`
// therefore slipped past the P0-5 "never point at the user's home" guard on macOS — the same class
// of accident as the Windows one the guard was written for (a real home polluted with `profiles/`,
// `storages/` and `.credentials.yaml`).
//
// Every assertion passes an explicit platform, so the file is host-independent and the case rule
// is exercised identically on Windows, Linux and macOS CI (no `process.platform` mutation).

import { describe, expect, it } from "vitest";
import {
  dataLocationAliasProblems,
  dataLocationProblems,
  foldForComparison,
  isWithin,
  samePath,
  type RealpathLookup,
} from "../../src/policy/paths.js";
import "../support/isolation.js";

const FOLDING = ["win32", "darwin"] as const;
const SENSITIVE = ["linux"] as const;

describe("foldForComparison: one rule, two directions", () => {
  it("folds where the platform's default filesystem folds", () => {
    for (const platform of FOLDING) {
      expect(foldForComparison("/Data/Root/Bob", platform, "filesystem"), platform).toBe("/data/root/bob");
    }
    for (const platform of SENSITIVE) {
      expect(foldForComparison("/Data/Root/Bob", platform, "filesystem"), platform).toBe("/Data/Root/Bob");
    }
  });

  it("keeps a conservative policy for comparisons that could widen a kill/delete surface", () => {
    // Sites where a *false match* is what removes something (see
    // `reports/r4-cross-platform-fixes.md` §3): `orphans.ts` (a positive ownership verdict lets the
    // supervisor signal the pid) and `runtime-package.ts` (fewer blockers opens the global
    // fail-closed prune gate). There, macOS deliberately keeps today's case-sensitive verdict.
    expect(foldForComparison("/Data/Root", "darwin", "win32-only")).toBe("/Data/Root");
    expect(foldForComparison("/Data/Root", "linux", "win32-only")).toBe("/Data/Root");
    expect(foldForComparison("/Data/Root", "win32", "win32-only")).toBe("/data/root");
  });

  it("has no folding default (R5-5), so every call site must take a stance", () => {
    expect(foldForComparison("/Data/Root", process.platform, "filesystem"))
      .toBe(process.platform === "win32" || process.platform === "darwin" ? "/data/root" : "/Data/Root");
    // The guarantee is compile-time, so the calls below must never run: they only exist to be
    // type-checked. `tsc` fails on either one (see the report for the raw output).
    const missingPolicyOrPlatform = (): void => {
      // @ts-expect-error — `policy` is mandatory since R5-5
      void foldForComparison("/Data/Root", "linux");
      // @ts-expect-error — `platform` is mandatory at this low level as well
      void foldForComparison("/Data/Root", "filesystem");
    };
    expect(missingPolicyOrPlatform).toBeTypeOf("function");
  });
});

describe("samePath: the case rule is per platform, not per call site", () => {
  it("treats a case-variant as the same path exactly where the filesystem does", () => {
    for (const platform of FOLDING) {
      expect(samePath("/ws/ALPHA", "/ws/alpha", platform), platform).toBe(true);
    }
    for (const platform of SENSITIVE) {
      expect(samePath("/ws/ALPHA", "/ws/alpha", platform), platform).toBe(false);
    }
  });

  it("stays reflexive and rejects a genuinely different directory on every platform", () => {
    for (const platform of [...FOLDING, ...SENSITIVE]) {
      expect(samePath("/ws/alpha", "/ws/alpha", platform), `${platform}: reflexive`).toBe(true);
      // `..`/`.` are normalised before comparing, so the same directory spelled two ways matches.
      expect(samePath("/ws/./alpha", "/ws/beta/../alpha", platform), `${platform}: normalised`).toBe(true);
      expect(samePath("/ws/alpha", "/ws/beta", platform), `${platform}: distinct`).toBe(false);
    }
  });
});

describe("isWithin: containment folds with the same rule", () => {
  it("accepts the root itself and true descendants only", () => {
    for (const platform of [...FOLDING, ...SENSITIVE]) {
      expect(isWithin("/data", "/data", platform), `${platform}: root`).toBe(true);
      expect(isWithin("/data", "/data/services/a", platform), `${platform}: descendant`).toBe(true);
      expect(isWithin("/data", "/database", platform), `${platform}: shared prefix`).toBe(false);
    }
  });

  it("folds a case-only difference on the platforms whose filesystem folds", () => {
    // `/DATA/ROOT/services/a` **is** inside `/data/root` on a case-insensitive volume.
    for (const platform of FOLDING) {
      expect(isWithin("/data/root", "/DATA/ROOT/services/a", platform), platform).toBe(true);
    }
    // The `linux` half cannot be asserted through `isWithin`: it compares via `node:path`'s *host*
    // implementation and `path.win32.relative` is case-insensitive by itself, so such an assertion
    // would pass on a Windows host while meaning nothing there. The Linux property is covered where
    // it is host-independent — `samePath` above and `dataLocationProblems` in
    // `tests/unit/data-location.test.ts` (equality comparisons, no `relative`).
  });
});

// ---------------------------------------------------------------------------------------------
// R5-1: the alias layer. A fake resolver keeps these deterministic and host-independent; the real
// junction/symlink cases live in `tests/unit/data-location.test.ts` (they need a real filesystem).
// ---------------------------------------------------------------------------------------------

/** A resolver where only the listed paths exist; everything else is `ENOENT`. */
function lookupOf(existing: Record<string, string>): RealpathLookup {
  return (path) => {
    const resolved = existing[path];
    return resolved === undefined ? { ok: false, code: "ENOENT" } : { ok: true, path: resolved };
  };
}

/** Nothing on the filesystem exists: the alias layer must then agree with the spelling layer. */
const nothingExists = lookupOf({});

describe("dataLocationAliasProblems: the guard sees through junctions and symlinks (R5-1)", () => {
  const HOME = "/users/bob";
  const SUGGESTION = /must not be the user's home directory/u;

  it("refuses a data directory that IS the home directory through an alias", () => {
    const problems = dataLocationAliasProblems({
      dataDirectory: "/tmp/alias",
      serviceHome: "/tmp/alias/services/a",
      home: HOME,
      realpath: lookupOf({ "/tmp/alias": HOME, "/tmp": "/tmp", "/users/bob": HOME }),
    });

    // The spelling layer alone accepts this — that is the defect.
    expect(dataLocationProblems({ dataDirectory: "/tmp/alias", serviceHome: "/tmp/alias/services/a", home: HOME }))
      .toEqual([]);
    expect(problems.join("\n")).toMatch(SUGGESTION);
  });

  it("refuses a not-yet-existing data directory below an alias into the home directory", () => {
    const problems = dataLocationAliasProblems({
      dataDirectory: "/tmp/alias/data",
      serviceHome: "/tmp/alias/data/services/a",
      home: HOME,
      realpath: lookupOf({ "/tmp/alias": HOME, "/tmp": "/tmp", "/users/bob": HOME }),
    });

    // `/tmp/alias/data` does not exist, so the walk resolves its nearest existing ancestor
    // (`/tmp/alias` → home) and the result lands inside the home directory.
    expect(problems.join("\n")).toMatch(/resolves into the user's home directory through an alias/u);
    expect(problems.join("\n")).toContain("/tmp/alias/data");
  });

  it("keeps an explicitly spelled home-relative data directory legal (the documented default)", () => {
    // The home directory itself is a symlink (`/users/bob` → `/volumes/data/bob`, common on macOS).
    const problems = dataLocationAliasProblems({
      dataDirectory: "/users/bob/.deep-seek-harness-mcp",
      serviceHome: "/users/bob/.deep-seek-harness-mcp/services/a",
      home: HOME,
      realpath: lookupOf({ "/users/bob": "/volumes/data/bob", "/volumes/data/bob": "/volumes/data/bob" }),
    });

    // Refusing this would break the recommended layout; the rule is about *hidden* targets, not
    // about forbidding a home-relative one.
    expect(problems).toEqual([]);
  });

  it("enforces containment against the real directory, not the spelling", () => {
    const problems = dataLocationAliasProblems({
      dataDirectory: "/srv/data",
      // Spelled inside the data directory, but the link escapes it.
      serviceHome: "/srv/data/link",
      home: HOME,
      realpath: lookupOf({ "/srv/data": "/srv/data", "/srv/data/link": "/etc", "/etc": "/etc" }),
    });

    expect(problems.join("\n")).toMatch(/DSH_HOME must live underneath/u);
  });

  it("stays byte-identical to the spelling layer when nothing exists to resolve", () => {
    const cases = [
      { dataDirectory: "/data/root", serviceHome: "/data/root/services/a", home: HOME },
      { dataDirectory: HOME, serviceHome: "/data/root/services/a", home: HOME },
      { dataDirectory: "/data/root", serviceHome: HOME, home: HOME },
      { dataDirectory: "/data/root", serviceHome: "/other", home: HOME },
      { dataDirectory: ".\\data", serviceHome: "/data/root/services/a", home: HOME },
      { dataDirectory: "/", serviceHome: "/services/a", home: HOME },
    ];
    for (const input of cases) {
      for (const platform of ["win32", "linux", "darwin"] as const) {
        expect(
          dataLocationAliasProblems({ ...input, platform, realpath: nothingExists }),
          `${platform}: ${input.dataDirectory} / ${input.serviceHome}`,
        ).toEqual(dataLocationProblems({ ...input, platform }));
      }
    }
  });

  it("fails closed when the resolver cannot explain a path", () => {
    const symlinkLoop: RealpathLookup = (path) => (path === "/data/loop" ? { ok: false, code: "ELOOP" } : { ok: false, code: "ENOENT" });
    const denied: RealpathLookup = (path) => (path === HOME ? { ok: false, code: "EACCES" } : { ok: false, code: "ENOENT" });
    const throwing: RealpathLookup = () => {
      throw new Error("resolver exploded");
    };
    const base = { dataDirectory: "/data/root", serviceHome: "/data/root/services/a", home: HOME };

    expect(dataLocationAliasProblems({ ...base, dataDirectory: "/data/loop", realpath: symlinkLoop }).join("\n"))
      .toMatch(/could not be resolved on disk \(ELOOP\)/u);
    expect(dataLocationAliasProblems({ ...base, realpath: denied }).join("\n"))
      .toMatch(/could not be resolved on disk \(EACCES\)/u);
    expect(dataLocationAliasProblems({ ...base, realpath: throwing }).join("\n"))
      .toMatch(/could not be resolved on disk \(unresolvable\)/u);
  });

  it("still reports the spelling problems when the alias layer is clean", () => {
    const problems = dataLocationAliasProblems({
      dataDirectory: "/data/root",
      serviceHome: "/data/root/services/a",
      home: HOME,
      realpath: nothingExists,
    });

    expect(problems).toEqual([]);
  });
});
