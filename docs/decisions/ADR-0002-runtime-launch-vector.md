# ADR-0002：运行时启动向量——本地安装 + 直接 node 启动

- 状态：**已接受**（判据实测已完成，见文末「实测证据」；实现待排，见 `docs/roadmap.md` P3）
- 日期：2026-10-08
- 相关：`docs/architecture.md` §4、审计报告 §2 P1-1、P2-1、P2-2

## 背景

当前实现用 `npx --yes --package=@deepseek-ai/dsh@0.2.1-alpha.1 -- dsh web --no-open --port 0` 启动被控端，带来三个彼此耦合的根因问题：

1. **就绪预算被污染**：npx 的下载/安装与"进程是否就绪"共用一个 `STARTUP_TIMEOUT_MS = 120_000`。实测冷启动 117.3 s（热启动 5.8 s）——余量 2.7 s，属于按设计就会失败的首跑路径；
2. **命令注入面**：Windows 上必须 `shell: true` 才能执行 `npx.cmd`，而 `DSH_MCP_NPX_COMMAND` 未做任何校验；README 只声明"DSH 包名拒绝 shell 元字符"，声明与实现不一致；
3. **进程树过深**：实测 `cmd → npx → cmd → dsh` 四层，收尾只能靠 `taskkill /T /F` 整树兜底，优雅停止几乎无效。

## 决策（已由实测确认）

1. 新增 `service/runtime-package.ts`：把运行时包安装到 `<dataDir>/versions/<version>/`
   - `npm install --prefix <prefix> --no-save --no-audit --no-fund <spec>`，argv 启动、`shell:false`；
   - 幂等：已安装（含 `package.json` 版本匹配）则跳过；支持离线复用；
   - 独立预算 `installTimeoutMs`（默认 900 s），安装进度输出可见，失败信息含原始 stderr + 可操作建议（检查网络/npm 缓存/包名与版本是否存在）。
2. 启动改为直接执行已安装包的 bin：`spawn(process.execPath, [<binPath>, "web", "--no-open", "--port", "0"], { shell:false, windowsHide:true, detached: <POSIX 为 true / Windows 为 false> })`（P0-2 修订：POSIX 需要独立进程组才能整树回收，且**不 `unref()`**，管道保留）
   - `<binPath>` 从已安装包的 `package.json#bin` 解析（不拼字符串、不依赖 PATH）；
   - 进程树退化为 `node → dsh 子进程`，Windows 无 shell。
3. 就绪判定采用**活动重置**语义：安装（`DSH_MCP_INSTALL_TIMEOUT_MS`，默认 900s，一次性）与启动（`DSH_MCP_STARTUP_TIMEOUT_MS`，默认 180s，spawn → URL 行，每行输出重置）分离；失败原因区分 `no-first-output` / `no-url-line` / `install-timeout`，失败必须携带脱敏日志尾与安装路径。
   > 演进：初稿的三段预算（`firstOutputMs`/`readyMs`/`quietPeriodMs`）在实测后被"单预算 + 活动重置 + 多个失败 cause"取代——直启稳态只有 3.5–4.6s，长尾全在一次性安装阶段，三个旋钮没有换来额外判别力。
4. 停止：优雅信号 → 平台收尾 → **确认退出后才写 `stopped`**；无法确认时明确标注 `stopUnconfirmed`。
5. `doctor` 报告运行时包状态（是否已安装、路径、版本、pin 与支持区间），把"装不上"从运行期故障变成前置诊断。

## 备选方案

| 方案 | 评估 |
|---|---|
| 只把超时从 120 s 提到 300 s | 治标：仍然把网络下载算进就绪、仍然需要 shell、仍然 4 层进程树 |
| 预装全局 `@deepseek-ai/dsh` 并依赖 PATH | 依赖用户全局状态，版本不可控、不可并存、违反"数据目录自包含" |
| 直接把 DSH 作为 npm 依赖放进本包 `dependencies` | 重量级（DSH 依赖树很大）、与"按工作区/版本切换"需求冲突；且每次 `npm ci` 都要拉全套 |
| 继续 npx，但改用 `cmd.exe` 显式传参消除注入 | 只解决 2；1 与 3 仍在 |

## 后果

- 正面：首跑不再假超时；无 shell、无注入面；进程树变浅，收尾更可靠；离线可复用；DSH 版本可并存/回滚（换目录即可）；`doctor` 可直接解释失败。
- 代价：我们负责版本目录布局与安装失败诊断；需要新增"安装预算"的概念与进度反馈。
- 影响面：`service/*` 新增两个模块；`runtime.ts` 的 `buildHarnessWebCommand` 被"解析式启动"取代；`policy/package-spec.ts` 仍负责 spec 合法性。

## 实测证据（task-4，2026-10-08，完整记录见 `reports/design-runtime-launch.md`）

| 判据 | npx 向量 | 本地安装 + 直接 `node <bin>` |
|---|---|---|
| 稳态就绪 | 6.43 / 7.47 s | **3.56–4.58 s**（10 次） |
| 真·首次冷启动（空 npm 缓存） | **161.58 s**（含 735.2 MB 下载） | 29.49 s（树已装、机器缓存冷；之后 3.89 s） |
| Windows 是否需要 shell | 需要（npx.cmd） | **不需要**（argv 直调） |
| 进程树 | 4 层 `cmd→npx→cmd→node` | **1 层** |
| 收尾 | 必须 `taskkill /T /F` | **`child.kill()` 实测足够** |
| 离线 | 缓存缺失即 `ENOTCACHED` | 死代理下 3.80 s 起服务并返回 303 |
| 链路等价性 | 基准 | 8 步状态码/取值路径/`turn/end` 原文逐项一致 |
| 磁盘占用 | `_npx` 15 目录 **1249.3 MB**（不自清理） | `versions/<ver>` 约 486 MB/版本（可枚举清理） |

