// Public service vocabulary: the lifecycle status and the immutable snapshot a caller sees.

/** Lifecycle state for a local Harness Web service. */
export type ServiceStatus = "starting" | "running" | "stopped" | "failed";

/** Public state of one local Harness Web service. */
export interface ServiceSnapshot {
  serviceId: string;
  workspace: string;
  status: ServiceStatus;
  webUrl: string | null;
  browserOpened: boolean;
  browserError: string | null;
  startedAt: string;
  stoppedAt: string | null;
  processId: number | null;
  /** True when the exit of the child could not be confirmed after a stop request. */
  stopUnconfirmed: boolean;
  /** Runtime package version directory the service was launched from. */
  runtimeRoot: string | null;
  logTail: string;
}

/** Inputs needed to start or reuse a local Harness Web service. */
export interface StartServiceInput {
  workspace: string;
  openBrowser?: boolean | undefined;
}