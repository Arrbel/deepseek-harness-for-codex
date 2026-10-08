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
  cancelRequested: boolean;
  startedAt: string;
  finishedAt: string | null;
  assistantText: string;
  lastEventSeq: number;
  error: string | null;
}

/** Inputs needed to start a visible Harness task. */
export interface StartRunInput {
  task: string;
  workspace: string;
  sessionId?: string | undefined;
  openBrowser?: boolean | undefined;
}
