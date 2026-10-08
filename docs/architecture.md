# 架构设计（deepseek-harness-for-codex）

状态：**设计冻结（v1）** · 决定日期 2026-10-08 · 依据：本轮三份审计报告（`reports/verify-proto.md`、`reports/verify-runtime.md`、`reports/verify-packaging-tests.md`）与 `reports/00-dshforcodex-0.4.0-critique.md`

本文是后续所有重构的约束来源。任何实现与本文冲突时，先改本文（走 ADR），再改实现。

---

## 1. 产品边界

**是什么**：一个 MCP 服务 + Codex 插件。它在本地拉起 DeepSeek Harness 的 Web 宿主，把一个可见会话的登录链接交给用户，把任务提交进该会话，并在 Harness 结束后由 Codex 独立验收工作区变更。

**不是什么**（明确非目标，避免范围蔓延）：

- 不重写 DSH、不 fork DSH 运行时、不修改 DSH 源码。
- 不做托管中转（那是 `deepseek-harness-relay-mcp` 的定位）。
- 本阶段不提供 MCP 进程重启后的运行恢复/幂等对账（需要有持久运行标识与对账器，是另一个产品级特性）。
- 不提供模型/Provider/推理强度选择、子任务审批应答、steer 注入（同上，属 relay 能力面）。
- 不做多工作区并行调度器；一个 MCP 进程内每个工作区一个服务实例，串行提交。

**成功判据**（端到端验收，见 §10）：用户按 README 的 canonical 安装路径装好后，新建 Codex 任务即可：拿到可点击会话链接 → Codex 能看到运行状态与助手输出 → 任务真正落到工作区 → 失败时收到明确的失败原因而不是"假成功"。

---

## 2. 分层与职责

目标目录结构（Phase 4 落地；当前是单文件 `src/run-manager.ts`）。

```
src/
  version.ts            生成的版本常量（源自 package.json，禁止手改）
  index.ts              bin 入口：只做 stdio transport 装配与信号处理
  app/container.ts      组合根：唯一允许 new 具体实现的地方
  config/               {types.ts, resolve.ts}      环境变量 → 校验后的 Config
  policy/               {workspace.ts, package-spec.ts, trusted-input.ts}
  dsh/                  {contract.ts, wire.ts, client.ts, events.ts, types.ts}
  service/              {supervisor.ts, readiness.ts, runtime-package.ts, credentials.ts}
  run/                  {state.ts, registry.ts}
  tools/                {catalog.ts, schemas.ts, register.ts}
  diagnostics/doctor.ts
```

