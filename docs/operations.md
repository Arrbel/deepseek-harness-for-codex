# 运维手册（安装 / 升级 / 排障 / 验收）

面向使用或维护本项目的人。配置项语义见 [configuration.md](./configuration.md)，架构约束见 [architecture.md](./architecture.md)，进度与剩余工作见 [roadmap.md](./roadmap.md)。

## 1. 安装（canonical：本地路径）

```sh
git clone <本仓库>
cd deepseek-harness-for-codex
npm install
npm run prepare:plugin          # 构建 + 生成 + 全量 check（不可跳过）
codex plugin marketplace add "$PWD"          # PowerShell: (Get-Location).Path
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

为什么必须有 `prepare:plugin`：Codex 只复制插件文件、不会替你构建，而市场载荷 `plugins/deepseek-harness/` 是**生成物**（`dist/bin.mjs`、生成后的清单与 skills）。跳过它市场会解析到一个没有 `dist/bin.mjs` 的目录。

安装完成后新建一个 Codex 任务，并要求它使用 DeepSeek Harness。插件会：

1. 首次运行自动把 `@deepseek-ai/dsh@<pin>` 安装到 `<数据目录>/versions/<version>/`（一次性，实测约 1 分钟、约 486 MB）；
2. 以 `node <版本目录>/…/lib/bin.js web --no-open --port 0` 启动本地 Web 宿主（回环地址、随机端口），并把带 token 的会话链接返回给你；
3. 把任务提交进该可见会话、跟踪到终态，由 Codex 独立检查工作区变更。

浏览器不会自动打开；需要看过程时点击 Codex 给出的链接。**该链接等价于本机登录凭据**（服务停止前一直有效），不要转发、不要粘贴进任务正文。

## 2. 环境准备

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` | 由本项目自持校验（DSH 发布包无 `engines` 字段）；`doctor.engines` 会报告 |
| npm | 随 Node 提供 | 通过 `node <npm-cli.js>` 调用，不经 shell；可用 `DSH_MCP_NPM_CLI` 覆盖 |
| DeepSeek API Key | 必需 | 注入启动 Codex 的环境、写进目标工作区未提交的 `.env`，或稍后在 Harness 页面配置 |
| 平台 | Windows / macOS / Linux | Windows 上已针对控制台隐藏与进程树收尾做过专门处理 |

## 3. 升级与回滚

- **升级本项目**：`git pull && npm install && npm run prepare:plugin`，然后 `codex plugin remove … ` + `codex plugin add …`（或先清理 Codex 的插件缓存目录）。
  Codex 按插件**版本**缓存内容：同版本内容更新不会重新复制，因此更新后用 `npm version patch` 提升版本，或清理缓存。
- **升级 DSH 运行时**：改 `DSH_MCP_HARNESS_PACKAGE` 为新的精确版本 → 下次启动会安装到新的 `versions/<version>/`。
- **回滚**：把变量改回旧版本。注意安装成功后会**自动 prune**（P0-4）：非当前 pin 且未被在用服务引用的版本目录会被回收（每个约 486 MB），因此"旧目录天然留着"不再成立——需要随时回滚就设 `DSH_MCP_PRUNE_VERSIONS=off`，或先把旧版本目录复制到别处。prune 只在持有 `<dataDir>/versions/.install.lock` 时运行，且对"是否在用"无法确认时**一律不删**（当前 pin 永不删；Windows 上 `EBUSY` 只记入 `skipped`）。
- **清理**：`versions/` 由上述 prune 负责（返回 `prune {ran, reason, removed, skipped, reclaimedBytes}`，并在安装日志里输出一行摘要）；`services/<hash>/` 保存各工作区的会话数据，按需删除。残留的孤儿服务进程与端口由 `doctor.orphans` 报告（`state: alive | unverified | stale-pidfile`），下一次 `start_service` 会在证明身份后自动回收。

## 4. 排障矩阵

