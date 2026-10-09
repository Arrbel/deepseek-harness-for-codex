// R4-1 (extended by R5-3): the release workflow's structural invariants.
//
// `release.yml` cannot run locally (no runner, no OIDC, no artifacts), so what can be pinned
// down is its *shape*: this suite parses the file into a structure (see `./yaml.ts`) and asks
// questions about jobs and steps, rather than grepping for strings. The headline invariant is
// "no step in any job publishes anything" — checked by scanning every `run:` script and every
// `uses:` reference with the tolerant patterns from `./publish-surface.ts` (which catches
// `npm --prefix . publish`, quote concatenation and direct registry HTTP).
//
// **Scope of that claim (R5-3 honesty fix)**: this is a static text/structure scan of the files
// in this repository. It does *not* catch dynamically built commands (`node -e`, `bash -c`), a
// publish performed by a third-party action with an innocent name, credentials injected from
// outside the tree, third-party install scripts, `package.json#scripts` indirection or
// `scripts/**` — the last two are covered by `./publish-surface.test.ts`, and the authoritative
// list of remaining blind spots is the module header of `./publish-surface.ts` plus
// `reports/r5-publish-surface.md`. A publish smuggled in as `npm publish` in a step fails here;
// an obfuscated one may not.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asMapping, asSequence, type YamlMapping } from "./yaml.js";
import {
  artifactPaths,
  effectivePermissions,
  findPublishActions,
  findRegistryAuthWiring,
  findRepoWrites,
  findSuspiciousStrings,
  jobOf,
  loadWorkflow,
  stepsUsing,
  type WorkflowFinding,
} from "./workflow.js";
import { resolveNpmCli } from "../../src/service/npm-cli.js";
import "../support/isolation.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releasePath = join(repoRoot, ".github", "workflows", "release.yml");
const release = loadWorkflow(releasePath);
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  files: string[];
};

/** Renders a finding so a failure names the offending job and step. */
function describeFinding(finding: WorkflowFinding): string {
  return `${finding.step} -> ${finding.reason}`;
}