| 模块 | 单一职责 | 明确不做 | 主要测试层 |
|---|---|---|---|
| `index.ts` | stdio 传输、进程信号、把 container 接到 MCP server | 任何编排逻辑 | 集成 |
| `app/container.ts` | 读 Config、构造各层、注册工具、统一关闭顺序 | 业务判断 | 集成 |
| `config/*` | env → Config；默认值与校验只在这里出现 | 抛业务错误、访问网络/磁盘（除读取 env） | 纯单测 |
| `policy/workspace.ts` | 绝对路径/realpath/目录性/允许根/会话归属判定 | 启动进程、发 RPC | 纯单测 |
| `policy/package-spec.ts` | npm spec 与外部命令输入的合法性判定 | 解释"为什么装不上" | 纯单测 |
| `policy/trusted-input.ts` | 决定输入是"受信"还是"必须校验"，给出校验后的 argv | 拼接命令行字符串 | 纯单测 |
| `dsh/contract.ts` | 我们依赖的 DSH 方法与值的**显式契约**（方法名 + 请求/响应 schema + 引擎区间 + 支持版本线） | 网络、状态 | 纯单测 |
| `dsh/wire.ts` | 信封编解码 + 错误分类（Auth/Transport/Protocol/NotFound/Rpc） | 认证状态、重试策略 | 纯单测 |
| `dsh/client.ts` | 带认证的 RPC：cookie 获取/刷新、超时、按分类抛出、通过 contract 校验返回值 | 运行状态机、进程 | 契约回放 |
| `dsh/events.ts` | 会话事件投影：助手文本、turn 结局（对官方 kind 全集做**显式映射 + fail-closed 兜底**） | 网络、状态、日志 | 纯单测 |
| `service/readiness.ts` | stdout 解析：启动 URL、静默期、安装进度；把输出流变成就绪状态迁移 | 决定超时政策（由 supervisor 传入预算） | 纯单测 |
| `service/runtime-package.ts` | 保证 `<dataDir>/runtime/<pkg>/<version>` 存在；解析可执行入口；诊断安装失败 | 决定是否启用 DSH | 集成 |
| `service/supervisor.ts` | 子进程生命周期：启动、就绪、运行、停止、收树；状态机唯一写入者 | RPC、事件解析 | 集成（真进程） |
| `service/credentials.ts` | `LaunchCredentials` 值对象：url/token/cookie 的持有与 `redact()` | 决定何时刷新（由 client 决定） | 纯单测 |
| `run/state.ts` | Run 状态机与终态保证（settle-once）、错误分类 → 结果映射 | IO | 纯单测 |
| `run/registry.ts` | 运行记录、活动会话锁、快照投影（对外只暴露不可变快照） | IO | 纯单测 + 集成 |
| `tools/*` | MCP 表面的 schema、注解、描述与薄适配 | 任何业务逻辑 | 集成 |
| `diagnostics/doctor.ts` | 环境与前置条件诊断（Node 引擎区间、npm、代理、数据目录、工作区策略、运行时包状态） | 安装动作（只报告，安装由 runtime-package 在启动时做） | 集成 |

**依赖方向（不得反向）**：

```
index → app → {tools, diagnostics}
tools → {run, service, dsh, policy, config}
run → {dsh, service, policy}
service → {dsh, policy, config}
dsh → {dsh/types, dsh/contract, dsh/wire}
policy, config, run/state, dsh/events  ← 纯模块（不得 import node:fs / node:child_process / node:net）
例外：policy/workspace.ts 是唯一的 "filesystem policy"，需要 node:fs/promises 做 realpath/stat；
      边界测试对它按"允许 IO 的 policy"单独断言（policy/paths.ts 等其他 policy 文件仍严格要求纯）。
```

由 `tests/module-boundaries.test.ts` 静态断言（P4 起实跑：依赖方向 + 纯模块 IO 导入 + 聚合文件不复存在 + 构造点约束）。纯模块约束是"可确定性单测"的前提，也是防止编排逻辑再次沉淀回大文件的结构性手段。

**测试隔离的硬约束**：数据目录（`DSH_MCP_DATA_DIR`）与 `DSH_HOME` 只能由组合根解析后显式注入；service 层不得自行读取环境或回退到默认值，且**目录创建必须发生在真实 spawn 之前的那一刻**，使注入假启动的路径零文件系统副作用。测试侧由 `tests/support/**` 统一提供临时数据目录，并有套件级守卫断言"用户真实默认目录的存在性在整轮测试前后未改变"（该守卫的由来见 `reports/fix-test-isolation.md`：P4 期间测试曾在用户 home 下写出 225 个空目录）。

---

## 3. 状态机与终态保证

> 官方 `packages/AGENTS.md` 的既有规则："Represent one asynchronous operation with one lifecycle controller." 本次改造把这条规则落到服务与运行两级。

### 3.1 服务（Service）

```
idle ──start()──> starting ──ready──> running ──stop()/crash──> stopping ──> stopped
                    │                    │
                    └──fail(cause)──────> failed(cause)
```

- `starting` 期间只有 `readiness` 能推进到 `running`；`failed` 必须带 **cause 枚举**：`install-failed` / `no-first-output` / `no-url-line` / `exit-before-ready`（服务侧），`install-timeout`（运行时包获取侧）。
  > 词汇统一（P5，task-9）：早期草案里的 `quiet-timeout` 在"单预算 + 活动重置"模型下没有对应物，已删除；`readiness.ts` 曾同时输出 `no-output` / `silent-timeout` 的别名展示，也已收敛为上述规范名。
