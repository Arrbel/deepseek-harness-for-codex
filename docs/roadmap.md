# 路线图与验收（deepseek-harness-for-codex 系统化改造）

原则：**根因优先、先有测试网再搬家、禁止补丁式兼容、每阶段有可复核的证据**。

状态标记：✅ 完成 · 🔄 进行中 · ⏳ 待开始 · ⛔ 阻塞

| 阶段 | 主题 | 状态 | 任务 | 出口判据（必须可复核） |
|---|---|---|---|---|
| P0 | 设计冻结：架构、ADR、路线图 | ✅ | 本文 + `docs/architecture.md` + ADR-0001..0005 | 设计文档存在且被后续实现引用 |
| P1 | 分发与元数据根因修复（SSOT + 生成 + 门禁 + 自包含启动） | ✅ | task-5 | 达成：`npm run check` exit 0（含门禁×2 + 运行期启动探针：10 工具、`serverInfo=0.4.0`）；`package.json` 唯一权威，派生 3 个根文件 + 6 个载荷文件；篡改检出 2 例真实文件 + 18 例内存快照；`.mcp.json` 无自引用钉；本地安装路径真跑通（复制到 Codex 缓存、无 `node_modules` 仍可启动）。遗留：`dependencies` 仍声明已内联的 MCP SDK/zod（可移到 devDependencies，仅体积代价，列为 P1 收尾项） |
| P2 | 测试基石：修红、夹具保真、缺口用例、契约回放骨架 | ✅ | task-6 | 达成：`npx vitest run` **69 passed \| 2 expected fail \| 5 skipped（76）**（原 1 failed \| 11 passed）；新增 39 条执行用例；4 条反向验证（改动后 SHA256 全部还原）；真实 0.2.1 wire 采集并脱敏（token/cookie 命中 0）；夹具进程/端口残留 0 |
| P3 | 运行时启动向量切换（本地安装 + 直接 node 启动） | ✅ | task-4 ✅ + task-7 ✅ | ADR-0002 P1–P8 全部落地：启动路径无 npx/shell（`process.execPath` + `versions/<ver>/…/lib/bin.js`）；实测安装 59.4s/486.1 MB、幂等复用 1 ms（未调 npm）、冷启 28.7s、热启 4.0s；四类 npm 失败分级 + `install-timeout` 实测；`doctor` 增 version/engines/runtimePackage/npmCli/proxy/deprecatedEnv；`npm run check` exit 0（冻结基线 **132 passed \| 2 expected fail \| 6 skipped**，起始 70 passed）；反向验证 4/4 变红 |
| P4 | 分层重构（无行为变更） | ✅ | task-8 | 达成：`src/run-manager.ts`(785行)、`server.ts`、`runtime.ts`、`types.ts` 全部删除且**无转发壳**；新增 32 个源文件（app/config/policy/dsh/service/run/tools/diagnostics/util）；`tests/module-boundaries.test.ts` 由 skip 转实跑（7 条断言 + 3 条反向验证先红后还原）；用例 **132 → 192 passed**（+60，零删除），`it.fails` 仍 2、skipped 6→1；`npm run check` exit 0（Lead 亲跑复核）。偏差 D1–D8 见报告，其中 D3/D4/D7 刻意把 terminate 语义、契约收紧、catch 直写留给 P5/P6 |
| P5 | 生命周期状态机与错误恢复 | ✅ | task-9 | 达成：Lead 复跑 `npm run check` exit 0，**`242 passed \| 1 skipped (243)`**，`it.fails` **归零**；`settle` 唯一终态写入点（二次 settle 返回 false 不覆盖，`settleStrict` 仅测试）；`dsh/wire.ts` 单一分类来源 + `run/state.ts` 策略表（删除正则猜测）；回合映射穷举官方全集（`completed` 是唯一成功），新增 `turn-unknown:missing-turn-end` 关闭"会话停下但无终态回合"的永久 running 洞；`auth` 自动重换 cookie 一次；服务死亡判 `service-unreachable`；`doctor.ready` 四项制 + `problems[]`（`ready = problems.length === 0`）；测试文件按被测模块重组、旧聚合测试名消失；3 条反向验证（7/3/2 条变红）+ SHA256 还原；整轮跑完用户真实数据目录仍不存在 |
| P6 | 安全与凭据统一 | ✅ | task-12 | 达成：Lead 复跑 `npm run check` exit 0，**`271 passed \| 1 skipped (272)`**（P5 → +29）；新增 `src/util/redaction.ts`（秘密表 + `redactSecrets`/`redactDeep`/`redactErrorText`），`LaunchCredentials` 的 `toString`/`toJSON`/模板插值默认脱敏，真实值只经 `loginUrl`/`cookieHeader`；修掉 `browserError` 未脱敏直写根因并在 MCP 边界对每个工具结果再扫一次；`tests/security-exits.test.ts` 分桶断言（`outward` 桶不得含 token/cookie，`loginUrls` 桶必须仍含 token 且回环）；cookie 改 `headers.getSetCookie()`；契约 `session/list#cwd` 必填（缺字段 → `protocol-drift`，含 `items.0.cwd`），附加字段仍允许；`isLoopbackUrl` 在换凭据前拒绝非回环目标且不发请求；补强 README "仅监听回环"的过度声明；5 条变异反向验证全部咬合 |
| P7 | 交互与文档完整性 | ✅ | Lead + task-13 | 达成：`catalog.ts` 为工具面唯一事实来源（`noArgs` 删除改为派生并真实消费；语义类 `behavior` → 三个 hint 由 `annotationsFor()` 计算，注解不再写第二遍；注解矩阵与 handler 实际调用的 `ToolContext` 方法**交叉验证**）；失败出口统一 `toolFailure()`（`isError` + 可读文本 + 统一脱敏，10 工具双覆盖）；`wait_run` 契约（可重复、无副作用、终态同快照、超时不失败）写入描述与 README；**README 中英 ↔ 插件广告工具名门禁进 `check`/`prepack`**（触发码 `tool-surface-drift`）；`doctor` 17 键与 README 双向一致；`docs/configuration.md` + `docs/operations.md`（安装/升级/排障/验收，含 `RunSnapshot` 字段表与 `reason` 词表）+ `.github/workflows/*`（actionlint 通过）+ PR 模板；4 条反向验证；Lead 复跑 `284 passed \| 1 skipped (285)` |
| P8 | 发布与端到端验收 | 🔄 首轮独立验收 NO-GO → 阻断项已修 → 复验中 | task-14（reopen） | 首轮（task-14）：门禁/用例/两条安装路径/live 链路全部亲验通过，但判 **NO-GO**，4 条阻断项：B1 `check:live` 干净环境必红（隔离守卫把被配置的数据目录误当用户 home 监视）、B1′ 同根的 `live-smoke.yml` 必红、B2 README 称 `allowedWorkspaceRoots` 用 `null`（实测 `[]`）、B3 README"冷态约 4 秒"（实测真冷启 29.4s）。修复（task-15 + Lead）：守卫改为带策略观察（默认目录不许出现变化、被配置目录允许出现但不许消失、同路径取更严）+ 四条回归；README 中英按实测改三情形并新增**取值语义门禁**；**空跑陷阱已修**（`scripts/check-live-guard.mjs`，不设 `DSH_LIVE` → exit 2）。Lead 亲跑：`check` exit 0 `294 passed \| 1 skipped (295)`；干净数据目录 `check:live` 首次 exit 0。**待**：独立复验 B1/B1′/B2/B3 与空跑修复后重新出结论。**仍待用户决策**：npm 分发身份（ADR-0001 未决点） |

