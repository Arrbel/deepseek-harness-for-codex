// R3-1: the contract version matrix is an index, and this file holds it to its evidence.
//
// A matrix that is not compared against the capture (or against the official checkout) is a claim
// nobody executes. Two kinds of assertion live here:
//
//   1. **The baseline entry is true** — its method set, `turn/end.reason.kind` set, page record
//      kinds, and `session/list` field set are compared with `src/dsh/contract.ts`, the recorded
//      capture under `tests/fixtures/recorded/<dshLine>/`, and (when present) the official checkout.
//   2. **The differencing mechanism works** — `resolveShape` applies a line's differences to the
//      baseline, and `classifyContract` answers all four statuses. Both are exercised with
//      synthetic lines so a future line cannot be added by copying the baseline shape.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { METHODS } from "../../src/dsh/contract.js";
import { TURN_END_REASON_KINDS } from "../../src/dsh/events.js";
import {
  BASELINE_DSH_LINE,
  CONTRACT_MATRIX,
  classifyContract,
  contractBlocksReadiness,
  dshLineOf,
  matrixLine,
  resolveShape,
  versionOfSpec,
  type ContractLine,
} from "../../src/dsh/matrix.js";
import "../support/isolation.js";

const testsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const recordedRoot = join(testsRoot, "fixtures", "recorded");
const sourceCheckout = join(testsRoot, "..", "..", "deepseek-harness");

const pointer = JSON.parse(readFileSync(join(recordedRoot, "current.json"), "utf8")) as { dshLine: string };
const lineDir = join(recordedRoot, pointer.dshLine);

function recorded<T>(name: string): T {
  return JSON.parse(readFileSync(join(lineDir, name), "utf8")) as T;
}

const baseline = CONTRACT_MATRIX.find((line) => line.baseline)!;
const baselineShape = resolveShape(baseline);

describe("contract matrix: the baseline entry is held to its evidence", () => {
  it("lists exactly the methods the client actually implements", () => {
    // The matrix is what a future version is compared against; if it drifts from the code, a
    // compatibility verdict would be computed against a fiction.
    expect([...baselineShape.methods].sort()).toEqual(Object.keys(METHODS).sort());
  });

  it("records the official turn/end reason kinds, one for one", () => {
    expect([...baselineShape.turnEndReasons].sort()).toEqual([...TURN_END_REASON_KINDS].sort());
    // The four the project deliberately maps, plus the two that stay "unknown" by design.
    for (const kind of ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"]) {
      expect(baselineShape.turnEndReasons).toContain(kind);
    }
  });

  it("declares a page record union that contains every kind the capture carries", () => {
    const page = recorded<{ records: { event: { type: string } }[] }>("session-page.json");
    const observed = [...new Set(page.records.map((record) => record.event.type))].sort();
    expect(observed.length).toBeGreaterThan(0);
    // Every recorded kind must be declared: an undeclared kind is unpriced drift.
    for (const kind of observed) expect(baselineShape.pageRecordKinds, kind).toContain(kind);

    // Declared kinds this particular capture did not happen to contain are written down rather
    // than left implicit. `assistant/message` is still part of the union the client handles (the
    // contract validates it, `projectAssistantText` reads it, the synthetic fixture emits it) —
    // this capture's session simply produced `assistant/attempt` instead. If a future capture
    // gains or loses one, this list is what asks a human to confirm the union really moved.
    const unobserved = baselineShape.pageRecordKinds.filter((kind) => !observed.includes(kind));
    expect(unobserved).toEqual(["assistant/message"]);
    const fixture = readFileSync(join(testsRoot, "fixtures", "fake-harness.mjs"), "utf8");
    expect(fixture).toContain('"assistant/message"');
  });

  it("requires exactly the session/list fields the client reads", () => {
    const list = recorded<{ items: Record<string, unknown>[] }>("session-list.json");
    const item = list.items[0]!;
    // The shape is what the client *requires*; the capture proves the Host supplies it.
    for (const field of baselineShape.sessionListFields) expect(Object.keys(item), field).toContain(field);
    // The fields the client needs but does not model (`updatedAt`, `agentAvailable`) stay recorded
    // as host extras: the matrix is the requirement, not a mirror of the Host's whole object.
    expect(baselineShape.sessionListFields).toContain("cwd");
    expect(baselineShape.sessionListFields).toContain("sessionId");
  });

  it("agrees with the official checkout when it is present", () => {
    if (!existsSync(sourceCheckout)) {
      // The checkout is the authority, but it is not required to run the suite.
      expect(existsSync(sourceCheckout)).toBe(false);
      return;
    }
    const types = readFileSync(join(sourceCheckout, "packages", "core", "session", "src", "types.ts"), "utf8");
    for (const kind of baselineShape.turnEndReasons) expect(types, kind).toContain(kind);
  });
});

