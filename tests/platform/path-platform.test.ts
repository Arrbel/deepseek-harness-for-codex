// Path spelling rules: the case-folding policy split in `src/policy/paths.ts`, `policy/orphans.ts`.
//
// **The markers in this file were flipped once** (task-34 → task-35): the first revision recorded
// the pre-fix behaviour of defect B (darwin case-sensitive in `dataLocationProblems`/`samePath`) as
// an explicit "this is what happens today, not what is correct" marker. The fix landed, so the
// expectations here now read:
//
//   * **protective** comparisons (`samePath`, `isWithin`, `dataLocationProblems`) fold on
//     `["win32","darwin"]` — the platform's *default* filesystem is case-insensitive on both, and
//     "matching more" there means "refusing more", which is the safe direction;
//   * **irreversible** comparisons (`identityOwnsRecord` → signals a process; the prune blockers in
//     `runtime-package.ts` → delete directories) fold on `["win32"]` only, deliberately: widening a
//     match there would widen an action that cannot be taken back.
//
// Three driving styles are used, all **simulated** evidence:
//   * functions that take an explicit `platform` (`samePath`, `isWithin`, `dataLocationProblems`,
//     `identityOwnsRecord`) are called with all three platforms on any host;
//   * the *default* platform argument (what production uses) is reached by overriding
//     `process.platform` for the duration of one call — the technique `tests/service/launch.test.ts`
//     established;
//   * `foldForComparison`'s table is asserted through the two public directions above, never by
//     reading the table.
//
// Overlap worth knowing: `tests/unit/paths.test.ts` (added with the fix) covers the same three
// platforms host-independently for the pure functions. This file keeps its own coverage because it
// also pins the **default-argument** path and the policy contrast in one place.
//
// NOT simulatable here, and therefore left to a real host: the **separator** half of path handling.
// `node:path` implements `resolve`/`relative`/`normalize` per *host*, so "does `/a/b` equal `\\a\\b`"
// is decided by the running OS, not by any parameter in `src/`. Only ubuntu/mac can prove the POSIX
// reading; see `reports/r4-cross-platform.md` §4 (row "separator normalisation").
import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAllowedRoots } from "../../src/config/resolve.js";
import { dataLocationProblems, isWithin, samePath } from "../../src/policy/paths.js";
import { identityOwnsRecord } from "../../src/policy/orphans.js";
import "../support/isolation.js";

/** Runs `body` with `process.platform` reporting `platform`, restoring the real value afterwards. */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

/** Inputs that differ only in case, so the comparison outcome depends solely on the branch taken. */
const UPPER = "/ws/ALPHA";
const LOWER = "/ws/alpha";

describe("samePath: the case rule is per platform, not per call site", () => {
  it("is case-insensitive on win32 and darwin, case-sensitive on linux", () => {
    // **Marker flipped after task-35 defect B was fixed.** Earlier this file recorded darwin as
    // case-sensitive; that is no longer the contract. `samePath` is a *protective* comparison
    // (matching more = refusing more), so it folds wherever the platform's default filesystem
    // folds — `CASE_FOLDING.filesystem = ["win32","darwin"]` in `src/policy/paths.ts:22-25`.
    // The assertion goes through the *default* platform argument, which is what production uses.
    expect(withPlatform("win32", () => samePath(UPPER, LOWER))).toBe(true);
    expect(withPlatform("darwin", () => samePath(UPPER, LOWER))).toBe(true);
    expect(withPlatform("linux", () => samePath(UPPER, LOWER))).toBe(false);
  });

  it("is reflexive and rejects a genuinely different directory on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(withPlatform(platform, () => samePath(UPPER, UPPER)), `reflexive on ${platform}`).toBe(true);
      expect(withPlatform(platform, () => samePath(UPPER, "/ws/beta")), `distinct on ${platform}`).toBe(false);
    }
  });

  it("still uses the host platform when the override is lifted", () => {
    expect(samePath(UPPER, UPPER)).toBe(true);
    // Flipped with the same fix: on a macOS runner this must now be `true` as well.
    expect(samePath(UPPER, LOWER)).toBe(process.platform === "win32" || process.platform === "darwin");
  });
});

