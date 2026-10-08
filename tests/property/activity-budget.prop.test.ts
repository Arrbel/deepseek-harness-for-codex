// Property: the readiness budget measures **silence**, and the watcher's projection is monotone.
//
// ADR-0002 makes startup a budget over silence rather than a wall-clock deadline: a slow but
// progressing child must never be killed, and a hanging one must be. Those two statements are the
// whole policy, and both are properties of the *sequence* of clock reads, which is why they are
// tested generatively instead of at three hand-picked timestamps:
//
//   * progress prevents timeout — every inter-output gap below the budget means "not expired";
//   * silence times out — a gap at or beyond the budget means "expired", inclusive at the edge;
//   * `touch()` really resets; the observers are side-effect free; expiry is monotone in time;
//   * once the ready URL is observed it never reverts, and the retained log stays bounded;
//   * the startup failure message always carries its diagnosis and never a launch token.
import { describe, expect, it } from "vitest";
import {
  ActivityBudget,
  MAX_LOG_CHARACTERS,
  READY_PATTERN,
  ReadinessWatcher,
  startupFailureMessage,
} from "../../src/service/readiness.js";
import { REDACTED } from "../../src/util/redaction.js";
import { forAll, forEachValue, repr } from "./support/generators.js";
import "../support/isolation.js";

const SWEEP = 600;

/** A manually advanced clock, so the budget never waits on real time. */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: (): number => current,
    advance: (delta: number): void => {
      current += delta;
    },
    set: (value: number): void => {
      current = value;
    },
  };
}

function budgetWith(timeoutMs: number) {
  const clock = fakeClock();
  return { clock, budget: new ActivityBudget({ timeoutMs, now: clock.now }) };
}

describe("property: progress prevents a timeout", () => {
  it("is never expired at any point strictly inside the silence window", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 5_000);
      const { clock, budget } = budgetWith(timeout);
      budget.touch();

      clock.advance(rng.int(0, timeout - 1));

      expect(budget.expired(), `timeout=${String(timeout)} silence=${String(budget.silenceMs())}`).toBe(false);
    });
  });

  it("survives an arbitrarily long start as long as every gap stays under the budget", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(10, 2_000);
      const { clock, budget } = budgetWith(timeout);
      const rounds = rng.int(1, 10);

      for (let round = 0; round < rounds; round++) {
        budget.touch();
        clock.advance(rng.int(0, timeout - 1));

        expect(budget.expired(), `round ${String(round)} of ${String(rounds)}`).toBe(false);
      }

      // Total elapsed can far exceed the budget; only the longest *gap* matters.
      expect(clock.now()).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("property: silence times out, at the boundary", () => {
  it("is expired for any silence at or beyond the budget", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 5_000);
      const { clock, budget } = budgetWith(timeout);
      budget.touch();

      clock.advance(timeout + rng.int(0, 5_000));

      expect(budget.expired(), `timeout=${String(timeout)} silence=${String(budget.silenceMs())}`).toBe(true);
    });
  });

  it("treats exactly the budget as expired and one millisecond less as not", () => {
    forEachValue([1, 2, 50, 1_000, 180_000], (timeout) => {
      const justInside = budgetWith(timeout);
      justInside.budget.touch();
      justInside.clock.advance(timeout - 1);
      expect(justInside.budget.expired(), `${String(timeout)}ms, ${String(timeout - 1)}ms elapsed`).toBe(false);

      const exactly = budgetWith(timeout);
      exactly.budget.touch();
      exactly.clock.advance(timeout);
      expect(exactly.budget.expired(), `${String(timeout)}ms, ${String(timeout)}ms elapsed`).toBe(true);
    });
  });

  it("expires a zero or negative budget immediately, having had no output", () => {
    forEachValue([0, -1, -1_000], (timeout) => {
      const { budget } = budgetWith(timeout);

      expect(budget.expired(), `timeout=${String(timeout)}`).toBe(true);
      expect(budget.hasOutput).toBe(false);
    });
  });
});