## 评审后的整改轮（R1：进程生命周期与运行时目录治理）

来源：5 位专家评审（协议 / 运行时 / 测试强度 / 交付体验 / 红队反驳）的结论与裁定见 `reports/plan-p0-p1.md`。P0 组已落地并经**独立验证**（`reports/verify-r1-p0.md`）：第一轮 **NO-GO**（唯一阻断项 N-1：`launch.test.ts` 未注入 `platform` → ubuntu 列确定性红，本地 Windows 全绿掩盖），修复后第二轮 **GO**（`check` exit 0 / `455 passed | 1 skipped (456)`；五条 P0 声明在本机成立，其中 P0-2 的 POSIX 真实行为仍标未验证）。P1 组按该文件的优先级推进。

| 项 | 主题 | 状态 | 任务 | 出口判据 |
|---|---|---|---|---|
| R1-P0-1 | 孤儿服务进程 + 端口自愈（`dsh.pid` + 启动前对账 + `doctor.orphans`） | ✅ | task-16（launch-impl） | 身份可证才回收；拿不到身份 → `unverified` 不杀；停止需端口已释放才算确认；3 条反向验证变红后还原；`doctor` 18 键 |
| R1-P0-2 | POSIX 进程树修补 + `process-tree` 补测 | ✅ | task-16 | POSIX `detached:true`（不 `unref`）+ 自叶向根递归兜底；该文件从**零测试**到 15 例缝级单测。**POSIX 真实行为未验证**（仅缝级 + 静态推理） |
| R1-P0-3 | `package-spec` 边界测试 + 复合子句缺陷修复 | ✅ | task-18（Lead） | 84 例；发现并修掉真实缺陷（见 D-11）；R1/R2 反向验证（1 红 / 5 红）后还原 |
| R1-P0-4 | 运行时版本目录 prune（fail-closed） | ✅ | task-17（dist-ssot） | 62 例；真实活体验证"在用则 0 删除"；两条反向验证（2 红 / 14 红）后还原；`doctor` 零改动 |
| R1-P0-5 | `serviceHome`/`DSH_HOME` 安全断言 | ✅ | task-16 | 非绝对路径/文件系统根/用户主目录或其直接父级/越界一律 fail-closed 且不创建目录 |
| R1-P1-1 | `nextAction`（由 `reason` 单向派生，闭集）+ `reason → 动作` 故障词典 | ⏳ | 待分配 | 与 `run/state.ts` 策略表同构；开放形态一律 `report-only` |
| R1-P1-2 | `webUrlStale` + SKILL/README 写明"服务重启后旧链接失效" | ⏳ | 待分配 | 仅 `failed(service-unreachable)` 时为 true，有测试 |
| R1-P1-3 | 审批语义文档 + `doctor` 提示（默认 `workspace-write` → `approval: ask`） | ⏳ | 待分配 | 文档明说"需在页面点批准或显式用 `danger-full-access`"；先做"读路径能否观测待审批"的实验，**不许猜接口** |
| R1-P1-4 | `wire.ts` 漂移结构化（method/path 进入错误对象） | ⏳ | 待分配 | `classifyThrownFailure` 不再丢结构；有断言 |
| R1-P1-5 | `dsh:try <version>`（不改文件、临时数据目录、finally 清理） | ⏳ | 待分配 | live 测试改读 `resolveHarnessPackage(env)`；失败不污染真实数据目录 |
| R1-P1-6 | `onEvent` 结构化日志（**只写 stderr**、单一开关、`redactDeep`）+ 耗时挂快照 | ⏳ | 待分配 | 不得污染 MCP stdio stdout；默认 off |
| R1-P1-7 | mac 进 `check` 矩阵、`.gitattributes`、CONTRIBUTING、mermaid 架构图 | ⏳ | 待分配 | `check:live` **不进** PR 门禁 |