先跑 `doctor`（MCP 工具），它报告：本服务版本、Node 引擎是否满足、npm CLI 路径与是否存在、运行时包是否已安装及其版本/路径/占用、数据目录（`{path, source, exists, writable}`）、工作区策略、代理相关环境变量、以及被忽略的废弃变量。

**`doctor` 的顶层字段（20 个，与 README 中英由门禁双向锁定）**：`ready`、`problems`、`version`、`engines`、`nodeVersion`、`nodeSupported`、`platform`、`architecture`、`npmCli`、`runtimePackage`、`harnessPackage`、`dataDirectory`、`proxy`、`deprecatedEnv`、`apiKeyInEnvironment`、`allowedWorkspaceRoots`、`orphans`、`permission`、`contract`、`surface`。其中 `problems` 是"未满足前置条件 + 修法 + 提示性说明"的字符串数组，`dataDirectory` 是 `{path, source, exists, writable}`，`runtimePackage` 是 `{spec, installed, version, root, binPath, diskBytes, error}`，`orphans` 是 `{pid, port, serviceHome, state}[]`（`state ∈ {alive, unverified, stale-pidfile}`，存在孤儿只追加**提示性** `problems`，不翻转 `ready`），`permission` 是 `{mode, source, approval, advisory}`（见 §7），`contract` 是 `{dshLine, installedVersion, status, baselineDshLine, recordedVersions, differences, detail}`（契约版本矩阵判定，见 §8），`proxy` 只报告环境变量（`env`/`noProxy`），`deprecatedEnv` 列出已废弃但仍被设置的变量（例如 `DSH_MCP_NPX_COMMAND`）。新增字段若未同步 README/本文档，门禁会以 `tool-surface-drift` / 文档一致性断言报红。

**`doctor.ready` 的判据（四项制，语义不扩大）**：`ready` 只由**四项前置条件**决定——① Node 在引擎区间内；② npm CLI 可解析且存在（必须是 `npm-cli.js` 的绝对路径，不能指向 `npm.cmd`）；③ 数据目录可写（`dataDirectory.writable !== "no"`）；④ 运行时 spec 合法（`DSH_MCP_HARNESS_PACKAGE` 必须是精确版本）。`problems` 是字符串数组：**前置条件失败项 + 可操作的提示性条目**（当前唯一会追加提示的是**残留孤儿服务**——权限模式的提示**不在** `problems` 里，而是在 `permission.advisory`，因此它连 `problems` 都不会碰）。因此 `ready=true` 时 `problems` **可能非空**——判读请只看 `ready` 与前四类条目，不要用 `problems.length` 反推可用性。`dataDirectory` 的可写性是**真实探测**：只在目录**已存在**时"建临时文件→删除"，目录不存在时返回 `exists=false, writable="unknown"` 并提示"首跑安装时创建"——**探测本身绝不创建目录**（这条是 D-07 缺陷的教训：任何顺手建目录的行为都可能写到用户真实 home）。

**运行结果怎么读**（`get_run`/`wait_run`/`list_runs`/`start_run`/`cancel_run` 返回的 `RunSnapshot`）：

