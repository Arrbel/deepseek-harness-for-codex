// Run lifecycle vocabulary and the public snapshots returned to MCP clients.

/** Lifecycle state for one task submitted through the Harness Web service. */
export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

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
