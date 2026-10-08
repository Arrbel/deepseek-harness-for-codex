#!/usr/bin/env node
// R2-6: `npm run dsh:try -- <version>` — upgrade rehearsal against a specific DSH version.
//
// What it is for: before adopting a new `@deepseek-ai/dsh` version you want the *whole* launch
// vector re-proved against that version — install, cold/hot start, the 8-step wire chain, and a
// per-method look at whether the Host still answers the shapes this project reads. This script
// orchestrates exactly that, with three properties that make it safe to run on a working laptop:
//
//   1. it never edits a file in the repository (only the report it writes outside the tree);
//   2. it never points the child at your real data directory: the whole run happens under a
//      freshly created temp directory that is removed in `finally`;
//   3. both claims are *checked*, not asserted: the repository and the real data directory are
//      fingerprinted before and after, and a difference fails the drill.
//
// The version is passed the only way the product supports it — as the `DSH_MCP_HARNESS_PACKAGE`
// environment variable of the child process. Nothing else about the target version is written down.
//
// Usage:
//   npm run dsh:try -- 0.2.2-alpha.1
//   npm run dsh:try -- "0.2.2-alpha.1" --keep          # keep the temp tree for inspection
//   npm run dsh:try -- "@scope/dsh@1.2.3" --name @scope/dsh
//   npm run dsh:try -- 0.2.2-alpha.1 --out <path.md> --timeout-ms 1800000
//
// Exit codes: 0 clean, 2 contract drift found (the version is NOT safe to adopt yet),
//             1 the drill itself failed (live chain red, or a no-write check failed).

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/** Default package name for a bare version argument (the pinned distribution). */
const DEFAULT_PACKAGE_NAME = "@deepseek-ai/dsh";
/** One-off install budget, matching `live.test.ts` and ADR-0002 (never part of startup). */
const INSTALL_BUDGET_MS = 900_000;
/** Startup budget, matching `live.test.ts`: silence budget, reset by every child output line. */
const STARTUP_BUDGET_MS = 180_000;
/** Whole-drill watchdog: install + cold + hot + chain, with generous slack. */
const DEFAULT_TIMEOUT_MS = 1_500_000;
/** Directories excluded from the repository fingerprint (dependencies and scratch state). */
const REPO_FINGERPRINT_EXCLUDES = ["node_modules", ".git", ".verify-scratch"];
/** Exact version, mirroring `policy/package-spec.ts` (ranges are refused before we start). */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

// --- small utilities ---------------------------------------------------------------------

function log(line) {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = {
    target: null,
    out: null,
    keep: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    packageName: DEFAULT_PACKAGE_NAME,
    tolerateConcurrentWrites: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--tolerate-concurrent-writes") options.tolerateConcurrentWrites = true;
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--name") options.packageName = argv[++index];
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`unexpected extra argument: ${arg}`);
  }
  return options;
}

/** Resolves the exact npm spec to rehearse, refusing anything that is not an exact version. */
function resolveSpec(options) {
  if (options.target === null) {
    throw new Error("missing <version>: try `npm run dsh:try -- 0.2.2-alpha.1`");
  }
  const target = options.target.trim();
  if (EXACT_VERSION.test(target)) return `${options.packageName}@${target}`;
  const at = target.lastIndexOf("@");
  if (at > 0 && EXACT_VERSION.test(target.slice(at + 1))) return `${target.slice(0, at)}@${target.slice(at + 1)}`;
  throw new Error(
    `not an exact version: ${target} — dsh:try rehearsals need name@x.y.z (ranges and dist-tags would not be reproducible)`,
  );
}

/**
 * Locates `npm-cli.js` without `PATH` (mirrors `config/resolve.ts`).
 *
 * `npm`/`npx` shims on Windows require `shell: true`, which is the injection surface ADR-0002
 * removed; this script therefore runs `node <absolute js path>` exactly like the product does.
 */
function resolveNpmCli() {
  const candidates = [
    process.env.DSH_MCP_NPM_CLI?.trim(),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA === undefined ? null : join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate !== "");
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("could not locate npm-cli.js; set DSH_MCP_NPM_CLI to its absolute path");
}

/**
 * Runs a child process, streaming its output and capturing it.
 *
 * `detached` on POSIX gives the child its own process group so a watchdog timeout can take the
 * whole tree down; on Windows the platform tree killer (`taskkill /T /F`) does the same job.
 */
