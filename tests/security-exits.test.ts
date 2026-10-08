// The all-exits scan (P6 item 1): drive representative failure scenarios and assert that
// **no outward string carries a launch token or a login cookie**.
//
// Why a scan instead of per-site assertions: the defect this replaces was structural — redaction
// was a function each call site had to remember (`browserError = errorText(error)` forgot). The
// fix registers every credential literal in `util/redaction.ts` and scrubs at the single tool
// boundary, so this test is the contract with that design: whatever the scenario, nothing but the
// intentional login URL may carry the token, and nothing at all may carry the cookie.
//
// The one deliberate carrier is the login URL returned to the user (`webUrl`/`loginUrl`): it *is*
// the bearer credential the caller asked for (see `SERVER_INSTRUCTIONS` and README's security
// section). Every other string — snapshots, errors, log tails, doctor output, tool text — must be
// clean, which is what the `loginUrls` bucket exists to keep honest.

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessManager, type HarnessManagerOptions } from "./support/manager.js";
import { createMcpServer } from "../src/tools/register.js";
import "./support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");

/** Unmistakable secrets: nothing legitimate can contain these substrings by accident. */
const TOKEN = "FIXTURE-SECRET-LAUNCH-TOKEN";
const COOKIE_VALUE = "SECRET-COOKIE-VALUE";
const COOKIE_PAIR = `dsh-auth=${COOKIE_VALUE}`;

/** Field names that intentionally carry the one-time login URL. */
const LOGIN_URL_KEYS = new Set(["webUrl", "loginUrl"]);

interface Collected {
  /** Every outward string that must be free of the token and the cookie. */
  readonly outward: string[];
  /** The intentional login-URL carriers, asserted separately. */
  readonly loginUrls: string[];
}

/** Walks a value and sorts every string into "must be clean" or "is the login URL". */
function collect(value: unknown, key: string | null, sink: Collected): Collected {
  if (typeof value === "string") {
    if (key !== null && LOGIN_URL_KEYS.has(key)) sink.loginUrls.push(value);
    else sink.outward.push(value);
    return sink;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, key, sink);
    return sink;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, entry] of Object.entries(value)) collect(entry, childKey, sink);
    return sink;
  }
  return sink;
}

function newSink(): Collected {
  return { outward: [], loginUrls: [] };
}