评审明确**不做**的项：遥测上报、版本区间自动降级、每个 patch 版本建 fixture、`doctor --json` 新开关（`structuredContent` 已存在）、全仓 Stryker、IO 编排的属性/变异测试、`check:live` 进 PR 门禁、mac runner 跑 live、自动缩窄重试、交互式审批（无公开 RPC）、keychain 凭据、独立 RELEASING.md。**独立验证后新增的不做项**：为 `ServiceSnapshot` 增加 `orphan` 字段（`doctor.orphans` 已是该可观察面，扩快照属外部契约变更、收益不足）；"停止后保留 `dsh.pid` 并标 `stoppedAt`"（经评估**不关闭**"遗留孤儿无 pidfile 无法归属"这一残余风险，故不加状态）。

## 阶段依赖

```
P0 ─┬─> P1 ─┐
    └─> P2 ─┼─> P4 ─> P5 ─> P6 ─> P7 ─> P8
            │
     P3 ────┘   （P3 与 P1/P2 并行；P4 需要 P1/P2 完成、P3 的接口已定）
```

- P4 必须在 P2 之后：**先有回归网再搬家**。
- P3 与 P4 有交叠（`service/*` 是 P4 的目标结构、P3 的新模块），实现顺序：P3 的 `runtime-package` 先以现有结构落地，P4 再搬迁并加边界测试。
- P8 的最后一步（发布）取决于 ADR-0001 的未决点（包名归属）——**用户决策项**，不阻塞 P1..P7。