/** The file with full-line comments removed, for the literal-level net below. */
function withoutComments(text: string): string {
  return text.split(/\r?\n/u).filter((line) => !/^\s*#/u.test(line)).join("\n");
}

describe("release.yml: it must never publish", () => {
  it("contains no publish step in any job (commands, actions and provenance flags)", () => {
    expect(findPublishActions(release).map(describeFinding)).toEqual([]);
  });

  it("wires no registry credential or registry endpoint", () => {
    expect(findRegistryAuthWiring(release).map(describeFinding)).toEqual([]);
  });

  it("contains no publication literal outside comments", () => {
    // Secondary net over the raw text: the sweep above understands the constructs this workflow
    // uses, while this catches a publish command hidden in a field the model does not surface
    // (job `defaults`, a `container:`, an exotic action). Comments are removed first so that
    // explaining the rule cannot fail the rule.
    const code = withoutComments(readFileSync(releasePath, "utf8"));
    for (const literal of ["npm publish", "--provenance", "registry-url", "NODE_AUTH_TOKEN", "NPM_TOKEN"]) {
      expect(code, `${literal} must not appear in release.yml`).not.toContain(literal);
    }
  });

  it("does not write to the repository from any step", () => {
    expect(findRepoWrites(release).map(describeFinding)).toEqual([]);
  });

  it("has no environment or secret that could authenticate a publication", () => {
    // Scanned over the *parsed* document (keys and values), so explanatory comments cannot
    // produce a false positive and a token hidden in any field still fails.
    expect(findSuspiciousStrings(release).map((finding) => `${finding.path} -> ${finding.reason}`)).toEqual([]);
  });
});

describe("release.yml: triggers", () => {
  it("is triggered by a version tag, not by a branch push", () => {
    const push = asMapping(release.triggers["push"], "push");
    expect(Object.keys(push)).toEqual(["tags"]);
    expect(asSequence(push["tags"], "push.tags")).toEqual(["v*"]);
    expect(push["branches"]).toBeUndefined();
  });

  it("can also be dispatched by hand, and has no other automatic trigger", () => {
    expect(Object.keys(release.triggers).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(release.triggers["workflow_dispatch"]).toBeNull();
  });
});

describe("release.yml: provenance and permissions", () => {
  it("attests the tarball with the provenance action", () => {
    const attestSteps = stepsUsing(release, "actions/attest-build-provenance");
    expect(attestSteps).toHaveLength(1);
    expect(attestSteps[0]?.uses).toBe("actions/attest-build-provenance@v2");
    expect(attestSteps[0]?.with["subject-path"]).toBe("*.tgz");
  });

  it("gives that job the permissions provenance needs (effective, not just declared)", () => {
    const attestStep = stepsUsing(release, "actions/attest-build-provenance")[0];
    expect(attestStep).toBeDefined();
    const permissions = effectivePermissions(release, jobOf(release, attestStep!));
    expect(permissions["id-token"]).toBe("write");
    expect(permissions["attestations"]).toBe("write");
    expect(permissions["contents"]).toBe("read");
  });

  it("bounds every job with a timeout", () => {
    for (const job of release.jobs) {
      expect(job.raw["timeout-minutes"], `jobs.${job.id} has no timeout-minutes`).toBeTypeOf("number");
    }
  });

  it("pins every action to a version tag", () => {
    for (const step of release.jobs.flatMap((job) => [...job.steps])) {
      if (step.uses === null) continue;
      expect(step.uses, `${step.label} is not pinned`).toMatch(/@v\d+(\.\d+){0,2}$/u);
      expect(step.uses).not.toMatch(/@(main|master|HEAD)$/u);
    }
  });
});

describe("release.yml: artifacts and the gate", () => {
  it("reuses the hermetic gate instead of re-inventing it", () => {
    const scripts = release.jobs.flatMap((job) => job.steps.map((step) => step.run ?? ""));
    expect(scripts.some((script) => /npm ci\b/u.test(script))).toBe(true);
    expect(scripts.some((script) => /npm run check\b/u.test(script))).toBe(true);
    // The supply-chain job in check.yml owns `npm audit`; duplicating it here would make two
    // jobs disagree about the same signal.
    expect(scripts.some((script) => /npm audit\b/u.test(script))).toBe(false);
  });

  it("packs the tarball without re-running the gate through prepack", () => {
    const packScripts = release.jobs
      .flatMap((job) => job.steps.map((step) => step.run ?? ""))
      .filter((script) => /npm pack\b/u.test(script));
    expect(packScripts).toHaveLength(1);
    expect(packScripts[0]).toContain("--ignore-scripts");
  });

  it("uploads both the tarball and the SBOM as artifacts", () => {
    const uploads = artifactPaths(release);
    expect(uploads.map((upload) => upload.path)).toEqual(expect.arrayContaining(["*.tgz", "sbom.cdx.json"]));
    expect(uploads.map((upload) => upload.name)).toEqual(expect.arrayContaining(["npm-tarball", "sbom-cyclonedx"]));
    for (const upload of uploads) {
      expect(upload.ifNoFilesFound, `${String(upload.name)} must fail when it has nothing to upload`).toBe("error");
    }
  });

  it("generates the SBOM with the same entry point maintainers run locally", () => {
    const sbomSteps = release.jobs.flatMap((job) => job.steps).filter((step) => (step.run ?? "").includes("sbom"));
    expect(sbomSteps).toHaveLength(1);
    expect(sbomSteps[0]?.run).toContain("npm run sbom");
    expect(release.path.endsWith("release.yml")).toBe(true);
  });
});

describe("package.json: the release surface the workflow packs", () => {
  it("declares an `sbom` script that points at scripts/sbom.mjs", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["sbom"]).toBe("node scripts/sbom.mjs");
  });

  it("packs exactly the declared file surface (and never the sources or the tests)", { timeout: 60_000 }, () => {
    const npmCli = resolveNpmCli();
    const result = spawnSync(process.execPath, [npmCli.path, "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(result.status, result.stderr.slice(0, 800)).toBe(0);
    const [packed] = JSON.parse(result.stdout) as { filename: string; files: { path: string }[] }[];

    // The artifact name is derived from the manifest, so a version bump cannot silently produce
    // a tarball the release job then fails to find.
    expect(packed?.filename).toBe(`${manifest.name}-${manifest.version}.tgz`);

    const paths = (packed?.files ?? []).map((file) => file.path.split(sep).join("/"));
    // npm always ships the manifest, the licence and the readmes next to `files`.
    const alwaysIncluded = new Set(["package.json", "LICENSE", "README.md", "README.en.md"]);
    const declaredDirectories = manifest.files.filter((entry) => entry.endsWith("/"));
    const declaredFiles = new Set(manifest.files.filter((entry) => !entry.endsWith("/")));
    for (const path of paths) {
      if (alwaysIncluded.has(path)) continue;
      const covered = declaredFiles.has(path) || declaredDirectories.some((directory) => path.startsWith(directory));
      expect(covered, `${path} is packed but not covered by package.json#files`).toBe(true);
    }
    for (const directory of declaredDirectories) {
      // `dist/` and the plugin payload are generated and git-ignored, so a fresh clone (and thus
      // a fresh CI checkout, where `npm test` runs *before* `npm run build`) legitimately has
      // nothing to pack for them. Only a directory that exists on disk must actually be packed;
      // the release workflow's ordering (check → build → pack) covers the generated case.
      if (!existsSync(join(repoRoot, directory))) continue;
      expect(paths.some((path) => path.startsWith(directory)), `${directory} exists but is not packed`).toBe(true);
    }
    for (const forbidden of ["src/", "tests/", "scripts/", "docs/", ".github/", "CHANGELOG.md", "plugins/"]) {
      expect(paths.some((path) => path.startsWith(forbidden)), `${forbidden} must not be published`).toBe(false);
    }
  });
});
