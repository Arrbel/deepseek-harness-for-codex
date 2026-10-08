// Security invariants (P6 items 2, 4, 5, 6, 7): the claims the README and architecture docs make
// are asserted here, so "documented" can never drift from "true".
//
// Every invariant has a documented reverse verification in `reports/impl-security.md`: the static
// scans are backed by greps over `src/**`, and the runtime ones by a scenario that would fail
// loudly if the property were removed.

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessManager, type HarnessManagerOptions } from "./support/manager.js";
import { DshClient } from "../src/dsh/client.js";
import { METHODS } from "../src/dsh/contract.js";
import {
  LaunchCredentials,
  parseSetCookie,
  readSetCookieHeader,
  rememberCookie,
} from "../src/service/credentials.js";
import { isLoopbackUrl } from "../src/policy/trusted-input.js";
import { redactErrorText, redactSecrets, registerSecret } from "../src/util/redaction.js";
import "./support/isolation.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-harness.mjs");
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every `.ts` file under `src/`. */
function sourceFiles(directory = srcRoot, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...sourceFiles(join(directory, entry.name), relative));
    else if (entry.name.endsWith(".ts")) files.push(relative);
  }
  return files;
}

function sourceOf(file: string): string {
  return readFileSync(join(srcRoot, file), "utf8");
}

/** Source with `//` and block comments removed, so documentation may still name what we refuse. */
function codeOf(file: string): string {
  return sourceOf(file)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/\/\/.*$/gmu, "");
}

describe("security: static invariants", () => {
  it("never spawns a shell", () => {
    const offenders = sourceFiles().filter((file) => /shell\s*:\s*true/u.test(codeOf(file)));
    expect(offenders).toEqual([]);
    // The launch vector is the only spawn site, and it states the choice explicitly.
    expect(sourceOf("service/launch.ts")).toContain("shell: false");
  });

  it("has no npx on any launch path", () => {
    // Comments legitimately mention `npx.cmd` as the thing ADR-0002 removed; only code counts.
    const offenders = sourceFiles().filter((file) => /\bnpx(\.cmd)?\b/u.test(codeOf(file)));
    // The one remaining mention is the *deprecated variable name* reported and ignored.
    expect(offenders).toEqual([]);
    expect(sourceOf("config/resolve.ts")).toContain("DSH_MCP_NPX_COMMAND");
    expect(codeOf("service/launch.ts")).not.toMatch(/npx/iu);
  });

  it("never installs a proxy dispatcher (loopback traffic is never proxied)", () => {
    const offenders = sourceFiles().filter((file) =>
      /ProxyAgent|dispatcher\s*:|agent\s*:\s*new/u.test(codeOf(file)),
    );
    expect(offenders).toEqual([]);
    // Node's global fetch (undici) ignores HTTP(S)_PROXY unless a dispatcher is passed, and the
    // client passes none — the runtime proof is the dead-proxy scenario below.
    expect(codeOf("dsh/client.ts")).not.toContain("dispatcher");
  });

  it("keeps the credential module free of IO and of raw console output", () => {
    const credentials = sourceOf("service/credentials.ts");
    expect(credentials).not.toMatch(/console\.|process\.env|node:fs/u);
    const redaction = sourceOf("util/redaction.ts");
    expect(redaction).not.toMatch(/^import /mu);
  });
});

describe("security: cookie parsing prefers the split header API", () => {
  it("reads the cookie from getSetCookie() and survives a comma inside an attribute", () => {
    const headers = {
      get: () => `${"dsh-auth=from-fallback"}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT`,
      getSetCookie: () => [
        `${"dsh-auth=split-value"}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT`,
      ],
    };
    expect(readSetCookieHeader(headers)).toBe("dsh-auth=split-value");
  });

  it("falls back to the single header only when the runtime lacks getSetCookie()", () => {
    const headers = {
      get: () => "dsh-auth=fallback-value; Path=/; HttpOnly",
      getSetCookie: undefined,
    };
    expect(readSetCookieHeader(headers)).toBe("dsh-auth=fallback-value");
  });

  it("prefers the first usable cookie in the list and ignores unusable ones", () => {
    expect(readSetCookieHeader({ get: () => null, getSetCookie: () => ["", "  ", "a=b; Path=/"] })).toBe("a=b");
    expect(readSetCookieHeader({ get: () => null, getSetCookie: () => [] })).toBeNull();
    expect(readSetCookieHeader({ get: () => "", getSetCookie: () => [] })).toBeNull();
    expect(parseSetCookie(null)).toBeNull();
    expect(parseSetCookie("")).toBeNull();
    expect(parseSetCookie("HttpOnly")).toBeNull();
    expect(parseSetCookie("=; Path=/")).toBeNull();
  });

  it("recovers the real cookie from the split list when the first entry has no name", () => {
    // The single-header fallback cannot: its first pair is nameless, and sending it would turn a
    // diagnosable "no cookie" into a confusing 401. Only the array API sees the second cookie.
    const combined = "=; Path=/, dsh-auth=real-value; Path=/";
    const headers = {
      get: () => combined,
      getSetCookie: () => ["=; Path=/", "dsh-auth=real-value; Path=/"],
    };

    expect(readSetCookieHeader(headers)).toBe("dsh-auth=real-value");
    expect(parseSetCookie(combined)).toBeNull();
  });

  it("uses the split API in the real login exchange", async () => {
    const cookie = "dsh-auth=wire-value";
    const requested: string[] = [];
    const client = new DshClient({
      serviceId: "service-split",
      credentialSlots: { webUrl: "http://127.0.0.1:9/?token=wire-token", cookie: null, pending: null },
      fetchImpl: async (input) => {
        requested.push(String(input));
        return new Response(null, {
          status: 303,
          headers: { "set-cookie": `${cookie}; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT` },
        });
      },
    });

    await expect(client.ensureCredentials()).resolves.toBe(cookie);
    expect(requested).toHaveLength(1);
  });
});

