// Contract version matrix (R3-1).
//
// The wire contract used to be an implicit "whatever the pin happens to answer". This module makes
// it explicit and *per DSH version line*: which methods exist, which `turn/end.reason.kind`
// members can appear, which record kinds the page union carries, and which fields the client reads.
//
// Two rules keep it honest:
//
//   1. **Only the baseline carries a shape.** Every other line records its *differences* from the
//      baseline ({@link ContractDifferences}); {@link resolveShape} applies them. A line never
//      restates the whole surface, so a new line cannot silently fork the truth.
//   2. **Reading the matrix never fails a run.** {@link classifyContract} answers `exact`,
//      `compatible`, `unknown`, or `unsupported`; only `unsupported` (an installed version whose
//      line we have never recorded) may be treated as a prerequisite by `doctor`. `unknown` means
//      "nothing resolved yet", which is the normal state before the first install.
//
// Pure by construction: no IO, no clock, no process.

import { TURN_END_REASON_KINDS } from "./events.js";
import { parseExactPackageSpec } from "../policy/package-spec.js";

/** The wire surface of one DSH version line, as a comparable checklist. */
export interface ContractShape {
  /** RPC methods the line answers on `/api/<method>`. */
  readonly methods: readonly string[];
  /** `turn/end.reason.kind` members the line can publish. */
  readonly turnEndReasons: readonly string[];
  /** Event kinds observed on the `session/page` record union. */
  readonly pageRecordKinds: readonly string[];
  /** `session/list` item fields the client reads. */
  readonly sessionListFields: readonly string[];
  /** `session/projections` value fields the client reads. */
  readonly projectionFields: readonly string[];
  /** Fields the client requires from a `create` response value, per method. */
  readonly createValueFields: Readonly<Record<string, readonly string[]>>;
}

/**
 * A line's differences from the baseline — only what changed.
 *
 * Every list is optional: an absent list means "same as the baseline", so adding a version line
 * means writing down what actually moved, not copying the surface.
 */
export interface ContractDifferences {
  readonly methodsAdded?: readonly string[];
  readonly methodsRemoved?: readonly string[];
  readonly turnEndReasonsAdded?: readonly string[];
  readonly turnEndReasonsRemoved?: readonly string[];
  readonly pageRecordKindsAdded?: readonly string[];
  readonly pageRecordKindsRemoved?: readonly string[];
  readonly sessionListFieldsAdded?: readonly string[];
  readonly sessionListFieldsRemoved?: readonly string[];
  readonly projectionFieldsAdded?: readonly string[];
  readonly projectionFieldsRemoved?: readonly string[];
  readonly createValueFieldsAdded?: Readonly<Record<string, readonly string[]>>;
  readonly createValueFieldsRemoved?: Readonly<Record<string, readonly string[]>>;
}

/** One DSH version line of the matrix. */
export interface ContractLine {
  /** The version line, `major.minor.patch` — the key everything else is grouped by. */
  readonly dshLine: string;
  /** Full versions that were actually recorded for this line (prereleases included). */
  readonly recordedVersions: readonly string[];
  /** Directory under `tests/fixtures/recorded/` holding this line's capture. */
  readonly fixture: string;
  /** When the capture was taken; `null` for a line declared but not yet recorded. */
  readonly capturedAt: string | null;
  /** The authoritative source the capture was checked against. */
  readonly source: string;
  /** Exactly one line is the baseline; it is the only one allowed to carry `shape`. */
  readonly baseline: boolean;
  readonly shape?: ContractShape;
  readonly differences?: ContractDifferences;
}

/** The line the baseline shape is written against. */
export const BASELINE_DSH_LINE = "0.2.1";

/**
 * The matrix.
 *
 * `0.2.1` is the baseline and the only recorded line today. A line is added here *with* its
 * `tests/fixtures/recorded/<fixture>/` capture — never as a duplicate of the baseline set
 * (that is what `differences` is for).
 */