- `stop()` 幂等：任意状态调用都收敛到 `stopped`；`terminate()` 在**所有分支**（含"进程已退出"的早退）都要写完 `status`/`stoppedAt`/释放工作区索引——当前实现的早退分支不写状态，是必须消除的缺陷。
- 状态迁移是唯一写入点，所有对外快照从状态派生，不再散落赋值。

### 3.2 运行（Run）

```
pending ──accepted──> running ──┬──> succeeded
                                ├──> failed(reason)
                                └──> cancelled
```

- **settle-once**：终态只能由 `settle(record, outcome)` 写入一次；`settle` 内部负责 `finishedAt`、释放活动会话锁、写终态快照。任何路径（含异常、超时、服务崩溃、用户取消）都必须经过 `settle`，不存在"停在 running 且只留 error 字符串"的状态——P4 期间 `refresh()` 的 catch 只写 `run.error` 不改状态、以及 `cancel()` 在 `session/cancel` 报错时不收敛，都是被该不变量排除的写法（P5/task-9 消除）。
  > **二次 settle 的语义（Lead 裁决）**：`settle` 返回 `boolean`——已是终态则**不写、返回 false**；另提供严格变体仅供测试断言"不可能重复写"。之所以不让它抛错：`dispose()`/停机路径若因重复 settle 中断，会跳过后续服务的停止，那比覆盖写更危险。
- **终态字段**：`RunSnapshot` 暴露 `reason`（`FailureReason`）与终态标识。`FailureReason` 的词汇表是模板字面量联合：`auth | transport | protocol-drift | service-unreachable | rpc:<code> | turn-blocked | turn-truncated | turn-aborted:<cause> | turn-interrupted | turn-unknown:<kind>`。
  > **`stopUnconfirmed` 只在 `ServiceSnapshot`**（"无法确认子进程退出"是服务级事实）。因服务停止而失败的运行使用 `reason = service-unreachable`。
- 非终态错误必须有**恢复策略**，不允许静默：

| 分类（`dsh/wire.ts`） | 触发 | 策略 |
|---|---|---|
| `AuthExpired` | HTTP 401/403、cookie 失配 | 清空 cookie → 重新换取一次 → 重试一次；仍失败则 `settle(failed, auth)` |
| `Transport` | ECONNREFUSED / 超时 / socket 关闭 | 退避重试 ≤3 次；仍失败则 `settle(failed, service-unreachable)`，并在错误里带服务状态 |
| `ProtocolDrift` | 信封/字段/游标不符合 `dsh/contract.ts` | **不重试**，`settle(failed, protocol-drift)`，错误信息必须含方法名 + JSON 路径 + 期望/实际 |
| `NotFound` | 未知 run/service/sessionId | 立即抛错，不改状态（调用方错误，不是运行失败） |
| `Rpc`（业务错误码） | 例如 `session/workspace-attach-failed` | 按 contract 中登记的处理策略表决定；未登记的错误码 → `settle(failed, rpc:<code>)` |

- **turn 结局映射**（`dsh/events.ts`，对官方 `TurnEndReasonMap` 全集显式穷尽 + 未知 kind fail-closed）：

| `reason.kind` | 结果 |
|---|---|
| `completed` | `succeeded` |
| `error` | `failed`，message 取 `error.message`（附 `error.code`） |
| `blocked` | `failed`，`turn-blocked`（回合在任何 step 前被拒，通常无助手文本） |
| `max-tokens` | `failed`，`turn-truncated`（文本可能部分产出，必须让调用方知道不完整） |
| `aborted` + `reason.user`（或本地已请求取消） | `cancelled` |
| `aborted` + `parent|hook|disposed|legacy` | `failed`，`turn-aborted:<cause>` |
| `interrupted` | `failed`，`turn-interrupted`（崩溃后合成） |
| `forked` / 未知 kind | `failed`，`turn-unknown:<kind>` —— 失败关闭，绝不再判成功 |