## 每阶段必带的证据形式

1. 命令原文 + 原始输出（不接受"应该通过"）；
2. 反向验证记录（把实现改回错误写法后用例/门禁必须失败）；
3. 与官方源码的对应关系（文件:行），涉及协议时尤其如此；
4. 未验证项的显式清单。

## 变更管理

- 任何与 `docs/architecture.md` 冲突的实现，先提 ADR（新增或修订），再改代码。
- 外部可感知变更（`RunStatus` 语义、`RunSnapshot` 字段、安装方式、工具行为）必须进 `CHANGELOG.md`，并同步 SKILL / README 双语。
- 每个阶段完成后更新本表的"状态"与出口判据结果。

## 文档地图

| 文档 | 作用 | 语言 |
|---|---|---|
| `README.md` / `README.en.md` | 面向使用者：安装、环境变量、用法、排障入口 | 双语（同源更新） |
| `skills/deepseek-harness/SKILL.md` | 面向 Codex：委派工作流与安全约束 | 英文（插件协议要求） |
| `docs/architecture.md` | 目标架构、职责、状态机、测试与分发策略 | 中文 |
| `docs/configuration.md` | **冻结的配置契约**与数据目录布局、失败分类 | 中文 |
| `docs/operations.md` | 安装/升级/排障/验收运行手册 | 中文 |
| `docs/decisions/ADR-000x-*.md` | 设计决策与备选方案 | 中文 |
| `docs/plans/phase-4-5-refactor-plan.md` | 分层搬迁与状态机执行计划、接口签名 | 中文 |
| `docs/roadmap.md` | 本文件：阶段、出口判据、风险 | 中文 |
| `CHANGELOG.md` | 外部可感知变更（含未发布状态与已知缺陷） | 中文 |

> 双语范围决策：**面向使用者的产物（README、插件界面文案、安装命令）保持双语同源**；面向维护者的设计/决策文档先用中文，翻译按需（`dsh-translate-docs` 属显式调用场景）。这样既不牺牲用户可读性，也不为内部文档维护两份易漂移的事实。

## 缺陷台账（本轮发现，按发现顺序）