describe("property: the budget is a well-behaved observer", () => {
  it("reports `expired` exactly when the silence reached the budget", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 1_000);
      const { clock, budget } = budgetWith(timeout);
      if (rng.bool()) budget.touch();
      clock.advance(rng.int(0, 2_000));

      expect(budget.expired(), `timeout=${String(timeout)} silence=${String(budget.silenceMs())}`)
        .toBe(budget.silenceMs() >= budget.timeout);
    });
  });

  it("is monotone in elapsed time within one silence window", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 1_000);
      const { clock, budget } = budgetWith(timeout);
      budget.touch();

      const first = rng.int(0, 2_000);
      clock.advance(first);
      const expiredAtFirst = budget.expired();

      clock.advance(rng.int(0, 2_000));
      const expiredAtSecond = budget.expired();

      if (expiredAtFirst) expect(expiredAtSecond, `first=${String(first)} silence=${String(budget.silenceMs())}`).toBe(true);
    });
  });

  it("has no side effects: repeated reads agree and do not change the outcome", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 1_000);
      const { clock, budget } = budgetWith(timeout);
      if (rng.bool()) budget.touch();
      clock.advance(rng.int(0, 1_500));

      const readings = Array.from({ length: 3 }, () => ({ expired: budget.expired(), silence: budget.silenceMs(), hasOutput: budget.hasOutput }));

      expect(readings[1]).toEqual(readings[0]);
      expect(readings[2]).toEqual(readings[0]);
      // Reading did not shift the clock either, so the verdict is unchanged afterwards.
      expect(budget.expired()).toBe(readings[0]?.expired);
    });
  });

  it("resets both the silence and the expiry flag on every touch", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(1, 1_000);
      const { clock, budget } = budgetWith(timeout);

      // Drive it arbitrarily far past the budget, then prove a touch revives it.
      clock.advance(rng.int(timeout, timeout + 10_000));
      expect(budget.expired()).toBe(true);

      budget.touch();

      expect(budget.silenceMs()).toBe(0);
      expect(budget.expired()).toBe(false);
      expect(budget.hasOutput).toBe(true);
    });
  });

  it("never un-reports output once a chunk has arrived", () => {
    forAll(SWEEP, (rng) => {
      const { clock, budget } = budgetWith(rng.int(1, 1_000));
      let seen = false;

      for (let round = 0; round < rng.int(1, 6); round++) {
        if (rng.bool()) budget.touch();
        clock.advance(rng.int(0, 500));
        if (budget.hasOutput) seen = true;
        else expect(seen, `round ${String(round)}`).toBe(false);
      }
    });
  });
});

