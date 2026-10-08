// Concurrency admission (R3-4), the pure part: one run per workspace, N per process.
//
// The semantics this pins: exceeding either bound is *reported* with an actionable message and
// creates no state at all — no `queued` status (the vocabulary is closed), no fabricated run.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_CONCURRENCY_LIMIT,
  MAX_RUN_CONCURRENCY_LIMIT,
  MIN_RUN_CONCURRENCY_LIMIT,
  RUN_LIMIT_ENV,
  admitRun,
  capacityVerdict,
  concurrencyLine,
  resolveRunLimit,
  type ActiveRun,
  type PendingRun,
} from "../../src/run/concurrency.js";
import type { RunStatus } from "../../src/run/types.js";
import { samePath } from "../../src/policy/paths.js";
import "../support/isolation.js";

const WS = "C:\\ws\\alpha";
const OTHER = "C:\\ws\\beta";

function active(runId: string, workspace: string, status: RunStatus = "running"): ActiveRun {
  return { runId, workspace, status };
}

function pending(workspace: string): PendingRun {
  return { workspace };
}

describe("resolveRunLimit", () => {
  it("defaults to four when nothing is configured", () => {
    expect(resolveRunLimit({})).toBe(DEFAULT_RUN_CONCURRENCY_LIMIT);
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "" })).toBe(DEFAULT_RUN_CONCURRENCY_LIMIT);
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "   " })).toBe(DEFAULT_RUN_CONCURRENCY_LIMIT);
  });

  it("reads a configured value", () => {
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "7" })).toBe(7);
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: " 2 " })).toBe(2);
  });

  it("falls back to the default instead of throwing on a typo", () => {
    for (const bad of ["two", "2.5", "1e3", "4 runs", "0x2", "--1"]) {
      expect(resolveRunLimit({ [RUN_LIMIT_ENV]: bad }), bad).toBe(DEFAULT_RUN_CONCURRENCY_LIMIT);
    }
  });

  it("clamps to the supported range (the bound cannot be removed by a typo)", () => {
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "0" })).toBe(MIN_RUN_CONCURRENCY_LIMIT);
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "-5" })).toBe(MIN_RUN_CONCURRENCY_LIMIT);
    expect(resolveRunLimit({ [RUN_LIMIT_ENV]: "9999" })).toBe(MAX_RUN_CONCURRENCY_LIMIT);
  });
});

describe("admitRun", () => {
  it("admits when the workspace is free and the limit has room", () => {
    expect(admitRun({ active: [active("a", OTHER)], pending: [], workspace: WS, limit: 2 })).toEqual({
      ok: true,
      limit: 2,
      active: 1,
    });
    expect(admitRun({ active: [], pending: [], workspace: WS, limit: 1 })).toEqual({ ok: true, limit: 1, active: 0 });
  });

  it("refuses a second run in the same workspace, naming the run to wait for", () => {
    const admission = admitRun({ active: [active("run-a", WS)], pending: [], workspace: WS, limit: 8 });

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.reason).toBe("workspace-busy");
    expect(admission.message).toContain("run-a");
    expect(admission.message).toContain("wait_run run-a");
    expect(admission.message).toContain("cancel_run run-a");
    expect(admission.message).toContain("one run per workspace");
  });

  it("compares workspaces with the shared path predicate (so host spelling rules apply)", () => {
    // `samePath` is case-insensitive on Windows and case-sensitive elsewhere; the admission check
    // must not grow a second, differently-spelled notion of "same workspace".
    const variant = process.platform === "win32" ? "C:\\WS\\ALPHA" : WS;
    expect(samePath(variant, WS)).toBe(true);

    const admission = admitRun({ active: [active("run-a", variant)], pending: [], workspace: WS, limit: 8 });
    expect(admission.ok).toBe(false);
  });

  it("refuses at the limit and tells the caller how to make room", () => {
    const admission = admitRun({
      active: [active("run-a", OTHER), active("run-b", "C:\\ws\\gamma")],
      pending: [],
      workspace: WS,
      limit: 2,
    });

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.reason).toBe("limit-reached");
    expect(admission.message).toContain("2/2 active in 2 workspaces");
    expect(admission.message).toContain("run-a, run-b");
    expect(admission.message).toContain(RUN_LIMIT_ENV);
    expect(admission.message).toContain("wait_run");
  });

  it("prefers the workspace verdict over the limit verdict (more specific is more actionable)", () => {
    const admission = admitRun({
      active: [active("run-a", WS), active("run-b", OTHER)],
      pending: [],
      workspace: WS,
      limit: 1,
    });
    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.reason).toBe("workspace-busy");
  });

  it("never puts a status of its own into the message (the vocabulary stays closed)", () => {
    const admission = admitRun({ active: [active("run-a", WS)], pending: [], workspace: WS, limit: 4 });
    if (admission.ok) throw new Error("unreachable");
    for (const invented of ["queued", "waiting", "scheduled", "blocked"]) {
      expect(admission.message.toLowerCase()).not.toContain(invented);
    }
  });
});