describe("contract matrix: differencing and classification", () => {
  it("applies a line's differences on top of the baseline instead of restating it", () => {
    const nextLine: ContractLine = {
      dshLine: "0.3.0",
      recordedVersions: ["0.3.0"],
      fixture: "0.3.0",
      capturedAt: null,
      source: "synthetic — this line exists only to exercise the merge",
      baseline: false,
      differences: {
        methodsAdded: ["session/fork"],
        methodsRemoved: ["session/projections"],
        turnEndReasonsAdded: ["forked-twice"],
        pageRecordKindsRemoved: ["approval/policy"],
        sessionListFieldsAdded: ["agentVersion"],
        createValueFieldsAdded: { "session/create": ["forkedFrom"] },
      },
    };

    const merged = resolveShape(nextLine);
    expect(merged.methods).toContain("session/fork");
    expect(merged.methods).not.toContain("session/projections");
    expect(merged.methods).toContain("session/list");
    expect(merged.turnEndReasons).toContain("forked-twice");
    expect(merged.pageRecordKinds).not.toContain("approval/policy");
    expect(merged.pageRecordKinds).toContain("turn/end");
    expect(merged.sessionListFields).toContain("agentVersion");
    expect(merged.sessionListFields).toContain("sessionId");
    expect(merged.createValueFields["session/create"]).toEqual(["sessionId", "forkedFrom"]);
    expect(merged.createValueFields["workspace/create"]).toEqual(["workspaceId"]);

    // The baseline entry itself is untouched by another line's differences.
    expect(resolveShape(baseline).methods).not.toContain("session/fork");
  });

  it("lets an explicit removal win over an addition of the same name", () => {
    const contradictory: ContractLine = {
      dshLine: "9.9.9",
      recordedVersions: [],
      fixture: "9.9.9",
      capturedAt: null,
      source: "synthetic",
      baseline: false,
      differences: { methodsAdded: ["session/x"], methodsRemoved: ["session/x"] },
    };
    expect(resolveShape(contradictory).methods).not.toContain("session/x");
  });

  it("classifies an exact, compatible, unknown, and unsupported version", () => {
    expect(classifyContract("0.2.1-alpha.1")).toMatchObject({ dshLine: BASELINE_DSH_LINE, status: "exact" });
    // Another version on a recorded line: same wire, but not itself recorded.
    expect(classifyContract("0.2.1")).toMatchObject({ dshLine: BASELINE_DSH_LINE, status: "compatible" });
    expect(classifyContract("0.2.1-alpha.2")).toMatchObject({ status: "compatible" });
    // Nothing resolved yet — the state before the first install.
    expect(classifyContract(null)).toMatchObject({ dshLine: null, status: "unknown" });
    expect(classifyContract("")).toMatchObject({ status: "unknown" });
    expect(classifyContract("not-a-version")).toMatchObject({ status: "unknown" });
    // A line we have never recorded.
    expect(classifyContract("0.3.0")).toMatchObject({ dshLine: "0.3.0", status: "unsupported" });
    expect(classifyContract("1.0.0-beta.1")).toMatchObject({ dshLine: "1.0.0", status: "unsupported" });
  });

  it("only lets `unsupported` be treated as a prerequisite failure", () => {
    const statuses = ["0.2.1-alpha.1", "0.2.1", null, "0.3.0"] as const;
    const blocking = statuses.map((version) => contractBlocksReadiness(classifyContract(version)));
    // exact / compatible / unknown must never block; unsupported may.
    expect(blocking).toEqual([false, false, false, true]);
  });

  it("reads the version out of the pinned spec without throwing on a bad one", () => {
    expect(versionOfSpec("@deepseek-ai/dsh@0.2.1-alpha.1")).toBe("0.2.1-alpha.1");
    expect(versionOfSpec("dsh@1.2.3")).toBe("1.2.3");
    expect(versionOfSpec("@deepseek-ai/dsh@latest")).toBeNull();
    expect(versionOfSpec("@deepseek-ai/dsh@^0.2.1")).toBeNull();
    expect(versionOfSpec("")).toBeNull();
    expect(versionOfSpec(null)).toBeNull();
  });

  it("derives the version line the way the matrix is keyed", () => {
    expect(dshLineOf("0.2.1-alpha.1")).toBe("0.2.1");
    expect(dshLineOf("0.2.1+build.7")).toBe("0.2.1");
    expect(dshLineOf("12.34.56")).toBe("12.34.56");
    expect(dshLineOf("nope")).toBeNull();
    expect(dshLineOf(null)).toBeNull();
    expect(matrixLine("0.2.1")).toBe(baseline);
    expect(matrixLine("0.3.0")).toBeNull();
  });
});
