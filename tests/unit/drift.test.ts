// R3-2: drift telemetry stores pointers, and this file tries to make it leak.
//
// The cheap version of this test asserts the field list. That passes even when the implementation
// writes the wrong *thing* into a right-named field, so the load-bearing assertions here drive a
// real payload that contains a token, a cookie value, and model output through the real client and
// then grep the file for them. Two layers are exercised separately:
//
//   * the projection (`gotType` is derived from a value the payload controls, so the payload is the
//     thing that would have to leak), and
//   * the redaction choke point (a registered secret is replaced even when a caller passes it in a
//     pointer-shaped field verbatim).
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DshClient, type FetchLike } from "../../src/dsh/client.js";
import {
  DRIFT_LOG_ENV,
  configureDriftTelemetry,
  disableDriftTelemetry,
  driftLogPath,
  driftTelemetryEnabled,
  driftTelemetryStatus,
  expectedTypeName,
  methodField,
  pointerField,
  recordDrift,
  resetDriftTelemetry,
  typeNameOf,
} from "../../src/dsh/drift.js";
import { REDACTED, forgetSecrets, registerSecret } from "../../src/util/redaction.js";
import "../support/isolation.js";

const WEB_URL = "http://127.0.0.1:1234/?token=fixture-token";
/** Distinctive fragments: if any of these appear in the file, the probe failed. */
const TOKEN = "sk-live-9f3c-SECRET-PROBE-TOKEN";
const COOKIE_VALUE = "SECRET-COOKIE-VALUE";
const MODEL_OUTPUT = "SECRET-MODEL-OUTPUT";
const ALLOWED_KEYS = ["ts", "kind", "method", "path", "expected", "gotType", "pluginVersion", "dshVersion", "runId"];

const scratchDirectories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-drift-"));
  scratchDirectories.push(directory);
  return directory;
}

/** A fetch stub that answers the launch exchange and then one drifting RPC value. */
function stubFetch(value: unknown): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === WEB_URL) {
      return new Response(null, { status: 303, headers: { "set-cookie": `dsh-auth=${COOKIE_VALUE}; HttpOnly` } });
    }
    void init;
    return Response.json({ result: { ok: true, value } });
  };
}

function clientFor(value: unknown): DshClient {
  const fetchImpl = stubFetch(value);
  return new DshClient({ serviceId: "svc-1", credentialSlots: { webUrl: WEB_URL, cookie: null, pending: null }, fetchImpl });
}

beforeEach(() => {
  resetDriftTelemetry();
  forgetSecrets();
});

