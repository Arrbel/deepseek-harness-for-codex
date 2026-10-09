// R5-3: the expanded publish-surface net, and R5-2's lifecycle-hook gate.
//
// Three layers live here:
//   1. **Positive cases** for every shape the R4-1 detector missed (the bypasses the adversarial
//      pass used): `npm --prefix . publish`, quote concatenation, `package.json#scripts`
//      indirection, `node scripts/<file>` indirection, direct registry HTTP, `.npmrc`
//      credentials, `scripts/**` contents.
//   2. **Negative cases** — benign commands must stay silent, because a net that fires on
//      `npm ci` is a net maintainers learn to ignore.
//   3. **The real repository** as a finding-free baseline, plus the assumption-of-record: the
//      remaining blind spots are listed in `./publish-surface.ts` and `reports/r5-publish-surface.md`
//      and are *not* claimed to be covered here.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractNodeScripts,
  extractScriptReferences,
  findPublishCommands,
  findPublishSurface,
  resolveScriptClosure,
  scanNpmrc,
  scanPackageScripts,
  scanScriptFiles,
  stripJsComments,
  type PublishSurfaceInput,
  type SurfaceFinding,
} from "./publish-surface.js";
import { allRunScripts, findPublishActions, findRegistryAuthWiring, findSuspiciousStrings, loadWorkflow } from "./workflow.js";
import {
  ALLOWED_LIFECYCLE_HOOKS,
  CI_LIFECYCLE_HOOKS,
  PUBLICATION_LIFECYCLE_HOOKS,
  evaluateMetadata,
} from "../../scripts/lib/metadata.mjs";
import "../support/isolation.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};

