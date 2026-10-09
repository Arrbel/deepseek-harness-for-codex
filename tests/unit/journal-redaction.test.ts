// R5-4: the journal's free-text `error` field must be scrubbed like every other outward string.
//
// The inconsistency this file pins: `dsh/drift.ts` redacts its record field by field
// (`redactSecrets(record.path)`, `…expected`, `…gotType`, …), while `run/journal.ts` wrote
// `error` verbatim. An error message is exactly where a `?token=…` URL or a registered credential
// shows up (a launch failure, a failed RPC), so "the journal is the one writer that skips the
// redactor" is a leak waiting for its first bad day.
//
// Three layers are asserted here, because a leak can enter at any of them:
//   1. the pattern layer (`?token=` / `&token=`) — caught even for a token this process never held;
//   2. the registry layer (a literal registered by `service/credentials.ts`) — `Bearer …`, cookies,
//      base64url blobs;
//   3. the legacy-read layer — a record written *before* this fix must not hand the literal back
//      through `parseJournal`/`read`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunJournal, JOURNAL_VERSION, parseJournal, serializeJournal, type JournalRecord } from "../../src/run/journal.js";
import { REDACTED, forgetSecrets, registerSecret } from "../../src/util/redaction.js";
import type { RunStatus } from "../../src/run/types.js";
import "../support/isolation.js";

const TOKEN = "fixtureJournalSecretTokenValue0123456789";
const roots: string[] = [];

function tempHome(): string {
  const directory = mkdtempSync(join(tmpdir(), "dsh-journal-redaction-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
  forgetSecrets();
});

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: JOURNAL_VERSION,
    runId: "run-redaction",
    serviceId: "svc-1",
    sessionId: "ses-1",
    sessionReused: false,
    workspace: "/ws/alpha",
    task: "task",
    webUrl: "http://127.0.0.1:51234/",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: null,
    status: "running" as RunStatus,
    reason: null,
    lastKnownSeq: 0,
    startEventSeq: 0,
    sawRunningSession: true,
    cancelRequested: false,
    error: null,
    ...overrides,
  };
}

/** A terminal record shaped the way the strict parser accepts it. */
function terminal(error: string): JournalRecord {
  return record({
    status: "failed",
    finishedAt: "2026-10-09T00:00:10.000Z",
    reason: "turn-unknown:missing-turn-end",
    error,
  });
}

/** Writes one record through the real class and returns the bytes on disk. */
function written(overrides: Partial<JournalRecord>): string {
  const home = tempHome();
  const journal = new RunJournal(home);
  expect(journal.write(record(overrides))).toBe(true);
  return readFileSync(join(home, "runs", "run-redaction.json"), "utf8");
}

describe("journal error redaction (R5-4)", () => {
  it("scrubs the token= pattern even for a token this process never held", () => {
    const text = written({ status: "failed", error: `launch failed: http://127.0.0.1:9/?token=${TOKEN} refused` });

    expect(text).not.toContain(TOKEN);
    expect(text).toContain("?token=[redacted]");
  });

  it("scrubs a registered credential in any shape (Bearer, cookie, base64url)", () => {
    registerSecret(TOKEN);
    const text = written({
      status: "failed",
      error: `rpc rejected: Authorization: Bearer ${TOKEN}; cookie=${TOKEN}; b64=${TOKEN}`,
    });

    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Bearer fixture");
    expect(text.match(/\[redacted\]/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves a non-secret error readable (no over-redaction)", () => {
    const text = written({ status: "failed", error: "session stopped without a terminal turn marker: ses-1" });

    expect(text).toContain("session stopped without a terminal turn marker: ses-1");
  });

  it("cleans a legacy record on read (a file written before the fix)", () => {
    // `serializeJournal` is the raw serializer: writing the file by hand reproduces exactly what a
    // pre-R5-4 process left on disk. A terminal record must carry `finishedAt` + `reason` to pass
    // the strict parser, so those are part of the fixture.
    const legacy = serializeJournal(terminal(`old failure http://127.0.0.1:9/?token=${TOKEN}`));
    const parsed = parseJournal(legacy);

    expect(parsed?.error).not.toContain(TOKEN);
    expect(parsed?.error).toContain("?token=[redacted]");
  });

  it("cleans a legacy record read through RunJournal.read as well", () => {
    // The `Bearer …` shape is covered by the **registry** layer, not by a pattern: the literal must
    // have been registered (that is what `service/credentials.ts` does when it constructs a
    // credential). `redactSecrets` deliberately has no `Bearer` regex — see the report §R5-4.
    registerSecret(TOKEN);
    const home = tempHome();
    const journal = new RunJournal(home);
    const path = join(home, "runs", "run-redaction.json");
    // The directory must exist before the hand-written file lands in it.
    expect(journal.write(record())).toBe(true);
    writeFileSync(path, serializeJournal(terminal(`Bearer ${TOKEN}`)), { encoding: "utf8" });

    const read = journal.read("run-redaction");
    expect(read?.error).toBe(`Bearer ${REDACTED}`);
  });
});