export const CONTRACT_MATRIX: readonly ContractLine[] = [
  {
    dshLine: BASELINE_DSH_LINE,
    recordedVersions: ["0.2.1-alpha.1"],
    fixture: BASELINE_DSH_LINE,
    capturedAt: "2026-10-08T13:49:51.421Z",
    source: "deepseek-harness checkout (packages/core/session/src/types.ts, packages/api/session-controller/src/history.ts)",
    baseline: true,
    shape: {
      methods: ["workspace/create", "session/create", "session/list", "session/projections", "session/page", "session/prompt", "session/cancel"],
      turnEndReasons: [...TURN_END_REASON_KINDS],
      pageRecordKinds: [
        "agent/inbox/spliced",
        "approval/policy",
        "assistant/attempt",
        "assistant/message",
        "permission/preset",
        "request/context",
        "request/header",
        "sandbox/mode",
        "session/title",
        "session/title-llm-request",
        "step/end",
        "step/start",
        "system/message",
        "turn/end",
        "turn/start",
        "user/message",
      ],
      sessionListFields: ["agentAvailable", "blank", "cwd", "projections", "running", "sessionId", "updatedAt"],
      projectionFields: ["title"],
      createValueFields: { "workspace/create": ["workspaceId"], "session/create": ["sessionId"] },
    },
  },
];

/** The version line of a full version: `0.2.1-alpha.1` → `0.2.1`; `null` when unparseable. */
export function dshLineOf(version: string | null | undefined): string | null {
  if (typeof version !== "string") return null;
  const match = /^(\d+\.\d+\.\d+)/u.exec(version.trim());
  return match?.[1] ?? null;
}

/**
 * The exact version inside a package spec, or `null` when the spec is not an exact one.
 *
 * Tolerant on purpose: `doctor` reports rather than throws, so an unusable spec degrades to `null`,
 * which {@link classifyContract} answers with `unknown` — explicitly *not* a problem.
 */
export function versionOfSpec(spec: string | null | undefined): string | null {
  if (typeof spec !== "string" || spec.trim() === "") return null;
  try {
    return parseExactPackageSpec(spec).version;
  } catch {
    return null;
  }
}

/** The matrix line for a version line, or `null` when that line was never recorded. */
export function matrixLine(dshLine: string | null): ContractLine | null {
  if (dshLine === null) return null;
  return CONTRACT_MATRIX.find((line) => line.dshLine === dshLine) ?? null;
}

function withAdded(base: readonly string[], added: readonly string[] | undefined): string[] {
  return [...new Set([...base, ...(added ?? [])])];
}

function withoutRemoved(base: readonly string[], removed: readonly string[] | undefined): string[] {
  const drop = new Set(removed ?? []);
  return base.filter((entry) => !drop.has(entry));
}

/**
 * The effective shape of a line: the baseline's, with that line's differences applied.
 *
 * Removal is applied after addition, so a line that both adds and removes the same name ends up
 * without it — the explicit statement wins.
 */
export function resolveShape(line: ContractLine): ContractShape {
  if (line.baseline) {
    if (line.shape === undefined) throw new Error(`the baseline line ${line.dshLine} has no shape`);
    return line.shape;
  }
  const base = CONTRACT_MATRIX.find((entry) => entry.baseline);
  if (base === undefined) throw new Error("the contract matrix has no baseline line");
  const shape = resolveShape(base);
  const diff = line.differences ?? {};
  const createValueFields: Record<string, readonly string[]> = {};
  for (const [method, fields] of Object.entries(shape.createValueFields)) {
    createValueFields[method] = withoutRemoved(withAdded(fields, diff.createValueFieldsAdded?.[method]), diff.createValueFieldsRemoved?.[method]);
  }
  for (const [method, fields] of Object.entries(diff.createValueFieldsAdded ?? {})) {
    if (createValueFields[method] === undefined) createValueFields[method] = [...fields];
  }
  return {
    methods: withoutRemoved(withAdded(shape.methods, diff.methodsAdded), diff.methodsRemoved),
    turnEndReasons: withoutRemoved(withAdded(shape.turnEndReasons, diff.turnEndReasonsAdded), diff.turnEndReasonsRemoved),
    pageRecordKinds: withoutRemoved(withAdded(shape.pageRecordKinds, diff.pageRecordKindsAdded), diff.pageRecordKindsRemoved),
    sessionListFields: withoutRemoved(withAdded(shape.sessionListFields, diff.sessionListFieldsAdded), diff.sessionListFieldsRemoved),
    projectionFields: withoutRemoved(withAdded(shape.projectionFields, diff.projectionFieldsAdded), diff.projectionFieldsRemoved),
    createValueFields,
  };
}

