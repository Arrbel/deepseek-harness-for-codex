// Layering gates for Phase 4 (ADR-0001 / ADR-0003, `docs/architecture.md` §2).
//
// Three invariants are asserted here:
//
//   1. **Dependency direction** — the layer matrix in `docs/architecture.md` §2 is the source
//      of truth: an inner layer may not reach back out to an outer one.
//   2. **Pure modules stay pure** — `policy/*`, `config/*`, `dsh/{types,contract,wire,events}.ts`,
//      `run/{state,registry,types}.ts`, `service/credentials.ts`, and `util/*` must not import
//      IO modules, because "deterministic unit test" is the whole reason they exist.
//   3. **The aggregating modules are gone** — `run-manager.ts`, `server.ts`, `runtime.ts`, and
//      the flat `types.ts` must not come back, not even as forwarding shells.
//
// A boundary that is only described in prose drifts; this file is the mechanical check.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "./support/isolation.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceOf(file: string): string {
  return readFileSync(join(srcRoot, file), "utf8");
}

/** Every `.ts` file under `src/`, relative to `src/`. */
function collect(directory = srcRoot, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...collect(join(directory, entry.name), relative));
    else if (entry.name.endsWith(".ts")) files.push(relative);
  }
  return files;
}

/** Every module specifier imported by `file` (static imports and re-exports). */
function importsOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/\bfrom\s*"([^"]+)"/gu)].map((match) => match[1]!);
}

/** A declared boundary rule: one source file may not reach one import specifier. */
interface BoundaryRule {
  /** Source file, relative to `src/`. */
  file: string;
  /** Import specifier that must not appear. */
  forbidden: RegExp;
  /** Which layer owns the forbidden dependency. */
  reason: string;
}

const DIRECTION_RULES: BoundaryRule[] = [
  // config is the innermost layer: env in, validated values out, no IO and no outer layer.
  {
    file: "config/resolve.ts",
    forbidden: /^node:(fs|child_process|net)$|^\.\.\/(policy|dsh|service|run|tools|app|diagnostics)\//u,
    reason: "config is pure: it reads the passed env map only, never the filesystem or an outer layer",
  },
  {
    file: "config/types.ts",
    forbidden: /./u,
    reason: "config types are a pure declaration module",
  },
  // policy decides; it does not spawn or fetch.
  {
    file: "policy/package-spec.ts",
    forbidden: /^node:/u,
    reason: "spec legality and engine ranges are decided from the string alone",
  },
  {
    file: "policy/trusted-input.ts",
    forbidden: /^node:/u,
    reason: "input predicates are pure",
  },
  {
    file: "policy/paths.ts",
    forbidden: /^node:(?!path)/u,
    reason: "path predicates use `node:path` only",
  },
  {
    file: "policy/workspace.ts",
    forbidden: /^\.\.\/(dsh|service|run|tools|app|diagnostics)\//u,
    reason: "workspace policy may not depend on a transport, process, or orchestration layer",
  },
  // dsh: the RPC client owns no process and no run state.
  {
    file: "dsh/client.ts",
    forbidden: /^\.\.\/(service\/(supervisor|runtime-package|process-tree|browser|launch|npm-cli|readiness)|run|tools|app|diagnostics)\//u,
    reason: "the RPC client owns no process and no run state",
  },
  // service: process ownership may not reach the tool surface, the composition root, or runs.
  {
    file: "service/supervisor.ts",
    forbidden: /^\.\.\/(run|tools|app|diagnostics)\//u,
    reason: "service lifecycle must not depend on the run layer, the tool surface, or the composition root",
  },
  {
    file: "service/launch.ts",
    forbidden: /^\.\.\//u,
    reason: "the launch vector is the innermost process shape",
  },
  // run: orchestration may not know the tool surface or the composition root.
  {
    file: "run/orchestrator.ts",
    forbidden: /^\.\.\/(tools|app|diagnostics)\//u,
    reason: "orchestration must not depend on the MCP surface or the composition root",
  },
  {
    file: "run/registry.ts",
    forbidden: /^\.\.\//u,
    reason: "the run registry is pure bookkeeping",
  },
  {
    file: "run/state.ts",
    forbidden: /^\.\.\//u,
    reason: "the run state machine is pure",
  },
  // tools: the transport adapts; it decides nothing.
  {
    file: "tools/register.ts",
    forbidden: /^\.\.\/(app|run|service|dsh|policy|config|diagnostics)\//u,
    reason: "the transport layer may only know the catalogue and the version constants",
  },
  // diagnostics reports prerequisites and takes no part in orchestration.
  {
    file: "diagnostics/doctor.ts",
    forbidden: /^\.\.\/(run|tools|app)\//u,
    reason: "diagnostics reports prerequisites and takes no part in orchestration",
  },
];