- **注意**：`agent/error` 不是会话日志事件（它是 Cordis 总线事件，被 `api-session-controller` 转成 `api-session/error`），因此"从会话历史里找 `agent/error`"的分支必须删除，错误只能经 `turn/end.reason` 呈现。

---

## 4. 运行时启动向量与就绪语义

**问题根因**：把"获取 DSH 运行时"（网络下载、不确定耗时）与"启动并等到就绪"（本地过程、秒级）混在同一个 120s 墙钟预算里；为了在 Windows 上跑 `npx.cmd` 又必须开 `shell:true`，于是制造了命令注入面；`dsh` 真实进程在 `cmd→npx→cmd→dsh` 第三层之下，收尾只能靠整树兜底。

**设计（ADR-0002，已由实测确认：`reports/design-runtime-launch.md`）**：

1. `service/runtime-package.ts` 负责**获取**：把 `@deepseek-ai/dsh@<精确 pin>` 安装到 `<dataDir>/versions/<version>/`（`npm install --prefix … --no-save`，argv 启动、`shell:false`、进度可见、独立且宽松的安装预算、失败带原始 stderr 与可操作建议）。已安装则秒级复用，支持离线复用；安装走"临时目录 + 原子 rename + `.install.lock`"避免并发。安装成功后（仍持有该锁时）运行一次 **prune**：回收「非当前 pin + 未被在用服务引用」的版本目录与超过 24 小时的 `.tmp-*`，结果经返回值 `prune {ran, reason, removed, skipped, reclaimedBytes}` 暴露；拿不到锁、证据不可读或"是否在用"无法证实一律**不删**（fail-closed），当前 pin 永不删，`EBUSY`/`EPERM` 只记入 `skipped`。
2. `service/supervisor.ts` 负责**启动**：`spawn(process.execPath, [<resolved bin>, "web", "--no-open", "--port", "0"], {shell:false, windowsHide:true, detached: <POSIX 为 true / Windows 为 false>})`。入口由已安装包的 `lib/bin.js` 解析（**不得**使用 `.bin/dsh.cmd` / `.bin/dsh` shim），并校验 `package.json#version` 与版本目录一致。启动前先做 `<dataDir>`/`DSH_HOME` 安全断言（绝对路径、非文件系统根、非用户主目录或其直接父级、`DSH_HOME` 严格位于数据目录之下，违反即抛错且不创建任何目录），再与上一轮遗留的 `dsh.pid` 对账（见 §4 第 4 条）。
3. **就绪预算按"活动重置"语义**：安装与启动各自一个预算——`DSH_MCP_INSTALL_TIMEOUT_MS`（默认 900s，一次性安装，绝不计入启动）与 `DSH_MCP_STARTUP_TIMEOUT_MS`（默认 180s，spawn → 打印 URL 行，**子进程每产生一行输出即重置**）。失败原因区分 `no-first-output`（从未输出）与 `no-url-line`（有输出但未出现 URL），信息包含脱敏日志尾 + 运行时包路径 + npm stderr 尾。
   > 设计演进：早期草案分为 `firstOutputMs`/`readyMs`/`quietPeriodMs` 三段。实测表明**热启（DSH 家目录已存在）**只有 3.5–4.6s，真正的"长尾"发生在一次性安装阶段（约 55–59 s / 486 MB）和**真冷启（DSH 家目录为空）**（约 20–30 s）；因此用"单预算 + 活动重置 + 两个失败 cause"表达同样语义，且不引入三个需要用户理解的旋钮。配置契约见 `docs/configuration.md`；README 里的耗时表述必须区分这三种情形（有防回退断言）。