/** How well the resolved version matches the recorded matrix. */
export type ContractStatus = "exact" | "compatible" | "unknown" | "unsupported";

/** The `doctor.contract` key: what we know, and how sure we are. */
export interface ContractReport {
  /** Matrix line the resolved version belongs to, or `null` when nothing resolved. */
  readonly dshLine: string | null;
  /** The version the configured harness package resolves to, or `null`. */
  readonly installedVersion: string | null;
  readonly status: ContractStatus;
  /** The line the shape is written against. */
  readonly baselineDshLine: string;
  /** Full versions recorded for the resolved line; empty when the line is unknown. */
  readonly recordedVersions: readonly string[];
  /** What changed in this line relative to the baseline; `null` when the line is unknown. */
  readonly differences: ContractDifferences | null;
  /** One line an operator can act on. */
  readonly detail: string;
}

/**
 * Classifies a resolved harness version against the matrix.
 *
 * `exact` is a recorded version of a known line; `compatible` is another version of that same
 * line (a patch or a different prerelease, where the surface has not moved); `unknown` means no
 * version could be resolved — which is the state *before the first install*, so it must never be
 * reported as a problem; `unsupported` means a version line whose wire we have never recorded.
 */
export function classifyContract(version: string | null): ContractReport {
  const line = dshLineOf(version);
  const unknown: ContractReport = {
    dshLine: null,
    installedVersion: version ?? null,
    status: "unknown",
    baselineDshLine: BASELINE_DSH_LINE,
    recordedVersions: [],
    differences: null,
    detail: "No harness version could be resolved from the configured package spec yet.",
  };
  if (line === null) return unknown;
  const entry = matrixLine(line);
  if (entry === null) {
    return {
      ...unknown,
      dshLine: line,
      status: "unsupported",
      detail: `The harness version line ${line} has no recorded contract (matrix lines: ${CONTRACT_MATRIX.map((item) => item.dshLine).join(", ")}). The wire may have changed; pin DSH_MCP_HARNESS_PACKAGE to a recorded line.`,
    };
  }
  const status: ContractStatus = entry.recordedVersions.includes(version ?? "") ? "exact" : "compatible";
  const differences = entry.differences ?? {};
  return {
    dshLine: line,
    installedVersion: version ?? null,
    status,
    baselineDshLine: BASELINE_DSH_LINE,
    recordedVersions: entry.recordedVersions,
    differences,
    detail: status === "exact"
      ? `Recorded contract for ${line} (${entry.recordedVersions.join(", ")}); the resolved version matches it exactly.`
      : `Resolved ${String(version)} is on the recorded line ${line} but was not itself recorded (${entry.recordedVersions.join(", ")}); the surface is assumed unchanged.`,
  };
}

/**
 * True when the status may be treated as a prerequisite failure.
 *
 * The whole point of the discipline: only a version line we have *never recorded* can block a run.
 * `compatible` (a patch we have not seen) and `unknown` (nothing resolved yet) never do.
 */
export function contractBlocksReadiness(report: ContractReport): boolean {
  return report.status === "unsupported";
}
