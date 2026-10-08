#!/usr/bin/env node
// Packaging gate: asserts that every version fact and every distribution path is derived
// from package.json (ADR-0001) and that the generated plugin payload still resolves.
//
//   node scripts/check-metadata.mjs                     # offline, deterministic: used by `npm run check`
//   node scripts/check-metadata.mjs --self-contained    # + launch the generated plugin for real
//   node scripts/check-metadata.mjs --registry          # + verify any self-pin against npm
//
// The offline mode is the gate. `--registry` is opt-in because CI must not need the network.

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  MARKETPLACE_REL,
  MCP_SERVER_NAME,
  PLUGIN_DIR_REL,
  PLUGIN_NAME,
  evaluateMetadata,
  formatFindings,
} from "./lib/metadata.mjs";
import { defaultRepoRoot, readRepoSnapshot } from "./lib/repo-snapshot.mjs";
import { pluginPayloadExists, probePluginLaunch } from "./lib/self-contained-probe.mjs";

const args = process.argv.slice(2);
const withRegistry = args.includes("--registry");
// The runtime probe starts a real MCP server, so it is only requested by
// `npm run prepare:plugin` (after the build produced the payload).
const withSelfContained = args.includes("--self-contained");
const rootIndex = args.indexOf("--root");
const root = rootIndex === -1 ? defaultRepoRoot() : resolve(args[rootIndex + 1] ?? ".");

/** Files that could ship a self-referencing version pin to a user. */
const PIN_SURFACE = [
  "package.json",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  "README.md",
  "README.en.md",
  "skills/deepseek-harness/SKILL.md",
  `${PLUGIN_DIR_REL}/.mcp.json`,
  `${PLUGIN_DIR_REL}/.codex-plugin/plugin.json`,
  `${PLUGIN_DIR_REL}/skills/deepseek-harness/SKILL.md`,
];

/** Self-pins that must exist on the registry if any distributed file still declares one. */async function collectSelfPins(names) {
  const pins = new Set();
  for (const rel of PIN_SURFACE) {
    let text;
    try {
      text = await readFile(join(root, ...rel.split("/")), "utf8");
    } catch {
      continue;
    }
    for (const name of names) {
      const pattern = new RegExp(`${name.replace(/[/@.]/g, "\\$&")}@(\\d+\\.\\d+\\.\\d+[0-9A-Za-z.+-]*)`, "g");
      for (const match of text.matchAll(pattern)) pins.add(`${name}@${match[1]}`);
    }
  }
  return [...pins].sort();
}