afterEach(() => {
  resetDriftTelemetry();
  forgetSecrets();
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("drift telemetry: the file holds pointers, not payload", () => {
  it("does not let a token, a cookie, or model output reach the file even when they are the payload", async () => {
    const dataDirectory = scratch();
    const status = configureDriftTelemetry({ dataDirectory, dshVersion: "0.2.1-alpha.1" });
    expect(status.enabled).toBe(true);
    const filePath = join(dataDirectory, "logs", "drift.jsonl");
    expect(status.filePath).toBe(filePath);
    expect(dataDirectory.startsWith(tmpdir())).toBe(true);

    // Three real drifts through the real client. Each payload carries a secret in a different
    // shape: the offending value itself, siblings of the offending field, and a nested field.
    // (A payload that only *adds* unknown keys would not drift at all — the validator strips them.)
    const payloads: { value: unknown; path: string }[] = [
      { value: { items: TOKEN }, path: "result.value.items" },
      {
        value: { items: "not-an-array", authorization: `Bearer ${TOKEN}`, note: `cookie: ${COOKIE_VALUE}` },
        path: "result.value.items",
      },
      { value: { items: [{ preview: MODEL_OUTPUT }] }, path: "result.value.items.0.sessionId" },
    ];
    // One client per payload keeps the stub honest (each answers with its own drifting value).
    for (const payload of payloads) {
      const drifting = clientFor(payload.value);
      await expect(drifting.call("session/list", { _request: {} })).rejects.toThrow(/drifts from the contract/u);
    }

    const text = readFileSync(filePath, "utf8");
    // 1. The secrets themselves are absent, in every shape they had.
    for (const secret of [TOKEN, COOKIE_VALUE, MODEL_OUTPUT, "Bearer "]) {
      expect(text, secret).not.toContain(secret);
    }
    // 2. No free-text field exists under any name.
    expect(text).not.toMatch(/"(message|prompt|body|cookie|token|authorization|preview|note)":/iu);

    // 3. The pointers that make the record useful are all there.
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    for (const [index, line] of lines.entries()) {
      expect(line["kind"]).toBe("protocol-drift");
      expect(line["method"]).toBe("session/list");
      expect(line["path"]).toBe(payloads[index]!.path);
      expect(["array", "string"]).toContain(line["expected"]);
      // The payload was an object; only its *type* is kept.
      expect(line["gotType"]).toBe("object");
      expect(line["pluginVersion"]).toBeTypeOf("string");
      expect(line["dshVersion"]).toBe("0.2.1-alpha.1");
      expect(typeof line["ts"]).toBe("string");
      expect(Object.keys(line).filter((key) => !ALLOWED_KEYS.includes(key))).toEqual([]);
    }
    // 4. Every stored value is a scalar pointer; nothing nested came through.
    for (const line of lines) {
      for (const [key, value] of Object.entries(line)) {
        expect(value === null || typeof value === "string", key).toBe(true);
      }
    }
  });

  it("keeps only the type of the offending value, never the value", () => {
    const dataDirectory = scratch();
    configureDriftTelemetry({ dataDirectory });

    const stored = recordDrift({
      kind: "protocol-drift",
      method: "session/list",
      path: "result.value.items",
      expected: "array",
      gotValue: TOKEN,
    });

    expect(stored).toMatchObject({ gotType: "string", method: "session/list", path: "result.value.items", expected: "array" });
    expect(JSON.stringify(stored)).not.toContain("SECRET-PROBE-TOKEN");
    expect(readFileSync(join(dataDirectory, "logs", "drift.jsonl"), "utf8")).not.toContain("SECRET-PROBE-TOKEN");
  });

  it("drops a method name it does not know, so a credential cannot be passed off as one", () => {
    const dataDirectory = scratch();
    configureDriftTelemetry({ dataDirectory });

    // `TOKEN` is pointer-shaped, so a charset check would have accepted it.
    expect(pointerField(TOKEN)).toBe(TOKEN);
    expect(methodField(TOKEN)).toBeNull();
    expect(methodField("session/list")).toBe("session/list");

    expect(recordDrift({ kind: "protocol-drift", method: TOKEN })?.method).toBeNull();
    expect(recordDrift({ kind: "protocol-drift", method: "session/list" })?.method).toBe("session/list");
    expect(readFileSync(join(dataDirectory, "logs", "drift.jsonl"), "utf8")).not.toContain(TOKEN);
  });

  it("replaces a registered secret even when it arrives in a pointer-shaped field", () => {
    const dataDirectory = scratch();
    configureDriftTelemetry({ dataDirectory });
    // This is the layer that does not depend on the projection having been written correctly:
    // `path` accepts any pointer-shaped string, so the choke point is what saves us here.
    registerSecret(TOKEN);

    const stored = recordDrift({ kind: "protocol-drift", path: TOKEN });

    // The caller and the file get the same representation — there is no unredacted copy to log.
    expect(stored?.path).toBe(REDACTED);
    const text = readFileSync(join(dataDirectory, "logs", "drift.jsonl"), "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain(REDACTED);
  });
});

describe("drift telemetry: lifecycle", () => {
  it("creates nothing until a drift actually happens", () => {
    const dataDirectory = scratch();
    configureDriftTelemetry({ dataDirectory });

    // Enabling telemetry is not a filesystem operation: a process that never drifts must not
    // add `logs/` — that is the same defect class as a test writing a user's data directory.
    expect(existsSync(join(dataDirectory, "logs"))).toBe(false);
    expect(driftTelemetryStatus()).toMatchObject({ enabled: true, written: 0, failures: 0 });

    recordDrift({ kind: "protocol-drift", method: "session/list" });
    expect(existsSync(join(dataDirectory, "logs", "drift.jsonl"))).toBe(true);
    expect(driftTelemetryStatus().written).toBe(1);
  });

  it("is on by default and can be disabled by the environment", () => {
    expect(driftTelemetryEnabled({})).toBe(true);
    expect(driftTelemetryEnabled({ [DRIFT_LOG_ENV]: "" })).toBe(true);
    expect(driftTelemetryEnabled({ [DRIFT_LOG_ENV]: "1" })).toBe(true);
    for (const off of ["0", "off", "false", "no", "disabled", "OFF"]) {
      expect(driftTelemetryEnabled({ [DRIFT_LOG_ENV]: off }), off).toBe(false);
    }

    const dataDirectory = scratch();
    const status = configureDriftTelemetry({ dataDirectory, env: { [DRIFT_LOG_ENV]: "off" } });
    expect(status).toMatchObject({ enabled: false, filePath: null });
    expect(recordDrift({ kind: "protocol-drift", method: "session/list" })).toBeNull();
    expect(existsSync(join(dataDirectory, "logs"))).toBe(false);

    // Disabling after the fact stops writes as well.
    configureDriftTelemetry({ dataDirectory });
    expect(driftTelemetryStatus().enabled).toBe(true);
    disableDriftTelemetry();
    expect(recordDrift({ kind: "protocol-drift" })).toBeNull();
  });

  it("never throws and never blocks the caller when the sink is unusable", () => {
    const dataDirectory = scratch();
    configureDriftTelemetry({ dataDirectory });
    // A *file* where the `logs` directory must go: the write cannot succeed.
    writeFileSync(join(dataDirectory, "logs"), "not a directory", "utf8");

    let stored: unknown = "unset";
    expect(() => {
      stored = recordDrift({ kind: "protocol-drift", method: "session/list" });
    }).not.toThrow();

    // The record is still built (the caller gets its pointer), and the failure is counted, silent.
    expect(stored).toMatchObject({ kind: "protocol-drift", method: "session/list" });
    expect(driftTelemetryStatus()).toMatchObject({ written: 0, failures: 1 });
    expect(driftTelemetryStatus().filePath).toContain(join(dataDirectory, "logs", "drift.jsonl"));
  });

  it("writes one parseable JSON object per line, appended never rewritten", () => {
    const dataDirectory = scratch();
    const fixed = new Date("2026-10-09T00:00:00.000Z");
    configureDriftTelemetry({ dataDirectory, now: () => fixed });

    recordDrift({ kind: "protocol-drift", method: "session/list", path: "result.value.items" });
    recordDrift({ kind: "protocol-drift", method: "session/page", runId: "run-1" });

    const lines = readFileSync(join(dataDirectory, "logs", "drift.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ts: fixed.toISOString(), method: "session/list" });
    expect(lines[0]).not.toContain("runId");
    expect(JSON.parse(lines[1]!)).toMatchObject({ method: "session/page", runId: "run-1" });
  });

  it("resolves the log path under the injected data directory", () => {
    const base = scratch();
    expect(driftLogPath(base)).toBe(join(base, "logs", "drift.jsonl"));
    expect(driftLogPath(base)).toContain("drift.jsonl");
    // The configured directory is exactly the one telemetry writes into.
    configureDriftTelemetry({ dataDirectory: base });
    recordDrift({ kind: "protocol-drift", method: "session/list" });
    expect(existsSync(join(base, "logs", "drift.jsonl"))).toBe(true);
  });
});

describe("drift telemetry: field projections", () => {
  it("names types from a fixed vocabulary", () => {
    expect(typeNameOf(null)).toBe("null");
    expect(typeNameOf(undefined)).toBe("undefined");
    expect(typeNameOf([1, 2])).toBe("array");
    expect(typeNameOf({ a: 1 })).toBe("object");
    expect(typeNameOf("x")).toBe("string");
    expect(typeNameOf(1)).toBe("number");
    expect(typeNameOf(true)).toBe("boolean");
    expect(typeNameOf(() => undefined)).toBe("function");
    // Never the value, whatever the value looks like.
    expect(typeNameOf(TOKEN)).toBe("string");
    expect(typeNameOf({ cookie: COOKIE_VALUE })).toBe("object");
  });

  it("whitelists the expected type instead of storing validator text", () => {
    expect(expectedTypeName("string")).toBe("string");
    expect(expectedTypeName("ARRAY")).toBe("array");
    expect(expectedTypeName("Expected string, received number")).toBe("other");
    expect(expectedTypeName(TOKEN)).toBe("other");
    expect(expectedTypeName("")).toBeNull();
    expect(expectedTypeName(7)).toBeNull();
  });

  it("rejects pointer fields that are not pointer-shaped", () => {
    expect(pointerField("result.value.items.0.sessionId")).toBe("result.value.items.0.sessionId");
    expect(pointerField("  payload.args.request.sessionId  ")).toBe("payload.args.request.sessionId");
    expect(pointerField("has spaces and 'quotes'")).toBeNull();
    expect(pointerField("tökén")).toBeNull();
    expect(pointerField("x".repeat(200))).toBeNull();
    expect(pointerField("")).toBeNull();
    expect(pointerField(7)).toBeNull();
    expect(pointerField(null)).toBeNull();
  });
});