describe("dataLocationProblems: canonicalisation is per platform", () => {
  const home = "/users/bob";
  // The same directory as `home` on any case-insensitive volume (Windows, default APFS).
  const variant = "/users/BOB";

  it("rejects a case-variant of the home directory on win32", () => {
    const problems = dataLocationProblems({
      dataDirectory: variant,
      serviceHome: `${variant}/services/a`,
      home,
      platform: "win32",
    });
    expect(problems.join("\n")).toMatch(/must not be the user's home directory/u);
  });

  it("rejects the case-variant on every folding platform and still allows it on linux", () => {
    // **Marker flipped after task-35 defect B was fixed.** Before the fix this test asserted
    // `["linux","darwin"]` both return `[]` (and said so was the recorded behaviour, not the
    // correct one). `dataLocationProblems` is the P0-5 guard — matching more must refuse more —
    // so on a case-insensitive default filesystem the case-variant **is** the home directory and
    // must be refused. `linux` legitimately still allows it: there the two spellings really are
    // two different directories.
    for (const platform of ["win32", "darwin"] as const) {
      const problems = dataLocationProblems({
        dataDirectory: variant,
        serviceHome: `${variant}/services/a`,
        home,
        platform,
      });
      expect(problems.join("\n"), `${platform}: the case-variant must be refused`).toMatch(/must not be the user's home directory/u);
    }

    expect(dataLocationProblems({
      dataDirectory: variant,
      serviceHome: `${variant}/services/a`,
      home,
      platform: "linux",
    })).toEqual([]);
  });

  it("also refuses the case-variant of the home directory's *parent* on folding platforms", () => {
    // The pre-fix file only covered rule 3 (`=== home`); rule 3's parent case (paths.ts:113-119)
    // goes through the same canonical form, so it must flip with it.
    const parent = "/USERS";
    for (const platform of ["win32", "darwin"] as const) {
      const problems = dataLocationProblems({
        dataDirectory: parent,
        serviceHome: `${parent}/services/a`,
        home,
        platform,
      });
      expect(problems.join("\n"), `${platform}: the parent case-variant must be refused`)
        .toMatch(/must not be the parent of the user's home directory/u);
    }
    expect(dataLocationProblems({
      dataDirectory: parent,
      serviceHome: `${parent}/services/a`,
      home,
      platform: "linux",
    })).toEqual([]);
  });

  it("keeps the structural rules identical on every platform (only spelling differs)", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const inside = dataLocationProblems({
        dataDirectory: "/data/root",
        serviceHome: "/data/root/services/a",
        home,
        platform,
      });
      expect(inside, `${platform}: a dedicated directory is accepted`).toEqual([]);

      const root = dataLocationProblems({ dataDirectory: "/", serviceHome: "/services/a", home, platform });
      expect(root.join("\n"), `${platform}: a filesystem root is rejected`).toMatch(/filesystem root/u);
    }
  });
});

describe("identityOwnsRecord: the opposite folding policy on purpose", () => {
  const record = { binPath: "/data/runtime/lib/bin.js", version: "0.2.1-alpha.1" };
  const shouted = "node /DATA/RUNTIME/LIB/BIN.JS web --no-open --port 0";

  it("accepts a differently-cased command line on win32 only", () => {
    // Unchanged by the task-35 fix, and now load-bearing evidence for the ruling: this comparison
    // uses `foldForComparison(..., "win32-only")` (`src/policy/orphans.ts:117`) because a positive
    // verdict is what lets `stop_service` / orphan reclamation **signal a process**. Folding on
    // darwin would *widen* an irreversible action, so it deliberately does not.
    expect(identityOwnsRecord(shouted, record, "win32")).toBe(true);
    expect(identityOwnsRecord(shouted, record, "linux")).toBe(false);
    expect(identityOwnsRecord(shouted, record, "darwin")).toBe(false);
  });

  it("folds darwin on the protective side and not on the irreversible one, for the same two strings", () => {
    // The contrast is the ruling (task-35 §3): one case-only difference, two questions.
    //   * "is this the same path?" (a guard)      -> darwin folds  -> `true`
    //   * "may I signal this pid?" (irreversible) -> darwin must not fold -> `false`
    expect(samePath(record.binPath, "/DATA/RUNTIME/LIB/BIN.JS", "darwin")).toBe(true);
    expect(identityOwnsRecord(shouted, record, "darwin")).toBe(false);
    // win32 folds on both sides, so the same pair is positive there.
    expect(samePath(record.binPath, "/DATA/RUNTIME/LIB/BIN.JS", "win32")).toBe(true);
    expect(identityOwnsRecord(shouted, record, "win32")).toBe(true);
  });

  it("requires both the recorded bin path and the --port argument on every platform", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      expect(identityOwnsRecord(record.binPath, record, platform), `${platform}: no --port`).toBe(false);
      expect(identityOwnsRecord("node /other/script.js --port 0", record, platform), `${platform}: other script`).toBe(false);
      expect(identityOwnsRecord(null, record, platform), `${platform}: unknown identity`).toBe(false);
      expect(identityOwnsRecord("", record, platform), `${platform}: empty identity`).toBe(false);
    }
  });
});

