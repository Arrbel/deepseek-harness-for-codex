// Filesystem reader that turns a checkout into the snapshot evaluated by
// scripts/lib/metadata.mjs. Kept separate from the pure model so that
// tests/metadata.test.ts can exercise the model without touching the disk.

import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIST_FILES,
  MARKETPLACE_REL,
  PLUGIN_DIR_REL,
  externalImports,
  hashPathsFor,
  textPathsFor,
} from "./metadata.mjs";

/** Repository root that contains package.json. */
export function defaultRepoRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function toPosix(path) {
  return path.split(sep).join("/");
}

async function readTextFile(root, rel) {
  try {
    return await readFile(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

async function readJsonFile(root, rel) {
  const text = await readTextFile(root, rel);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function hashPath(root, rel) {
  try {
    const bytes = await readFile(join(root, rel));
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

async function listFilesRecursive(root, dirRel) {
  const absolute = join(root, dirRel);
  const found = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        found.push(toPosix(relative(root, child)));
      }
    }
  }
  await walk(absolute);
  return found.sort();
}

/**
 * Reads the checkout into an evaluation snapshot.
 * @param {string} [root]
 */
export async function readRepoSnapshot(root = defaultRepoRoot()) {
  const manifest = (await readJsonFile(root, "package.json")) ?? {};
  const name = typeof manifest.name === "string" ? manifest.name : "unknown";
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";

  const texts = new Map();
  for (const rel of textPathsFor(name, version)) {
    texts.set(rel, await readTextFile(root, rel));
  }

  const hashes = new Map();
  const sourceHashes = new Map();
  for (const rel of hashPathsFor(name, version)) {
    const value = await hashPath(root, rel);
    hashes.set(rel, value);
    sourceHashes.set(rel, value);
  }

  const listings = new Map();
  listings.set(PLUGIN_DIR_REL, await listFilesRecursive(root, PLUGIN_DIR_REL));

  const distImports = new Map();
  for (const file of DIST_FILES) {
    const rel = `dist/${file}`;
    const content = await readTextFile(root, rel);
    if (content !== null) {
      distImports.set(rel, externalImports(content));
    }
  }

  return {
    root,
    manifest,
    lock: await readJsonFile(root, "package-lock.json"),
    marketplace: await readJsonFile(root, MARKETPLACE_REL),
    texts,
    hashes,
    sourceHashes,
    listings,
    distImports,
  };
}
