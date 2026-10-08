#!/usr/bin/env node
// Generates every version-bearing artifact from package.json (ADR-0001).
//
//   node scripts/version-sync.mjs            # write: regenerate root metadata + the plugin payload
//   node scripts/version-sync.mjs --check    # verify only, never writes, exits 1 on drift
//
// The generated plugin directory is git-ignored on purpose: a committed copy is a second
// version fact that inevitably drifts (that is the incident ADR-0001 fixes).

import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import {
  PLUGIN_DIR_REL,
  evaluateMetadata,
  expectedArtifacts,
  formatFindings,
} from "./lib/metadata.mjs";
import { defaultRepoRoot, readRepoSnapshot } from "./lib/repo-snapshot.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const rootIndex = args.indexOf("--root");
const root = rootIndex === -1 ? defaultRepoRoot() : resolve(args[rootIndex + 1] ?? ".");

async function readBytesOrNull(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function readManifest() {
  const bytes = await readBytesOrNull(join(root, "package.json"));
  if (bytes === null) throw new Error(`package.json not found under ${root}`);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json must define string name and version");
  }
  return manifest;
}

async function walk(dir, kind, found) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (kind === "dir") found.push(child);
      await walk(child, kind, found);
    } else if (entry.isFile() && kind === "file") {
      found.push(child);
    }
  }
  return found;
}

/** Writes the expected artifacts, then removes anything no longer derived. */
async function writeExpected(manifest) {
  const artifacts = expectedArtifacts({ name: manifest.name, version: manifest.version });
  const written = [];
  const unchanged = [];
  const skipped = [];

  for (const artifact of artifacts) {
    const target = join(root, artifact.path);
    if (artifact.kind === "text") {
      const existing = await readBytesOrNull(target);
      if (existing !== null && existing.toString("utf8") === artifact.text) {
        unchanged.push(artifact.path);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, artifact.text, "utf8");
      written.push(artifact.path);
      continue;
    }
    const source = await readBytesOrNull(join(root, artifact.copyFrom));
    if (source === null) {
      skipped.push(`${artifact.path} (source ${artifact.copyFrom} not built yet)`);
      continue;
    }
    const existing = await readBytesOrNull(target);
    if (existing !== null && Buffer.compare(existing, source) === 0) {
      unchanged.push(artifact.path);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    written.push(artifact.path);
  }

  // Remove stale files under the generated plugin directory so a shrinking template
  // cannot leave hand-added or previously generated files in the copied payload.
  const pluginDir = resolve(root, PLUGIN_DIR_REL);
  const guard = resolve(root, ...PLUGIN_DIR_REL.split("/"));
  if (pluginDir !== guard || pluginDir === resolve(root)) {
    throw new Error(`refusing to clean unexpected directory: ${pluginDir}`);
  }
  const expected = new Set(
    artifacts
      .filter((artifact) => artifact.path.startsWith(`${PLUGIN_DIR_REL}/`))
      .map((artifact) => resolve(root, ...artifact.path.split("/"))),
  );
  const removed = [];
  for (const file of await walk(pluginDir, "file", [])) {
    if (!expected.has(resolve(file))) {
      await rm(file);
      removed.push(file.slice(resolve(root).length + 1).split(sep).join("/"));
    }
  }
  for (const dir of (await walk(pluginDir, "dir", [])).reverse()) {
    await rmdir(dir).catch(() => {});
  }

  return { written, unchanged, skipped, removed };
}

async function main() {
  const manifest = await readManifest();

  if (checkOnly) {
    const findings = evaluateMetadata(await readRepoSnapshot(root));
    if (findings.length > 0) {
      console.error(`version-sync --check: ${findings.length} metadata problem(s)`);
      console.error(formatFindings(findings));
      process.exitCode = 1;
      return;
    }
    console.log(`version-sync --check: OK (${manifest.name}@${manifest.version})`);
    return;
  }

  const result = await writeExpected(manifest);
  console.log(`version-sync: ${manifest.name}@${manifest.version}`);
  console.log(
    `  wrote ${result.written.length}, unchanged ${result.unchanged.length}, removed ${result.removed.length}, skipped ${result.skipped.length}`,
  );
  for (const path of result.written) console.log(`  + ${path}`);
  for (const path of result.removed) console.log(`  - ${path}`);
  for (const path of result.skipped) console.warn(`  ! skipped ${path}`);
  if (result.skipped.length > 0) {
    console.warn("  ! run `npm run build` so the plugin payload can include dist/");
  }
}

try {
  await main();
} catch (error) {
  console.error(`version-sync: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