describe("isWithin is a path-segment test, not a string-prefix test", () => {
  it("accepts the root itself and true descendants only", () => {
    expect(isWithin("/data", "/data")).toBe(true);
    expect(isWithin("/data", "/data/services/a")).toBe(true);
    // The classic prefix bug: "/database" starts with "/data" but is not inside it.
    expect(isWithin("/data", "/database")).toBe(false);
    expect(isWithin("/data", "/data/../etc")).toBe(false);
  });

  it("folds a case-only difference wherever the default filesystem folds (allow-list shape)", () => {
    // `isWithin` is the third protective site (P0-5 rule 4 and the DSH_MCP_WORKSPACE_ROOTS
    // allow-list): on a case-insensitive volume `/data/root/services/a` **is** inside `/DATA/ROOT`,
    // and answering "outside" would refuse a legitimate workspace.
    //
    // Honest limitation, measured during the marker-flip verification (NEG-3' in
    // `reports/r4-cross-platform.md` §3): **this assertion is not load-bearing on a Windows host.**
    // `isWithin` compares through `node:path`'s *host* `relative`, and `path.win32.relative` is
    // case-insensitive by itself, so the assertion stays green even with the darwin fold removed.
    // It only discriminates where the host `relative` is case-sensitive — i.e. on the ubuntu/mac CI
    // columns. The load-bearing evidence for the folding policy on any host is the pair above
    // (`samePath`) and `dataLocationProblems`, which use no `relative`.
    for (const platform of ["win32", "darwin"] as const) {
      expect(isWithin("/DATA/ROOT", "/data/root/services/a", platform), platform).toBe(true);
    }
  });
});

describe("workspace-root lists use the host list separator, never a hard-coded one", () => {
  it("splits on the host delimiter and treats the other delimiter as data", () => {
    const separator = delimiter; // ";" on Windows, ":" on POSIX
    const other = separator === ";" ? ":" : ";";

    expect(resolveAllowedRoots({ DSH_MCP_WORKSPACE_ROOTS: ["/a", "/b"].join(separator) })).toEqual(["/a", "/b"]);
    // A value joined with the *other* platform's separator is one entry here. `tests/config/
    // resolve.test.ts:57` hard-codes a ";"-joined value, so on a POSIX host it asserts a split the
    // code cannot perform: this test states the rule that assertion is missing.
    expect(resolveAllowedRoots({ DSH_MCP_WORKSPACE_ROOTS: ["/a", "/b"].join(other) })).toEqual([`/a${other}/b`]);
  });
});