describe("security: every outward string is credential-free", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: HarnessManager | undefined;
  let client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let previousDataDir: string | undefined;

  function createManager(fixtureEnv: Record<string, string> = {}, openBrowser?: (url: string) => Promise<void>): HarnessManager {
    const options: HarnessManagerOptions = {
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser: openBrowser ?? (async () => undefined),
      launchEnv: { FIXTURE_TOKEN: TOKEN, FIXTURE_COOKIE_VALUE: COOKIE_VALUE, ...fixtureEnv },
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(temporaryRoot, "runtime"),
        packageDir: join(temporaryRoot, "runtime"),
        binPath: fixture,
        installedNow: false,
      }),
    };
    manager = new HarnessManager(options);
    return manager;
  }

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-exits-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    previousDataDir = process.env.DSH_MCP_DATA_DIR;
    process.env.DSH_MCP_DATA_DIR = join(temporaryRoot, "data");
  });

  afterEach(async () => {
    if (client !== undefined) await client.close();
    if (manager !== undefined) await manager.close();
    if (server !== undefined) await server.close();
    client = undefined;
    server = undefined;
    manager = undefined;
    if (previousDataDir === undefined) delete process.env.DSH_MCP_DATA_DIR;
    else process.env.DSH_MCP_DATA_DIR = previousDataDir;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  /** The assertion the whole file exists for. */
  function expectClean(sink: Collected, label: string): void {
    expect(sink.outward.length, `${label}: nothing was collected`).toBeGreaterThan(0);
    for (const text of sink.outward) {
      expect(text, `${label}: token leaked in ${JSON.stringify(text)}`).not.toContain(TOKEN);
      expect(text, `${label}: cookie leaked in ${JSON.stringify(text)}`).not.toContain(COOKIE_VALUE);
      expect(text, `${label}: cookie pair leaked in ${JSON.stringify(text)}`).not.toContain(COOKIE_PAIR);
    }
    // The login URL is the *only* intentional carrier, and it must still be usable.
    for (const url of sink.loginUrls) {
      expect(url, `${label}: the login URL lost its token`).toContain(TOKEN);
      expect(new URL(url).hostname, `${label}: the login URL must stay loopback`).toMatch(/^(127\.0\.0\.1|\[::1\]|localhost)$/u);
    }
  }

  it("keeps a normal run, its service snapshot, and doctor output clean", async () => {
    const container = createManager();
    const started = await container.start({ task: "normal", workspace });
    const finished = await container.wait(started.runId, 5_000);
    const services = container.listServices();
    const sink = newSink();

    collect(started, null, sink);
    collect(finished, null, sink);
    collect(services, null, sink);
    collect(container.doctor(), null, sink);

    expect(finished.status).toBe("succeeded");
    expectClean(sink, "normal run");
    expect(sink.loginUrls.length).toBeGreaterThan(0);
  });

  it("keeps an auth failure and its error text clean", async () => {
    const container = createManager({ FIXTURE_UNAUTHORIZED: "after-prompt" });
    const started = await container.start({ task: "auth lost", workspace });
    const finished = await container.wait(started.runId, 5_000);
    const sink = newSink();
    collect(started, null, sink);
    collect(finished, null, sink);

    expect(finished.status).toBe("failed");
    expect(finished.reason).toBe("auth");
    expectClean(sink, "auth failure");
  });

  it("redacts a browser failure at the source and again at the tool boundary", async () => {
    // The opener receives the login URL and throws it back: this is exactly the leak path
    // (browserError) the P6 audit found. Both layers are checked: the stored snapshot and the
    // MCP tool response.
    const container = createManager({}, async (url) => {
      throw new Error(`browser command failed while opening ${url}`);
    });
    server = createMcpServer(container);
    client = new Client({ name: "exit-scan", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({
      name: "start_run",
      arguments: { task: "open the page", workspace, openBrowser: true },
    });
    const listed = await client.callTool({ name: "list_services", arguments: {} });
    const service = container.listServices()[0];
    const sink = newSink();
    collect(response, null, sink);
    collect(listed, null, sink);
    collect(service, null, sink);

    expect(response.isError).not.toBe(true);
    // `browserError` lives on the service snapshot; both the stored form and the tool response
    // must be clean (the tool boundary is the safety net for a future call site that forgets).
    expect(service?.browserError).toContain("browser command failed");
    expect(service?.browserError).toContain("token=[redacted]");
    expect(service?.browserError).not.toContain(TOKEN);
    expect(JSON.stringify(listed)).toContain("browser command failed");
    expectClean(sink, "browser failure");
  });

  it("keeps a startup failure (whose log carries the token) clean", async () => {
    // `crash-with-token` prints a real-looking launch URL and dies: the failure message embeds the
    // child log tail, which is where an unredacted token would surface.
    const container = createManager({ FIXTURE_MODE: "crash-with-token" });
    const message = await container.startService({ workspace }).then(
      () => "",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const sink = newSink();
    collect(message, null, sink);
    collect(container.listServices(), null, sink);

    expect(message).not.toBe("");
    expectClean(sink, "startup failure");
  });

  it("keeps a token-bearing tool failure clean at the boundary", async () => {
    const container = createManager({ FIXTURE_MODE: "crash-with-token" });
    server = createMcpServer(container);
    client = new Client({ name: "exit-scan-errors", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // The child prints a launch URL containing the token and exits before readiness: the failure
    // text the tool returns embeds that log tail, so the boundary must scrub it.
    const response = await client.callTool({ name: "start_service", arguments: { workspace } });
    const sink = newSink();
    collect(response, null, sink);

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("token=");
    expectClean(sink, "token-bearing tool failure");
  });

  it("never prints a credential through the value object's own stringification", async () => {
    const { LaunchCredentials } = await import("../src/service/credentials.js");
    const credentials = new LaunchCredentials(`http://127.0.0.1:9/?token=${TOKEN}`, COOKIE_PAIR);

    const rendered = [String(credentials), `${credentials}`, JSON.stringify(credentials), credentials.redacted.url];
    for (const text of rendered) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(COOKIE_VALUE);
    }
    expect(credentials.loginUrl).toContain(TOKEN);
    expect(credentials.cookieHeader).toBe(COOKIE_PAIR);
  });
});

describe("security: the scan itself bites", () => {
  it("detects an unredacted credential in a snapshot-shaped value", () => {
    // Positive control: if the collector could not see a leak, the scan above would be theatre.
    const sink = newSink();
    collect({ browserError: `failed for http://127.0.0.1:9/?token=${TOKEN}` }, null, sink);

    expect(sink.outward).toHaveLength(1);
    expect(sink.outward[0]).toContain(TOKEN);
  });

  it("treats webUrl as the intentional carrier and nothing else", () => {
    const sink = newSink();
    collect({ webUrl: `http://127.0.0.1:9/?token=${TOKEN}`, error: "clean" }, null, sink);

    expect(sink.loginUrls).toEqual([`http://127.0.0.1:9/?token=${TOKEN}`]);
    expect(sink.outward).toEqual(["clean"]);
  });
});
