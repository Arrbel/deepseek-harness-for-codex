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

**`doctor` 的顶层字段（18 个，与 README 中英由门禁双向锁定）**：`ready`、`problems`、`version`、`engines`、`nodeVersion`、`nodeSupported`、`platform`、`architecture`、`npmCli`、`runtimePackage`、`harnessPackage`、`dataDirectory`、`proxy`、`deprecatedEnv`、`apiKeyInEnvironment`、`allowedWorkspaceRoots`、`orphans`、`surface`。其中 `problems` 是"未满足前置条件 + 修法"的字符串数组，`dataDirectory` 是 `{path, source, exists, writable}`，`runtimePackage` 是 `{spec, installed, version, root, binPath, diskBytes, error}`，`orphans` 是 `{pid, port, serviceHome, state}[]`（`state ∈ {alive, unverified, stale-pidfile}`，存在孤儿只追加**提示性** `problems`，不翻转 `ready`），`proxy` 只报告环境变量（`env`/`noProxy`），`deprecatedEnv` 列出已废弃但仍被设置的变量（例如 `DSH_MCP_NPX_COMMAND`）。新增字段若未同步 README/本文档，门禁会以 `tool-surface-drift` / 文档一致性断言报红。

**`doctor.ready` 的判据（四项制）**：`ready = problems.length === 0`，其中 `problems` 覆盖四类前置条件——① Node 在引擎区间内；② npm CLI 可解析且存在（必须是 `npm-cli.js` 的绝对路径，不能指向 `npm.cmd`）；③ 数据目录可写（`dataDirectory.writable !== "no"`）；④ 运行时 spec 合法（`DSH_MCP_HARNESS_PACKAGE` 必须是精确版本）。`problems` 是字符串数组，每项一条"未满足的前置条件 + 可操作修法"，`ready=true` 时为空数组。`dataDirectory` 的可写性是**真实探测**：只在目录**已存在**时"建临时文件→删除"，目录不存在时返回 `exists=false, writable="unknown"` 并提示"首跑安装时创建"——**探测本身绝不创建目录**（这条是 D-07 缺陷的教训：任何顺手建目录的行为都可能写到用户真实 home）。

**运行结果怎么读**（`get_run`/`wait_run`/`list_runs`/`start_run`/`cancel_run` 返回的 `RunSnapshot`）：

| 字段 | 取值 |
|---|---|
| `status` | `running` \| `succeeded` \| `failed` \| `cancelled`（**只有这四种**；不存在其他中间态出现在快照里） |
| `reason` | `failed` 时的失败原因：`auth` \| `transport` \| `service-unreachable` \| `protocol-drift` \| `rpc:<code>` \| `turn-blocked` \| `turn-truncated` \| `turn-aborted:<cause>` \| `turn-interrupted` \| `turn-unknown:<kind>`；非 `failed` 时为 `null` |
| `error` | `failed` 时的可读文本（含 `(code: X)`）；`succeeded`/`cancelled` 为 `null` |
| `cancelRequested` | 本地是否已请求取消 |
| `finishedAt` | 终态写入时间；`running` 时为 `null` |
| 其余 | `runId`/`serviceId`/`sessionId`/`sessionReused`/`task`/`workspace`/`webUrl`/`startedAt`/`lastEventSeq`/`assistantText` |

判读规则：**以 `status`/`reason` 为准，不要以"有没有 error 文本"判断失败**。`blocked`（回合被拒）与 `max-tokens`（输出被截断）都是 `failed`，不会伪装成 `succeeded`；`service-unreachable` 表示服务已死（用 `doctor` + 重新 `start_service` 恢复）；`protocol-drift` 表示 DSH 版本与适配层不匹配（**不要重试**，把方法与 JSON 路径报给维护者）；`cancelled` 是用户主动取消，不当失败上报。

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