| 字段 | 取值 |
|---|---|
| `status` | `running` \| `succeeded` \| `failed` \| `cancelled`（**只有这四种**；不存在其他中间态出现在快照里） |
| `reason` | `failed` 时的失败原因：`auth` \| `transport` \| `service-unreachable` \| `protocol-drift` \| `rpc:<code>` \| `turn-blocked` \| `turn-truncated` \| `turn-aborted:<cause>` \| `turn-interrupted` \| `turn-unknown:<kind>`；非 `failed` 时为 `null` |
| `error` | `failed` 时的可读文本（含 `(code: X)`）；`succeeded`/`cancelled` 为 `null` |
| `cancelRequested` | 本地是否已请求取消 |
| `nextAction` | **由 `reason` 单向派生**的建议动作（闭集 6 值，见下表）；非 `failed` 时为 `none`。它是**建议**：本服务只自动执行其中唯一安全的一种（`auth` 换 cookie 重试一次） |
| `webUrlStale` | `true` 表示本次失败是 `service-unreachable`——**旧链接与旧 token 已失效**，恢复后必须重新 `start_service` 取新链接 |
| `finishedAt` | 终态写入时间；`running` 时为 `null` |
| `progress` | `{started, finished, current}`：**只含数字**的进度投影。`current` 为 `{turn, step, seq}` 或 `null`，来自**已录制实证**的 `step/start` 事件（`{turn, step}` + 每个 schema 都校验的 `seq`）。**刻意不包含**工具名/参数/命令/输出——录制夹具里 `step/start` 的 data 只有 `{turn, step}`，运行时工具名**无证据**，因此不投影（规则：拿不到证据就不猜字段） |
| 其余 | `runId`/`serviceId`/`sessionId`/`sessionReused`/`task`/`workspace`/`webUrl`/`startedAt`/`lastEventSeq`/`assistantText`（键集以本表为准；**不写死数字**——快照键**没有**中英双向门禁，硬编码计数会静默漂移） |

判读规则：**以 `status`/`reason` 为准，不要以"有没有 error 文本"判断失败**。`blocked`（回合被拒）与 `max-tokens`（输出被截断）都是 `failed`，不会伪装成 `succeeded`；`service-unreachable` 表示服务已死（用 `doctor` + 重新 `start_service` 恢复）；`protocol-drift` 表示 DSH 版本与适配层不匹配（**不要重试**，把方法与 JSON 路径报给维护者）；`cancelled` 是用户主动取消，不当失败上报。

**失败词典（`reason` → `nextAction` → 建议动作）**：开放形态（`rpc:*`、`turn-aborted:*`、`turn-unknown:*`）**一律** `report-only`——这类原因的具体语义未知，猜一个"重试"或"换会话"会把不确定性变成错误动作。

| `reason` | `nextAction` | 建议动作 |
|---|---|---|
| `auth` | `relogin` | 本服务已自动重换 cookie 一次；仍失败说明启动链接失效 → 重新 `start_service` 取新链接 |
| `transport` | `restart-service` | 传输层失败（已退避重试 ≤3 次）→ 确认服务仍在运行，必要时 `stop_service` + `start_service` |
| `service-unreachable` | `restart-service` | 服务进程已死 → 重新起服务；注意此时 `webUrlStale=true`，旧链接不可再用 |
| `protocol-drift` | `report-only` | **不重试**：DSH 版本或协议形状变了 → 报出错误里的方法名 + JSON 路径 |
| `rpc:<code>` | `report-only` | 服务端返回的其它 RPC 错误 → 报告原始码与消息 |
| `turn-blocked` | `new-session` | 回合在执行任何 step 前被拒 → 新会话重试，并补足约束（含权限模式，见 §7） |
| `turn-truncated` | `retry-narrower` | 输出达到 token 上限被截断 → **缩窄任务范围**再试；本服务**不自动**改 prompt（静默改变任务语义比失败更糟） |
| `turn-aborted:<cause>` | `report-only` | 被取消/父级终止等 → 报告具体 cause |
| `turn-interrupted` | `report-only` | 回合被中断（转向/接管等）→ 报告，由调用方决定是否新会话 |
| `turn-unknown:<kind>` | `report-only` | 从未见过的终态 → 报告原始 kind |
| 非 `failed`（`running`/`succeeded`/`cancelled`） | `none` | — |

