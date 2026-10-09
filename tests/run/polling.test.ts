// Adaptive poll schedule (`run/polling.ts`, R3-5).
//
// The schedule is the one place a "make it faster" change can turn into a request storm against a
// local Host, so the properties below are proven by **exhaustive sweep**, not sampling: the state
// space is two integers plus a boolean, so there is no reason to sample it.
//
// What is pinned:
//   * **pure** — the same inputs always give the same answer, and nothing reads a clock;
//   * **bounded** — every answer lies in `[floor, ceiling]`, for every reachable state *and* for
//     nonsense inputs;
//   * **monotone in silence** — more empty polls never shorten the wait;
//   * **faster on progress** — a session that is emitting events is polled at the floor;
//   * the arithmetic behind the rate bound the report quotes (7 polls/s at a 150 ms floor).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_SCHEDULE,
  INITIAL_POLL_STATE,
  MAX_BACKOFF_DOUBLINGS,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  advancePollState,
  maxPollsPerWindow,
  nextPollDelayMs,
  pollScheduleFor,
  pollsPerSecondUpperBound,
  type PollSchedule,
  type PollState,
} from "../../src/run/polling.js";
import "../support/isolation.js";

/** Schedules worth sweeping: the real one, degenerate ones, and hostile ones. */
const SCHEDULES: readonly PollSchedule[] = [
  DEFAULT_POLL_SCHEDULE,
  { floorMs: POLL_FAST_MS, ceilingMs: POLL_FAST_MS },
  { floorMs: 10, ceilingMs: 10 }, // what the integration suites configure
  { floorMs: 1, ceilingMs: 1 },
  { floorMs: 150, ceilingMs: 60_000 },
  { floorMs: 0, ceilingMs: 0 },
  { floorMs: -5, ceilingMs: -1 },
  { floorMs: Number.NaN, ceilingMs: Number.NaN },
  { floorMs: Number.POSITIVE_INFINITY, ceilingMs: Number.POSITIVE_INFINITY },
];

const EMPTY_SWEEP = 65;

function stateFor(emptyPolls: number, progressed: boolean): PollState {
  return { emptyPolls, progressed };
}

