# ADR-0005：测试策略——四层结构与反向验证纪律

- 状态：**已接受**（Phase 2 由 task-6 落地）
- 日期：2026-10-08
- 相关：`docs/architecture.md` §8、审计报告 §3（测试实跑与覆盖缺口）

## 背景

现状：3 个测试文件、12 个用例，`npx vitest run` 实测 **1 failed | 11 passed**（唯一红点是 `run-manager.test.ts:49` 用默认 `fetch` 跟随 303 后断言 200）。更重要的是**测试的证据力不足**：

- 夹具 `fake-harness.mjs` 与官方 wire 有实质偏差（`assistant/message` 缺必填 `turn`/`step`/`stream`；`session/page` 忽略消息对齐切页、恒 `hasMore:false`；`session/cancel` 伪造 `interrupted`）→ **测试全绿不能证明协议兼容**；
- 高危缺陷（`blocked`/`max-tokens` 被判成功、401 后永久 running、`terminate` 早退不收敛状态）**一个都没被现有用例覆盖**；
- 断言偏向"调用过某函数"，而非可观察结果（进程是否真的退出、端口是否真的释放）。

## 决策

四层测试，前三层全部无网络无凭据并进入 `npm run check`：

| 层 | 位置 | 目标 | 证据形式 |
|---|---|---|---|
| 纯单测 | `tests/unit/` | config、policy、contract、wire 分类、events 投影（kind 全集表）、run/state 迁移、credentials 脱敏 | 毫秒级、确定性 |
| 契约回放 | `tests/contract/` + `tests/fixtures/recorded/` | 用**真实且已脱敏**的 wire 驱动解析层 | 采集脚本 + 脱敏说明 |
| 进程级集成 | `tests/run-manager.test.ts`、`tests/runtime.test.ts`、`tests/server.test.ts`（P5 按被测模块重命名）+ 单一夹具 `tests/fixtures/fake-harness.mjs`（另有 `fake-npm-cli.mjs` 供运行时包安装用例） | 真子进程启停/收树、readiness 迁移、错误分类与恢复、端到端 run 生命周期、安装幂等 | 真进程 + 端口/状态断言 |
| 真实 smoke（opt-in） | `tests/e2e/live.test.ts` | 起真实 `dsh web`，跑 8 步链路（无 API key 也能到 `turn/end{kind:'error'}`） | `DSH_LIVE=1` 才运行 |

配套纪律：

1. **夹具是协议的一部分**：夹具必须对齐官方 wire（必填字段、分页语义、`aborted@user`），偏差即为缺陷；保持**单一夹具文件**，用环境变量开关驱动场景。
2. **反向验证**：每条关键用例都要通过"把实现改回错误写法 → 用例变红"证明其有效性；报告需给出至少 3 条此类记录。
3. **可观察断言优先**：断言状态、端口、进程存活、返回字段，而不是"某函数被调用"。
4. **脱敏硬约束**：任何 fixture/记录不得含真实 token、cookie 或凭据；采集脚本负责脱敏，并在报告中说明。
5. **风险驱动覆盖**：优先覆盖 ADR-0003 的终态分类与 ADR-0004 的漂移检测，而不是追求行覆盖率数字。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 只补几条用例，保持现有夹具 | 夹具失真会让测试持续给出错误信心（本次事故即如此） |
| 直接用真实 DSH 做全部测试 | 需要联网与约 2 分钟启动，不适合作为默认门禁；作为 opt-in smoke 保留 |
| 追求覆盖率阈值 | 覆盖率不能表达"是否正确判定终态"；高危分支的**存在性**比行数更重要 |
| 为每个场景复制一个假服务 | 复制即漂移；单一夹具 + 开关更可维护 |

## 后果

- 正面：测试真正具备协议证据力；高危分支有回归网；重构（Phase 4）有安全网。
- 代价：夹具需要持续与官方 wire 对齐（每次 DSH 升级都要复核）；采集真实 wire 需要一次性人工/脚本步骤。
- 关系：本 ADR 是 Phase 4 分层重构的前置条件——**先有网，再搬家**。

## 验证

1. `< 18` 个用例或 `npx vitest run` 非全绿 → 不满足 DoD；
2. 夹具字段与官方 `packages/core/session/src/types.ts` / `packages/api/session-controller/src/history.ts` 逐条对应（报告列明）；
3. 至少 3 条反向验证记录；
4. `tests/fixtures/` 全目录扫描不得出现真实凭据形态。

## 落地修正（2026-10-08；实现后回填，与上文冲突以此处为准）

- **实际分层**见 `docs/architecture.md` §8（含"进程级集成"的真实文件名与两个静态门禁文件 `tests/module-boundaries.test.ts`、`tests/metadata.test.ts`）；上方路径 `tests/integration/` 是设计初稿，实际未建立该目录。
- **验证 1 的阈值已远超**：用例数由 12 → **203**（`200 passed | 2 expected fail | 1 skipped`），其中 2 条 expected fail 是刻意保留的"缺陷咬合"（P5 转正）。
- **新增第六类：测试隔离闸门**（由 D-07 缺陷催生：测试曾在用户真实 home 下写出目录）。五道闸门（类型/副作用/装配/运行时/元闸门）见 `docs/architecture.md` §8 末与 `reports/fix-test-isolation.md`；**任何新增测试文件都必须 import 隔离守卫**，否则元闸门变红。
- **已知陷阱**：`npm run check:live` 单跑会空跑通过（live 套件由 `DSH_LIVE=1` 短路）。CI 的手动 live workflow 已显式设置该变量；根治（live 套件独立 vitest 配置）列入 `docs/roadmap.md` 的 P1 收尾项。
- **契约回放的证据来源**：`tests/fixtures/recorded/*.json` 取自真实 0.2.1 采集并脱敏，元数据见 `tests/contract/RECORDING.md`。
