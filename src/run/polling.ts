// Adaptive poll schedule for a running turn (R3-5).
//
// The wait loop used to sleep a constant `pollIntervalMs` (400 ms by default) between refreshes.
// That is the right pace for a *quiet* session and the wrong one for a session that is actively
// emitting events: the caller sees progress up to 400 ms late. So the interval now accelerates
// while the session is talking and backs off when it goes quiet.
//
// Three properties are deliberate and are proven exhaustively in `tests/run/polling.test.ts`:
//
//   1. **Pure.** {@link nextPollDelayMs} is a total function of its inputs — no clock, no state,
//      no IO — so the schedule can be swept over its whole domain instead of sampled.
//   2. **Bounded.** The result is always inside `[floorMs, ceilingMs]`, whatever the caller passes.
//      The floor is therefore also the *rate* bound: see {@link pollsPerSecondUpperBound}.
//   3. **Monotone in silence.** With no progress the interval never decreases as empty polls pile
//      up; with progress it snaps straight back to the floor.
//
// The ceiling stays the configured `pollIntervalMs`, so this module can only ever poll *faster*
// than the operator asked for — never slower — and an operator who sets 10 ms still gets 10 ms.

/** Fastest interval: a session that is emitting events is polled this often. */
export const POLL_FAST_MS = 150;

/** Slowest interval when no override is given — the pre-existing default pace. */
export const POLL_SLOW_MS = 400;

/**
 * How many times the interval may double while the session is silent.
 *
 * Two is enough to walk 150 → 300 → 400 (the ceiling); capping it also keeps `2 ** emptyPolls`
 * away from overflow if a caller hands over a nonsense counter.
 */
export const MAX_BACKOFF_DOUBLINGS = 2;

/** The two ends of the schedule. `floorMs` is the rate bound; `ceilingMs` is the quiet pace. */
export interface PollSchedule {
  readonly floorMs: number;
  readonly ceilingMs: number;
}

/** The schedule used when nothing overrides it. */
export const DEFAULT_POLL_SCHEDULE: PollSchedule = { floorMs: POLL_FAST_MS, ceilingMs: POLL_SLOW_MS };

/** What the loop observed last time round. */
export interface PollState {
  /** Consecutive refreshes that brought no new event. */
  readonly emptyPolls: number;
  /** Whether the most recent refresh brought a new event. */
  readonly progressed: boolean;
}

/** The state a wait loop starts from: nothing seen yet, so nothing to back off from. */
export const INITIAL_POLL_STATE: PollState = { emptyPolls: 0, progressed: false };

/**
 * The schedule for a configured interval.
 *
 * The configured interval is the **ceiling** (it is the pace the operator asked for); the floor is
 * the accelerator, clamped so a small configured value is never *raised*: with `pollIntervalMs: 10`
 * the schedule degenerates to a constant 10 ms, which is exactly the old behaviour.
 */
export function pollScheduleFor(configuredIntervalMs: number): PollSchedule {
  const ceilingMs = Number.isFinite(configuredIntervalMs) ? Math.max(1, Math.floor(configuredIntervalMs)) : POLL_SLOW_MS;
  return { floorMs: Math.min(POLL_FAST_MS, ceilingMs), ceilingMs };
}

/** Folds one observation into the next state. */
export function advancePollState(state: PollState, progressed: boolean): PollState {
  if (progressed) return { emptyPolls: 0, progressed: true };
  const empty = Number.isFinite(state.emptyPolls) ? Math.max(0, Math.floor(state.emptyPolls)) : 0;
  return { emptyPolls: empty + 1, progressed: false };
}

/**
 * The next wait, in milliseconds.
 *
 * * progress → the floor (the session is mid-turn, so look again soon);
 * * silence → the floor doubled once per empty poll, capped at the ceiling.
 *
 * The final clamp is what makes boundedness structural rather than a property of the arithmetic:
 * even a negative or absurd `option` cannot escape `[floorMs, ceilingMs]`.
 */
export function nextPollDelayMs(state: PollState, schedule: PollSchedule = DEFAULT_POLL_SCHEDULE): number {
  const floor = Number.isFinite(schedule.floorMs) ? Math.max(1, schedule.floorMs) : POLL_FAST_MS;
  const ceiling = Math.max(floor, Number.isFinite(schedule.ceilingMs) ? schedule.ceilingMs : POLL_SLOW_MS);
  const empty = Number.isFinite(state.emptyPolls) ? Math.max(0, Math.floor(state.emptyPolls)) : 0;
  const doublings = state.progressed ? 0 : Math.min(empty, MAX_BACKOFF_DOUBLINGS);
  const wanted = floor * 2 ** doublings;
  return Math.min(Math.max(wanted, floor), ceiling);
}

/**
 * The steady-state request rate at a given floor, in **polls** per second.
 *
 * Rounded up, so it is a true upper bound: one poll every 150 ms is 6.67/s, and no schedule this
 * module can produce polls faster than its floor, so 7 is the number to quote.
 */
export function pollsPerSecondUpperBound(floorMs: number = POLL_FAST_MS): number {
  const floor = Number.isFinite(floorMs) && floorMs > 0 ? floorMs : POLL_FAST_MS;
  return Math.ceil(1_000 / floor);
}

/** The most polls one bounded wait can perform in `windowMs`, floor included. */
export function maxPollsPerWindow(windowMs: number, floorMs: number = POLL_FAST_MS): number {
  const floor = Number.isFinite(floorMs) && floorMs > 0 ? floorMs : POLL_FAST_MS;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
  return Math.floor(window / floor) + 1;
}
