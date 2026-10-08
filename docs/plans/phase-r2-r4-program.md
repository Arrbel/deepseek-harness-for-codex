# R2–R4 优化与完善程序计划（0.4.x 硬化）

> 建立时间：2026-10-09；基线：commit `16b8029`、tag `v0.4.0`（`npm run check` exit 0，`455 passed | 1 skipped (456)`；独立验收 round 2 **GO**，`reports/verify-r1-p0.md`）。
> 上游输入：5 位专家评审与裁定 `reports/plan-p0-p1.md`；风险表与缺陷台账 `docs/roadmap.md`。
> 执行纪律：一个写者一个文件范围；`dist/`、`plugins/` 是生成物，**只有 Lead 串行跑 `npm run check`**；每项必须带**反向验证**（改坏实现 → 测试红 → 还原）；每项完成后由**独立验证者**（`packaging-verify`）判定，不得复用实现者结论。

## 0. 目标与完成定义（DoD）

**总目标**：把项目从"已验收可用"推进到"完整、稳定、可交付"——即：默认配置下能被真实使用（含审批语义不迷路）、协议变化能被早期诊断、运行态可恢复、有跨平台与发布证据、文档与实现逐条一致。

**整体 DoD**（全部满足才算完成）：
1. `npm run check` exit 0，`it.fails` = 0，且**新增能力都有反向验证记录**；
2. 干净数据目录 `npm run check:live` 首次 exit 0（install/cold/hot 耗时记录在案）；
3. 两条安装路径（canonical 本地载荷、`npm pack` 安装后启动）e2e 通过；
4. 每项在 `docs/roadmap.md` 有状态与出口判据，在 `CHANGELOG.md` 有外部可感知变更记录；
5. 独立验证者对每个 Wave 出结论（GO/NO-GO + 未验证项清单）；
6. 未验证项**显式列出**，不使用"应该/大概"。

## 1. Wave 划分（按优先级与依赖）

### Wave R2（P1：使用体验与可诊断性）——当前 Wave

| 项 | 主题 | 出口判据 | 写权（单一所有者） |
|---|---|---|---|
| R2-1 | `nextAction` + `reason → 动作` 故障词典 | `nextAction` 由 `reason` **单向派生**、闭集 6 值（`retry-narrower` / `new-session` / `restart-service` / `relogin` / `report-only` / `none`）；开放形态（`rpc:*`、`turn-aborted:*`、`turn-unknown:*`）一律 `report-only`；先写词典再落字段；表驱动测试 + 反向验证 | `launch-impl`：`src/run/**`、`src/tools/catalog.ts`、`src/service/types.ts` |
| R2-2 | `webUrlStale` + 链接失效说明 | 仅 `failed(service-unreachable)` 时为 `true`；README/SKILL 写明"服务重启后旧链接与旧 token 失效，需重新 `start_service`"；有测试 | `launch-impl`（同上） |
| R2-3 | **审批语义**（默认 `workspace-write` → `approval: ask`） | ① 文档明说"需在 Harness 页面点批准，或在受控环境显式 `DSH_PERMISSION_MODE=danger-full-access`"；② `doctor` 增可操作提示（**不扩大 `ready` 四项制**）；③ 先做实验：读路径（`session/page`/`projections`）能否观测"待审批"，**能观测才加字段，不能就明确写"不可观测"** | Lead：`src/diagnostics/doctor.ts`、`docs/**`、`README*`、`SKILL.md` |
| R2-4 | 协议漂移结构化（`method`/`path` 进入错误对象） | `classifyThrownFailure` 不再丢结构；错误文本含方法名 + JSON 路径；有断言 | `test-foundation`：`src/dsh/{wire,client}.ts` |
| R2-5 | `browser.ts` 平台注入缝 + 三平台用例（V-3） | 注入 `platform` + opener 命令选择；darwin/win32/linux 各一条用例；反向验证（改错平台分支 → 红） | `test-foundation`：`src/service/browser.ts` |
| R2-6 | `dsh:try <version>` 升级演练脚本 | **不改任何文件**（只导出 env）→ 临时数据目录 → live → 漂移报告 → `finally` 清理；失败不污染真实数据目录；live 测试改读 `resolveHarnessPackage(env)` | `dist-ssot`：`scripts/**`、`package.json`、`tests/e2e/live.test.ts`、`src/config/resolve.ts` |
| R2-7 | 依赖与发布面整理（A3） | `dependencies` → `devDependencies`（MCP SDK/zod 已内联）；刷 `package-lock.json`；`npm run check` 仍 exit 0；SBOM/`npm audit` 纳入 CI（只读步骤） | `dist-ssot`（同上） |
| R2-8 | `.gitattributes`（`eol=lf`）+ CONTRIBUTING + mermaid 架构/数据流图 | 提交不再出现成片 CRLF 警告；CONTRIBUTING 含"改 `skills/**`/README 必须紧跟 `version:sync`，否则 `generated-drift`"；图嵌入 `docs/architecture.md`（不新建文件） | Lead：`.gitattributes`、`CONTRIBUTING.md`、`docs/**` |
| R2-9 | mac 进 `check` 矩阵（跨平台真跑的第一步） | `.github/workflows/check.yml` 增 `macos-latest` 列；`live` 仍不进 PR 门禁；actionlint 通过 | `dist-ssot`（与 R2-7 同批，避免同文件竞争） |