| # | 症状 | 根因 | 处置 |
|---|---|---|---|
| D-01 | `DSH_MCP_HARNESS_PACKAGE` pin 了 registry 上不存在的 `0.4.0`，冷启动 161.58s 撞超时 | 元数据多份事实源 + 把"获取运行时"算进就绪预算 | ✅ task-5（SSOT + 门禁）、task-7（安装/启动分离） |
| D-02 | 市场安装静默降级到 0.3.1 副本 | 手工维护的内嵌副本作为第二份版本事实 | ✅ task-5（载荷改为生成 + 忽略 + 逐字节门禁） |
| D-03 | `tests/run-manager.test.ts:49` 断言 200，实际 303 | 陈旧断言 + `fetch` 自动跟随重定向 | ✅ task-6（改 `redirect:"manual"` 并断言 303/set-cookie） |
| D-04 | 测试夹具与官方 0.2.1 wire 有实质偏差，测试不能作为协议证据 | 夹具手工编写、未与上游类型对齐 | ✅ task-6（真实 wire 录制 + 脱敏回放 + 保真对齐） |
| D-05 | `turn/end` 的 `blocked`/`max-tokens` 被判成功；cookie 失效后永久 `running` | 结局映射 fail-open + `refresh()` catch 只写 error 不改状态 | ✅ task-9（P5）：`settle` 唯一终态写入点、映射穷举官方全集且未知 kind fail-closed、`auth` 自动重换 cookie 一次、服务死亡判 `service-unreachable`；2 条 `it.fails` 转正，`it.fails` 归零 |
| D-06 | `npm run check:live` 是静默空跑（需 `DSH_LIVE=1` 才真正执行） | live 套件用环境变量短路，脚本却自称"跑 live" | ✅ 已修（Lead）：新增 `scripts/check-live-guard.mjs` 作为命令前置条件——未设 `DSH_LIVE` 时**exit 2** 并打印可操作的运行指引；`check:live` 改为 `check-live-guard && vitest run tests/e2e/live.test.ts`。实测：未设变量 → exit 2；`DSH_LIVE=1` + 干净数据目录 → 真实跑通 exit 0 |
| D-07 | 测试在用户真实 home 下写出 225 个空目录（实测单跑一次 vitest 就出现 32 个） | service 层构造期回退默认数据目录（连传入值都被忽略）+ `start()` 里启动前饥饿 `mkdir` | ✅ task-11：类型闸门（必填 + `@ts-expect-error` 探针）+ 副作用闸门（mkdir 只在真实 spawn 路径）+ 装配闸门（`tests/support` 默认临时目录）+ 运行时闸门（每文件 `afterAll` 断真实目录存在性未变）+ 元闸门（强制每个测试文件 import 守卫）；`npm run check` ×2 exit 0（203 条）；3 条反向验证含 SHA256 还原 |
| D-08 | `reports/` 曾出现两个位置（仓库内 vs 会话根） | 任务书写"相对 `E:\AI\test`"，但报告放进了仓库 | ✅ Lead 已归一；后续任务书明确写规范位置 |
| D-09 | `browserError` 未脱敏直写进快照（可能含带 `?token=` 的 URL）；README 声称"Harness Web 仅监听回环"但代码从未校验 URL 是否回环 | 脱敏靠"记得调用"；声明先于实现 | ✅ task-12（P6）：`util/redaction.ts` 单一入口 + MCP 边界全量扫描 + `isLoopbackUrl` 在换凭据前拒绝非回环目标（不发请求）；README 改成可验证表述 |
| D-10 | cookie 用单头 `get("set-cookie")` + 自写解析，遇 `Expires=` 逗号会误切；`session/list#cwd` 可选导致归属校验 fail-open | 解析取巧 + 契约声明比实现依赖更宽 | ✅ task-12：`headers.getSetCookie()` 优先；契约 `cwd` 必填（缺字段 → `protocol-drift` 且错误含 `items.0.cwd`），附加字段仍允许 |
| D-11 | `satisfiesNodeRange` 静默放行**被排除**的版本：`">=2.3.0 <2.5.0"` 丢上界（`2.5.0` 判为支持）、`"1.2.3 - 1.3.0"` 被当作下界、`1.2.3-junk`/`1.2.3.4` 被当作数字核心 | `parseVersion` 未锚定（前缀匹配）+ 子句整体被单个比较器处理 | ✅ task-18（Lead，P0-3）：锚定解析 + 子句按空白拆成多个比较器全部成立 + 未实现语法一律 `false`（fail-closed）；84 例覆盖，含"声明区间用了未覆盖的形式即红"的守卫（详见 `reports/fix-package-spec-boundaries.md`）。**当前 pin 无实害**，但改成自然写法即会误判 |
| D-12 | `service/process-tree.ts`（68 行）**零测试引用**；且 `launch.ts` 的 `detached:false` 与 `kill(-pid)` 语义冲突 → POSIX 会漏掉 DSH 的孙进程 | 平台分支只靠"真机上没人踩" + 无注入口测试 | ✅ task-16（P0-2）：POSIX 改 `detached:true`（不 `unref`）+ 自叶向根递归兜底；15 例缝级单测；3 条反向验证 |
| D-13 | MCP host 被强杀后单层 `node …/lib/bin.js` 子进程**带监听端口**存活，无任何对账（现场：26 个孤儿服务进程各占端口；红队实测一次漏杀 4 进程/15 端口） | `terminate()` 只在持有 child 句柄时生效，没有跨进程证据 | ✅ task-16（P0-1）：`dsh.pid` 原子写 + 启动前对账 + 身份 fail-closed + 端口释放校验 + `doctor.orphans` |