describe("property: the watcher projection is monotone and bounded", () => {
  const CHUNKS: readonly string[] = [
    "",
    "starting dsh web\n",
    "dsh web: http://127.0.0.1:41234/?token=%3Ctoken%3E\n",
    "dsh web: http://[::1]:9/",
    "noise without a url",
    "dsh web:",
    "dsh web: not-a-url",
  ];

  it("keeps the ready URL once found, and only when a chunk really carried it", () => {
    forAll(SWEEP, (rng) => {
      const clock = fakeClock();
      const watcher = new ReadinessWatcher({ timeoutMs: 1_000, now: clock.now });
      let ready = false;

      for (let round = 0; round < rng.int(1, 8); round++) {
        watcher.push(rng.pick(CHUNKS));

        if (watcher.readyUrl === null) {
          expect(ready, `round ${String(round)}: readyUrl reverted to null`).toBe(false);
        } else {
          ready = true;
          expect(watcher.rawLog).toContain("dsh web:");
        }
      }

      // Whatever the sequence, the URL is exactly the first capture in the accumulated log.
      const match = READY_PATTERN.exec(watcher.rawLog);
      expect(watcher.readyUrl).toBe(match?.[1] ?? null);
    });
  });

  it("bounds the retained log and keeps its tail", () => {
    forAll(200, (rng) => {
      const clock = fakeClock();
      const watcher = new ReadinessWatcher({ timeoutMs: 1_000, now: clock.now });

      for (let round = 0; round < rng.int(1, 4); round++) watcher.push("y".repeat(rng.int(1, MAX_LOG_CHARACTERS)));

      expect(watcher.rawLog.length).toBeLessThanOrEqual(MAX_LOG_CHARACTERS);
    });
  });

  it("counts every push as progress, so a chatty child never exhausts the budget", () => {
    forAll(SWEEP, (rng) => {
      const timeout = rng.int(10, 500);
      const clock = fakeClock();
      const watcher = new ReadinessWatcher({ timeoutMs: timeout, now: clock.now });

      for (let round = 0; round < rng.int(1, 8); round++) {
        clock.advance(rng.int(0, timeout - 1));
        watcher.push(rng.pick(CHUNKS));

        expect(watcher.budget.expired(), `round ${String(round)}`).toBe(false);
      }
    });
  });

  it("separates a silent child from one that printed without a URL", () => {
    const silent = new ReadinessWatcher({ timeoutMs: 10 });
    expect(silent.cause()).toBe("no-first-output");
    expect(silent.readyUrl).toBeNull();

    const noisy = new ReadinessWatcher({ timeoutMs: 10 });
    noisy.push("nothing useful");
    expect(noisy.cause()).toBe("no-url-line");

    // The distinction is exactly "is the retained log empty once trimmed".
    forAll(SWEEP, (rng) => {
      const watcher = new ReadinessWatcher({ timeoutMs: 10 });
      for (let round = 0; round < rng.int(0, 4); round++) watcher.push(rng.pick(CHUNKS));

      expect(watcher.cause()).toBe(watcher.rawLog.trim() === "" ? "no-first-output" : "no-url-line");
    });
  });
});

describe("property: the startup failure message is diagnosable and scrubbed", () => {
  const CAUSES = ["no-first-output", "no-url-line", "exit-before-ready", "install-failed", "spawn-error"] as const;

  it("always carries the harness log tail and the npm stderr tail", () => {
    forAll(SWEEP, (rng) => {
      const message = startupFailureMessage({
        cause: rng.pick(CAUSES),
        timeoutMs: rng.int(0, 200_000),
        log: rng.pick(["", "some output", "dsh web: http://127.0.0.1:1/?token=SECRET"]),
        runtimeRoot: rng.pick([null, "C:\\runtime"]),
        npmStderrTail: rng.pick([null, "", "npm ERR! 404"]),
      });

      expect(message.length, repr(message)).toBeGreaterThan(0);
      expect(message).toContain("Harness log tail:");
      expect(message).toContain("npm stderr tail:");
    });
  });

  it("redacts a launch token wherever it appears", () => {
    forEachValue(["no-first-output", "no-url-line", "exit-before-ready"] as const, (cause) => {
      const message = startupFailureMessage({
        cause,
        timeoutMs: 1_000,
        log: "dsh web: http://127.0.0.1:41234/?token=SUPER_SECRET_TOKEN",
      });

      expect(message).not.toContain("SUPER_SECRET_TOKEN");
      expect(message).toContain(REDACTED);
    });
  });

  it("names the exit code and signal, and the timeout with its cause", () => {
    expect(startupFailureMessage({ cause: "exit-before-ready", exit: { code: 7, signal: null } }))
      .toContain("code 7, signal null");
    expect(startupFailureMessage({ cause: "exit-before-ready", exit: { code: null, signal: "SIGKILL" } }))
      .toContain("code null, signal SIGKILL");
    expect(startupFailureMessage({ cause: "no-first-output", timeoutMs: 180_000 }))
      .toContain("within 180000ms of silence (no-first-output)");
  });
});