### Wave R3（P2：韧性、可恢复性与并发）

| 项 | 主题 | 出口判据 |
|---|---|---|
| R3-1 | 契约版本矩阵（B1） | `CONTRACT_MATRIX` 按 DSH 版本存**差异**；fixture 分档 `recorded/<dshLine>/` + `current.json` 指针；`doctor.contract { dshLine, installedVersion, status: exact｜compatible｜unknown｜unsupported }`；**不进 `problems`/`ready`**（只有 `unsupported` 进） |
| R3-2 | 漂移遥测 `drift.jsonl`（B2） | 落 `<dataDir>/logs/drift.jsonl`，字段仅指针（`ts/kind/method/path/expected/gotType/pluginVersion/dshVersion/runId?`）；**禁** message 原文/cookie/token；可禁用 |
| R3-3 | 运行态持久化 + 对账（C1） | journal `<dataDir>/runs/<runId>.json`（`.tmp`+rename）；首次工具调用/启动时对账（`session/list` + `projections`）；`running=true` 续等，`false` 且无 `turn/end` 套用现有 fail-closed 规则；跨进程双开有 adopt 锁；**不得重演"永久 running"** |
| R3-4 | 并发上限与串行化（C2） | 同工作区串行、跨工作区并发 N（可配置）；超限行为明确（**报错**优先于新增 `queued` 状态，避免破坏 settle-once）；有测试 |
| R3-5 | 事件投影增强 + 自适应轮询（C3 廉价版） | 投影 `step/start` 与工具名（**不碰协议**）；`running` 期间轮询 400ms → 150ms；有测试 |
| R3-6 | coverage 基线 + 定向属性测试 | 加 `@vitest/coverage-v8` 基线（先量化再优化）；属性测试只打**纯函数**（`wire` 分类全函数性、`satisfiesNodeRange` 单调性、活动预算、`settle` 幂等）；**不做全仓 Stryker** |

### Wave R4（P3：交付与外部证据）

| 项 | 主题 | 出口判据 |
|---|---|---|
| R4-1 | 发布链与 SBOM/供应链 | 发布 workflow（手动触发、`--provenance`、`--dry-run` 演练）、SBOM 生成、CI 依赖固定 SHA；**不 publish**（等身份决策） |
| R4-2 | 分发身份决策包（需用户裁定） | 三个选项各自的成本/影响写成一页（沿用上游包名不可行 / 自有 scope 发布 / 内网 registry），给出推荐与所需授权；**不动手发布** |
| R4-3 | 跨平台证据 | 真实 ubuntu + mac 的 `check` 结果（需 CI runner）；`tests/unit/data-location.test.ts` 在真实 POSIX 上是否成立（V-2）；`browser.ts` 三平台用例（R2-5 已补） |
| R4-4 | 端到端重新验收 | 独立验证者按 §0 DoD 全量复核，出 `reports/verify-r4.md`（含未验证项清单） |

## 2. 风险与降级策略（执行中自动应用）

| 风险 | 降级/绕行 |
|---|---|
| 无 CI runner 无法验证真实 ubuntu/mac | 用"覆盖 `process.platform` 的模拟"给出**平台分支维度**结论，并把"真实 POSIX path/大小写/工具可用性/CRLF/真信号"明确列为未验证；不阻塞其它项 |
| 无法发布 npm（包名归上游） | 只做**发布前一切准备**（workflow/SBOM/演练），把身份决策做成 R4-2 的决策包；两条本地安装路径保持可用 |
| 状态机新增状态可能破坏 settle-once | 优先选择"超限即报错"而不是新增 `queued`；若必须加状态，先改 `run/state.ts` 的迁移表并补反向验证 |
| 运行态持久化引入新的"永久 running" | 对账必须复用现有 fail-closed 规则（无 `turn/end` → `turn-unknown:missing-turn-end`）；journal 只作对账输入，**不是**终态写入点 |
| 任一写者阻塞 | 该写者降级/绕行，其它 Wave 项继续；单点不阻塞整体 |

## 3. 每 Wave 的固定流程

1. 建任务（写权互斥 + 依赖显式）→ 分配 → 写者自测（`npx tsc --noEmit` + 定向 `vitest`，**不跑全量 check**）；
2. 写者回报：改动、反向验证、原始输出、未验证项；
3. Lead 串行跑 `npm run check`（必要时 `check:live` 干净目录）→ 记录原始输出；
4. 独立验证者判定（GO/NO-GO + 未验证项）；
5. 更新 `docs/roadmap.md`（状态 + 出口判据）、`CHANGELOG.md`（外部可感知变更）、必要时 ADR；
6. 提交一个 Wave 的基线 commit（tag 递增：`v0.4.1`、`v0.4.2`…）。

## 4. 需要用户决策的事项（不阻塞其它项）

1. **npm 分发身份**（R4-2）：这是"真正对外发布"的唯一外部依赖，其余全部可先完成；
2. `deepseek-harness-relay-mcp`（1.7 MB，C1 参考实现）是否保留在 `E:\AI\test` 下；
3. 是否要我把已生成载荷（`plugins/**`）改为随仓库提交，使 `git clone` 直装可用（当前需先 `npm run prepare:plugin`）。