| 症状 | 可能原因 | 处置 |
|---|---|---|
| `doctor.ready=false` | 看 `doctor.problems` 逐条：Node 不在区间 / npm CLI 缺失或非绝对路径 / 数据目录不可写 / `DSH_MCP_HARNESS_PACKAGE` 不是精确版本 | 按 `problems` 的文案逐条修正（`DSH_MCP_NPM_CLI` 必须是存在的绝对路径） |
| 启动报"版本不存在"（`ETARGET`/`E404`） | pin 的版本未发布 | 改 `DSH_MCP_HARNESS_PACKAGE`；**不要**重试 |
| 启动报 `ENOTCACHED` | 离线或缓存缺失 | 联网重跑一次（会自动安装），或预热 npm 缓存 |
| 启动超时（静默） | 子进程挂死、DSH_HOME 不可写、端口/配置异常 | 看错误里附带的脱敏日志尾；确认 `<数据目录>` 可写、磁盘有空间 |
| 运行停在 `running` 很久 | 任务确实很长，或服务已死 | 用 `get_run` 看 `lastEventSeq`/`assistantText` 是否在推进；服务死掉会被判 `failed(service-unreachable)`，不再长期悬挂 |
| 任务报 `failed(turn-blocked)` | 回合在执行任何 step 前被拒 | 换会话重试，或检查权限模式（`DSH_PERMISSION_MODE`） |
| 任务报 `failed(turn-truncated)` | 输出达到 token 上限被截断 | 缩小任务范围后重试 |
| 链接打不开 | 服务已停止 / 端口变化 / token 过期（服务重启后失效） | 重新 `start_service` 取新链接 |
| Windows 上工作区出现 ACL 标记 | `workspace-write` 在 Windows 的行为 | 对重要目录改用一次性 worktree，或用 `read-only` 处理审查类任务 |
| 代理环境启动异常 | 回环请求被代理带走 | 确认 `NO_PROXY` 含 `127.0.0.1,localhost`（`doctor.proxy` 会列出相关变量） |

## 5. 维护者验收清单

每次改动后按下表取证据（不接受"应该通过"）：

> **写权与生成物规则（踩过的坑）**：`skills/**`、`README*.md`、`assets/**`、`LICENSE` 是市场载荷的**事实源**——载荷里的对应文件由 `npm run version:sync` 从它们复制生成。因此**任何对这些文件的编辑都必须紧跟一次 `npm run version:sync`（或直接 `npm run prepare:plugin`）**，否则元数据门禁会以 `generated-drift` 报红，看起来像"别人的改动把测试弄红了"（P4 期间真实发生过一次误判：一人改了 `SKILL.md`、另一人正在跑 check）。同理，`src/version.ts`、`.mcp.json`、`.codex-plugin/plugin.json`、`plugins/deepseek-harness/**` 一律不得手工编辑。
>
> **测试隔离**：数据目录与 `DSH_HOME` 必须由组合根显式注入，测试统一走 `tests/support/**` 提供的临时目录；套件级守卫会断言用户真实默认数据目录的存在性在整轮测试前后未改变。若你看到真实 home 被写，那是缺陷而不是配置问题（见 `reports/fix-test-isolation.md`）。

| 检查 | 命令 | 通过标准 |
|---|---|---|
| **CI 门禁（默认，每个 PR）** | GitHub Actions `check.yml` | `windows-latest` 与 `ubuntu-latest` 上矩阵跑 `npm ci && npm run check`；Node 覆盖 22 与 24；失败即红 |
| **CI 门禁（手动）** | GitHub Actions `live-smoke.yml` | 仅手动触发：真实安装精确版 DSH + 启动 + 无 key 的 `turn/end` 失败路径；需网络与约 486 MB 磁盘，**失败不阻塞合并**（信息性）。该 workflow **故意不预建** `DSH_MCP_DATA_DIR`（`<workspace>\.verify-scratch\live-data`），以便让"首次运行创建数据目录"这条真实路径每次都在干净 runner 上被覆盖 |
| **CI 供应链（独立作业）** | GitHub Actions `check.yml` 的 `supply-chain` job | 与 `check` 矩阵**分开**，以保住 `check` 的"仅 `npm ci` 联网"密闭性。`npm audit --omit=dev --audit-level=high` 标 `continue-on-error`（可见**不阻塞**）；离线 `npm sbom --sbom-format=cyclonedx` 上传 artifact，该步**可以**让这个作业转红（lockfile 描述不出依赖属真实打包回归，是有意为之） |
| 类型/单测/契约/集成 + 元数据门禁 + 自包含探针 | `npm run check` | exit 0 |
| 打包内容 | `npm pack --dry-run` | 含 `dist/`、`.codex-plugin/`、`.mcp.json`、`skills/`、README、LICENSE |
| 插件载荷一致性 | `npm run check-metadata` | `OK (single source of truth: package.json@<ver>)` |
| 本地安装 | 见 §1 | 新任务里 `doctor` 报告版本 == `package.json` 版本；10 个工具可见 |
| 真实 DSH 链路（可选，需联网） | `DSH_LIVE=1` 的 live 套件 / 手工 smoke | 安装→启动→workspace/session 创建→无 key 时 `turn/end{kind:'error'}` 收敛为 `failed`→停止后端口释放 |
| 凭据泄漏 | 扫描日志与错误路径 | 不出现真实 token/cookie |

