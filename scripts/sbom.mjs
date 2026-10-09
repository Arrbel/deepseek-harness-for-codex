#!/usr/bin/env node
// R4-1: one local command that produces the same SBOM the release workflow publishes.
//
// Why a script instead of a raw `npm sbom` in the workflow: the flags, the validation and the
// exit-code semantics should be identical on a laptop and in CI, and the failure must stay
// loud. `npm sbom` derives the document from `package-lock.json` **plus the installed tree**
// (it reports `ESBOMPROBLEMS` when node_modules is missing) but it never needs the registry —
// both facts are exercised by `tests/release/sbom.test.ts`.
//
// Usage (stdout is always the SBOM itself, so redirection is safe; everything human-readable
// goes to stderr):
//
//   npm run sbom -- --out sbom.cdx.json              # recommended: the script writes the file
//   npm run --silent sbom                            > sbom.cdx.json
//   node scripts/sbom.mjs                            > sbom.cdx.json
//   npm run sbom -- --omit dev                       # production surface only
//   npm run sbom -- --format spdx
//
// `--silent` is not cosmetic: `npm run` prints its own banner to **stdout**, so a plain
// `npm run sbom > sbom.cdx.json` prepends two lines and the file is no longer JSON. `--out`
// avoids the question entirely, which is why the release workflow uses it.
//
// `npm sbom` fills in a random `serialNumber` and the current `metadata.timestamp`; every other
// field is reproducible (asserted by `tests/release/sbom.test.ts`).
//
// Exit codes: 0 the SBOM was produced and validated; 1 npm failed or the document did not
// match this package.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_FORMATS = new Set(["cyclonedx", "spdx"]);
/** npm's own noise (proxy agent warnings) is not part of the report. */
const NOISE = /UNDICI-EHPA|trace-warnings/u;

function fail(message) {
  process.stderr.write(`[sbom] ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = { out: null, omit: [], format: "cyclonedx", help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--out") options.out = argv[++index] ?? null;
    else if (arg === "--omit") options.omit.push(argv[++index] ?? "");
    else if (arg === "--format") options.format = argv[++index] ?? "";
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/**
 * Locates `npm-cli.js` without `PATH`, exactly like the product does.
 *
 * `npm`/`npm.cmd` on Windows need `shell: true`, which is the injection surface this project
 * removes everywhere (ADR-0002), so the CLI is always run as `node <absolute js path>`.
 */
function resolveNpmCli() {
  const candidates = [
    process.env.DSH_MCP_NPM_CLI?.trim(),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("could not locate npm-cli.js; set DSH_MCP_NPM_CLI to its absolute path");
}

function usage() {
  return [
    "npm run sbom [-- --out <path>] [-- --omit <dev|optional|peer|prod>] [-- --format cyclonedx|spdx]",
    "",
    "  stdout = the SBOM itself (safe to redirect)；stderr = 摘要与错误。",
    "  默认 cyclonedx（npm sbom 的默认格式），默认包含整棵依赖树；`--omit dev` 只留生产面。",
  ].join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (options.help) {
    process.stderr.write(`${usage()}\n`);
    return;
  }
  if (!SUPPORTED_FORMATS.has(options.format)) {
    fail(`unsupported --format ${JSON.stringify(options.format)}; expected one of ${[...SUPPORTED_FORMATS].join(", ")}`);
    return;
  }

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  let npmCli;
  try {
    npmCli = resolveNpmCli();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const args = [npmCli, "sbom", "--sbom-format", options.format];
  for (const omit of options.omit) {
    if (omit !== "") args.push("--omit", omit);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });

  const stdout = result.stdout ?? "";
  const stderr = (result.stderr ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "" && !NOISE.test(line))
    .join("\n");

  if (result.status !== 0 || stdout.trim() === "") {
    // Never swallowed: npm's own diagnostics go out verbatim, plus one actionable line when the
    // cause is the known one (an uninstalled tree).
    if (stderr !== "") process.stderr.write(`${stderr}\n`);
    if (/ESBOMPROBLEMS|missing:/u.test(stderr)) {
      fail(
        "npm sbom needs the installed tree (it cross-checks package-lock.json against node_modules). "
        + `Run \`npm ci\` in ${REPO_ROOT} first — the registry is not needed, but a fresh clone without install is not enough.`,
      );
    } else {
      fail(`npm sbom exited with ${String(result.status)}`);
    }
    return;
  }

  let document;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    fail(`npm sbom produced output that is not JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // The document must describe *this* package: an SBOM for another version would be worse than
  // no SBOM at all, because it looks authoritative.
  const component = document?.metadata?.component;
  const problems = [];
  if (options.format === "cyclonedx" && document?.bomFormat !== "CycloneDX") {
    problems.push(`bomFormat is ${JSON.stringify(document?.bomFormat)}, expected "CycloneDX"`);
  }
  if (typeof document?.specVersion !== "string" && options.format === "cyclonedx") {
    problems.push("specVersion is missing");
  }
  if (component?.name !== manifest.name) {
    problems.push(`metadata.component.name is ${JSON.stringify(component?.name)}, expected ${JSON.stringify(manifest.name)}`);
  }
  if (component?.version !== manifest.version) {
    problems.push(`metadata.component.version is ${JSON.stringify(component?.version)}, expected ${JSON.stringify(manifest.version)}`);
  }
  if (!Array.isArray(document?.components)) problems.push("components is not an array");
  if (problems.length > 0) {
    fail(`the SBOM does not match this package: ${problems.join("; ")}`);
    return;
  }

  const scopes = new Map();
  for (const entry of document.components) {
    const scope = typeof entry?.scope === "string" ? entry.scope : "(none)";
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
  }
  const production = document.components.filter(
    (entry) => entry?.scope !== "optional" && entry?.scope !== "excluded",
  ).length;
  const histogram = [...scopes.entries()].map(([scope, count]) => `${scope}×${String(count)}`).join(", ") || "none";

  if (options.out !== null) {
    const target = resolve(REPO_ROOT, options.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stdout.endsWith("\n") ? stdout : `${stdout}\n`, "utf8");
    process.stderr.write(`[sbom] wrote ${target}\n`);
  } else {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }

  const omit = options.omit.filter((value) => value !== "");
  process.stderr.write(
    `[sbom] ${options.format} ${String(document.specVersion)}: ${String(document.components.length)} components`
    + ` (${histogram}; production scope: ${String(production)}), root ${String(component.name)}@${String(component.version)}`
    + `${omit.length > 0 ? `, --omit ${omit.join(",")}` : ""}`
    + `${options.out === null ? " -> stdout" : ""}\n`,
  );
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