function publishedVersions(name) {
  // A direct registry request avoids spawning npm (on Windows `npm.cmd` cannot be
  // spawned without a shell, and spawning a shell is exactly what the security model forbids).
  const registry = (process.env.DSH_MCP_REGISTRY ?? "https://registry.npmjs.org/").replace(/\/$/, "");
  const path = name.startsWith("@") ? name.replace("/", "%2f") : name;
  return fetch(`${registry}/${path}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(20_000),
  })
    .then(async (response) => {
      if (response.status === 404) {
        return { ok: true, versions: [] };
      }
      if (!response.ok) {
        return { ok: false, reason: `registry returned HTTP ${response.status}`, versions: [] };
      }
      const body = await response.json();
      return { ok: true, versions: Object.keys(body.versions ?? {}) };
    })
    .catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      versions: [],
    }));
}

/**
 * The tool names a README documents.
 *
 * Anchored on the tools-table header (`| 工具 | 用途 |` / `| Tool | Purpose |`) and read from the
 * first column of the rows that follow, so other tables (`doctor` fields, env vars) cannot be
 * mistaken for the tool surface. Returns `null` when the table itself cannot be found.
 */
function documentedToolNames(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const header = lines.findIndex((line) => /^\|\s*(工具|Tool)\s*\|/u.test(line));
  if (header === -1) return null;
  const names = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("|")) break;
    const cell = line.split("|")[1]?.trim() ?? "";
    const match = /^`([a-z][a-z0-9_]*)`$/u.exec(cell);
    if (match === null) return null;
    names.push(match[1]);
  }
  return names;
}

/**
 * The tool surface the plugin advertises must equal the one the READMEs document.
 *
 * Source of truth: the **advertised** list, read from the launched plugin (so a table that was
 * never wired into `register.ts` is caught too). Any difference — a tool the docs forgot, or a
 * tool the docs still describe after deletion — fails the gate.
 */
function checkToolSurface(readmeTexts, advertised) {
  const findings = [];
  const expected = [...advertised].sort();
  for (const [file, text] of readmeTexts) {
    const documented = documentedToolNames(text);
    if (documented === null) {
      findings.push({
        code: "tool-surface-unreadable",
        path: file,
        message: "could not read the tools table (expected a `| 工具 | 用途 |` / `| Tool | Purpose |` header with `\\`tool_name\\`` cells)",
      });
      continue;
    }
    const missing = expected.filter((name) => !documented.includes(name));
    const extra = documented.filter((name) => !expected.includes(name));
    if (missing.length > 0 || extra.length > 0) {
      findings.push({
        code: "tool-surface-drift",
        path: file,
        message:
          `documented [${documented.sort().join(", ")}] but the plugin advertises [${expected.join(", ")}]`
          + `${missing.length > 0 ? `; document these: ${missing.join(", ")}` : ""}`
          + `${extra.length > 0 ? `; remove these (no such tool): ${extra.join(", ")}` : ""}`,
      });
      continue;
    }
    console.log(`tool surface (${file})   : OK (${documented.length} tools match the plugin)`);
  }
  return findings;
}

async function main() {
  const snapshot = await readRepoSnapshot(root);
  const findings = evaluateMetadata(snapshot);
  const manifest = snapshot.manifest;

  const pluginManifest = (() => {
    try {
      const text = snapshot.texts?.get(`${PLUGIN_DIR_REL}/.codex-plugin/plugin.json`);
      return text === null || text === undefined ? null : JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const pluginMcp = (() => {
    try {
      const text = snapshot.texts?.get(`${PLUGIN_DIR_REL}/.mcp.json`);
      return text === null || text === undefined ? null : JSON.parse(text);
    } catch {
      return null;
    }
  })();
  const marketplaceEntry = (snapshot.marketplace?.plugins ?? []).find(
    (plugin) => plugin?.name === PLUGIN_NAME,
  );

  console.log(`package.json            : ${manifest.name}@${manifest.version}`);
  console.log(`package-lock.json       : ${snapshot.lock?.packages?.[""]?.name ?? "?"}@${snapshot.lock?.packages?.[""]?.version ?? "?"}`);
  console.log(`marketplace             : ${MARKETPLACE_REL} -> ${marketplaceEntry?.source?.path ?? "?"}`);
  console.log(`plugin manifest         : ${pluginManifest?.name ?? "?"}@${pluginManifest?.version ?? "?"}`);
  const server = pluginMcp?.mcpServers?.[MCP_SERVER_NAME];
  console.log(
    `plugin launch           : ${server?.command ?? "?"} ${JSON.stringify(server?.args ?? [])} (cwd ${server?.cwd ?? "?"})`,
  );

  if (withSelfContained) {
    if (!(await pluginPayloadExists(root))) {
      findings.push({
        code: "plugin-payload-missing",
        path: `${PLUGIN_DIR_REL}/${PLUGIN_ENTRY_REL}`,
        message: "the generated plugin payload is missing; run: npm run build",
      });
    } else {
      const probe = await probePluginLaunch({ root });
      if (!probe.ok) {
        findings.push({
          code: "plugin-not-self-contained",
          path: `${PLUGIN_DIR_REL}/${PLUGIN_ENTRY_REL}`,
          message: `launching the generated plugin from its own directory failed: ${probe.error ?? `missing tools: ${probe.missingTools.join(", ")}`}`,
        });
      } else {
        console.log(
          `plugin launch probe     : OK (${probe.tools.length} tools over stdio, cwd = plugin root, server ${probe.serverName ?? "?"}@${probe.serverVersion ?? "?"})`,
        );
        if (probe.serverVersion !== manifest.version) {
          findings.push({
            code: "plugin-server-version-drift",
            path: `${PLUGIN_DIR_REL}/${PLUGIN_ENTRY_REL}`,
            message: `the launched plugin reports MCP server version ${String(probe.serverVersion)}, expected ${manifest.version}`,
          });
        }
        // Documentation ↔ tool-surface gate (P7): the README tables are a *claim* about the
        // advertised surface, and a claim nobody executes is exactly what drifts.
        const readmeTexts = [];
        for (const file of ["README.md", "README.en.md"]) {
          const text = snapshot.texts?.get(file) ?? (await readFile(join(root, file), "utf8"));
          readmeTexts.push([file, text]);
        }
        findings.push(...checkToolSurface(readmeTexts, probe.tools));
      }
    }
  }

  if (withRegistry) {
    const pins = await collectSelfPins([manifest.name, PLUGIN_NAME]);
    const published = await publishedVersions(manifest.name);
    if (!published.ok) {
      console.warn(`registry check: unavailable (${published.reason})`);
    } else {
      console.log(`registry ${manifest.name}: ${published.versions.join(", ") || "(none)"}`);
      for (const pin of pins) {
        const lastAt = pin.lastIndexOf("@");
        const name = lastAt > 0 ? pin.slice(0, lastAt) : manifest.name;
        const version = lastAt > 0 ? pin.slice(lastAt + 1) : pin;
        if (name !== manifest.name) continue;
        if (!published.versions.includes(version)) {
          findings.push({
            code: "unpublished-self-pin",
            path: "repository",
            message: `${pin} is not published on the registry`,
          });
        }
      }
      if (pins.length === 0) {
        console.log("registry check: no self-referencing version pin found (plugin is self-contained)");
      }
    }
  }

  if (findings.length > 0) {
    console.error(`check-metadata: ${findings.length} problem(s)`);
    console.error(formatFindings(findings));
    process.exitCode = 1;
    return;
  }
  console.log(`check-metadata: OK (single source of truth: package.json@${manifest.version})`);
}

try {
  await main();
} catch (error) {
  console.error(`check-metadata: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
