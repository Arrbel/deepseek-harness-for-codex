// Drift telemetry (R3-2): one JSON line per protocol-drift observation, pointers only.
//
// Why a file at all: a drift is the one failure whose *shape* an operator needs later, long after
// the run that produced it. `<dataDir>/logs/drift.jsonl` is the only sink; it is created on demand
// (the directory is created by the first record, never by enabling the feature) and writing is
// best-effort — telemetry must never break the main flow.
//
// The leak discipline is structural, in three layers:
//
//   1. **A call site cannot pass a value.** {@link DriftFacts} has `gotValue`, and the writer keeps
//      only {@link typeNameOf} of it — a fixed vocabulary (`string`, `array`, `null`, …). The raw
//      value is never stored, so a token in a payload cannot become a field.
//   2. **Untrusted text is whitelisted.** `expected` comes from a validator's type name and is
//      mapped through {@link expectedTypeName}; anything unrecognized becomes `other`. `method`,
//      `path`, and `runId` are pointer-shaped and pass {@link pointerField}.
//   3. **Registered secrets are scrubbed anyway.** The record passes the project's single redaction
//      choke point (`util/redaction.ts`) *before* it is written and before it is returned, so the
//      caller and the file see one and the same representation.
//
// Best-effort by construction: every filesystem call is inside one `try`/`catch`.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../util/redaction.js";
import { PACKAGE_VERSION } from "../version.js";
import { METHODS } from "./contract.js";

/** Env var that disables drift telemetry (`0`, `off`, `false`, `no`, `disabled`). Default: enabled. */
export const DRIFT_LOG_ENV = "DSH_MCP_DRIFT_LOG";

/** Directory under the data directory; `logs/` is created by the first record only. */
export const DRIFT_LOG_DIRECTORY = "logs";

/** File name inside {@link DRIFT_LOG_DIRECTORY}. */
export const DRIFT_LOG_FILENAME = "drift.jsonl";

/** The longest pointer-shaped field we will store. */
const MAX_POINTER_CHARACTERS = 120;

/**
 * The record shape. Every field is a pointer, an identifier, or a type name.
 *
 * Deliberately absent: `message`, request/response bodies, prompts, model output, cookies, tokens,
 * and any other free text — there is no field that could hold them.
 */
export interface DriftRecord {
  /** ISO-8601 observation time. */
  readonly ts: string;
  /** Failure class, e.g. `protocol-drift`. */
  readonly kind: string;
  /** RPC method the drift belongs to, when it belongs to one call. */
  readonly method: string | null;
  /** JSON path of the offending field, e.g. `result.value.items.0.sessionId`. */
  readonly path: string | null;
  /** The type the contract expected, from a fixed vocabulary. */
  readonly expected: string | null;
  /** The type that arrived, from a fixed vocabulary — never the value. */
  readonly gotType: string | null;
  /** This plugin's version. */
  readonly pluginVersion: string;
  /** The Harness version this process will talk to, from configuration. */
  readonly dshVersion: string | null;
  /** The run the drift interrupted, when the caller knows it. */
  readonly runId?: string;
}

/** What a call site may report. `gotValue` is consumed for its type only. */
export interface DriftFacts {
  readonly kind: string;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly expected?: string | null;
  /** The offending value as it arrived; only its *type* is ever written. */
  readonly gotValue?: unknown;
  /** The validator's own type name; mapped through a whitelist. */
  readonly expectedType?: string | null;
  readonly runId?: string | null;
}

interface DriftSink {
  readonly filePath: string;
  readonly dshVersion: string | null;
  readonly pluginVersion: string;
  readonly now: () => Date;
}

/** Resolved telemetry state, for `doctor` and tests. */
export interface DriftTelemetryStatus {
  readonly enabled: boolean;
  readonly filePath: string | null;
  readonly written: number;
  readonly failures: number;
}

let sink: DriftSink | null = null;
let written = 0;
let failures = 0;

/** `typeof`/arity as a fixed vocabulary; the value itself is never returned. */
export function typeNameOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  const kind = typeof value;
  return kind === "object" ? "object" : kind;
}

/**
 * Validator type names we are willing to write down.
 *
 * A whitelist, not a sanitiser: a validator's "expected" text is free-form, so anything outside
 * this set collapses to `other` instead of being stored.
 */
const KNOWN_EXPECTED_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
  "undefined",
  "date",
  "literal",
  "union",
  "enum",
  "record",
  "tuple",
  "map",
  "set",
  "bigint",
  "symbol",
  "function",
  "void",
  "never",
  "any",
  "unknown",
]);

/** Maps a validator's expected-type text through {@link KNOWN_EXPECTED_TYPES}. */
export function expectedTypeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  return KNOWN_EXPECTED_TYPES.has(normalized) ? normalized : "other";
}

/**
 * A pointer-shaped field: identifiers, JSON paths, and run ids only.
 *
 * Anything that is not a short string of pointer characters becomes `null` rather than being
 * truncated and stored — a field we cannot recognise is not worth keeping.
 */
