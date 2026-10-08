// Property: a run record has exactly **one** terminal state, whoever asks for it.
//
// `settle()` is the single terminal writer, and every stop/dispose/cancel path races toward it.
// The law is not "the last writer wins" but "the first writer wins and every later attempt is
// dropped, unmerged". The properties below exercise that law over random outcome sequences:
//
//   * exactly the first `settle` returns `true`, every later one `false`;
//   * the final state equals the state produced by applying the first outcome alone;
//   * the order of the *losing* attempts is irrelevant to the result;
//   * a refused settle mutates nothing — not even partially;
//   * `reason` is set exactly when the run failed, and the derived `nextAction`/`webUrlStale`
//     stay total over the whole failure vocabulary, including codes this project never saw.
import { describe, expect, it } from "vitest";
import { createRunRecord, type RunRecord } from "../../src/run/registry.js";
import {
  NEXT_ACTION_BY_REASON,
  isTerminal,
  nextActionFor,
  recoveryPolicyFor,
  settle,
  settleStrict,
  webUrlStaleFor,
  type FailureKind,
  type RunOutcome,
} from "../../src/run/state.js";
import type { FailureReason, RunAction } from "../../src/run/types.js";
import { forAll, forEachValue, repr, rngFor, type Rng } from "./support/generators.js";
import "../support/isolation.js";

const SWEEP = 800;

/** The closed failure vocabulary (everything whose action is a product decision). */
const CLOSED_REASONS: readonly FailureReason[] = [
  "auth",
  "transport",
  "protocol-drift",
  "service-unreachable",
  "turn-blocked",
  "turn-truncated",
  "turn-interrupted",
];

/** Reasons that carry a code this project may never have seen. */
const OPEN_REASONS: readonly FailureReason[] = [
  "rpc:session/not-found",
  "rpc:MISSING_CREDENTIAL",
  "rpc:",
  "turn-aborted:user",
  "turn-unknown:something-new",
];

const ALL_REASONS: readonly FailureReason[] = [...CLOSED_REASONS, ...OPEN_REASONS];

const RUN_ACTIONS: readonly RunAction[] = ["retry-narrower", "new-session", "restart-service", "relogin", "report-only", "none"];

const FAILURE_KINDS: readonly FailureKind[] = ["auth-expired", "transport", "protocol-drift", "not-found", "rpc", "unknown"];

function newRecord(): RunRecord {
  return createRunRecord({
    runId: "run-1",
    serviceId: "service-1",
    sessionId: "session-1",
    sessionReused: false,
    startEventSeq: 0,
    task: "task",
    workspace: "E:\\ws",
    webUrl: "http://127.0.0.1:1/?token=SECRET",
    startedAt: new Date(0),
    lastEventSeq: 0,
  });
}

function outcomeOf(rng: Rng): RunOutcome {
  const roll = rng.next();
  if (roll < 0.3) return { kind: "succeeded" };
  if (roll < 0.5) return { kind: "cancelled" };
  return { kind: "failed", reason: rng.pick(ALL_REASONS), message: rng.pick(["", "boom", "cookie expired"]) };
}

function outcomesOf(rng: Rng, count: number): RunOutcome[] {
  return Array.from({ length: count }, () => outcomeOf(rng));
}