/**
 * Files declared pure modules by `docs/architecture.md` §2.
 *
 * `policy/paths.ts` uses only `node:path` (pure); `policy/workspace.ts` legitimately uses
 * `node:fs/promises` because resolving a workspace *is* the filesystem policy.
 */
const PURE_FILES = [
  "config/resolve.ts",
  "config/types.ts",
  "dsh/contract.ts",
  "dsh/events.ts",
  "dsh/matrix.ts",
  "dsh/types.ts",
  "dsh/wire.ts",
  "policy/package-spec.ts",
  "policy/paths.ts",
  "policy/trusted-input.ts",
  "run/registry.ts",
  "run/state.ts",
  "run/types.ts",
  "service/credentials.ts",
  "util/errors.ts",
  "util/ids.ts",
  "util/redaction.ts",
];

/** Layers a pure module must never reach into. */
const OUTER_LAYERS = /\/(service|run|tools|app|diagnostics)\//u;

/** Concrete collaborators whose construction belongs to the composition root. */
const OWNED_CONSTRUCTORS = ["ServiceSupervisor", "RunOrchestrator", "RunRegistry", "DshClient"];
const CONSTRUCTION_ALLOWED_IN = new Set(["app/container.ts", "service/supervisor.ts", "run/orchestrator.ts"]);

describe("module boundaries", () => {
  it("does not let an inner layer reach back into an outer one", () => {
    const violations: string[] = [];
    for (const rule of DIRECTION_RULES) {
      if (!existsSync(join(srcRoot, rule.file))) {
        violations.push(`${rule.file} is missing from the layered structure`);
        continue;
      }
      for (const specifier of importsOf(rule.file)) {
        if (rule.forbidden.test(specifier)) violations.push(`${rule.file} → ${specifier}: ${rule.reason}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps every pure module free of filesystem, child-process, and socket imports", () => {
    const violations: string[] = [];
    for (const file of PURE_FILES) {
      if (!existsSync(join(srcRoot, file))) {
        violations.push(`${file} is missing from the layered structure`);
        continue;
      }
      for (const specifier of importsOf(file)) {
        if (/^node:(fs|child_process|net)(\/|$)/u.test(specifier)) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("does not let a pure module reach into an IO layer", () => {
    const violations: string[] = [];
    for (const file of PURE_FILES) {
      if (!existsSync(join(srcRoot, file))) continue;
      for (const specifier of importsOf(file)) {
        if (OUTER_LAYERS.test(specifier)) violations.push(`${file} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the shared DTO modules type-only", () => {
    expect(importsOf("dsh/types.ts")).toEqual([]);
    expect(importsOf("run/types.ts")).toEqual([]);
    expect(importsOf("config/types.ts")).toEqual([]);
  });

  it("keeps the transport layer free of layer-crossing re-exports", () => {
    expect(sourceOf("tools/register.ts")).not.toMatch(/export\s+\*\s+from/u);
  });

  it("constructs a layer's implementation only where that layer is owned", () => {
    // `new ServiceSupervisor(...)` in an inner layer would let it start owning another
    // layer's lifecycle — the regression this refactor exists to prevent.
    const violations: string[] = [];
    for (const file of ["bin.ts", ...collect()]) {
      if (CONSTRUCTION_ALLOWED_IN.has(file)) continue;
      const source = sourceOf(file);
      for (const name of OWNED_CONSTRUCTORS) {
        if (new RegExp(`new\\s+${name}\\s*\\(`, "u").test(source)) violations.push(`${file}: new ${name}()`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no longer carries the pre-refactor aggregating modules", () => {
    for (const file of ["run-manager.ts", "server.ts", "runtime.ts", "types.ts"]) {
      expect(existsSync(join(srcRoot, file)), `src/${file} must not exist after Phase 4`).toBe(false);
    }
  });
});
