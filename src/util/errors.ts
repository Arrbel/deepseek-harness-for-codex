// Small pure helpers shared across layers.

/** Message of any thrown value, without assuming it is an `Error`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Last `max` characters of `value` (bounded evidence for errors and diagnostics). */
export function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(-max);
}

/** Appends one line to a bounded log buffer, keeping only the newest characters. */
export function appendBounded(current: string | null, line: string, max: number): string {
  return tail(`${current ?? ""}${line}\n`, max);
}

/** Waits `ms` milliseconds (polling primitive; also injectable in tests). */
export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Configuration/expectation failure that carries an actionable hint. */
export class ConfigError extends Error {
  /** Stable failure class (e.g. `npm-cli-missing`). */
  public readonly kind: string;
  /** Operator-facing next step, or `null` when there is nothing actionable to add. */
  public readonly hint: string | null;

  public constructor(kind: string, message: string, init: { hint?: string; cause?: unknown } = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ConfigError";
    this.kind = kind;
    this.hint = init.hint ?? null;
  }
}