describe("security: credential value object", () => {
  it("redacts every default stringification and keeps the two real accessors explicit", () => {
    registerSecret("value-object-secret-token");
    const credentials = new LaunchCredentials("http://127.0.0.1:9/?token=value-object-secret-token", "dsh-auth=long-cookie-value");

    expect(String(credentials)).not.toContain("value-object-secret-token");
    expect(JSON.stringify(credentials)).not.toContain("long-cookie-value");
    expect(credentials.toString()).toContain("token=[redacted]");
    expect(credentials.redacted).toEqual({ url: "http://127.0.0.1:9/?token=[redacted]", cookie: "(set)" });
    expect(credentials.loginUrl).toContain("value-object-secret-token");
    expect(credentials.cookieHeader).toBe("dsh-auth=long-cookie-value");
    expect(credentials.authenticated).toBe(true);
    expect(credentials.withCookie("dsh-auth=other-cookie-value").authenticated).toBe(true);
    credentials.invalidate();
    expect(credentials.authenticated).toBe(false);
  });

  it("scrubs registered secrets, token parameters, and nested values", () => {
    registerSecret("registered-secret");
    expect(redactSecrets("a registered-secret b")).toBe("a [redacted] b");
    expect(redactSecrets("http://x/?token=abc&y=1")).toBe("http://x/?token=[redacted]&y=1");
    expect(redactErrorText(new Error("boom registered-secret"))).toBe("boom [redacted]");
    expect(redactErrorText("plain registered-secret")).toBe("plain [redacted]");
    expect(redactErrorText(7)).toBe("7");
  });

  it("registers a cookie pair, and its bare value only when it is long enough to be unambiguous", () => {
    rememberCookie("short=abc");
    rememberCookie(null);

    expect(redactSecrets("pair short=abc")).toBe("pair [redacted]");
    // A 3-character value is not scrubbed bare, so ordinary prose survives.
    expect(redactSecrets("just abc here")).toBe("just abc here");
  });
});