发布前额外确认：`CHANGELOG.md` 已记录外部可感知变更；`README` 双语与 `.mcp.json`/`plugin.json` 版本一致；`git status` 只含预期改动。

### 5.1 发布流程（有序，每步都要原始输出）

1. **确定变更与版本**：把外部可感知的改动按语义化版本写进 `CHANGELOG.md`（启动向量、配置新增/移除、`RunSnapshot`/`doctor` 字段、工具注解、`stopUnconfirmed` 之类）。版本号只在 `package.json` 改一处。
2. **同步派生**：`npm run version:sync` → 载荷、`.mcp.json`、`plugin.json`、`src/version.ts` 由生成器重写；确认输出是 `wrote N, unchanged M` 而不是手工改动残留。
3. **门禁**：`npm run check` → 必须 exit 0（含元数据双向校验、构建、自包含启动探针、README↔工具面门禁）。**注意**：`check` 的最后一步在 `build` 之后**再跑一次**元数据校验，这是刻意的——只在 build 前校验会让人为篡改被生成器"自动治好"。
4. **干净环境真实链路**：用一个**此前不存在**的目录作为 `DSH_MCP_DATA_DIR` 跑 live 套件。这一步必须覆盖"首次运行要创建数据目录 + 安装运行时"的真实路径；如果它是靠"目录已存在"才通过的，那是缺陷（曾真实发生，见 `reports/fix-acceptance-blockers.md`）。`npm run check:live` 有前置闸门：**未设 `DSH_LIVE=1` 时直接 exit 2** 并打印运行指引——不允许出现"跑 0 条用例却绿"的空跑（缺陷台账 D-06）。`DSH_MCP_DATA_DIR` 可不设，此时套件安装到系统临时目录。
5. **打包与第二条安装路径**：`npm pack` 出 tarball → 在临时目录 `npm install <tarball>` → 用包内 `.mcp.json` 的语义（`node ./dist/bin.mjs`，cwd 指向包根）启动，断言 10 个工具与 `serverInfo.version` 等于 `package.json` 版本。这是"从 registry 安装"在不发布前提下的等价验证；**registry 本身未被覆盖**，该缺口必须在验收报告里写明。
6. **本地路径**：`npm run prepare:plugin` 后按 §1 在 Codex 里以本地路径加载，确认 `doctor` 版本一致、10 个工具可见。
7. **卫生**：`git status` 只含预期改动；`plugins/**` 不在索引（生成物）；无真实凭据出现在 fixture/日志；跑完确认用户真实数据目录与 `~/.dsh` 未被改动。
8. **留档**：验收报告写入 `E:\AI\test\reports\`（本仓库不跟踪 `reports/`），并附原始命令与输出。

## 6. 数据与隐私

- 会话记录保存在 `<数据目录>/services/<workspace-hash>/`（DSH 自己的格式），属本机数据，不上传；项目自身不额外收集遥测（子进程遥测默认关闭）。
- 启动链接含本机 bearer token：只应出现在你与 Codex 的会话中；日志与错误输出已脱敏。
- API Key 只经环境变量或工作区 `.env` 传入 DSH，本项目不落盘、不写入会话记录。

## 7. 审批与权限模式（为什么任务会"停在 running"）

**事实**（来自 Harness 自身，不是本项目的假设）：`packages/bundle/base/cordis.patch.yml` 定义了

```yaml
permission:  mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
approval:    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"
presets:     workspace-write: { sandbox: workspace-write, approval: ask }
```

也就是说：**默认（`workspace-write`）会 `ask`**——凡需要写文件/执行命令的动作，Harness 先弹审批，而审批是 **gateway WS 流上的进程内 waterfall 事件（`approval/request`）**，浏览器里的 `ui-approval` 才能回答它。

**因此本项目的能力边界（如实）**：

- MCP 面**没有任何审批通道**：`session/page` 的会话事件词汇只有 `turn/start`、`step/start`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`——**`approval/request` 不写入会话日志**，读路径里"等待审批"没有一等信号。
- 唯一的形态相似物是"存在未配对的 `tool/call`（有调用、无结果）"，但它与"工具慢""进程已死"**不可区分**，所以本项目**不新增字段去猜**（猜出来的字段比没有更糟）。
- 结论：**任务是"真的在跑"还是"在等你点批准"，只能由 Harness 页面回答**。这也是 `doctor.permission.advisory` 存在的意义：让你在起服务之前就知道会发生什么。

