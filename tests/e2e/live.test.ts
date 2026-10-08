// Real-DSH smoke test (opt-in). Not part of `npm run check`: it downloads and installs the
// pinned runtime package (~486 MB) and starts a real Harness Web process.
//
//   PowerShell:  $env:DSH_LIVE=1; $env:DSH_MCP_DATA_DIR='<scratch>\data'; npm run check:live
//
// It proves the ADR-0002 vector end to end on the real product:
//   cold install once → start (cold) → 8-step RPC chain with no API key →
//   turn/end{kind:'error'} → run converges to `failed` → stop → port released.
//
// Always point DSH_MCP_DATA_DIR at a scratch directory: the user's real
// `~/.deepseek-harness-mcp` must not be touched.

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunManager } from "../support/manager.js";
import { DEFAULT_HARNESS_PACKAGE } from "../../src/config/resolve.js";
import { resolveNpmCli } from "../../src/service/npm-cli.js";
import { directorySizeSync, ensureRuntimePackage } from "../../src/service/runtime-package.js";
import "../support/isolation.js";

const live = process.env.DSH_LIVE === "1";
const dataDir = process.env.DSH_MCP_DATA_DIR ?? join(tmpdir(), `dsh-live-${randomUUID().slice(0, 8)}`, "data");
const root = dirname(dataDir);
const workspace = join(root, "ws");
const INVALID_PORTS: number[] = [];

function log(line: string): void {
  process.stdout.write(`[live-smoke] ${line}\n`);
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function listens(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    return response.status >= 0;
  } catch {
    return false;
  }
}

describe.runIf(live)("live DSH smoke (ADR-0002 launch vector)", () => {
  afterAll(async () => {
    for (const port of INVALID_PORTS) {
      expect(await listens(port)).toBe(false);
    }
  });

  it("installs once, reuses offline, starts cold/hot, fails keylessly, and stops clean", async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const manager = new RunManager({
      dataDirectory: dataDir,
      allowedRoots: [root],
      startupTimeoutMs: 180_000,
      installTimeoutMs: 900_000,
    });
    try {
      await mkdir(workspace, { recursive: true });
      const npmCli = resolveNpmCli();
      log(`dataDir=${dataDir}`);
      log(`workspace=${workspace}`);
      log(`npmCli=${npmCli.path} (${npmCli.source})`);
      log(`spec=${DEFAULT_HARNESS_PACKAGE}`);

      // Phase 1 — one-off install into <dataDir>/versions/<version>.
      const installStart = Date.now();
      const ensured = await ensureRuntimePackage({
        dataDir,
        spec: DEFAULT_HARNESS_PACKAGE,
        npmCli: npmCli.path,
        timeoutMs: 900_000,
        onProgress: (line) => log(`npm: ${line}`),
      });
      const installMs = Date.now() - installStart;
      const diskBytes = directorySizeSync(ensured.root);
      log(`INSTALL ok installedNow=${String(ensured.installedNow)} elapsed=${String(installMs)}ms disk=${(diskBytes / 1024 / 1024).toFixed(1)}MB`);
      log(`INSTALL binPath=${ensured.binPath} exists=${String(existsSync(ensured.binPath))}`);
      expect(existsSync(ensured.binPath)).toBe(true);

      // Phase 2 — idempotency: the second call must not touch npm or the network.
      const reuseStart = Date.now();
      const reused = await ensureRuntimePackage({
        dataDir,
        spec: DEFAULT_HARNESS_PACKAGE,
        npmCli: npmCli.path,
        timeoutMs: 900_000,
      });
      const reuseMs = Date.now() - reuseStart;
      log(`REUSE installedNow=${String(reused.installedNow)} elapsed=${String(reuseMs)}ms`);
      expect(reused.installedNow).toBe(false);
      expect(reused.binPath).toBe(ensured.binPath);

      // Phase 3 — cold start of the real Harness from the installed tree.
      const coldStart = Date.now();
      const cold = await manager.startService({ workspace });
      const coldMs = Date.now() - coldStart;
      const coldPort = portOf(cold.webUrl!);
      INVALID_PORTS.push(coldPort);
      log(`START-COLD status=${cold.status} pid=${String(cold.processId)} port=${String(coldPort)} elapsed=${String(coldMs)}ms`);
      log(`START-COLD runtimeRoot=${String(cold.runtimeRoot)}`);
      log(`START-COLD url=${cold.webUrl!.replace(/([?&]token=)[^&]*/u, "$1[redacted]")}`);

      const exchange = await fetch(cold.webUrl!, { redirect: "manual" });
      log(`AUTH status=${String(exchange.status)} set-cookie-present=${String(exchange.headers.get("set-cookie") !== null)}`);
      expect(exchange.status).toBe(303);

      const stoppedCold = await manager.stopService(cold.serviceId);
      log(`STOP-COLD status=${stoppedCold.status} stopUnconfirmed=${String(stoppedCold.stopUnconfirmed)}`);
      expect(stoppedCold.status).toBe("stopped");
      expect(stoppedCold.stopUnconfirmed).toBe(false);
      await expect(listens(coldPort)).resolves.toBe(false);
      INVALID_PORTS.splice(INVALID_PORTS.indexOf(coldPort), 1);

      // Phase 4 — hot start, then the full 8-step chain through a keyless prompt.
      const hotStart = Date.now();
      const hot = await manager.startService({ workspace });
      const hotMs = Date.now() - hotStart;
      const hotPort = portOf(hot.webUrl!);
      log(`START-HOT status=${hot.status} pid=${String(hot.processId)} port=${String(hotPort)} elapsed=${String(hotMs)}ms`);
      expect(hot.status).toBe("running");

      const started = await manager.start({ task: "live smoke: no API key expected", workspace });
      log(`RUN runId=${started.runId} sessionId=${started.sessionId} status=${started.status}`);
      const finished = await manager.wait(started.runId, 30_000);
      log(`RUN status=${finished.status} error=${String(finished.error)}`);
      expect(finished.status).toBe("failed");
      expect(finished.error ?? "").toMatch(/no API key|MISSING_CREDENTIAL/u);
      expect(finished.error ?? "").not.toMatch(/token=/u);

      const stoppedHot = await manager.stopService(hot.serviceId);
      log(`STOP-HOT status=${stoppedHot.status} stopUnconfirmed=${String(stoppedHot.stopUnconfirmed)}`);
      expect(stoppedHot.status).toBe("stopped");
      expect(stoppedHot.stopUnconfirmed).toBe(false);
      expect(await listens(hotPort)).toBe(false);
      INVALID_PORTS.push(hotPort);

      log(`RESULT coldStart=${String(coldMs)}ms hotStart=${String(hotMs)}ms install=${String(installMs)}ms reuse=${String(reuseMs)}ms`);
      expect(coldMs).toBeLessThan(180_000);
      expect(hotMs).toBeLessThan(60_000);
      expect(reuseMs).toBeLessThan(10_000);
    } finally {
      await manager.close();
      if (savedKey === undefined) {
        delete process.env.DEEPSEEK_API_KEY;
      } else {
        process.env.DEEPSEEK_API_KEY = savedKey;
      }
      if (process.env.DSH_LIVE_KEEP !== "1") {
        await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }, 1_200_000);
});
