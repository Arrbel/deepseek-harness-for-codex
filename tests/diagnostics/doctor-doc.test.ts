// Documentation ↔ `doctor` field parity (P7 item 7).
//
// `docs/operations.md` §4 and the README's `doctor` table are *claims about the report shape*.
// A claim nobody executes drifts, so the documented field set is asserted against the real
// top-level keys here — for both README languages. (`docs/**` is owned by the Lead: the same key
// list is handed over in `reports/impl-tool-surface.md` so §4 can be closed the same way.)

import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectRuntime } from "../../src/diagnostics/doctor.js";
import "../support/isolation.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const scratchDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-doctor-doc-"));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * Field names documented in the `doctor` table.
 *
 * Anchored on the table header (`| 字段 | 含义 |` / `| Field | Meaning |`), then reads every
 * backticked name from the first cell — a row may document two related keys (`nodeVersion` /
 * `nodeSupported`).
 */
function documentedDoctorKeys(markdown: string): string[] | null {
  const lines = markdown.split(/\r?\n/u);
  const header = lines.findIndex((line) => /^\|\s*(字段|Field)\s*\|/u.test(line));
  if (header === -1) return null;
  const names: string[] = [];
  for (let index = header + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("|")) break;
    const cell = line.split("|")[1] ?? "";
    const found = [...cell.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/gu)].map((match) => match[1]!);
    if (found.length === 0) return null;
    names.push(...found);
  }
  return names;
}

describe("doctor fields are the fields the README documents", () => {
  it("matches the real top-level key set in both languages", () => {
    const report = inspectRuntime({ DSH_MCP_DATA_DIR: scratch() });
    const keys = Object.keys(report).sort();

    for (const file of ["README.md", "README.en.md"]) {
      const documented = documentedDoctorKeys(readFileSync(join(repoRoot, file), "utf8"));
      expect(documented, `${file}: doctor table not found`).not.toBeNull();
      expect([...documented!].sort(), file).toEqual(keys);
    }
  });

  it("documents no field that the report does not have", () => {
    const keys = new Set(Object.keys(inspectRuntime({ DSH_MCP_DATA_DIR: scratch() })));

    const documented = documentedDoctorKeys(readFileSync(join(repoRoot, "README.md"), "utf8")) ?? [];
    expect(documented.filter((name) => !keys.has(name))).toEqual([]);
  });

  it("documents the value semantics, not just the key set", () => {
    const report = inspectRuntime({ DSH_MCP_DATA_DIR: scratch() }) as unknown as {
      ready: boolean;
      problems: string[];
      allowedWorkspaceRoots: string[];
      deprecatedEnv: string[];
      orphans: unknown[];
      surface: string;
      apiKeyInEnvironment: boolean;
      engines: { supported: boolean };
      dataDirectory: { writable: string };
    };

    // `ready` follows the four prerequisites only. Advisory problems (a leftover pidfile, for
    // instance) must never flip it — that is what "the four-term composition is not widened" means.
    expect(Array.isArray(report.problems)).toBe(true);
    expect(Array.isArray(report.orphans)).toBe(true);
    if (report.orphans.length === 0) {
      expect(report.ready).toBe(report.problems.length === 0);
    } else {
      expect(report.problems.some((line) => line.includes("orphaned"))).toBe(true);
      expect(report.orphans.length).toBeGreaterThan(0);
    }

    // `allowedWorkspaceRoots` is an array, and "unrestricted" is `[]`, never `null` (B2).
    expect(Array.isArray(report.allowedWorkspaceRoots)).toBe(true);
    expect(report.allowedWorkspaceRoots).toEqual([]);
    const configured = inspectRuntime({
      DSH_MCP_DATA_DIR: scratch(),
      // Platform-neutral roots: values joined with `path.delimiter` must not themselves contain
      // that delimiter. `C:\one` does on POSIX (`:` is both the drive colon and the list
      // separator), so the list would split into four entries and this test would be red on the
      // ubuntu/macOS CI columns (found by task-35's audit).
      DSH_MCP_WORKSPACE_ROOTS: ["/roots/one", "/roots/two"].join(delimiter),
    }) as unknown as { allowedWorkspaceRoots: string[] };
    expect(configured.allowedWorkspaceRoots).toEqual(["/roots/one", "/roots/two"]);

    expect(["yes", "no", "unknown"]).toContain(report.dataDirectory.writable);
    expect(typeof report.engines.supported).toBe("boolean");
    expect(Array.isArray(report.deprecatedEnv)).toBe(true);
    expect(report.surface).toBe("web");
    expect(typeof report.apiKeyInEnvironment).toBe("boolean");
  });

  it("keeps the READMEs' wording for those semantics (no `null` for unrestricted)", () => {
    const zh = readFileSync(join(repoRoot, "README.md"), "utf8");
    const en = readFileSync(join(repoRoot, "README.en.md"), "utf8");

    expect(zh).not.toContain("`null` 表示不限制");
    expect(en).not.toContain("`null` means unrestricted");
    // Both READMEs must spell "unrestricted" the way the code does: an empty array.
    const zhRow = zh.split(/\r?\n/u).find((line) => line.includes("`allowedWorkspaceRoots`")) ?? "";
    const enRow = en.split(/\r?\n/u).find((line) => line.includes("`allowedWorkspaceRoots`")) ?? "";
    expect(zhRow).toContain("`[]`");
    expect(enRow).toContain("`[]`");
  });

  it("states all three startup cases with measured numbers (no stale 4 s cold claim)", () => {
    const zh = readFileSync(join(repoRoot, "README.md"), "utf8");
    const en = readFileSync(join(repoRoot, "README.en.md"), "utf8");

    // The old text blamed a ~4 s "cold" start; a true cold start (empty DSH home) is ~20–30 s.
    expect(zh).not.toContain("冷态约 4 秒");
    expect(en).not.toContain("roughly 4 s cold");
    for (const [text, cold, warm, install] of [
      [zh, "20–30 秒", "约 4 秒", "486 MB"],
      [en, "20–30 s", "about 4 s", "486 MB"],
    ] as const) {
      expect(text).toContain(cold);
      expect(text).toContain(warm);
      expect(text).toContain(install);
    }
  });
});