**操作指引**

| 情形 | 怎么做 |
|---|---|
| 卡片长时间 `running`、`assistantText` 不再增长 | 打开 Harness 页面看是否有审批卡片；批准后同一会话继续（`get_run`/`wait_run` 会看到新事件） |
| 想避免人工介入（受控环境） | 显式 `DSH_PERMISSION_MODE=danger-full-access`（`doctor.permission.approval` 会变成 `never`，`advisory` 为 `null`） |
| 只读审查类任务 | `DSH_PERMISSION_MODE=read-only`：不需要写权限，通常不会触发审批 |
| 判断当前会怎样 | `doctor.permission = { mode, source, approval, advisory }`：`source=default` 表示"不是你设的，是默认值"；`advisory` 非空时逐字读它 |

> 本项目**不会**替用户批准权限请求，也**不会**把它包装成自动重试：静默批准等于把"用户授权"这件事悄悄删掉（这是 ADR-0003 的同一原则——宁可显式失败，不做猜测）。

## 8. 契约版本矩阵、漂移遥测与运行态恢复（R3）

### 8.1 契约版本矩阵：`doctor.contract`

本项目对 DSH wire 的适配是**按版本线声明**的，而不是"能跑就算兼容"：

| `status` | 含义 | 你该怎么做 |
|---|---|---|
| `exact` | 安装版本正是被录制过的那个 | 无需动作 |
| `compatible` | 同一版本线的另一个版本（只按已声明的差异套用） | 可用；若遇到未声明的漂移，`protocol-drift` 会带着方法名 + JSON 路径报出来 |
| `unknown` | 还没解析出任何版本（**首次安装前的正常状态**） | 无需动作——它**不是**失败，`ready` 不受影响 |
| `unsupported` | 该版本线的 wire **从未被录制** | `ready=false` + `problems` 给出版本线与 `DSH_MCP_HARNESS_PACKAGE`；换回已知版本，或按 §8.2 采集新版本线 |

判定是**纯函数**（`src/dsh/matrix.ts`），只有 `unsupported` 进入 `problems` 并影响 `ready`——`exact`/`compatible`/`unknown` 结构上进不去（有反向验证钉住这一点）。
录制夹具按版本线分档：`tests/fixtures/recorded/<dshLine>/` + `current.json` 指针（**只有一份录制集**，指针指向当前基线，不做复制）。

### 8.2 漂移遥测：`<数据目录>/logs/drift.jsonl`

协议形状不符合预期时，除了失败（`protocol-drift`，带方法名 + JSON 路径）之外还会落一条**指针级**记录，便于事后判断"是 DSH 换了字段，还是我们自己的解析错了"：