/** Shuffles a copy with the given generator (Fisher-Yates). */
function shuffled<T>(rng: Rng, values: readonly T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = rng.int(0, index);
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

describe("property: settle-once", () => {
  it("lets exactly the first writer through and drops every later one", () => {
    forAll(SWEEP, (rng) => {
      const record = newRecord();
      const sequence = outcomesOf(rng, rng.int(1, 6));
      const at = rng.int(0, 1_000_000);

      const wrote = sequence.map((outcome, index) => settle(record, outcome, new Date(at + index)));

      expect(wrote[0], `sequence ${repr(sequence)}`).toBe(true);
      expect(wrote.slice(1), `sequence ${repr(sequence)}`).toEqual(sequence.slice(1).map(() => false));
    });
  });

  it("leaves a state that depends only on the winning outcome", () => {
    forAll(SWEEP, (rng) => {
      const sequence = outcomesOf(rng, rng.int(1, 6));
      const at = rng.int(0, 1_000_000);

      const actual = newRecord();
      sequence.forEach((outcome, index) => {
        settle(actual, outcome, new Date(at + index));
      });

      const reference = newRecord();
      settle(reference, sequence[0]!, new Date(at));

      expect(actual.status).toBe(reference.status);
      expect(actual.reason).toBe(reference.reason);
      expect(actual.error).toBe(reference.error);
      expect(actual.finishedAt?.getTime()).toBe(at);
      expect(actual.settled).toBe(true);
      expect(isTerminal(actual)).toBe(true);
    });
  });

  it("ignores the order of the losing attempts", () => {
    forAll(SWEEP, (rng) => {
      const sequence = outcomesOf(rng, rng.int(2, 6));
      const winner = sequence[0]!;
      const at = rng.int(0, 1_000_000);

      const ordered = newRecord();
      settle(ordered, winner, new Date(at));
      for (const outcome of sequence.slice(1)) settle(ordered, outcome, new Date(at));

      const reordered = newRecord();
      settle(reordered, winner, new Date(at));
      for (const outcome of shuffled(rng, sequence.slice(1))) settle(reordered, outcome, new Date(at + 1));

      expect(reordered.status).toBe(ordered.status);
      expect(reordered.reason).toBe(ordered.reason);
      expect(reordered.error).toBe(ordered.error);
      expect(reordered.finishedAt?.getTime()).toBe(ordered.finishedAt?.getTime());
    });
  });

  it("keeps `reason` set exactly for a failed run", () => {
    forAll(SWEEP, (rng) => {
      const record = newRecord();
      settle(record, outcomeOf(rng), new Date(5));

      expect(record.reason !== null, `status=${record.status} reason=${String(record.reason)}`)
        .toBe(record.status === "failed");
      expect(["succeeded", "failed", "cancelled"]).toContain(record.status);
      expect(record.startedAt.getTime()).toBe(0);
    });
  });

  it("also refuses a record that reached a terminal status without the flag", () => {
    // The second gate of `isTerminal`: a status set by some other writer must still stop a settle.
    forEachValue(["succeeded", "failed", "cancelled"] as const, (status) => {
      const record = newRecord();
      record.status = status;
      record.settled = false;

      expect(isTerminal(record)).toBe(true);
      expect(settle(record, { kind: "succeeded" }, new Date(9))).toBe(false);
      expect(record.status).toBe(status);
      expect(record.finishedAt).toBeNull();
    });
  });
});

describe("property: settleStrict is the assertion form of the same rule", () => {
  it("throws on the second attempt and mutates nothing while throwing", () => {
    forAll(SWEEP, (rng) => {
      const record = newRecord();
      const winner = outcomeOf(rng);
      const loser = outcomeOf(rng);
      const at = rng.int(0, 1_000_000);

      settleStrict(record, winner, new Date(at));
      const before = { status: record.status, reason: record.reason, error: record.error, finishedAt: record.finishedAt?.getTime() };

      expect(() => {
        settleStrict(record, loser, new Date(at + 999));
      }).toThrow(/already settled as/u);

      expect({ status: record.status, reason: record.reason, error: record.error, finishedAt: record.finishedAt?.getTime() })
        .toEqual(before);
    });
  });

  it("agrees with settle about the first write", () => {
    forAll(200, (rng) => {
      const outcome = outcomeOf(rng);
      const strict = newRecord();
      const lenient = newRecord();

      settleStrict(strict, outcome, new Date(3));
      expect(settle(lenient, outcome, new Date(3))).toBe(true);
      expect(strict.status).toBe(lenient.status);
      expect(strict.reason).toBe(lenient.reason);
      expect(strict.error).toBe(lenient.error);
    });
  });
});

describe("property: the derived fields stay total over the vocabulary", () => {
  it("maps every closed reason through the table and every open one to report-only", () => {
    forEachValue(CLOSED_REASONS, (reason) => {
      expect(nextActionFor(reason), reason).toBe(NEXT_ACTION_BY_REASON[reason as keyof typeof NEXT_ACTION_BY_REASON]);
    });
    forEachValue(OPEN_REASONS, (reason) => {
      expect(nextActionFor(reason), reason).toBe("report-only");
    });
    expect(nextActionFor(null)).toBe("none");
  });

  it("never invents an action outside the closed set", () => {
    forAll(SWEEP, (rng) => {
      const reason = rng.bool(0.5)
        ? rng.pick(ALL_REASONS)
        : (`rpc:${String(rng.int(0, 1_000))}` as FailureReason);

      expect(RUN_ACTIONS, `reason ${String(reason)}`).toContain(nextActionFor(reason));
    });
  });

  it("marks the web URL stale for exactly one reason", () => {
    forEachValue(ALL_REASONS, (reason) => {
      expect(webUrlStaleFor(reason), reason).toBe(reason === "service-unreachable");
    });
    expect(webUrlStaleFor(null)).toBe(false);
  });

  it("returns a well-formed recovery policy for every failure class", () => {
    forEachValue(FAILURE_KINDS, (kind) => {
      const policy = recoveryPolicyFor(kind, "SOME_CODE");

      expect(policy.attempts, kind).toBeGreaterThanOrEqual(1);
      expect(policy.backoffMs.length, kind).toBeLessThanOrEqual(policy.attempts);
      // A class either settles immediately or retries; never both.
      expect(policy.settleWithoutRetry && policy.propagates, kind).toBe(false);
      // A caller error has nothing to retry.
      if (policy.propagates) expect(policy.attempts, kind).toBe(1);
      // Any class that can retry must say how long to wait.
      if (policy.attempts > 1) expect(policy.backoffMs.length, kind).toBeGreaterThan(0);
      forEachValue(policy.backoffMs, (delay) => expect(delay).toBeGreaterThanOrEqual(0));
    });
  });

  it("keeps the not-found class a caller error, with no terminal reason to settle on", () => {
    const policy = recoveryPolicyFor("not-found");

    expect(policy.propagates).toBe(true);
    expect(policy.settleWithoutRetry).toBe(false);

    // The seed used to build the counterexample is printed in `forAll` failures; this is a
    // deterministic pin of the one class that must never settle.
    expect(() => recoveryPolicyFor("not-found", null)).not.toThrow();
  });
});

describe("property: seeded sweeps are reproducible", () => {
  it("produces the same sequence twice for the same seed", () => {
    forAll(50, (_rng, index) => {
      const first = outcomesOf(rngFor(index), 5);
      const second = outcomesOf(rngFor(index), 5);

      expect(first).toEqual(second);
    });
  });
});