export function pointerField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_POINTER_CHARACTERS) return null;
  return /^[A-Za-z0-9_./:@<>[\]|,-]+$/u.test(trimmed) ? trimmed : null;
}

/** The RPC methods this client can call; anything else is not a method name. */
const KNOWN_METHODS = new Set<string>(Object.keys(METHODS));

/**
 * The `method` field: a whitelist, not a shape check.
 *
 * A charset check would accept `sk-live-…` (base64url is pointer-shaped). Requiring membership in
 * {@link KNOWN_METHODS} means a credential cannot be smuggled through this field at all, whether
 * or not it was ever registered as a secret.
 */
export function methodField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return KNOWN_METHODS.has(value) ? value : null;
}

/** True unless the env explicitly turns telemetry off. Unset means on. */
export function driftTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[DRIFT_LOG_ENV] ?? "").trim().toLowerCase();
  if (value === "") return true;
  return !["0", "off", "false", "no", "disabled"].includes(value);
}

/** The absolute log path for a data directory. */
export function driftLogPath(dataDirectory: string): string {
  return join(dataDirectory, DRIFT_LOG_DIRECTORY, DRIFT_LOG_FILENAME);
}

/**
 * Builds the record from the whitelist. Every field is produced here, so an extra property on the
 * caller's object has no way into the file.
 */
function projectDrift(facts: DriftFacts, config: { dshVersion: string | null; pluginVersion: string; now: Date }): DriftRecord {
  const record: DriftRecord = {
    ts: config.now.toISOString(),
    kind: pointerField(facts.kind) ?? "unknown",
    method: methodField(facts.method),
    path: pointerField(facts.path),
    expected: expectedTypeName(facts.expectedType) ?? expectedTypeName(facts.expected),
    gotType: facts.gotValue === undefined ? null : typeNameOf(facts.gotValue),
    pluginVersion: config.pluginVersion,
    dshVersion: pointerField(config.dshVersion),
  };
  const runId = pointerField(facts.runId);
  return runId === null ? record : { ...record, runId };
}

/**
 * Enables telemetry for this process.
 *
 * Resolving the path is not a filesystem operation: nothing is created until the first record, so
 * a process that never drifts never adds a `logs/` directory.
 */
export function configureDriftTelemetry(options: {
  readonly dataDirectory: string;
  readonly dshVersion?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}): DriftTelemetryStatus {
  const env = options.env ?? process.env;
  if (!driftTelemetryEnabled(env)) {
    sink = null;
    return driftTelemetryStatus();
  }
  sink = {
    filePath: driftLogPath(options.dataDirectory),
    dshVersion: options.dshVersion ?? null,
    pluginVersion: PACKAGE_VERSION,
    now: options.now ?? (() => new Date()),
  };
  return driftTelemetryStatus();
}

/** Turns telemetry off and forgets the sink (test isolation). */
export function disableDriftTelemetry(): void {
  sink = null;
}

/** Forgets the sink *and* the counters (test isolation). */
export function resetDriftTelemetry(): void {
  sink = null;
  written = 0;
  failures = 0;
}

/** The resolved state; `written`/`failures` are counters, never content. */
export function driftTelemetryStatus(): DriftTelemetryStatus {
  return { enabled: sink !== null, filePath: sink?.filePath ?? null, written, failures };
}

/**
 * Scrubs every string field of a record.
 *
 * The record that is returned to the caller and the record that is written are the *same* object,
 * so there is exactly one representation of a drift in this process and no unredacted copy can be
 * passed on by a caller that logs what it got back.
 */
function redactRecord(record: DriftRecord): DriftRecord {
  return {
    ts: record.ts,
    kind: redactSecrets(record.kind),
    method: record.method === null ? null : redactSecrets(record.method),
    path: record.path === null ? null : redactSecrets(record.path),
    expected: record.expected === null ? null : redactSecrets(record.expected),
    gotType: record.gotType === null ? null : redactSecrets(record.gotType),
    pluginVersion: record.pluginVersion,
    dshVersion: record.dshVersion === null ? null : redactSecrets(record.dshVersion),
    ...(record.runId === undefined ? {} : { runId: redactSecrets(record.runId) }),
  };
}

/**
 * Records one drift. Best-effort: a missing directory, a read-only disk, or an invalid path is
 * counted and swallowed — telemetry never changes the outcome of the call that produced it.
 */
export function recordDrift(facts: DriftFacts): DriftRecord | null {
  const active = sink;
  if (active === null) return null;
  const projected = projectDrift(facts, { dshVersion: active.dshVersion, pluginVersion: active.pluginVersion, now: active.now() });
  const record = redactRecord(projected);
  try {
    mkdirSync(dirname(active.filePath), { recursive: true, mode: 0o700 });
    appendFileSync(active.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    written += 1;
  } catch {
    failures += 1;
  }
  return record;
}