describe("pending admissions occupy slots (the N-R3-1 fix)", () => {
  it("refuses a concurrent submission for the same workspace, naming the in-flight call", () => {
    const admission = admitRun({ active: [], pending: [pending(WS)], workspace: WS, limit: 8 });

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.reason).toBe("workspace-busy");
    expect(admission.message).toContain("already has a start_run in progress");
    expect(admission.message).toContain("one run per workspace");
    // Nothing is invented: the pending call has no runId yet, so the message cannot name one.
    expect(admission.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  it("counts pending admissions against the process capacity", () => {
    const admission = admitRun({ active: [active("run-a", OTHER)], pending: [pending("C:\\ws\\gamma")], workspace: WS, limit: 2 });

    expect(admission.ok).toBe(false);
    if (admission.ok) throw new Error("unreachable");
    expect(admission.reason).toBe("limit-reached");
    expect(admission.message).toContain("2/2 active in 2 workspaces");
    expect(admission.message).toContain("1 start_run in progress");
  });

  it("does not refuse when a pending admission is for a different workspace and there is room", () => {
    expect(admitRun({ active: [], pending: [pending(OTHER)], workspace: WS, limit: 2 })).toEqual({
      ok: true,
      limit: 2,
      active: 1,
    });
  });

  it("reports the count of in-flight calls with correct pluralisation", () => {
    expect(capacityVerdict({ active: [active("run-a", OTHER)], pending: [pending(WS)], limit: 1 }).ok).toBe(false);
    const one = capacityVerdict({ active: [active("run-a", OTHER)], pending: [pending(WS)], limit: 1 });
    if (one.ok) throw new Error("unreachable");
    expect(one.message).toContain("1 start_run in progress");

    const two = capacityVerdict({ active: [], pending: [pending(WS), pending(OTHER)], limit: 1 });
    if (two.ok) throw new Error("unreachable");
    expect(two.message).toContain("2 start_runs in progress");
  });
});

describe("concurrencyLine", () => {
  it("counts runs and workspaces, with a singular/plural that reads correctly", () => {
    expect(concurrencyLine({ active: [], pending: [] }, 4)).toBe("0/4 active in 0 workspaces");
    expect(concurrencyLine({ active: [active("a", WS)], pending: [] }, 4)).toBe("1/4 active in 1 workspace");
    expect(concurrencyLine({ active: [active("a", WS), active("b", OTHER)], pending: [] }, 4)).toBe("2/4 active in 2 workspaces");
    expect(concurrencyLine({ active: [active("a", WS), active("b", WS)], pending: [] }, 2)).toBe("2/2 active in 1 workspace");
  });

  it("counts a pending admission as a slot in its workspace", () => {
    expect(concurrencyLine({ active: [active("a", WS)], pending: [pending(WS)] }, 2)).toBe("2/2 active in 1 workspace");
    expect(concurrencyLine({ active: [], pending: [pending(WS), pending(OTHER)] }, 4)).toBe("2/4 active in 2 workspaces");
  });
});