describe("security: workspace ownership fails closed", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: HarnessManager | undefined;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-ownership-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
  });

  afterEach(async () => {
    if (manager !== undefined) await manager.close();
    manager = undefined;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  function createManagerFixture(env: Record<string, string>): HarnessManager {
    const options: HarnessManagerOptions = {
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser: vi.fn(async () => undefined),
      launchEnv: env,
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

  it("reuses a session whose cwd matches the workspace", async () => {
    const container = createManagerFixture({ FIXTURE_CWD: workspace });
    const first = await container.start({ task: "first", workspace });
    await container.wait(first.runId, 5_000);

    const second = await container.start({ task: "second", workspace, sessionId: first.sessionId });

    expect(second.sessionReused).toBe(true);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("rejects a session that belongs to a different workspace", async () => {
    const container = createManagerFixture({ FIXTURE_CWD: join(temporaryRoot, "elsewhere") });
    const first = await container.start({ task: "first", workspace });
    await container.wait(first.runId, 5_000);

    await expect(container.start({ task: "second", workspace, sessionId: first.sessionId }))
      .rejects.toThrow(/belongs to a different workspace/u);
  });

  it("rejects a session whose cwd the Host does not report (fail closed)", async () => {
    // The old behaviour was fail-open: `cwd === undefined` was treated as "belongs here". Now the
    // tightened contract refuses the list item itself (protocol drift, with the JSON path), and
    // the orchestration guard remains as defence in depth for any non-contract summary source.
    const container = createManagerFixture({ FIXTURE_LIST_OMIT_CWD: "1" });
    const first = await container.start({ task: "first", workspace });
    await container.wait(first.runId, 5_000);

    const rejection = await container.start({ task: "second", workspace, sessionId: first.sessionId })
      .then(() => null, (error: unknown) => error as { message: string; kind?: string });

    expect(rejection?.message).toMatch(/items\.0\.cwd|no cwd|Cannot prove Harness session/u);
    expect(rejection?.kind).toBe("protocol-drift");
  });
});

describe("security: loopback traffic ignores a dead proxy", () => {
  let temporaryRoot: string;
  let workspace: string;
  let manager: HarnessManager | undefined;
  let savedProxy: { HTTP_PROXY?: string | undefined; HTTPS_PROXY?: string | undefined };

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), "deepseek-harness-mcp-proxy-"));
    workspace = join(temporaryRoot, "workspace");
    await mkdir(workspace);
    savedProxy = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
    // A dead proxy: if any code path honoured the environment, every loopback call would fail.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  });

  afterEach(async () => {
    if (manager !== undefined) await manager.close();
    manager = undefined;
    for (const [name, value] of Object.entries(savedProxy)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("completes a whole run while HTTP_PROXY points at a dead port", async () => {
    manager = new HarnessManager({
      dataDirectory: join(temporaryRoot, "data"),
      allowedRoots: [temporaryRoot],
      startupTimeoutMs: 2_000,
      pollIntervalMs: 10,
      openBrowser: vi.fn(async () => undefined),
      launchEnv: {},
      ensureRuntime: async () => ({
        name: "@deepseek-ai/dsh",
        version: "0.0.0-fixture",
        root: join(temporaryRoot, "runtime"),
        packageDir: join(temporaryRoot, "runtime"),
        binPath: fixture,
        installedNow: false,
      }),
    });
    const started = await manager.start({ task: "through a dead proxy", workspace });
    const finished = await manager.wait(started.runId, 5_000);

    expect(finished.status).toBe("succeeded");
    expect(new URL(started.webUrl).hostname).toMatch(/^(127\.0\.0\.1|\[::1\]|localhost)$/u);
    // `doctor` reports the proxy environment but never fails because of it.
    const report = manager.doctor();
    expect(report.proxy).toMatchObject({ env: { HTTP_PROXY: "http://127.0.0.1:1" } });
    expect(report.ready).toBe(true);
  });
});

describe("security: the credential only ever goes to a loopback Host", () => {
  it("recognizes exactly the loopback forms", () => {
    for (const url of [
      "http://127.0.0.1:9/?token=x",
      "http://127.1.2.3:9/?token=x",
      "http://localhost:9/?token=x",
      "http://[::1]:9/?token=x",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
    for (const url of [
      "http://192.168.1.5:9/?token=x",
      "http://0.0.0.0:9/?token=x",
      "https://127.0.0.1:9/?token=x",
      "http://dsh.example.test:9/?token=x",
      "http://127.0.0.1.example.com:9/?token=x",
      "not a url",
      "",
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });

  it("refuses to exchange the credential with a non-loopback Host and never calls fetch", async () => {
    const calls: string[] = [];
    const client = new DshClient({
      serviceId: "service-non-loopback",
      credentialSlots: { webUrl: "http://192.168.1.5:9/?token=non-loopback-token", cookie: null, pending: null },
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(null, { status: 303 });
      },
    });

    const rejection = await client.ensureCredentials().then(
      () => null,
      (error: unknown) => error as { message: string; kind?: string },
    );

    expect(rejection?.kind).toBe("protocol-drift");
    expect(rejection?.message).toMatch(/non-loopback/u);
    expect(rejection?.message).not.toContain("non-loopback-token");
    expect(calls).toEqual([]);
  });
});

describe("security: trusted inputs", () => {
  it("declares the contract for the fields we read and tolerates extra keys", () => {
    const summary = METHODS["session/list"].response.parse({
      items: [{
        sessionId: "s-1",
        running: false,
        blank: true,
        cwd: "C:\\ws",
        // Extra keys are how the wire evolves: they must be accepted (and ignored).
        updatedAt: 1,
        projections: { kind: "sequenced" },
      }],
    });
    expect(summary.items[0]?.cwd).toBe("C:\\ws");
  });

  it("rejects a session summary that omits the cwd we depend on", () => {
    expect(() => METHODS["session/list"].response.parse({
      items: [{ sessionId: "s-1", running: false, blank: true }],
    })).toThrow(/cwd/u);
  });

  it("rejects a turn/end whose reason is malformed, but keeps unknown event types permissive", () => {
    const event = (type: string, data: unknown): unknown => ({
      type: "event",
      event: { type, seq: 1, data },
    });

    // Known type, wrong shape → drift.
    expect(() => METHODS["session/page"].response.parse({
      records: [event("turn/end", { reason: { kind: 7 } })],
      hasMore: false,
    })).toThrow();
    // Known type, right shape, plus unknown keys → accepted.
    expect(METHODS["session/page"].response.parse({
      records: [event("turn/end", { turn: 1, reason: { kind: "completed" }, extra: true })],
      hasMore: false,
    })).toMatchObject({ hasMore: false });
    // A type we merely skip keeps `data: unknown`.
    expect(METHODS["session/page"].response.parse({
      records: [event("system/message", { anything: [1, 2, 3] })],
      hasMore: false,
    })).toMatchObject({ hasMore: false });
  });
});