/** Every file under `scripts/`, relative to the repository root (forward slashes). */
function readScriptFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) {
        files.push({ path: relative(repoRoot, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(repoRoot, "scripts"));
  return files;
}

/** The whole repository's publish surface, using the real workflow/script/npmrc inputs. */
function repoPublishSurface(): SurfaceFinding[] {
  const workflowFiles = readdirSync(join(repoRoot, ".github", "workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  const workflowFindings: SurfaceFinding[] = [];
  const workflowRunScripts: { location: string; script: string }[] = [];
  for (const name of workflowFiles) {
    const workflow = loadWorkflow(join(repoRoot, ".github", "workflows", name));
    for (const finding of [...findPublishActions(workflow), ...findRegistryAuthWiring(workflow)]) {
      workflowFindings.push({ location: `${name} ${finding.step}`, kind: "publish", reason: finding.reason, text: "" });
    }
    for (const finding of findSuspiciousStrings(workflow)) {
      workflowFindings.push({
        location: `${name} ${finding.path}`,
        kind: /token|credential|secret/iu.test(finding.reason) ? "credential" : "publish",
        reason: finding.reason,
        text: finding.value,
      });
    }
    for (const { step, script } of allRunScripts(workflow)) {
      workflowRunScripts.push({ location: `${name} ${step.label}`, script });
    }
  }
  const input: PublishSurfaceInput = {
    packageScripts: manifest.scripts,
    npmrc: readFileSync(join(repoRoot, ".npmrc"), "utf8"),
    scriptFiles: readScriptFiles(),
    workflowFindings,
    workflowRunScripts,
  };
  return findPublishSurface(input);
}

describe("publish surface: shapes the R4-1 detector missed", () => {
  it.each([
    ["npm --prefix . publish --access public", "the reviewer's verified bypass"],
    ["npm --prefix=. publish", "flag with = sign"],
    ["npm --global publish", "another flag form"],
    ["pnpm --filter deepseek-harness-for-codex publish", "pnpm flag form"],
    ["yarn --cwd . publish", "yarn flag form"],
    ["npm.cmd publish", "Windows shim"],
    ["npm stage publish", "npm's staging flow"],
    ["npm p" + "''" + "ublish", "quote concatenation (the shell runs `npm publish`)"],
    ["npm unpublish deepseek-harness-for-codex", "unpublish"],
    ["npm deprecate deepseek-harness-for-codex@0.4.0 bad", "deprecate"],
  ])("detects %j (%s)", (command) => {
    expect(findPublishCommands(command, "test").map((finding) => finding.kind)).toContain("publish");
  });

  it("detects --provenance even when the subcommand is spelled out of order", () => {
    expect(findPublishCommands("npm publish --provenance", "test").map((finding) => finding.reason))
      .toContain("--provenance is a publication flag");
  });

  it("detects a direct registry conversation that never invokes npm", () => {
    const script = 'node -e "fetch(\'https://registry.npmjs.org/my-pkg\',{method:\'PUT\'})"';
    expect(findPublishCommands(script, "test").map((finding) => finding.reason))
      .toContain("talks to a registry over HTTP without npm");
    expect(findPublishCommands("curl -X PUT https://registry.npmjs.org/my-pkg -d @payload", "test").length).toBeGreaterThan(0);
  });

  it("detects registry authentication commands", () => {
    expect(findPublishCommands("npm login --registry=https://registry.npmjs.org/", "test").map((finding) => finding.kind))
      .toContain("credential");
  });

  it("stays silent for benign commands (a net that cries wolf gets ignored)", () => {
    for (const benign of [
      "npm ci",
      "npm ci --ignore-scripts",
      "npm run check",
      "npm pack --ignore-scripts",
      "npm run sbom -- --out sbom.cdx.json",
      "node scripts/sbom.mjs --omit dev",
      "curl -fsS https://example.test/health",
      'printf %s "the workflow does not publish to any registry"',
    ]) {
      expect(findPublishCommands(benign, "test"), benign).toEqual([]);
    }
  });
});

describe("publish surface: indirection through package.json#scripts and files", () => {
  it("resolves `npm run <script>` transitively and reports where it landed", () => {
    const scripts = { release: "npm run build && npm publish --access public", build: "npm run check" };
    const closure = resolveScriptClosure(scripts, "release").map((entry) => entry.name);
    expect(closure).toEqual(["release", "build"]);
    expect(scanPackageScripts(scripts).map((finding) => finding.location))
      .toContain('package.json#scripts["release"]');
  });

  it("follows a chain of scripts (a -> b -> publish)", () => {
    const scripts = { a: "npm run b", b: "npm run c", c: "npm publish" };
    expect(scanPackageScripts(scripts).map((finding) => finding.location)).toContain('package.json#scripts["c"]');
  });

  it("terminates on a cycle", () => {
    const scripts = { a: "npm run b", b: "npm run a" };
    expect(resolveScriptClosure(scripts, "a").map((entry) => entry.name).sort()).toEqual(["a", "b"]);
  });

  it("finds a publish in a file a workflow runs by path", () => {
    const surface = findPublishSurface({
      packageScripts: {},
      npmrc: null,
      scriptFiles: [{ path: "scripts/publish.mjs", text: 'import { execSync } from "node:child_process";\nexecSync("npm publish");\n' }],
      workflowFindings: [],
      workflowRunScripts: [{ location: "release.yml step 9", script: "node scripts/publish.mjs" }],
    });
    expect(surface.map((finding) => finding.location)).toContain("release.yml step 9 -> scripts/publish.mjs");
  });

  it("flags a dormant publish script that no workflow calls yet", () => {
    expect(scanPackageScripts({ ship: "node scripts/ship.mjs --registry https://registry.npmjs.org/" })).toEqual([]);
    expect(scanPackageScripts({ ship: "npm publish" }).map((finding) => finding.kind)).toEqual(["publish"]);
  });

  it("extracts the references it claims to extract", () => {
    expect(extractScriptReferences("npm run --silent sbom && npm run-script check")).toEqual(["sbom", "check"]);
    expect(extractNodeScripts("node --experimental-x ./scripts/sbom.mjs --out x")).toEqual(["./scripts/sbom.mjs"]);
  });

  it("scans scripts/** but ignores the prose in JavaScript comments", () => {
    const withComment = [{ path: "scripts/x.mjs", text: "// never run `npm publish` here\nexport const ok = true;\n" }];
    expect(scanScriptFiles(withComment)).toEqual([]);
    const withCode = [{ path: "scripts/x.mjs", text: '/* c */\nexecSync("npm publish --provenance");\n' }];
    expect(scanScriptFiles(withCode).map((finding) => finding.kind)).toEqual(["publish", "publish"]);
    expect(stripJsComments('const url = "https://example.test"; // npm publish\n')).toBe('const url = "https://example.test"; \n');
  });
});

describe("publish surface: .npmrc", () => {
  it("reports credentials as credentials and a bare registry line as an endpoint note", () => {
    expect(scanNpmrc("registry=https://registry.npmjs.org/\n")).toEqual([
      { location: ".npmrc:1", kind: "endpoint", reason: "registry endpoint override", text: "registry=https://registry.npmjs.org/" },
    ]);
    expect(scanNpmrc("//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n").map((finding) => finding.kind)).toEqual(["credential"]);
    expect(scanNpmrc("_auth=abc123\nalways-auth=true\nemail=ci@example.test\n").map((finding) => finding.kind))
      .toEqual(["credential", "credential", "credential"]);
    expect(scanNpmrc("; a comment\n# another\n")).toEqual([]);
    expect(scanNpmrc(null)).toEqual([]);
  });
});

describe("publish surface: this repository", () => {
  it("has no publish-shaped or credential-shaped finding anywhere", () => {
    const surface = repoPublishSurface();
    expect(surface.filter((finding) => finding.kind !== "endpoint").map((finding) => `${finding.location}: ${finding.reason}`)).toEqual([]);
    // The one documented, reviewed finding: `.npmrc` pins the public registry (no credential).
    expect(surface.filter((finding) => finding.kind === "endpoint").map((finding) => finding.location)).toEqual([".npmrc:1"]);
  });

  it("keeps the CI-reachable lifecycle hooks banned and the publication hooks on the reviewed command", () => {
    const scripts = manifest.scripts;
    expect(CI_LIFECYCLE_HOOKS.filter((hook) => Object.hasOwn(scripts, hook))).toEqual([]);
    const lifecycleHooks = [...CI_LIFECYCLE_HOOKS, ...PUBLICATION_LIFECYCLE_HOOKS];
    const unreviewed = Object.keys(scripts).filter(
      (hook) => lifecycleHooks.includes(hook) && !Object.hasOwn(ALLOWED_LIFECYCLE_HOOKS, hook),
    );
    expect(unreviewed, "lifecycle hooks must be banned or listed in ALLOWED_LIFECYCLE_HOOKS with a reason").toEqual([]);
    for (const [hook, allowed] of Object.entries(ALLOWED_LIFECYCLE_HOOKS)) {
      expect(scripts[hook], `script "${hook}" must be exactly the reviewed command`).toBe(allowed.command);
      expect(allowed.reason.length).toBeGreaterThan(20);
    }
  });

  it("installs dependencies without running lifecycle scripts (R5-2)", () => {
    // The CI-side half of R5-2: `npm ci` would otherwise execute the root package's
    // preinstall/install/postinstall/prepare hooks, and the metadata gate now bans those — but a
    // third-party dependency's install script is still a surface, and `--ignore-scripts` closes
    // it. Evidence that the toolchain needs no install script: `npm run build`,
    // `check-metadata --self-contained` and `npm run sbom` all pass in a fresh copy installed
    // with `--ignore-scripts` (reports/r5-publish-surface.md).
    const workflowDir = join(repoRoot, ".github", "workflows");
    const installs: { file: string; script: string }[] = [];
    for (const name of readdirSync(workflowDir).filter((entry) => entry.endsWith(".yml"))) {
      const workflow = loadWorkflow(join(workflowDir, name));
      for (const { script } of allRunScripts(workflow)) {
        if (/\bnpm ci\b/u.test(script)) installs.push({ file: name, script });
      }
    }
    expect(installs.length).toBeGreaterThanOrEqual(4);
    for (const install of installs) {
      expect(install.script, `${install.file}: npm ci must pass --ignore-scripts`).toContain("--ignore-scripts");
    }
  });

  it("keeps the metadata gate's own lifecycle rule in sync with this test", () => {
    // The gate is what CI actually runs (`npm run check-metadata`); this asserts its teeth on a
    // synthetic manifest so the rule cannot be removed without the suite noticing.
    const snapshot = {
      manifest: {
        name: "x",
        version: "1.0.0",
        files: [],
        scripts: { check: "node scripts/check-metadata.mjs", postinstall: "node scripts/publish.mjs" },
      },
      lock: { version: "1.0.0", packages: { "": { name: "x", version: "1.0.0" } } },
      marketplace: null,
      texts: new Map<string, string | null>(),
      hashes: new Map<string, string | null>(),
      sourceHashes: new Map<string, string | null>(),
      listings: new Map<string, string[]>(),
      distImports: new Map<string, string[]>(),
    };
    const findings = evaluateMetadata(snapshot).filter((finding) => finding.code.startsWith("lifecycle"));
    expect(findings.map((finding) => finding.code)).toContain("lifecycle-hook");
    expect(findings.map((finding) => finding.message).join(" ")).toContain('"postinstall"');
  });
});