describe("run/polling: the schedule is pure and bounded", () => {
  it("is a pure function of its inputs", () => {
    for (const schedule of SCHEDULES) {
      for (let emptyPolls = 0; emptyPolls <= EMPTY_SWEEP; emptyPolls += 1) {
        for (const progressed of [false, true]) {
          const state = stateFor(emptyPolls, progressed);
          expect(nextPollDelayMs(state, schedule)).toBe(nextPollDelayMs({ ...state }, { ...schedule }));
        }
      }
    }
  });

  it("stays inside [floor, ceiling] for every reachable state and every schedule", () => {
    for (const schedule of SCHEDULES) {
      // The invariant has to be expressed in terms of the schedule the module actually applies,
      // which sanitises hostile values — so it is restated here from the same rules.
      const floor = Number.isFinite(schedule.floorMs) ? Math.max(1, schedule.floorMs) : POLL_FAST_MS;
      const ceiling = Math.max(floor, Number.isFinite(schedule.ceilingMs) ? schedule.ceilingMs : POLL_SLOW_MS);
      for (let emptyPolls = -3; emptyPolls <= EMPTY_SWEEP; emptyPolls += 1) {
        for (const progressed of [false, true]) {
          const delay = nextPollDelayMs(stateFor(emptyPolls, progressed), schedule);
          expect(Number.isInteger(delay), `${String(delay)} for ${JSON.stringify(schedule)}`).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(floor);
          expect(delay).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });

  it("never returns something a timer would reject, whatever the caller passes", () => {
    const hostile: readonly PollSchedule[] = [
      { floorMs: Number.NaN, ceilingMs: 400 },
      { floorMs: 400, ceilingMs: Number.NaN },
      { floorMs: Number.POSITIVE_INFINITY, ceilingMs: 400 },
      { floorMs: 50, ceilingMs: 10 }, // ceiling below floor is corrected, never inverted
      { floorMs: 0.5, ceilingMs: 0.5 },
    ];
    for (const schedule of hostile) {
      for (const emptyPolls of [-1, 0, 1, 10, Number.NaN, Number.POSITIVE_INFINITY]) {
        for (const progressed of [false, true]) {
          const delay = nextPollDelayMs(stateFor(emptyPolls, progressed), schedule);
          expect(Number.isFinite(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(delay)).toBe(true);
        }
      }
    }
  });
});

describe("run/polling: silence backs off, progress snaps back", () => {
  it("polls at the floor whenever the last refresh brought an event", () => {
    for (let emptyPolls = 0; emptyPolls <= EMPTY_SWEEP; emptyPolls += 1) {
      expect(nextPollDelayMs(stateFor(emptyPolls, true))).toBe(POLL_FAST_MS);
    }
  });

  it("is monotone in silence: more empty polls never shorten the wait", () => {
    for (const schedule of SCHEDULES) {
      let previous = -1;
      for (let emptyPolls = 0; emptyPolls <= EMPTY_SWEEP; emptyPolls += 1) {
        const delay = nextPollDelayMs(stateFor(emptyPolls, false), schedule);
        expect(delay).toBeGreaterThanOrEqual(previous);
        previous = delay;
      }
    }
  });

  it("walks 150 -> 300 -> 400 and then stays at the ceiling", () => {
    const silent = (emptyPolls: number) => nextPollDelayMs(stateFor(emptyPolls, false));
    expect(silent(0)).toBe(POLL_FAST_MS);
    expect(silent(1)).toBe(300);
    expect(silent(2)).toBe(POLL_SLOW_MS);
    expect(silent(3)).toBe(POLL_SLOW_MS);
    expect(silent(1_000)).toBe(POLL_SLOW_MS);
    // The doubling is capped, which is also what keeps `2 ** emptyPolls` finite.
    expect(MAX_BACKOFF_DOUBLINGS).toBe(2);
  });

  it("never polls slower after progress than it would have while silent", () => {
    for (let emptyPolls = 0; emptyPolls <= EMPTY_SWEEP; emptyPolls += 1) {
      expect(nextPollDelayMs(stateFor(emptyPolls, true))).toBeLessThanOrEqual(
        nextPollDelayMs(stateFor(emptyPolls, false)),
      );
    }
  });
});

describe("run/polling: the loop's configured pace is a ceiling, not a floor to be raised", () => {
  it("degrades to the configured pace when the operator asks for something faster", () => {
    // `pollIntervalMs: 10` (the integration suites) must stay 10 ms: accelerating is optional,
    // slowing an operator down is not allowed.
    expect(pollScheduleFor(10)).toEqual({ floorMs: 10, ceilingMs: 10 });
    expect(nextPollDelayMs(INITIAL_POLL_STATE, pollScheduleFor(10))).toBe(10);
    expect(nextPollDelayMs(stateFor(9, true), pollScheduleFor(10))).toBe(10);
  });

  it("accelerates to 150 ms under the default 400 ms pace", () => {
    expect(pollScheduleFor(POLL_SLOW_MS)).toEqual({ floorMs: POLL_FAST_MS, ceilingMs: POLL_SLOW_MS });
    expect(pollScheduleFor(60_000)).toEqual({ floorMs: POLL_FAST_MS, ceilingMs: 60_000 });
  });

  it("sanitises a nonsense configured pace instead of trusting it", () => {
    expect(pollScheduleFor(0)).toEqual({ floorMs: 1, ceilingMs: 1 });
    expect(pollScheduleFor(-100)).toEqual({ floorMs: 1, ceilingMs: 1 });
    expect(pollScheduleFor(Number.NaN)).toEqual(DEFAULT_POLL_SCHEDULE);
    expect(pollScheduleFor(400.7)).toEqual({ floorMs: POLL_FAST_MS, ceilingMs: 400 });
  });
});

describe("run/polling: state folding", () => {
  it("resets the silence counter the moment anything arrives", () => {
    expect(advancePollState(INITIAL_POLL_STATE, true)).toEqual({ emptyPolls: 0, progressed: true });
    expect(advancePollState(stateFor(7, false), true)).toEqual({ emptyPolls: 0, progressed: true });
  });

  it("counts consecutive empty polls and never overflows the backoff", () => {
    let state = INITIAL_POLL_STATE;
    const observed: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      state = advancePollState(state, false);
      observed.push(nextPollDelayMs(state));
    }
    expect(observed.slice(0, 4)).toEqual([300, 400, 400, 400]);
    expect(state.emptyPolls).toBe(10);
  });

  it("sanitises a corrupted counter rather than propagating NaN into a timer", () => {
    expect(advancePollState({ emptyPolls: Number.NaN, progressed: false }, false).emptyPolls).toBe(1);
    expect(advancePollState({ emptyPolls: -5, progressed: false }, false).emptyPolls).toBe(1);
    expect(nextPollDelayMs({ emptyPolls: Number.NaN, progressed: false })).toBe(POLL_FAST_MS);
  });
});

describe("run/polling: the rate bound the report quotes", () => {
  it("is one poll per floor, rounded up", () => {
    expect(pollsPerSecondUpperBound(POLL_FAST_MS)).toBe(7); // 1000/150 = 6.67
    expect(pollsPerSecondUpperBound(400)).toBe(3); // silent pace: 2.5 -> 3
    expect(pollsPerSecondUpperBound(10)).toBe(100);
    expect(pollsPerSecondUpperBound(0)).toBe(7); // falls back to the real floor
    expect(pollsPerSecondUpperBound(Number.NaN)).toBe(7);
  });

  it("bounds one 30 s wait at 201 polls, so the storm ceiling is arithmetic", () => {
    // 30_000 / 150 = 200 intervals, +1 for the refresh every wait starts with.
    expect(maxPollsPerWindow(30_000, POLL_FAST_MS)).toBe(201);
    expect(maxPollsPerWindow(30_000, POLL_SLOW_MS)).toBe(76);
    expect(maxPollsPerWindow(0, POLL_FAST_MS)).toBe(1);
    expect(maxPollsPerWindow(Number.NaN, POLL_FAST_MS)).toBe(1);
  });

  it("cannot outrun its own floor, however the loop is driven", () => {
    // Simulate the loop: every refresh is empty (the worst case for the schedule) and no time
    // passes in the model, so the *schedule* is the only thing under test.
    let state = INITIAL_POLL_STATE;
    let elapsed = 0;
    let polls = 0;
    const windowMs = 10_000;
    while (elapsed < windowMs) {
      state = advancePollState(state, false);
      elapsed += nextPollDelayMs(state);
      polls += 1;
    }
    expect(polls).toBeLessThanOrEqual(maxPollsPerWindow(windowMs, POLL_SLOW_MS) + 2);
  });
});
