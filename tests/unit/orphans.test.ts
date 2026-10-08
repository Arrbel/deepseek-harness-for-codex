// Pure pidfile / orphan policy (P0-1). The decisions that must never be wrong live here:
// a pidfile is evidence, not permission, and an unprovable identity means "do not kill".

import { describe, expect, it } from "vitest";
import {
  PID_FILE_NAME,
  identityOwnsRecord,
  orphanProblem,
  orphanState,
  parsePidFile,
  pidFilePath,
  serializePidFile,
  type PidFileRecord,
} from "../../src/policy/orphans.js";
import "../support/isolation.js";

const record: PidFileRecord = {
  pid: 4242,
  port: 51_234,
  version: "0.2.1-alpha.1",
  binPath: "C:\\data\\versions\\0.2.1-alpha.1\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
  startedAt: "2026-10-09T00:00:00.000Z",
  dataDirectory: "C:\\data",
  workspace: "C:\\ws",
  serviceHome: "C:\\data\\services\\abc",
};

describe("pidfile serialization", () => {
  it("round-trips every field", () => {
    expect(parsePidFile(serializePidFile(record))).toEqual(record);
  });

  it("keeps a starting child's unknown port as null", () => {
    const starting = { ...record, port: null };
    expect(parsePidFile(serializePidFile(starting))?.port).toBeNull();
  });

  it("locates the file inside the service home", () => {
    expect(pidFilePath("C:\\data\\services\\abc")).toBe(`C:\\data\\services\\abc\\${PID_FILE_NAME}`);
  });

  it("returns null instead of guessing for anything malformed", () => {
    expect(parsePidFile("not json")).toBeNull();
    expect(parsePidFile("null")).toBeNull();
    expect(parsePidFile("[]")).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, pid: 0 }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, pid: -3 }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, pid: "4242" }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, pid: 1.5 }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, port: 70_000 }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, port: "51234" }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, binPath: "" }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ ...record, serviceHome: "   " }))).toBeNull();
    expect(parsePidFile(JSON.stringify({ pid: 1, port: 2 }))).toBeNull();
  });
});

describe("orphan classification is fail-closed", () => {
  it("maps liveness and ownership onto the three reported states", () => {
    expect(orphanState({ alive: false, owned: false })).toBe("stale-pidfile");
    expect(orphanState({ alive: false, owned: null })).toBe("stale-pidfile");
    expect(orphanState({ alive: true, owned: true })).toBe("alive");
    expect(orphanState({ alive: true, owned: false })).toBe("unverified");
    expect(orphanState({ alive: true, owned: null })).toBe("unverified");
  });

  it("requires both the recorded binPath and our --port argument", () => {
    const cmdline = `"C:\\Program Files\\nodejs\\node.exe" ${record.binPath} web --no-open --port 0`;
    expect(identityOwnsRecord(cmdline, record)).toBe(true);
    // A recycled pid running something else is never ours.
    expect(identityOwnsRecord("node C:\\other\\script.js --serve", record)).toBe(false);
    // Missing our argv marker is not enough proof either.
    expect(identityOwnsRecord(`node ${record.binPath} web`, record)).toBe(false);
    expect(identityOwnsRecord(null, record)).toBe(false);
    expect(identityOwnsRecord("", record)).toBe(false);
    expect(identityOwnsRecord("   ", record)).toBe(false);
  });

  it("compares case- and separator-insensitively on Windows only", () => {
    const upper = `"C:\\NODE.EXE" C:/DATA/VERSIONS/0.2.1-ALPHA.1/NODE_MODULES/@DEEPSEEK-AI/DSH/LIB/BIN.JS web --port 0`;
    expect(identityOwnsRecord(upper, record, "win32")).toBe(true);
    expect(identityOwnsRecord(upper, record, "linux")).toBe(false);
  });

  it("turns findings into one actionable line, or nothing", () => {
    expect(orphanProblem([])).toBeNull();
    const alive = orphanProblem([{ pid: 4242, port: 51_234, serviceHome: record.serviceHome, state: "alive" }]);
    expect(alive).toContain("4242");
    expect(alive).toContain("does not block `ready`");
    const stale = orphanProblem([{ pid: null, port: null, serviceHome: record.serviceHome, state: "stale-pidfile" }]);
    expect(stale).toContain("leftover pid files");
    expect(stale).not.toMatch(/\(pid /u);
  });
});