## 当前风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 无法发布 npm（包名归上游） | 只能走本地路径安装 | ADR-0001 把安装路径参数化；`prepare:plugin` + 本地 marketplace 已可端到端验收 |
| 市场载荷为生成 + 忽略 | git 源安装需先 prepare（否则插件目录为空、安装失败） | README 双语写明并显式劝阻 `--ref main` 直装；若需要再切"生成 + 提交"形态（门禁在两种形态下都校验） |
| Codex 按插件版本缓存内容 | 同版本改动不会自动重新复制 | 更新内容时提升 `version` 或清缓存目录；已写进 README 与 CHANGELOG |
| DSH 内部 RPC 未稳定，升级可能破坏契约 | 运行期漂移 | ADR-0004 的 contract + 契约回放；`doctor` 报告支持区间 |
| 真实 API key 缺失 | 助手文本全路径无法本地实测 | 用录制 wire 回放覆盖解析；`check:live` 在具备 key 的环境补全 |
| **posix-only-code** | `browser.ts:7-8` 的三平台 opener 分支（`open`/`cmd /c start`/`xdg-open`）**全仓 0 测试引用且无 platform 注入缝** → 异平台无法验证（独立验证者新发现，信息级；它不被任何断言依赖，故不会红 CI） | 若 opener 在 macOS/Linux 上选错命令，只影响 `open_service` 的便利性，不影响服务本身 | 给它加 `platform` 注入缝并补三平台用例（可并入 R1-P1-7 的跨平台工作） |
| `paths.ts:20 samePath` | 直接读 `process.platform`，没有注入参数；保护方式是"测试按平台分支断言"而非"注入平台钉住" | 若将来在非 win32 上改错语义，`layering.test.ts` 的 `else` 分支会红（有保护，但方式是跟随平台） | 需要更硬的保护时改为注入式 |
| **真实 ubuntu 上 CI 三列未观测** | 平台分支已用"覆盖 `process.platform`"方式全量验证（`launch.test.ts` 全文件绿），但**真实 POSIX `path` 语义 / 大小写敏感 FS / 平台工具可用性（`taskkill`/`powershell`/`xdg-open`/`/proc`/`pgrep`）/ CRLF / 真信号语义**这五类完全未覆盖；`tests/unit/data-location.test.ts` 在真实 ubuntu 上是否仍绿亦未验证 | 已知成因（N-1）已关闭；缺的是 runner 直接观测 | 补 R1-P1-7 的 mac job / 让 CI 真跑 ubuntu 列并把结果纳入验收 |
| Windows 专属行为（ACL、控制台、进程树） | 只在 Windows 复现 | 保留平台分支的显式测试与文档提示；CI 若可用需含 Windows |
| **POSIX 进程回收真实行为未验证** | macOS/Linux 上孤儿/孙进程泄漏可能仍存在 | 仅缝级单测 + 静态推理（本机 Windows）；缓解：`doctor.orphans` + `dsh.pid` 对账（跨平台），待 mac/linux CI job 覆盖 |
| **prune 与"无 pidfile 的遗留进程"** | 一个在 P0-1 之前启动、仍活着的孤儿进程所使用的版本目录仍可能被 prune 删除（Windows 上文件占用会让删除失败并计入 `skipped`，POSIX 无此兜底） | 已知且如实记录（`reports/impl-version-prune.md` §3.2）；缓解：`DSH_MCP_PRUNE_VERSIONS=off` 可完全关闭；被点名的加固方案（停止后保留 `dsh.pid` 并标 `stoppedAt`）经评估**并不关闭该风险**（遗留进程本就没有 pidfile），故未采纳以免徒增状态 |
| **默认权限模式需要人工审批** | 默认 `workspace-write` → `approval: ask`：需要写操作的任务会停在"等人批准"，而 MCP 面无法回答审批，从 Codex 视角看只是一个长时间 `running` | 已在评审中确证（`packages/bundle/base/cordis.patch.yml:232,248,256-259`）；处置见 R1-P1-3（文档 + `doctor` 提示 + 先做可观测性实验）；不要猜接口实现审批 |

