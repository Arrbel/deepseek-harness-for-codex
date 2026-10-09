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
import { foldForComparison, isWithin, samePath } from "../../src/policy/paths.js";
import "../support/isolation.js";

const FOLDING = ["win32", "darwin"] as const;
const SENSITIVE = ["linux"] as const;

describe("foldForComparison: one rule, two directions", () => {
  it("folds where the platform's default filesystem folds", () => {
    for (const platform of FOLDING) {
      expect(foldForComparison("/Data/Root/Bob", platform), platform).toBe("/data/root/bob");
    }
    for (const platform of SENSITIVE) {
      expect(foldForComparison("/Data/Root/Bob", platform), platform).toBe("/Data/Root/Bob");
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

  it("defaults to the host platform and the protective direction", () => {
    const expected = process.platform === "win32" || process.platform === "darwin" ? "/data/root" : "/Data/Root";
    expect(foldForComparison("/Data/Root")).toBe(expected);
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