4. 停止：先优雅信号，再按平台收尾（Windows `taskkill /T /F` 兜底；POSIX 进程组 SIGKILL → 自叶向根递归兜底 → 自身），并**确认退出且端口已释放后再写 `stopped`**；无法确认时写 `stopped` 但附带 `stopUnconfirmed` 告警，不谎报。
   **孤儿回收（P0-1）**：spawn 成功后原子写 `<服务目录>/dsh.pid`（`.tmp` + rename；端口未知时先写 `null`，就绪后重写真实端口），确认停止后删除、未确认则保留为证据。`start_service` 启动前与它**对账**：pidfile 解析失败只丢弃（绝不按其中数字杀进程）；记录的进程不存活 → `stale-pidfile`；存活且**身份可证**（OS 报出的命令行同时含记录的 `binPath` 与 `--port`）→ 回收；存活但身份不符或查不到 → `unverified`，**不杀**并保留证据。该结论经 `doctor.orphans` 暴露（存在孤儿只追加提示性 `problems`，`ready` 仍是四项制）。
   POSIX 上子进程以 `detached: true` 启动（**不 `unref()`**，stdout/stderr 管道保留），使进程组信号可用；进程组不可用时走递归兜底（Linux 读 `/proc/<pid>/task/<pid>/children`，其它 POSIX 用 `pgrep -P`），自叶向根收。Windows 保持 `detached: false`（避免新控制台窗口），靠 `taskkill /T /F`。
5. **版本锁定**：必须精确 pin。实测 `dist-tags` 的 `latest=0.2.0-rc.2` 低于本项目使用的 `0.2.1-alpha.1`，任何 range 写法都会静默降级。
6. **引擎校验不能依赖 npm**：已发布的 `@deepseek-ai/dsh` **没有 `engines` 字段**（区间只在 monorepo 根），`doctor` 必须自带支持区间 `^22.19.0 || >=24.0.0` 并校验 `process.versions.node`。

**实测收益**：稳态就绪由 6.43–7.47 s 降到 3.56–4.58 s；真·首次冷启动由 161.58 s（npx 下载安装计入就绪）变为"一次性安装前置 + 29.49 s 冷启/3.89 s 后续"；进程树由 4 层降为 1 层、`child.kill()` 即可收尾；离线（死代理）3.80 s 起服务；磁盘由 `_npx` 的 1249 MB/不自清理变为约 486 MB/版本、可枚举清理。生产版 DSH 桌面应用已在用同一向量。

**收益**：安装与启动解耦（首跑不再假装超时）、npx 从运行路径消失（注入面消失、进程树变浅、离线可复用）、版本切换成为"换目录"（可并存、可回滚、可诊断）。

---

## 5. 协议契约与漂移检测

`dsh/contract.ts` 是我们**唯一**声明"依赖 DSH 什么"的地方，包含：

- 方法表：`workspace/create`、`session/create`、`session/list`、`session/projections`、`session/page`、`session/prompt`、`session/cancel`（含 wire 参数名，如 `session/list` 的 `_request`）、每个方法的请求参数 schema 与期望响应值 schema（zod，只在 wire 边界使用）。
- 事件契约：我们消费的事件类型与字段路径（`turn/end`、`assistant/message`、`agent/inbox/spliced`、`session/title` 等），以及 `TurnEndReasonMap` 全集镜像。
- 能力常量：Node 引擎区间（`^22.19.0 || >=24.0.0`，与 DSH 一致）、支持的 DSH 版本线、HTTP 路径前缀 `/api`、认证握手形状（`GET /?token=` → 303 + `set-cookie`）。

**后果**：DSH 升级导致字段变化时，运行期立刻得到 `ProtocolDrift`（含方法名与路径），而不是静默拿到空文本或假成功；版本升级的工作量集中在 contract + 契约回放测试两处，不再散落。

---

## 6. 凭据与安全模型