function run(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const consume = (chunk, stream) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/u)) {
        if (line !== "") stream.write(`${line}\n`);
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, output: `${output}\nspawn error: ${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, output, timedOut });
    });
  });
}

/** Kills a child and everything it spawned (the DSH service tree included). */
function killTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

// --- "the drill touches nothing" checks ---------------------------------------------------

/** Recursively fingerprints a tree as `relative path -> size:mtimeMs`. */
async function fingerprint(root, excludes = []) {
  const entries = new Map();
  const walk = async (directory) => {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const absolute = join(directory, child.name);
      const rel = relative(root, absolute).split("\\").join("/");
      if (excludes.includes(rel)) continue;
      if (child.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!child.isFile()) continue;
      try {
        const info = await stat(absolute);
        entries.set(rel, `${String(info.size)}:${String(Math.round(info.mtimeMs))}`);
      } catch {
        // A file that vanished mid-walk is simply not part of the fingerprint.
      }
    }
  };
  await walk(root);
  return entries;
}

/** Compares two fingerprints and describes the first differences. */
function diffFingerprints(before, after) {
  const changed = [];
  for (const [path, value] of after) {
    if (before.get(path) !== value) changed.push(`${path} (${before.get(path) ?? "added"} -> ${value})`);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`${path} (removed)`);
  }
  return changed;
}

/** The data directory this machine really uses, resolved like `config/resolve.ts` does. */
function realDataDirectory() {
  const explicit = process.env.DSH_MCP_DATA_DIR?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;
  const pluginData = process.env.PLUGIN_DATA?.trim();
  if (pluginData !== undefined && pluginData !== "") return pluginData;
  return join(homedir(), ".deep-seek-harness-mcp");
}

/**
 * Summarises the real data directory without walking every file twice.
 *
 * The drill's claim is stronger than "we passed another --data-dir": the directory the user
 * actually uses must come out of the run unchanged. Top-level entry names, their mtimes, and the
 * total file count/bytes are enough to catch a version directory being pruned, a service home
 * appearing, or credentials being rewritten.
 */
async function dataDirectorySummary(directory) {
  if (!existsSync(directory)) return { absent: true };
  const entries = {};
  let files = 0;
  let bytes = 0;
  for (const child of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, child.name);
    const info = await stat(absolute);
    let childFiles = child.isFile() ? 1 : 0;
    let childBytes = child.isFile() ? info.size : 0;
    if (child.isDirectory()) {
      const fingerprintOfChild = await fingerprint(absolute);
      childFiles = fingerprintOfChild.size;
      for (const value of fingerprintOfChild.values()) childBytes += Number(value.split(":")[0]);
    }
    entries[child.name] = `${String(Math.round(info.mtimeMs))}:${String(childFiles)}:${String(childBytes)}`;
    files += childFiles;
    bytes += childBytes;
  }
  return { absent: false, entries, files, bytes };
}

function describeDataDirectory(summary) {
  if (summary.absent) return "absent (nothing to protect, and it must stay absent)";
  const names = Object.keys(summary.entries);
  return `${String(names.length)} top-level entr${names.length === 1 ? "y" : "ies"}, ${String(summary.files)} files, ${String(summary.bytes)} bytes`;
}

/** Differences between two data-directory summaries, most specific first. */
function diffDataDirectory(before, after) {
  if (before.absent !== after.absent) return [before.absent ? "the directory was CREATED" : "the directory DISAPPEARED"];
  if (before.absent) return [];
  const changed = [];
  for (const [name, value] of Object.entries(after.entries)) {
    if (before.entries[name] !== value) changed.push(`${name} (${before.entries[name] ?? "added"} -> ${value})`);
  }
  for (const name of Object.keys(before.entries)) {
    if (!(name in after.entries)) changed.push(`${name} (removed)`);
  }
  return changed;
}

// --- protocol drift section ---------------------------------------------------------------

/** Renders the per-method probe result as the drill's drift table. */
function driftSection(probe) {
  if (probe === null) {
    return [
      "### 4. 协议漂移/差异报告",
      "",
      "**未采集**：live 测试未写出逐方法探针结果（`DSH_MCP_PROTOCOL_REPORT` 未产出）——",
      "通常意味着链路在探针之前就失败了，请先看上一节的原始输出。",
      "",
    ].join("\n");
  }
  const methods = Array.isArray(probe.methods) ? probe.methods : [];
  const drifted = methods.filter((entry) => entry.drift !== null && entry.drift !== undefined);
  const failed = methods.filter((entry) => entry.ok !== true);
  const lines = [
    "### 4. 协议漂移/差异报告",
    "",
    `每个方法各调用一次真实 Host：**${String(methods.length)} 个方法，parse 成功 ${String(methods.length - failed.length)}，漂移 ${String(drifted.length)}，非漂移失败 ${String(failed.length - drifted.length)}**。`,
    "",
    "| method | parse | 耗时 | 漂移（JSON path: message） | failureKind |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of methods) {
    const parse = entry.ok === true ? "✅ ok" : entry.drift == null ? "❌ 失败" : "⚠️ 漂移";
    const drift = entry.drift == null ? "—" : `\`${String(entry.drift)}\``;
    lines.push(`| \`${String(entry.method)}\` | ${parse} | ${String(entry.ms)}ms | ${drift} | ${entry.failureKind ?? "—"} |`);
  }
  lines.push("");
  if (drifted.length > 0) {
    lines.push("**漂移的方法/路径**：“");
    for (const entry of drifted) lines.push(`- \`${String(entry.method)}\` → \`${String(entry.drift)}\``);
    lines.push("");
    lines.push("> 漂移意味着该 DSH 版本回答的形状与本项目读的字段不一致（ADR-0004）。**先不要升 pin**：");
    lines.push("> 要么按新形状更新 `src/dsh/contract.ts`（并补 fixture），要么把该版本判为不兼容。");
    lines.push("");
  } else if (failed.length === 0) {
    lines.push("**无漂移**：该版本对全部方法的响应形状与本项目的契约一致。");
    lines.push("");
  } else {
    lines.push("**无特征漂移，但有非漂移失败**（如无 API key 导致的业务错误）：逐行看上面的 failureKind。");
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// --- main ---------------------------------------------------------------------------------

function usage() {
  return [
    "npm run dsh:try -- <version> [--keep] [--out <path.md>] [--name <pkg>] [--timeout-ms <n>] [--tolerate-concurrent-writes]",
    "",
    "  演练：npm view 验版本 → 全新临时数据目录 → live 链路 → 逐方法协议漂移报告 → finally 清理。",
    "  不改仓库文件；不碰真实数据目录（两者都有前后指纹自检）。",
    "",
    "  --tolerate-concurrent-writes  仅把「仓库文件有变化」降级为警告。共享工作树里别的写者",
    "                                （另一位 agent、IDE、并发 npm run check）会触发同一信号；",
    "                                请只在主动确认变化来自他人时使用，默认保持严格。",
    "",
    "  退出码：0 干净；2 发现协议漂移（暂不可升 pin）；1 演练失败或自检不通过。",
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true || (options.target === null && process.argv.length <= 2)) {
    log(usage());
    return 0;
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`--timeout-ms must be a positive integer, got ${String(options.timeoutMs)}`);
  }

  const spec = resolveSpec(options);
  const npmCli = resolveNpmCli();
  const realData = realDataDirectory();
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");

  log(`[dsh:try] spec=${spec}`);
  log(`[dsh:try] npmCli=${npmCli}`);
  log(`[dsh:try] realDataDirectory=${realData} (must not change)`);
  log(`[dsh:try] budgets: install=${String(INSTALL_BUDGET_MS)}ms startup=${String(STARTUP_BUDGET_MS)}ms (activity-reset) watchdog=${String(options.timeoutMs)}ms`);

  // Step 1 — the version must exist. This is the cheapest way to fail, and it happens before
  // anything is created on disk.
  log("[dsh:try] step 1/5: npm view (version existence)");
  const view = await run(process.execPath, [npmCli, "view", spec, "version", "--json"], { timeoutMs: 120_000 });
  if (view.code !== 0) {
    log(`[dsh:try] FAIL: npm view ${spec} exit ${String(view.code)} — 该版本不可获取（未发布/无网络/名字写错）。没有任何临时目录被创建。`);
    return 1;
  }
  const resolvedVersion = view.output.trim().split(/\r?\n/u).filter((line) => line.trim() !== "").pop() ?? "";
  log(`[dsh:try] npm view OK: ${spec} resolves to ${resolvedVersion}`);

  // Step 2 — fingerprints before the run.
  log("[dsh:try] step 2/5: fingerprinting the repository and the real data directory");
  const repoBefore = await fingerprint(REPO_ROOT, REPO_FINGERPRINT_EXCLUDES);
  const dataBefore = await dataDirectorySummary(realData);
  log(`[dsh:try] repo: ${String(repoBefore.size)} files (excluding ${REPO_FINGERPRINT_EXCLUDES.join(", ")})`);
  log(`[dsh:try] real data directory: ${describeDataDirectory(dataBefore)}`);

  // Step 3 — a brand-new temp tree. Nothing below this line points at the real data directory.
  const tempRoot = await mkdtemp(join(tmpdir(), `dsh-try-${spec.slice(spec.lastIndexOf("@") + 1).replace(/[^0-9A-Za-z.-]/gu, "_")}-`));
  const dataDir = join(tempRoot, "data");
  const protocolReport = join(tempRoot, "protocol-report.json");
  log(`[dsh:try] step 3/5: temp data directory = ${dataDir}`);
  log(`[dsh:try] step 4/5: live chain (this installs ~486 MB unless the npm cache is warm)`);

  const childEnv = {
    ...process.env,
    DSH_LIVE: "1",
    DSH_MCP_HARNESS_PACKAGE: spec,
    DSH_MCP_DATA_DIR: dataDir,
    DSH_MCP_PROTOCOL_REPORT: protocolReport,
  };
  if (options.keep) childEnv.DSH_LIVE_KEEP = "1";
  else delete childEnv.DSH_LIVE_KEEP;

  let liveResult = { code: -1, output: "", timedOut: false };
  let probe = null;
  let repoAfter = null;
  let dataAfter = null;
  let tempRemoved = false;
  try {
    liveResult = await run(process.execPath, [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "tests/e2e/live.test.ts", "--reporter=verbose"], {
      env: childEnv,
      timeoutMs: options.timeoutMs,
    });
    try {
      probe = JSON.parse(await readFile(protocolReport, "utf8"));
    } catch {
      probe = null;
    }

    // Step 5 — self-checks.
    log("[dsh:try] step 5/5: verifying that the drill changed nothing it must not change");
    repoAfter = await fingerprint(REPO_ROOT, REPO_FINGERPRINT_EXCLUDES);
    dataAfter = await dataDirectorySummary(realData);
  } finally {
    if (!options.keep) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      tempRemoved = !existsSync(tempRoot);
    }
  }

  const repoDiff = repoAfter === null ? ["not checked"] : diffFingerprints(repoBefore, repoAfter);
  const dataDiff = dataAfter === null ? ["not checked"] : diffDataDirectory(dataBefore, dataAfter);
  const drifted = probe === null ? [] : probe.methods.filter((entry) => entry.drift != null);
  // A non-empty repo diff means *someone* wrote to the working tree during the window. The drill
  // itself writes nothing there, but a shared checkout (several writers, IDE formatters, a
  // concurrent `npm run check`) produces the same signal — so the strict rule is the default and
  // the opt-out only downgrades it to a loud warning.
  const toleratedRepoDiff = repoDiff.length > 0 && options.tolerateConcurrentWrites;
  const verdict = liveResult.code !== 0
    ? "FAIL（live 链路失败）"
    : repoDiff.length > 0 && !toleratedRepoDiff
      ? "FAIL（不改文件自检不通过）"
      : dataDiff.length > 0
        ? "FAIL（真实数据目录被改动）"
        : drifted.length > 0
          ? "DRIFT（发现协议漂移，暂不可升 pin）"
          : "PASS";

  const report = [
    `# dsh:try 升级演练报告 — \`${spec}\``,
    "",
    `- 开始时间：${startedAt.toISOString()}（Asia/Shanghai ${startedAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}）`,
    `- 平台：${process.platform} ${process.arch} / node ${process.version} / npm-cli \`${npmCli}\``,
    `- 目标版本解析：\`npm view ${spec} version\` → \`${resolvedVersion}\``,
    `- 预算回显：**安装 ${String(INSTALL_BUDGET_MS)} ms**（一次性，独立于启动预算）｜**启动 ${String(STARTUP_BUDGET_MS)} ms**（活动重置：子进程每产生一行输出即重置）｜脚本看门狗 ${String(options.timeoutMs)} ms`,
    `- 子进程数据目录（全新临时目录）：\`${dataDir}\``,
    `- **结论：${verdict}**`,
    "",
    "## 1. 版本存在性",
    "",
    `\`npm view ${spec} version\` exit ${String(view.code)} → \`${resolvedVersion}\`。`,
    "",
    "## 2. 「演练不改文件」自检",
    "",
    "| 项目 | 演练前 | 演练后 | 判定 |",
    "| --- | --- | --- | --- |",
    `| 仓库文件指纹（排除 ${REPO_FINGERPRINT_EXCLUDES.join("、")}） | ${String(repoBefore.size)} 个文件 | ${repoAfter === null ? "未采集" : `${String(repoAfter.size)} 个文件`} | ${repoDiff.length === 0 ? "✅ 完全一致" : `${toleratedRepoDiff ? "⚠️ 降级为警告" : "❌"} ${String(repoDiff.length)} 处变化`} |`,
    `| 真实数据目录 \`${realData}\` | ${describeDataDirectory(dataBefore)} | ${dataAfter === null ? "未采集" : describeDataDirectory(dataAfter)} | ${dataDiff.length === 0 ? "✅ 未触碰" : `❌ ${String(dataDiff.length)} 处变化`} |`,
    `| 临时目录清理 | — | — | ${options.keep ? `➖ 已保留（--keep）：\`${tempRoot}\`` : tempRemoved ? "✅ 已删除" : "❌ 仍存在"} |`,
    "",
  ];
  if (repoDiff.length > 0) {
    report.push(
      "仓库差异（最多 20 条）：",
      "",
      ...repoDiff.slice(0, 20).map((line) => `- \`${line}\``),
      "",
      "> 演练自身**不写任何仓库文件**，因此这一项只有在无人并发改动同一工作树时才可能通过。",
      `> 演练窗口：${startedAt.toISOString()} → ${new Date().toISOString()}（改动时间戳晚于窗口起点、且不是演练产物的路径，来自其它写者）。`,
      "",
    );
  }
  if (dataDiff.length > 0) {
    report.push("真实数据目录差异（最多 20 条）：", "", ...dataDiff.slice(0, 20).map((line) => `- \`${line}\``), "");
  }
  report.push(
    "## 3. live 链路原始输出",
    "",
    `vitest exit ${String(liveResult.code)}${liveResult.timedOut ? "（看门狗超时，已收掉进程树）" : ""}`,
    "",
    "```text",
    ...liveResult.output.split(/\r?\n/u).slice(-400),
    "```",
    "",
  );
  report.push(driftSection(probe));
  report.push(
    "## 5. 收尾与未验证项",
    "",
    `- 临时目录：${options.keep ? `保留在 \`${tempRoot}\`` : tempRemoved ? "已删除（含安装的运行时与工作区）" : "删除失败，见上一节"}`,
    "- 演练会真实安装目标版本（约 486 MB，暖缓存约 1 分钟）并真实启动 Harness Web；它**不**修改 pin（`DSH_MCP_HARNESS_PACKAGE` 只存在于子进程环境）。",
    "- 未验证：升 pin 后本项目的端到端行为（本次只演练了 DSH 侧的安装/启动/协议形状）；跨平台（本次平台 = " + process.platform + "）。",
    "",
  );

  const reportText = report.join("\n");
  const outPath = options.out ?? defaultReportPath(spec, stamp);
  if (outPath !== null) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, reportText, "utf8");
    log(`[dsh:try] report written: ${outPath}`);
  }
  log("");
  log(reportText);
  log(`[dsh:try] VERDICT: ${verdict}`);

  if (verdict === "PASS") return 0;
  return verdict.startsWith("DRIFT") ? 2 : 1;
}

/** Writes next to the repository's sibling `reports/` directory when it exists. */
function defaultReportPath(spec, stamp) {
  const directory = resolve(REPO_ROOT, "..", "reports");
  if (!existsSync(directory)) return null;
  const safe = spec.replace(/[^0-9A-Za-z.-]/gu, "_");
  return join(directory, `dsh-try-${safe}-${stamp}.md`);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`[dsh:try] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