- 字段：`ts`、`kind`、`method`、`path`、`expected`、`gotType`、`pluginVersion`、`dshVersion`、`runId?`；
- **绝不含**：message 原文、token、cookie、prompt 文本、模型输出（载荷只以**类型名**离场，方法名走白名单，写盘前再过一次统一脱敏；有"把 token 塞进字段会红"的反向验证）；
- 目录由**第一条记录**按需创建（启用后从未漂移 → 目录不存在，不留空目录）；
- 关闭：`DSH_MCP_DRIFT_LOG=0`；写入失败静默降级，**不影响**运行。

### 8.3 运行态恢复：journal + 对账

MCP host 崩溃/重启后，Harness 侧那个回合可能仍在跑或已结束。为此每次运行都会在该工作区的服务目录下留一条 journal 记录（`services/<hash>/runs/<runId>.json`，`.tmp` + rename 原子写，`0600`），下一次工具调用/服务启动时对**非终态**记录做对账：

| 对账所见 | 结论 |
|---|---|
| 会话仍在跑（`session/list` + `projections` 的 `running === true`） | **收养**：保持 `running`，从 journal 的 `lastKnownSeq` 恢复进度（该值在快照里体现为 `lastEventSeq`） |
| 服务已死 | `failed(service-unreachable)`（快照同时 `webUrlStale: true`、`nextAction: restart-service`） |
| 会话已空闲**但日志里没有 `turn/end`** | `failed`，复用既有 fail-closed 规则（`turn-unknown:missing-turn-end`）——**绝不写成 `succeeded`** |

跨进程安全：`runs/.adopt.lock` 保证同一 `runId` 只被一个进程对账；**抢不到锁就整轮跳过**，不会替别人的运行写终态。对账是**唯一**写终态的路径（仍走 `settle()`，因此 `RunStatus` 不新增成员）。对账会扫描该数据目录下**所有**工作区的服务目录——否则崩溃的运行永远无人终结；安全性由"服务仍活则收养 + 持有者持锁则跳过"两条保证，而不是靠白名单。

**收养后的进度语义（别看错字段）**：journal 里存的是 `lastKnownSeq`，`RunSnapshot.lastEventSeq` 是它的对外投影。读取窗口是**左开右闭** `(startEventSeq, asOfSeq]`；收养**不改读取游标**（下一次 `refresh()` 仍从 `startEventSeq` 重读整个窗口，因此不会丢助手文本、也不会重复追加）。`lastKnownSeq` 是**单调高水位**（取 journal 记录、窗口最高 seq、`asOfSeq` 三者最大）——host 落后时保留旧值，**绝不凭空造进度**；它**不是**"从这条继续"的承诺。

**凭据落盘边界**：journal 的**非终态**记录允许保留完整 `webUrl`（此时 token 本就在生效，保留它换来收养后仍可点击）；**终态记录只留 origin + path**（已无用途的凭据不留在磁盘上）。逐条清单：

| 会含 token | 不会含 token |
|---|---|
| ① 非终态 journal（仅该运行存活期间）<br>② DSH 自身的数据（同目录、同信任边界）<br>③ 返回给调用方的 `RunSnapshot.webUrl`（登录链接，本来就是给用户点的） | ① 终态 journal（写盘 choke point + 读回净化双重保证）<br>② 日志、③ 错误文本、④ `doctor`/driver 输出、⑤ README/SKILL/docs/夹具 |

**残余风险（不粉饰）**：攻击者若能在**服务存活期间**读到那个非终态 journal 文件，就等于拿到一个有效 token——与直接读 DSH 自身数据等价。本次把窗口从"永久"缩到"运行存活期间"，**不是消除**。Windows 上没有 POSIX 位（实测 Node 报 `0666`），那里的保护依赖目录 ACL，`0600` 断言做成自校准；历史遗留的旧格式 journal 不会被自动改写，只在读回时净化。