- **凭据对象唯一**：`LaunchCredentials{url, token, cookie}` 只在 `service/credentials.ts` 内持有；`cookie` 仅存内存、不落盘；任何日志、错误、快照、doctor 输出都经过 `redact()`（规则覆盖 `token=`、`Cookie`、`Set-Cookie`、裸 token）。
- **链接是 bearer**：`webUrl` 会（按设计）返回给用户，因此必须在工具描述、SKILL、README 三处明示"等价于本机登录凭据；同一服务进程存活期内一直有效（非一次性）；不要转发、不要写进任务正文"。`browserError` 等派生文本一律脱敏。
- **不拼命令行**：所有外部命令用 argv 形式启动，`shell:false`；必须在受信边界上取值的变量（如自定义启动器路径）按 `policy/trusted-input.ts` 的规则校验或显式标注为受信输入，README 的措辞必须与实现一致（当前 README 只声明了包名校验，是过度声明）。
- **工作区策略 fail-closed**：绝对路径 + realpath + 必须为目录 + 允许根（如配置）；复用会话时**必须**能证明归属同一工作区，`cwd` 缺失即拒绝复用（而不是跳过校验）。
- **权限默认**：`workspace-write`；切到 `danger-full-access` 必须是调用方显式传入；Windows `workspace-write` 可能留下 ACL 标记，文档必须提示用一次性 worktree。
- **不静默扩大范围**：不自动 commit/push/deploy；不把任务文本中的声明当作权限来源。

---

## 7. 交互面（MCP 工具与 SKILL）

- 工具目录来自 `tools/catalog.ts` **一张表**：名称、标题、描述、schema、annotations、是否可写、是否幂等、返回字段。`register.ts` 只是遍历注册，杜绝"描述与实现不一致"。
- 注解必须与语义一致：`start_service`/`start_run` 会创建进程/会话，不得声明 `idempotentHint: true`；`open_service` 有副作用（打开浏览器），不得声明幂等。
- `wait_run` 的语义必须写清：**单次调用最多 30 秒，超时只是时间切片，运行仍在进行时必须继续调用**（对齐官方 host-poll 契约的思路）；返回体里给 `status`/`terminal`/`nextAction`，让调用方无需猜测。
- 返回约定：结构化字段 + 人类可读摘要并存；失败用 `isError` + 分类后的可操作信息（不要只回原始栈）。
- `doctor` 输出覆盖：Node 引擎区间（不是"主版本 ≥22"）、npm 可用性、数据目录可写、运行时包是否已安装及路径、工作区策略、代理/`NO_PROXY` 风险、DSH pin 与支持区间。
- SKILL 与 README 双语保持同源：版本号与命令由生成/校验脚本保证一致（ADR-0001），文档变更纳入 `check`。

---

## 8. 测试策略

四层，前三层全部无网络、无凭据，进入 `npm run check`：

| 层 | 位置（实际） | 覆盖 | 特征 |
|---|---|---|---|
| 纯单测 | `tests/unit/`（client、events、layering、readiness、runtime-package、supervisor-isolation） | config、policy、contract、wire 分类、events 投影（含 kind 全集表）、run/state 状态机、credentials 脱敏、就绪预算、运行时包安装幂等/并发/失败分级 | 无 IO（除专门验证副作用的用例），毫秒级 |
| 契约回放 | `tests/contract/recorded-wire.test.ts` + `tests/fixtures/recorded/` | 用真实 0.2.1 采集并脱敏的 wire 片段驱动 client/事件投影 | 证明"解析真实 wire"而不是"符合自造假服务" |
| 进程级集成 | `tests/run-manager.test.ts`、`tests/runtime.test.ts`、`tests/server.test.ts`（P5 将按被测模块重命名）+ `tests/fixtures/fake-harness.mjs`、`fake-npm-cli.mjs` | supervisor 启停/收树、readiness 迁移、编排端到端、错误分类与恢复、安装幂等（假 npm CLI） | 真子进程；夹具保真度必须对齐官方 wire（`assistant/message` 必填字段、消息对齐分页、`aborted@user`） |
| 静态门禁 | `tests/module-boundaries.test.ts`、`tests/metadata.test.ts` | 依赖方向、纯模块 IO 导入、聚合文件不复存在；版本/清单/载荷一致性与自包含启动探针 | 让"结构退化"与"元数据漂移"在本地即可证伪 |
| 真实 smoke（opt-in） | `tests/e2e/live.test.ts`（`npm run check:live`） | 起真实 `dsh web`，跑完整链路（无 API key 也能到 `turn/end{kind:'error'}`） | `DSH_LIVE=1` 才运行；默认 skip；不进入 check |

