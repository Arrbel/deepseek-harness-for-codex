// Run journal (R3-3): atomic writes, strict parsing, and "a broken journal never breaks a run".
//
// The two properties worth testing here are the ones the task made red lines:
//   * a crash can never leave a half-written record (`.tmp` + rename), and a leftover `.tmp` is
//     never read back as a record;
//   * a journal that cannot be written (read-only directory, refused path) reports and returns
//     false — it must not throw into the run's flow.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JOURNAL_VERSION,
  RunJournal,
  isSafeRunId,
  journalPath,
  journalWebUrl,
  parseJournal,
  serializeJournal,
  serviceHomesUnder,
  urlCarriesCredential,
  type JournalRecord,
} from "../../src/run/journal.js";
import "../support/isolation.js";

// The atomic-write contract needs the *sequence* of filesystem calls, not just the end state.
// `vi.hoisted` keeps the recorder reachable from the hoisted factory; every mocked function still
// delegates to the real implementation, so nothing else changes behaviour.
const fsSpy = vi.hoisted(() => ({
  calls: [] as { op: string; path: string; to?: string; mode?: number | undefined }[],
  failRename: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const options = args[2];
      const mode = typeof options === "object" && options !== null && typeof options.mode === "number" ? options.mode : undefined;
      fsSpy.calls.push({ op: "write", path: String(args[0]), mode });
      return actual.writeFileSync(...args);
    },
    renameSync: (from: string, to: string) => {
      fsSpy.calls.push({ op: "rename", path: from, to });
      if (fsSpy.failRename) {
        throw Object.assign(new Error("simulated crash between write and rename"), { code: "EXDEV" });
      }
      return actual.renameSync(from, to);
    },
  };
});

const scratch: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-journal-"));
  scratch.push(home);
  return home;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
  fsSpy.calls.length = 0;
  fsSpy.failRename = false;
});

function record(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: JOURNAL_VERSION,
    runId: "4d6f2a1e-0000-4000-8000-000000000001",
    serviceId: "svc-1",
    sessionId: "ses-1",
    sessionReused: false,
    workspace: "C:\\ws",
    task: "do the thing",
    webUrl: "http://127.0.0.1:51234/?token=fixture",
    startedAt: "2026-10-09T00:00:00.000Z",
    finishedAt: null,
    status: "running",
    reason: null,
    lastKnownSeq: 7,
    startEventSeq: 3,
    sawRunningSession: true,
    cancelRequested: false,
    error: null,
    ...overrides,
  };
}

describe("journal format", () => {
  it("round-trips a record", () => {
    expect(parseJournal(serializeJournal(record()))).toEqual(record());
  });

  it("round-trips a terminal record", () => {
    const failed = record({
      status: "failed",
      reason: "turn-unknown:missing-turn-end",
      finishedAt: "2026-10-09T00:05:00.000Z",
      error: "no marker",
      // A terminal record never carries the launch credential (R3-3b).
      webUrl: "http://127.0.0.1:51234/",
    });
    expect(parseJournal(serializeJournal(failed))).toEqual(failed);
  });

  it("refuses anything malformed instead of guessing", () => {
    expect(parseJournal("not json")).toBeNull();
    expect(parseJournal("[]")).toBeNull();
    expect(parseJournal("null")).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), version: 99 }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), runId: "../escape" }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), status: "stalled" }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), startedAt: "yesterday" }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), lastKnownSeq: -1 }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), lastKnownSeq: 1.5 }))).toBeNull();
    // A `running` record must not carry terminal fields, and a terminal one must carry both.
    expect(parseJournal(JSON.stringify({ ...record(), finishedAt: "2026-10-09T00:05:00.000Z" }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), status: "failed", reason: null }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), status: "cancelled", finishedAt: null }))).toBeNull();
    expect(parseJournal(JSON.stringify({ ...record(), status: "succeeded", reason: "auth" }))).toBeNull();
  });

  it("keeps an unknown reason string (it degrades to report-only downstream)", () => {
    const exotic = record({ status: "failed", reason: "some/new-failure" as never, finishedAt: "2026-10-09T00:05:00.000Z" });
    expect(parseJournal(serializeJournal(exotic))?.reason).toBe("some/new-failure");
  });

  it("accepts only plain file names as run ids", () => {
    expect(isSafeRunId("abc-123_DEF.4")).toBe(true);
    expect(isSafeRunId("../escape")).toBe(false);
    expect(isSafeRunId("a/b")).toBe(false);
    expect(isSafeRunId("a\\b")).toBe(false);
    expect(isSafeRunId("")).toBe(false);
    expect(isSafeRunId(".hidden")).toBe(false);
  });

  it("locates records under runs/", () => {
    expect(journalPath("C:\\data\\services\\k", "run-1")).toBe("C:\\data\\services\\k\\runs\\run-1.json");
  });
});

