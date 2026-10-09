// Run lifecycle vocabulary and the public snapshots returned to MCP clients.

/** Lifecycle state for one task submitted through the Harness Web service. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * One `step/start` the session published (R3-5).
 *
 * Structurally identical to `dsh/events.ts`'s `StepMarker`, and declared here rather than imported
 * because this module is a type-only DTO with **no imports** (`tests/module-boundaries.test.ts`
 * pins that). `tests/run/projection.test.ts` assigns each shape to the other in both directions,
 * so the two declarations cannot drift apart silently.
 */
export interface RunStepMarker {
  readonly turn: number;
  readonly step: number;
  readonly seq: number;
}

/**
 * The progress markers the event window carried.
 *
 * The recorded wire offers exactly one progress signal — `step/start` paired with `step/end`
 * (`tests/fixtures/recorded/0.2.1/session-page.json`) — so this is all the snapshot can honestly
 * say beyond `status: "running"`. A tool name is deliberately absent: no tool-call event was ever
 * recorded (see `reports/r4-projection-and-polling.md` §3).
 *
 * Scalars only, copied from validated fields: no payload text, no parameters, no tool arguments.
 */
export interface RunProgress {
  readonly started: number;
  readonly finished: number;
  /** The step that is open right now, or `null` when none is. */
  readonly current: RunStepMarker | null;
}

/**
 * Why a run failed, in the vocabulary the recovery policy and the turn mapping speak.
 *
 * Closed on purpose (ADR-0003 §3.2): `rpc:`/`turn-aborted:`/`turn-unknown:` stay open-ended
 * because DSH can report codes and causes this project has never seen, and a failure that
 * cannot be named must still be *representable* rather than silently swallowed.
 */
export type FailureReason =
  | "auth"
  | "transport"
  | "protocol-drift"
  | "service-unreachable"
  | `rpc:${string}`
  | "turn-blocked"
  | "turn-truncated"
  | `turn-aborted:${string}`
  | "turn-interrupted"
  | `turn-unknown:${string}`;

/** Public state returned to MCP clients for one visible Web session task. */
export interface RunSnapshot {
  runId: string;
  serviceId: string;
  sessionId: string;
  sessionReused: boolean;
  task: string;
  workspace: string;
  webUrl: string;
  status: RunStatus;
  /** Set exactly when the run settled as `failed`; `null` for `succeeded`/`cancelled`. */
  reason: FailureReason | null;
  /**
   * The next action a caller should take, derived from `reason` **alone** (see `run/state.ts`).
   *
   * Deliberately a closed six-value set and one-directional: nothing here may be re-derived from
   * the client's situation, so reading the field can never produce a guess. `reason === null`
   * (running/succeeded/cancelled) yields `none`.
   */
  nextAction: RunAction;
  /**
   * True **only** for `failed(service-unreachable)`: the service that served `webUrl` died, and a
   * restart both moves the port and rotates the launch token, so the old link is dead.
   */
  webUrlStale: boolean;
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  assistantText: string;
  lastEventSeq: number;
  /**
   * Progress markers projected from the durable event window (R3-5, additive).
   *
   * Answers "what is it doing right now" for a long turn without changing any existing field: a
   * caller that ignores `progress` sees exactly the previous snapshot shape.
   */
  progress: RunProgress;
  error: string | null;
}

/**
 * The closed set of next actions a snapshot may recommend.
 *
 * Closed on purpose: an open failure reason cannot name a specific fix, so it maps to
 * `report-only` rather than to a plausible-looking guess.
 */
export type RunAction =
  | "retry-narrower"
  | "new-session"
  | "restart-service"
  | "relogin"
  | "report-only"
  | "none";

/** Inputs needed to start a visible Harness task. */
export interface StartRunInput {
  task: string;
  workspace: string;
  sessionId?: string | undefined;
  openBrowser?: boolean | undefined;
}