## P1 收尾项（不影响门禁，但应在 P4 之前处理）

1. `package.json#dependencies` → `devDependencies`（MCP SDK 与 zod 已内联进 `dist/`），同步刷新 `package-lock.json`。
2. `doctor` 增加 `version` 字段（含运行时包版本与支持区间）——**P3 已完成**，`check-metadata --self-contained` 已同时断言 `serverInfo.version`；若仍需 `doctor.version` 与门禁联动，挂上即可。
3. ~~**`npm run check:live` 空跑缺陷**~~ → **✅ 已修**（见缺陷台账 D-06）：新增 `scripts/check-live-guard.mjs` 作为前置条件闸门，未设 `DSH_LIVE` 时 `npm run check:live` **exit 2**（不再"跑 0 条用例却绿"），并打印含 PowerShell/bash 两种写法的运行指引；`DSH_LIVE=1` + 干净 `DSH_MCP_DATA_DIR` 实测首次 exit 0（安装 55.1s、冷启 22.8s、热启 3.57s）。
   > 注：原计划"给 live 套件独立 vitest 配置并取消对 `DSH_LIVE` 的依赖"被否决——live 套件**应当**保持显式开关（它需要联网与约 486 MB 磁盘，不能进默认门禁）；缺的是"拒绝静默空跑"，前置闸门用更小的改动精确解决了这一点。
4. ~~**运行时目录清理策略**~~ → **✅ 已完成（P0-4，`reports/impl-version-prune.md`）**：安装成功后（仍持 `.install.lock`）运行一次 prune——回收「非当前 pin + 未被在用服务引用」的 `versions/<version>/` 与超过 24 小时的 `.tmp-*`；fail-closed（拿不到锁/证据不可读/身份无法证实 → 不删；当前 pin 永不删）；`EBUSY`/`EPERM` 记入 `skipped` 不重试；开关 `DSH_MCP_PRUNE_VERSIONS`（默认启用）。残留：真实生产目录上的回收量未验证（本环境只用临时目录）；`DSH_MCP_PRUNE_VERSIONS` 的 env 解析仍在 `runtime-package.ts`（若归口到 `config/resolve.ts` 需触发红线重验，暂缓）。