> ⚠️ **已知陷阱**：`npm run check:live` 单独执行会"空跑通过"（live 套件由 `DSH_LIVE=1` 短路）。CI 的手动 live workflow 已显式设置该变量；根治方案（给 live 套件独立 vitest 配置）见 `docs/roadmap.md` 的 P1 收尾项。

**反向验证纪律**：每条关键用例都要能通过"把实现改回错误写法"而变红（至少在高危分支上记录 3 条这样的证据）。脆弱断言（如"调用过某函数"）不算覆盖。

**测试隔离的五道闸门（不可回退）**：由 D-07 缺陷（测试在用户真实 home 下写出目录）催生，缺任何一道都可能复发——

1. **类型闸门**：`SupervisorOptions.dataDirectory` 必填，并有 `@ts-expect-error` 探针证明"省略即编译失败"；
2. **副作用闸门**：目录创建只在真实 spawn 路径上发生（注入假启动零文件系统副作用）；
3. **装配闸门**：`tests/support/manager.ts` 未显式传目录时自动 `mkdtemp` 并负责清理；
4. **运行时闸门**：`tests/support/isolation.ts` 在每个测试文件 `afterAll` 断言"真实默认数据目录的存在性未改变"；
5. **元闸门**：`tests/isolation.test.ts` 断言"每个测试文件都 import 了隔离守卫"——新增测试文件漏 import 会直接变红。

---

## 9. 分发与工程完整性

- **单一事实来源**：`package.json` 的 name/version 是唯一权威；`src/version.ts`、根 `.mcp.json`、根 `.codex-plugin/plugin.json`、内嵌/生成副本、README 中的版本引用全部由其派生（生成 + `--check` 门禁）。见 ADR-0001。
- **自包含启动**：插件 `.mcp.json` 用 `node ./dist/bin.mjs`（相对插件根，`cwd: "."`），不再 `npx --package=<本包>@<版本>`——消除"发布前自引用"死锁与"装了插件却拉到旧版本"的静默降级。
- **两条安装路径**：canonical = `npm run prepare:plugin` 后以本地路径加入 marketplace；可选 = 从已发布的 npm 包（需要属于本方的包名/命名空间，见 ADR-0001 的决策点）。两条路径解析到同一份内容，由门禁保证。
- **门禁**：`npm run check` = typecheck + 单测/契约/集成 + 元数据门禁 + build + **再跑一次门禁（含自包含启动探针）**——门禁跑两次是刻意的：`build` 末尾会执行生成器，只在 build 之后校验会让人为篡改被"自动治好"。另：`npm run check:live` = 真实 smoke；`prepack` = 生成 + check；`files` 覆盖 `dist/`、`.codex-plugin/`、`.mcp.json`、`skills/`、README、LICENSE。
- **CI**：`.github/workflows/check.yml`（windows/ubuntu × Node 22/24 跑 `npm ci && npm run check`）与 `.github/workflows/live-smoke.yml`（手动触发的真实 smoke）。
- **文档双语同源**：README 中英、SKILL 与实现同批更新；`CHANGELOG.md` 按语义化版本记录外部可感知变更。

---

## 10. 端到端验收（Definition of Done）

状态截至 2026-10-09（P0–P8 均已交付；**独立端到端验收 round 2 判 GO**，见 `reports/final-acceptance.md`）。**判据不接受"应该通过"，每条都要附证据。** 仍无法在本环境验证的项目集中列在表末。

