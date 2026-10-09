// R4-1: `npm run sbom` must work locally, produce a *verified* document, and fail loudly.
//
// The three properties exercised here are the ones the release workflow depends on:
//   1. stdout is the SBOM itself (so `npm run sbom > sbom.cdx.json` yields a parseable file);
//   2. the document describes **this** package (`dependencies` is empty, so `--omit dev` yields
//      no components at all — the SBOM-level proof of the zero-dependency surface);
//   3. nothing is ever swallowed: npm failing, npm printing non-JSON, or npm describing another
//      package each produce a non-zero exit with an actionable message.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveNpmCli } from "../../src/service/npm-cli.js";
import "../support/isolation.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = join(repoRoot, "scripts", "sbom.mjs");
const fixture = (name: string): string => join(repoRoot, "tests", "release", "fixtures", name);
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};

const scratchDirectories: string[] = [];
afterAll(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(args: string[], npmCliOverride?: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DSH_MCP_NPM_CLI;
  if (npmCliOverride !== undefined) env.DSH_MCP_NPM_CLI = npmCliOverride;
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface CycloneDocument {
  bomFormat: string;
  specVersion: string;
  serialNumber: string;
  metadata: { timestamp: string; tools?: unknown; component: { name: string; version: string } };
  components: { name: string; version: string; scope?: string }[];
}

describe("npm run sbom (scripts/sbom.mjs)", () => {
  it("prints a CycloneDX document for this package on stdout", { timeout: 60_000 }, () => {
    const result = runScript([]);

    expect(result.status, result.stderr.slice(-500)).toBe(0);
    const document = JSON.parse(result.stdout) as CycloneDocument;
    expect(document.bomFormat).toBe("CycloneDX");
    expect(document.specVersion).toBe("1.5");
    expect(document.metadata.component.name).toBe(manifest.name);
    expect(document.metadata.component.version).toBe(manifest.version);
    expect(Array.isArray(document.components)).toBe(true);
    // Human-readable output must not pollute stdout: the redirect is the documented usage.
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    expect(result.stderr).toContain("[sbom] cyclonedx 1.5:");
    expect(result.stderr).toContain(`root ${manifest.name}@${manifest.version}`);
  });

  it("is reproducible apart from npm's serial number and timestamp", { timeout: 60_000 }, () => {
    const first = JSON.parse(runScript([]).stdout) as CycloneDocument;
    const second = JSON.parse(runScript([]).stdout) as CycloneDocument;

    expect(first.serialNumber).not.toBe(second.serialNumber);
    const strip = (document: CycloneDocument): string => {
      const copy = { ...document, serialNumber: "", metadata: { ...document.metadata, timestamp: "" } };
      return JSON.stringify(copy);
    };
    expect(strip(first)).toBe(strip(second));
  });

  it("writes exactly the same document to --out and keeps stdout silent", { timeout: 60_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "dsh-sbom-"));
    scratchDirectories.push(directory);
    const target = join(directory, "nested", "sbom.cdx.json");

    const result = runScript(["--out", target]);

    expect(result.status, result.stderr.slice(-500)).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[sbom] wrote ");
    const document = JSON.parse(readFileSync(target, "utf8")) as CycloneDocument;
    expect(document.metadata.component.name).toBe(manifest.name);
    expect(document.metadata.component.version).toBe(manifest.version);
  });

  it("reports an empty production surface for --omit dev (dependencies is empty)", { timeout: 60_000 }, () => {
    // Premise: this package has no runtime dependencies at all (R2-7 moved the SDK and zod into
    // devDependencies because they are bundled into dist/). If that ever changes, this test
    // should fail here rather than in the release job.
    expect(manifest.dependencies).toEqual({});

    const result = runScript(["--omit", "dev"]);

    expect(result.status, result.stderr.slice(-500)).toBe(0);
    const document = JSON.parse(result.stdout) as CycloneDocument;
    expect(document.components).toEqual([]);
    expect(document.metadata.component.name).toBe(manifest.name);
    expect(result.stderr).toContain("production scope: 0");
  });

  it("fails loudly when npm cannot describe the installed tree", () => {
    const result = runScript([], fixture("failing-npm.mjs"));

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ESBOMPROBLEMS");
    expect(result.stderr).toContain("npm ci");
  });

  it("fails loudly when npm succeeds but prints no document", () => {
    const result = runScript([], fixture("broken-npm.mjs"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not JSON");
  });

  it("fails loudly when the document describes another package", () => {
    const result = runScript([], fixture("wrong-package-npm.mjs"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match this package");
    expect(result.stderr).toContain("some-other-package");
  });

  it("rejects an unsupported format before touching npm", () => {
    const result = runScript(["--format", "sarif"], fixture("failing-npm.mjs"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported --format");
    // The fixture was never reached: validation happens first.
    expect(result.stderr).not.toContain("ESBOMPROBLEMS");
  });

  it("is reachable as `npm run --silent sbom` with a parseable stdout", { timeout: 60_000 }, () => {
    // The documented redirect form: `npm run sbom > sbom.cdx.json` would prepend npm's own
    // banner to stdout, so the suite pins the `--silent` form (and `--out`, tested above).
    const npmCli = resolveNpmCli();
    const result = spawnSync(process.execPath, [npmCli.path, "run", "--silent", "sbom"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(result.status, result.stderr.slice(-500)).toBe(0);
    const document = JSON.parse(result.stdout) as CycloneDocument;
    expect(document.bomFormat).toBe("CycloneDX");
    expect(document.metadata.component.version).toBe(manifest.version);
  });

  it("documents itself with --help", () => {
    const result = runScript(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("npm run sbom");
  });
});