describe("the launch credential is kept only while it is live (R3-3b)", () => {
  // A distinctive value so the assertion can search for *this* token, not for a shape that the
  // record's own ids (a 36-char UUID, `session-<uuid>`) would also match.
  const TOKEN = "fixtureSuperSecretTokenValue0123456789";
  const LIVE_URL = `http://127.0.0.1:51234/?token=${TOKEN}`;

  it("keeps the full link while the run can still be adopted", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    expect(journal.write(record({ webUrl: LIVE_URL }))).toBe(true);

    const file = readFileSync(journal.pathFor(record().runId), "utf8");
    expect(file).toContain(`token=${TOKEN}`);
    expect(journal.read(record().runId)?.webUrl).toBe(LIVE_URL);
  });

  it("drops the credential from a terminal record, keeping origin + path", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    expect(
      journal.write(
        record({ webUrl: LIVE_URL, status: "failed", reason: "auth", finishedAt: "2026-10-09T00:05:00.000Z", error: "no" }),
      ),
    ).toBe(true);

    const file = readFileSync(journal.pathFor(record().runId), "utf8");
    expect(file).not.toContain("token=");
    expect(file).not.toContain(TOKEN);
    expect(journal.read(record().runId)?.webUrl).toBe("http://127.0.0.1:51234/");
  });

  it("is enforced by the write path itself, whatever the caller built", () => {
    // The projection helpers also redact, but this is the choke point: a caller that hands a
    // terminal record straight to `write()` must not be able to put the token on disk.
    const home = tempHome();
    const journal = new RunJournal(home);
    const terminal = {
      ...record({ webUrl: LIVE_URL }),
      status: "succeeded" as const,
      finishedAt: "2026-10-09T00:05:00.000Z",
    };

    expect(journal.write(terminal)).toBe(true);
    expect(readFileSync(journal.pathFor(record().runId), "utf8")).not.toContain(TOKEN);
  });

  it("cleans a terminal record written by an older build when it is read back", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    // Exactly what a pre-R3-3b build would have left behind.
    const legacy = { ...record({ webUrl: LIVE_URL }), status: "succeeded", finishedAt: "2026-10-09T00:05:00.000Z" };
    mkdirSync(join(home, "runs"), { recursive: true });
    writeFileSync(journal.pathFor(record().runId), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    expect(journal.read(record().runId)?.webUrl).toBe("http://127.0.0.1:51234/");
    // The file itself is only repaired by the next write; a terminal record is never written again,
    // so the invariant is stated for the write path (and any such file is pre-release only).
    expect(readFileSync(journal.pathFor(record().runId), "utf8")).toContain(TOKEN);
  });

  it("recognises a credential URL the same way the rest of the code does", () => {
    expect(urlCarriesCredential(LIVE_URL)).toBe(true);
    expect(urlCarriesCredential("http://127.0.0.1:51234/?TOKEN=abc")).toBe(true);
    expect(urlCarriesCredential("http://127.0.0.1:51234/")).toBe(false);
    expect(urlCarriesCredential("http://127.0.0.1:51234/?notoken=abc")).toBe(false);
    expect(journalWebUrl("http://127.0.0.1:51234/?token=x#frag", "cancelled")).toBe("http://127.0.0.1:51234/");
    // Not a parseable absolute URL: the query is cut anyway, so nothing credential-shaped survives.
    expect(journalWebUrl("127.0.0.1:51234/?token=x", "failed")).toBe("127.0.0.1:51234/");
  });

  it("asks for 0600 on every write (and gets it where the filesystem honours modes)", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    fsSpy.calls.length = 0;

    expect(journal.write(record())).toBe(true);

    const written = fsSpy.calls.find((call) => call.op === "write");
    expect(written?.mode).toBe(0o600);

    // Self-calibrating: Windows reports an emulated 0666 for any writable file (measured), so the
    // *effective* bits are asserted only where a probe file proves the filesystem honours them.
    const probe = join(home, "mode-probe");
    writeFileSync(probe, "", { mode: 0o600 });
    if ((statSync(probe).mode & 0o777) === 0o600) {
      expect(statSync(journal.pathFor(record().runId)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("RunJournal writes", () => {
  it("writes through a temporary file and renames it into place (the atomic-write contract)", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    fsSpy.calls.length = 0;

    expect(journal.write(record())).toBe(true);

    expect(fsSpy.calls.map((call) => call.op)).toEqual(["write", "rename"]);
    const [written, renamed] = fsSpy.calls;
    expect(written?.path).toContain(".tmp");
    expect(renamed?.path).toBe(written?.path);
    expect(renamed?.to).toBe(journal.pathFor(record().runId));
  });

  it("leaves the previous record intact when the rename never happens (crash safety)", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    const problems: string[] = [];
    const failing = new RunJournal(home, (problem) => problems.push(problem.message));
    expect(journal.write(record({ lastKnownSeq: 1 }))).toBe(true);

    // `rename` is where a crash between "temporary written" and "record replaced" lands.
    fsSpy.failRename = true;
    expect(failing.write(record({ lastKnownSeq: 2 }))).toBe(false);
    fsSpy.failRename = false;

    // The durable record is still the *old* one — never a half-applied write.
    expect(journal.read(record().runId)?.lastKnownSeq).toBe(1);
    expect(problems.join("\n")).toContain("journal write failed");
  });

  it("writes atomically and leaves no temporary file behind", () => {
    const home = tempHome();
    const journal = new RunJournal(home);

    expect(journal.write(record())).toBe(true);
    expect(existsSync(join(home, "runs", `${record().runId}.json`))).toBe(true);
    expect(readdirSync(join(home, "runs")).some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect(statSync(join(home, "runs", `${record().runId}.json`)).isFile()).toBe(true);
  });

  it("overwrites a previous record for the same run", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    journal.write(record({ lastKnownSeq: 7 }));
    journal.write(record({ lastKnownSeq: 42, status: "succeeded", finishedAt: "2026-10-09T00:09:00.000Z" }));

    const stored = journal.read(record().runId);
    expect(stored?.lastKnownSeq).toBe(42);
    expect(stored?.status).toBe("succeeded");
  });

  it("never reads a temporary file back as a record", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    journal.write(record());
    // Simulate a writer that died between the temporary write and the rename.
    writeFileSync(join(home, "runs", `${record().runId}.json.99999.tmp`), serializeJournal(record({ runId: "half", task: "x" })));

    const listed = journal.list();
    expect(listed.map((entry) => entry.runId)).toEqual([record().runId]);
  });

  it("reports and skips a malformed file without failing the listing", () => {
    const home = tempHome();
    const problems: string[] = [];
    const journal = new RunJournal(home, (problem) => problems.push(`${problem.path}: ${problem.message}`));
    journal.write(record());
    writeFileSync(join(home, "runs", "broken.json"), "{ not json");

    expect(journal.list().map((entry) => entry.runId)).toEqual([record().runId]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.json");
  });

  it("returns an empty list before any journal exists (a missing directory is not an error)", () => {
    const journal = new RunJournal(tempHome());
    expect(journal.list()).toEqual([]);
    expect(journal.read("nothing")).toBeNull();
  });

  it("reports a failing write instead of throwing (the run must keep working)", () => {
    const home = tempHome();
    const problems: string[] = [];
    const journal = new RunJournal(home, (problem) => problems.push(problem.message));
    // A directory where the record file must go: the rename cannot succeed.
    mkdirSync(join(home, "runs", `${record().runId}.json`), { recursive: true });

    expect(journal.write(record())).toBe(false);
    expect(problems.join("\n")).toContain("journal write failed");
  });

  it("refuses an unsafe run id before touching the filesystem", () => {
    const home = tempHome();
    const problems: string[] = [];
    const journal = new RunJournal(home, (problem) => problems.push(problem.message));

    expect(journal.write(record({ runId: "../escape" }))).toBe(false);
    expect(existsSync(join(home, "escape.json"))).toBe(false);
    expect(problems.join("\n")).toContain("unsafe runId");
  });

  it("sweeps only stale temporary files", () => {
    const home = tempHome();
    const journal = new RunJournal(home);
    journal.write(record());
    const fresh = join(home, "runs", `${record().runId}.json.1.tmp`);
    const stale = join(home, "runs", `${record().runId}.json.2.tmp`);
    writeFileSync(fresh, "{}");
    writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(stale, old, old);

    expect(journal.sweepTemporaries(60_000)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("serviceHomesUnder", () => {
  it("lists service home directories and ignores files", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "dsh-data-"));
    scratch.push(dataDirectory);
    mkdirSync(join(dataDirectory, "services", "abc"), { recursive: true });
    mkdirSync(join(dataDirectory, "services", "def"), { recursive: true });
    writeFileSync(join(dataDirectory, "services", "loose.txt"), "x");

    const homes = serviceHomesUnder(dataDirectory).map((home) => home.split(/[\\/]/u).pop());
    expect(homes.sort()).toEqual(["abc", "def"]);
  });

  it("returns an empty list when there is no data directory yet", () => {
    expect(serviceHomesUnder(join(tempHome(), "missing"))).toEqual([]);
  });
});