实现必须同时处理的迁移阻塞点（task-4 §⑤，编号沿用报告）：

- **P1** 必须自行解析 `…/dsh/lib/bin.js` 绝对路径（`.bin/dsh.cmd` 需 shell、`.bin/dsh` 是 sh shim，都不可用），并校验 `package.json#version` 与目录名一致。
- **P2** 用 `process.execPath` + `shell:false`；PATH 里的 `node` 不可依赖。
- **P3** **发布物没有 `engines` 字段**（区间只存在于 monorepo 根）→ `doctor` 必须自带 `^22.19.0 || >=24.0.0` 并校验 `process.versions.node`。
- **P4** 版本目录布局 + LRU 清理 —— **已落地（P0-4）**：安装成功后持 `.install.lock` 运行一次 fail-closed prune（非当前 pin 且未被在用服务引用 → 回收；超期 `.tmp-*` → 回收；当前 pin 与"是否在用无法确认"的目录永不删），开关 `DSH_MCP_PRUNE_VERSIONS`。
- **P5** 必须**精确 pin**：`dist-tags` 的 `latest=0.2.0-rc.2` < 我们的 `0.2.1-alpha.1`，用 range 会静默降级。
- **P6** 安装原子性：临时目录 + 原子 rename + 进程锁（`<dataDir>/versions/.install.lock`），已装则跳过。
- **P7** 失败分级：`ETARGET`/`E404`（版本不存在，不重试）→ `ENOTCACHED`（缓存/离线，提示预热）→ 其余按网络重试一次。
- **P8** 安装与启动分离进预算：安装一次性、启动预算改为"冷 ≤30 s / 热 ≤5 s"；启动前校验 `<dataDir>` 与 DSH_HOME 可写。

**旁证**：生产版 DSH 桌面应用已经在使用同一向量（`%APPDATA%\DSH\data\versions\<ver>` + 直接 `node`），可作长期可行性的外部证据。

## 验证（判据已满足；实现完成后仍需复验）

1. ✅ `npm install --prefix` 的冷/热耗时（64.49 s 首装 / 1.53–2.15 s 幂等）；`…/dsh/lib/bin.js` 存在且可独立运行；
2. ✅ 直接 `node <bin> web --no-open --port 0` 打印带 token URL，8 步链路与 npx 路径行为等价；
3. ✅ 进程树层数对比与 `taskkill /T /F` / `child.kill()` 收尾实测；
4. ✅ 已安装后的幂等耗时；离线（死代理）复用实测；
5. ✅ 不存在版本的原始错误码与 stderr（`ETARGET`/`E404`/`ENOTCACHED`）；
6. ⏳ 实现完成后的复验项见报告 §⑥ 的 10 条未验证清单（含"DSH 有活跃子进程时 `child.kill()` 是否足够""非 Windows 平台差异"）。

## 实现落地记录（task-7，2026-10-08；证据见 `reports/impl-launch-vector.md`）

- 启动向量已落地：`ensureRuntimePackage()` → `spawn(process.execPath, [binPath, "web", "--no-open", "--port", "0"], {shell:false, windowsHide:true, detached: <POSIX true / Windows false>})`（P0-2 修订见上文第 2 条）；`buildHarnessWebCommand` / `HarnessCommand` / `commandFactory` / 一切 shell 路径已从启动链删除。
- npm CLI 解析顺序（本机实测）：`DSH_MCP_NPM_CLI` → `<dirname(execPath)>/node_modules/npm/bin/npm-cli.js`（**本机命中**）→ `<execDir>/../lib/node_modules/...` → `createRequire.resolve('npm/bin/npm-cli.js')`（npm 的 exports 不导出，本机失败，故不能作主路径）→ `%APPDATA%\npm\...`；**从不读 PATH**。
- 收尾：`child.kill()` 为唯一常规路径，Windows `taskkill /T /F` 仅作宽限期（5s）后的兜底；所有分支收敛 `status/stoppedAt/索引`，未确认退出写 `stopUnconfirmed: true`。
- 新增第五类失败 `install-timeout`（npm 静默超时，不属于四类退出码映射）。
- `ServiceSnapshot` 增加 `stopUnconfirmed` 与 `runtimeRoot`（向后兼容的加法，已进 CHANGELOG）。
- 新增 `npm run check:live` 与 `tests/e2e/live.test.ts`（默认 skip，不进 `check`），把真实 DSH smoke 变成可重复执行的入口。
- ~~已知缺口（留待 P4/P6）：版本目录与 `.tmp-*` 残留**没有自动清理策略**（`doctor` 只报告占用）；~~ **已关闭（P0-4）**：安装成功后持锁运行 fail-closed prune，结果经 `prune {ran, reason, removed, skipped, reclaimedBytes}` 暴露。跨进程并发安装锁目前仍只有同进程并发与陈旧锁的单测覆盖（未变）。