| # | 判据 | 状态 | 证据 / 缺口 |
|---|---|---|---|
| 1 | `npm ci && npm run check` 全绿（含元数据门禁）；`npm run check:live` 在联网环境通过 | ✅ | `check` 已 exit 0（Lead 亲跑 `294 passed \| 1 skipped (295)`）；`check:live` **在干净（此前不存在的）数据目录上首次即 exit 0**（Lead 亲跑：安装 55.1s / 486.1 MB、冷启 22.8s、热启 3.57s、无凭据 → `failed(MISSING_CREDENTIAL)` 可读、`stopUnconfirmed=false`、URL 脱敏；独立验收另测 58.5s / 29.4s / 3.96s）。**空跑陷阱已修**：`scripts/check-live-guard.mjs` 让不设 `DSH_LIVE` 的 `check:live` **exit 2** 并给出可操作提示，而不是"跑 0 条用例却绿" |
| 2 | 冷环境首跑：从零到可用不超过一次安装预算，失败必带可操作诊断（不存在"117s vs 120s"式悬崖） | ✅ | P3：安装 59.4s（独立 900s 预算，不计入启动），冷启 28.7s、热启 4.0s；失败分级四类 + `install-timeout` 实测，错误含 npm stderr 尾 |
| 3 | 两条安装路径都能装出**同一版本**的服务，且 `doctor` 报告的版本与仓库一致 | 🔄 | canonical 本地路径已端到端跑通（`reports/impl-distribution-ssot.md` §6；Lead 独立验收：把载荷复制到临时目录启动，10 工具、`serverInfo.version=0.4.0`）；`doctor.version` 已加（P3）。**npm 源路径依赖 ADR-0001 未决点**（需要属于本方的包名） |
| 4 | 五个真实场景：无凭据→`failed` 且原因可读；正常任务→`succeeded` 且助手文本完整；`blocked`/`max-tokens`→`failed`（不假成功）；服务被杀→`failed(service-unreachable)` 不悬挂；用户取消→`cancelled` | ✅（自动化）/ ⏳（真机） | P5 已用表驱动 + 集成测试覆盖全部 `TurnEndReasonMap` 成员与未知 kind、401 重换 cookie、服务中途死亡、取消；①②③⑤ 的**真机**复现（含真实 API key 的正常任务）仍需在联网环境跑一次 `check:live`（见第 1 条） |
| 5 | 停止服务后无残留进程与监听端口（含 Windows 进程树） | ✅ | P3 实测：停两次 `stopUnconfirmed=false`、0 监听端口、无残留进程（`reports/impl-launch-vector.md` §5/§9） |
| 6 | 无任何日志/错误/快照泄漏 token 或 cookie（有自动化断言） | ✅ | P6：`src/util/redaction.ts` 单一脱敏入口 + `LaunchCredentials` 默认脱敏 + MCP 边界对每个工具结果再扫；`tests/security-exits.test.ts` 分桶断言（`outward` 桶不得含 token/cookie 值/cookie 对；`loginUrls` 桶必须仍含 token 且回环），并有正向控制证明扫描器看得见泄漏；5 条变异反向验证 |
| 7 | 模块边界测试通过：不存在跨层反向依赖，聚合文件不再存在 | ✅ | P4：`tests/module-boundaries.test.ts` 实跑（7 条断言 + 3 条反向验证），`run-manager.ts`/`server.ts`/`runtime.ts`/`types.ts` 全部删除且无转发壳 |

**验收怎么跑**：见 `docs/operations.md` §5（含 CI 行）。发布前另需：`CHANGELOG.md` 已记录外部可感知变更、`README` 双语与生成元数据一致、`git status` 只含预期改动。

---

## 11. 已知取舍

- 直接 `node <bin>` 启动意味着我们自己负责版本目录与安装失败诊断；换来的是确定性、离线复用、无 shell、浅进程树（见 ADR-0002）。
- 契约校验会在 DSH 漂移时**fail-fast**，而不是尽力兼容；这是有意的：宁可明确失败，也不要静默假成功。
- 运行态仍不跨 MCP 进程恢复（非目标）；如果需要，应按 relay 的持久标识 + 对账模型单独立项，而不是在本项目里逐步加补丁。
