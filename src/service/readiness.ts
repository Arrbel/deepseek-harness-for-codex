// Readiness accounting for one local Harness Web process (ADR-0002, architecture §4).
//
// The startup budget measures *silence*, not total wall clock: every stdout/stderr chunk
// resets it, so a slow-but-progressing start is never reported as a timeout while a silent
// hang still fails. This module is pure (no `node:fs` / `node:child_process` / `node:net`)
// so the policy is unit-testable with an injected clock.

import { logTail as redactedLogTail } from "./credentials.js";

/** The single line `dsh web` prints once the Host is serving. */
export const READY_PATTERN = /dsh web: (http:\/\/[^\s]+)/u;

/** Upper bound of the retained child log (the tail is what failures report). */
export const MAX_LOG_CHARACTERS = 100_000;

/** Why the service did not reach `running`. */
export type StartupFailureCause =
  | "no-first-output"
  | "no-url-line"
  | "exit-before-ready"
  | "install-failed"
  | "spawn-error";

// Redaction lives in `service/credentials.ts` (the credential value object); callers that need
// it import it from there. This module deliberately re-exports nothing.

export interface ActivityBudgetOptions {
  /** Maximum silence (ms) before the budget is exhausted. */
  readonly timeoutMs: number;
  readonly now?: () => number;
}

/** A wall-clock budget that every unit of child output resets. */
export class ActivityBudget {
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private lastActivityAt: number;
  private started = false;

  public constructor(options: ActivityBudgetOptions) {
    this.timeoutMs = options.timeoutMs;
    this.clock = options.now ?? Date.now;
    this.lastActivityAt = this.clock();
  }

  /** Records output (or any other proof of progress) and restarts the silence window. */
  public touch(): void {
    this.started = true;
    this.lastActivityAt = this.clock();
  }

  /** True once the child produced anything. */
  public get hasOutput(): boolean {
    return this.started;
  }

  /** Milliseconds since the last recorded activity. */
  public silenceMs(): number {
    return this.clock() - this.lastActivityAt;
  }

  /** True when the silence window is exhausted. */
  public expired(): boolean {
    return this.silenceMs() >= this.timeoutMs;
  }

  public get timeout(): number {
    return this.timeoutMs;
  }
}

export interface ReadinessWatcherOptions {
  readonly timeoutMs: number;
  readonly pattern?: RegExp;
  readonly now?: () => number;
}

/**
 * Accumulates child output, detects the ready URL, and tracks the activity budget.
 * `push` is the only mutation point, mirroring the single-writer rule for service state.
 */
export class ReadinessWatcher {
  public readonly budget: ActivityBudget;
  private readonly pattern: RegExp;
  private log = "";
  private url: string | null = null;

  public constructor(options: ReadinessWatcherOptions) {
    this.pattern = options.pattern ?? READY_PATTERN;
    this.budget = new ActivityBudget(
      options.now === undefined ? { timeoutMs: options.timeoutMs } : { timeoutMs: options.timeoutMs, now: options.now },
    );
  }

  public push(chunk: string): void {
    this.budget.touch();
    if (this.url !== null) return;
    this.log = `${this.log}${chunk}`.slice(-MAX_LOG_CHARACTERS);
    const match = this.pattern.exec(this.log);
    if (match?.[1] !== undefined) this.url = match[1];
  }

  /** The launch URL once it has been observed. */
  public get readyUrl(): string | null {
    return this.url;
  }

  /** The retained (unredacted) child log; never return this directly to a caller. */
  public get rawLog(): string {
    return this.log;
  }

  /** Redacted, bounded log tail safe for snapshots and errors. */
  public get logTail(): string {
    return redactedLogTail(this.log);
  }

  /** Distinguishes "never printed anything" from "printed, but no URL line". */
  public cause(): StartupFailureCause {
    return this.log.trim() === "" ? "no-first-output" : "no-url-line";
  }
}

/** Context for {@link startupFailureMessage}. */
export interface StartupFailureContext {
  readonly cause: StartupFailureCause;
  readonly timeoutMs?: number;
  readonly log?: string;
  readonly runtimeRoot?: string | null;
  readonly npmStderrTail?: string | null;
  readonly exit?: { readonly code: number | null; readonly signal: string | null } | undefined;
  readonly detail?: string | undefined;
}

/**
 * Builds a startup failure message that always carries the three things an operator needs:
 * the redacted Harness log tail, the runtime package path, and the npm stderr tail.
 */
export function startupFailureMessage(context: StartupFailureContext): string {
  const parts: string[] = [];
  switch (context.cause) {
    case "exit-before-ready":
      parts.push(
        `Harness Web service exited before readiness (code ${String(context.exit?.code ?? null)}, signal ${String(context.exit?.signal ?? null)}).`,
      );
      break;
    case "install-failed":
      parts.push(`Harness runtime package install failed.${context.detail === undefined ? "" : ` ${context.detail}`}`);
      break;
    case "spawn-error":
      parts.push(`Harness Web service could not be spawned.${context.detail === undefined ? "" : ` ${context.detail}`}`);
      break;
    default:
      parts.push(
        `Harness Web service did not become ready within ${String(context.timeoutMs ?? 0)}ms of silence (${context.cause}).`,
      );
      break;
  }
  if (context.runtimeRoot !== null && context.runtimeRoot !== undefined) {
    parts.push(`Runtime package: ${context.runtimeRoot}`);
  }
  const harnessLog = redactedLogTail(context.log ?? "");
  parts.push(`Harness log tail: ${harnessLog === "" ? "(empty)" : harnessLog}`);
  const npmTail = context.npmStderrTail?.trim() ?? "";
  parts.push(`npm stderr tail: ${npmTail === "" ? "(none)" : redactedLogTail(npmTail, 2_000)}`);
  return parts.join(" ");
}
