# DeepSeek Harness for Codex

<p align="center">
  <strong>简体中文</strong> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="./assets/icon.png" width="128" alt="DeepSeek Harness for Codex 图标">
</p>

DeepSeek Harness for Codex 让 Codex 在本地启动 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)，返回可点击的实时 Web 会话链接，将任务委派给它执行，并由 Codex 独立检查真实的工作区变更。

![DeepSeek Harness for Codex 演示](./imgs/examples.gif)

## 快速开始

除非你只需要独立的 MCP 服务，否则推荐安装 Codex 插件。插件会同时安装 MCP 工具和委派工作流，让 Codex 在 Harness 完成任务后独立验收结果。

### 1. 准备环境

- Node.js `^22.19.0 || >=24.0.0`，并包含随 Node 一同安装的 `npm`（首次安装 DSH 运行时包时使用）
- 支持插件的 Codex 客户端
- DeepSeek API Key

推荐把 API Key 放在目标仓库根目录中不提交到 Git 的 `.env` 文件里：

```dotenv
DEEPSEEK_API_KEY=your-key
```

不要提交这个文件。你也可以把 `DEEPSEEK_API_KEY` 注入启动 Codex 的环境，或者稍后在 Harness 页面中的 **Settings → Models** 配置。

### 2. 安装插件（推荐：本地路径）

本仓库根目录本身就是 Codex 插件（`.codex-plugin/plugin.json` + `.mcp.json` + `skills/`），
但 `dist/` 需要先构建 —— Codex 只复制文件，不会替你构建。因此先准备本地副本：

```sh
git clone https://github.com/Seann0824/deepseek-harness-for-codex.git
cd deepseek-harness-for-codex
npm install
npm run prepare:plugin
codex plugin marketplace add "$PWD"
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

Windows PowerShell 用 `codex plugin marketplace add (Get-Location).Path`。

`npm run prepare:plugin` 会执行完整的 `npm run check`（类型检查、测试、构建、元数据门禁），
并按 `package.json` 生成 `plugins/deepseek-harness/` 这份市场安装内容。**这一步不能跳过**：
跳过它市场会解析到一个没有 `dist/bin.mjs` 的插件目录。

本地路径安装的插件直接执行随插件一起交付的 `dist/bin.mjs`（`node ./dist/bin.mjs`），
不经过 `npx`，因此不依赖任何已发布的 npm 版本。

### 可选：从 npm 源安装

只有当 registry 上确实存在与本仓库匹配的版本时才使用这条路径（包名并非本仓库独有，
registry 上的公开版本可能落后于本仓库；本仓库当前版本见 `package.json`）。
从 npm 源安装要求 `.agents/plugins/marketplace.json` 的 `source` 指向已发布的包，
因此它**不是本仓库开箱可用的路径**，需要先完成两件事：把插件发布到你方能控制的包名
（见 `docs/decisions/ADR-0001-distribution-and-version-ssot.md` 的「未决点」），
再把 marketplace 的 `source` 从本地路径改为该包。改完后使用：

```sh
codex plugin marketplace add <你方 marketplace 仓库或包名>
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

**不要**直接对 `Seann0824/deepseek-harness-for-codex` 使用 `marketplace add --ref main`：
该仓库的市场载荷 `plugins/deepseek-harness/` 是构建产物且未提交，克隆出来是空的，
插件安装会失败。以 git 源分发时需要先在克隆里执行 `npm install && npm run prepare:plugin`
（即上面的 canonical 路径），或者改用「生成产物一并提交」的分发形态。

### 本地副本（canonical）与 git 源的取舍

`plugins/deepseek-harness/` 是 `npm run version:sync` 从 `package.json` 生成的产物，因此被
`.gitignore` 忽略：**提交一份生成副本等于制造第二份版本事实**（本仓库历史上正是这样出现了
0.3.1 与 0.4.0 并存的静默降级）。代价是 git 源安装必须先在克隆里准备一次。若将来希望
「克隆即可安装」，把该目录改成生成后一并提交即可 —— 门禁同样会逐字节校验它，不会重新引入漂移。

在 macOS 上，如果找不到 `codex`，或者其他全局安装覆盖了桌面客户端的命令，请直接使用客户端内置的可执行文件：

```sh
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex"
"$CODEX_APP_BIN" plugin marketplace add "$PWD"
"$CODEX_APP_BIN" plugin add deepseek-harness@deepseek-harness-for-codex
```

### 3. 新建 Codex 任务

插件会在新任务启动时加载。安装完成后新建一个 Codex 任务，并要求它使用 DeepSeek Harness，例如：

> 使用 DeepSeek Harness 在可见的本地会话中实现这个需求。不要自动打开浏览器，把 Harness 实时页面链接发给我；完成后由你检查 diff 并运行相关测试。

Codex 会在本地启动 Harness，在空闲的回环端口提供 Web 页面，返回可点击链接，提交任务并跟踪同一个可见会话，最后独立验收结果。浏览器不会自动打开；需要查看过程时，由你点击 Codex 消息中的链接。你不需要手动启动 Harness，也不需要另外注册 MCP 服务。

首次运行只会下载固定的 Harness 运行时包（`@deepseek-ai/dsh`），MCP 服务本身随插件一起交付，
不会再从 registry 拉取本仓库的包。

## 从旧名称迁移

项目已从 `deepseek-harness-mcp` 更名为 `deepseek-harness-for-codex`。如果安装过旧版插件，请先移除旧插件和旧市场，再按照上面的“安装插件”重新安装：

```sh
codex plugin remove deepseek-harness-mcp@deepseek-harness
codex plugin marketplace remove deepseek-harness
```

旧版 npm 包不会自动替换为新包。默认数据目录仍保留为 `~/.deep-seek-harness-mcp`，因此重新安装后可以继续使用原有的本地 Harness 设置和会话。

## 更新

刷新插件市场并重新安装插件，然后新建一个 Codex 任务：

```sh
codex plugin marketplace upgrade deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

## 卸载

```sh
codex plugin remove deepseek-harness@deepseek-harness-for-codex
codex plugin marketplace remove deepseek-harness-for-codex
```

## 独立安装 MCP

仅当你只需要 MCP 工具、不需要插件的委派工作流和 Codex UI 入口时使用。本地路径（不依赖发布）：

```sh
codex mcp add deepseek-harness -- node /absolute/path/to/deepseek-harness-for-codex/dist/bin.mjs
```

只有确认 registry 上确实存在**与本仓库匹配**的发布版本时，才可以改用 npm 源（把 `<已发布的匹配版本>` 换成该精确版本，不要用 `@latest`：registry 上的 `latest` 完全可能落后于本仓库，拉到的是行为不同的旧实现）：

```sh
codex mcp add deepseek-harness -- npx --yes --package=deepseek-harness-for-codex@<已发布的匹配版本> -- deepseek-harness-for-codex
```

注册完成后新建一个 Codex 任务。

## 工作原理

插件直接以 `node ./dist/bin.mjs` 启动随插件一起交付的 MCP 服务（不使用 `npx`，因此不存在"装了插件却拉到旧版本"的静默降级）。某个工作区首次运行任务时，MCP 服务会先把精确版本的 DSH 运行时安装到 `<DSH_MCP_DATA_DIR>/versions/<版本>/`（一次性前置成本），再以 `node <该目录>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0` 在本地回环地址启动，避免 DSH 自行打开浏览器。Codex 通过当前 Harness Web API 创建工作区和会话，并把对应 URL 作为可点击链接发给用户；服务内部会用 DSH 的启动链接换取本机 API 所需的认证 cookie。链接含有本机登录 token，请勿公开转发。后续任务会复用该本地服务，不会通过托管中转服务执行。

每次运行都是异步任务：

1. Codex 使用绝对工作区路径和完整任务调用 `start_run`。
2. MCP 服务启动或复用 Harness Web（首次会先完成上面那次一次性运行时安装），提交可见会话，并向 Codex 返回页面链接。
3. Codex 展示可点击链接；用户需要时手动打开，同时 Codex 通过 `wait_run` 或 `get_run` 跟踪同一会话。
4. Codex 检查实际 diff，并运行自己的验证流程。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `doctor` | 检查 Node 引擎区间、npm CLI、运行时包安装状态、代理变量、凭据可见性、数据目录和工作区限制；只报告，不安装、不下载。 |
| `start_service` | 为工作区启动或复用 Harness Web，并返回页面链接；默认不打开浏览器。 |
| `open_service` | 在用户明确要求时打开正在运行的 Harness 页面。 |
| `list_services` | 列出本地 Harness Web 服务及其 URL。 |
| `stop_service` | 停止 Harness Web 服务。 |
| `start_run` | 由 Codex 选择创建新会话或继续已完成的会话，然后提交任务。 |
| `wait_run` | 等待可见会话，单次最多 30 秒。**可重复调用且无副作用**：已结束的运行反复调用仍返回同一终态快照；超时返回**当前**快照而不是失败。 |
| `get_run` | 读取 Web 会话状态和助手输出。 |
| `list_runs` | 列出当前 MCP 服务进程创建的运行记录。 |
| `cancel_run` | 取消当前 agent turn，同时保留 Web 服务。 |

`start_service` 和 `start_run` 的 `openBrowser` 默认值都是 `false`，插件也会明确传入 `false`。Codex 应把返回的 `webUrl` 渲染成可点击链接；只有用户明确要求 Codex 代为打开时，才使用 `open_service`。

运行状态与失败原因（`RunSnapshot`）：

- `status` 只有四值：`running` / `succeeded` / `failed` / `cancelled`。**只有 `completed` 回合算 `succeeded`。**
- `reason` 仅在 `failed` 时非空，用来说明**为什么**失败：`auth`（凭据失效且重换一次后仍失败）、`service-unreachable`（连接不上/服务中途消失）、`protocol-drift`（Host 的回答不符合契约，含方法与 JSON 路径）、`rpc:<code>`（Host 报的业务错误码）、`turn-blocked`（回合在任何 step 前被拒）、`turn-truncated`（输出被 token 上限截断）、`turn-aborted:<cause>`（被 parent/hook/disposed/legacy 中止）、`turn-interrupted`（崩溃后合成）、`turn-unknown:<kind>`（本项目不认识的原因，一律按失败处理）。
- 取消语义：用户主动取消（`cancel_run` 或 Web UI）收敛为 `cancelled`；`aborted` 且原因是 `user` 也算取消。`blocked` 与 `max-tokens` 现在都是 `failed`（旧版本会误报成功）。
- 任何失败路径都会落到终态（含凭据失效、服务被杀、契约漂移）：不会出现"停在 `running` 只留一条 error"的运行。
- `nextAction`：由 `reason` **单向派生**的下一步动作，闭集六值——`new-session`（换一个新会话重跑：`turn-blocked`，回合在任何 step 前被拒，`blocked` 什么都没产出，缩窄没有对象）、`retry-narrower`（把任务缩窄再试：`turn-truncated`，产出被 token 上限截断）、`restart-service`（重启服务再试：`service-unreachable` / `transport`）、`relogin`（重新 `start_service` 换凭据：`auth`）、`report-only`（只上报、不猜动作：`protocol-drift`、`turn-interrupted`，以及**全部开放形态** `rpc:<code>` / `turn-aborted:<cause>` / `turn-unknown:<kind>`）、`none`（`reason` 为空，即 `running` / `succeeded` / `cancelled`）。开放形态**一律** `report-only`：本项目不认识的失败原因不允许被猜成一个具体动作。`turn-interrupted` 同属"不猜"：它是 DSH 对已持久化日志的**崩溃恢复**（缺失的 step/end、turn/end 由合成事件补齐），恢复后会**继续使用同一个会话**，因此"旧会话不可用"不是我们验证过的事实。
- `webUrlStale`：**仅**当 `failed(service-unreachable)` 时为 `true`。**服务重启后端口会重新分配、launch token 也会轮换，旧链接随即失效**——此时不要复用旧的 `webUrl`，请重新调用 `start_service` 取新链接。

**默认权限模式需要人工审批**：默认 `DSH_PERMISSION_MODE=workspace-write` 会映射为 `approval: ask`（见 `packages/bundle/base/cordis.patch.yml`）——需要写文件/执行命令的动作会在 Harness 页面等你点批准，而 MCP 面**无法替你回答审批**。此时从 Codex 视角看它只是一个长时间 `running`。请在页面完成批准，或在受控环境显式使用 `DSH_PERMISSION_MODE=danger-full-access`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_MCP_DATA_DIR` | `~/.deep-seek-harness-mcp` | 数据目录：其下 `versions/<版本>/` 存放本地安装的 DSH 运行时包，`services/<工作区哈希>/` 保存各工作区的 DSH_HOME（会话与设置）。 |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.2.1-alpha.1` | 本地 Harness 运行时使用的**精确** npm spec（必须写成 `name@x.y.z`）。range（`^`/`~`/`>`/`x`/`*`）与 dist-tag（`latest`/`next`）会被**拒绝**：registry 上的 `latest` 低于本项目使用的版本线，解析 range 只会静默降级。 |
| `DSH_MCP_NPM_CLI` | 由 `process.execPath` 推导 | `npm-cli.js` 的**绝对路径**。npm 始终以 `node <该文件> install …` + `shell:false` 调用（不经过 `npm.cmd`，因此没有 shell 注入面）；只有自动推导失败时才需要手动设置，相对路径或文件不存在会立即报错。 |
| `DSH_MCP_INSTALL_TIMEOUT_MS` | `900000` | 运行时包的一次性安装预算；与启动预算相互独立（安装进度输出会重置它）。 |
| `DSH_MCP_STARTUP_TIMEOUT_MS` | `180000` | 启动到打印 URL 的**静默**预算：子进程每产生一行输出就重置，有进展不算超时，只有完全静默才失败。 |
| `DSH_MCP_WORKSPACE_ROOTS` | 不限制 | `start_run` 允许使用的绝对根目录列表，使用当前平台的路径分隔符。 |
| `DSH_PERMISSION_MODE` | `workspace-write` | DSH 权限模式。**默认值会映射为 `approval: ask`**：需要写文件/执行命令的动作会在 Harness 页面等人工批准，而 MCP 面无法代答（见 `docs/operations.md` §7）。`read-only` 用于审查类任务；只有 `danger-full-access` 会变成 `approval: never`，必须由调用方显式传入。`doctor.permission` 会报告实际生效的模式、来源与审批策略。 |
| `DSH_TELEMETRY_DISABLED` | `1` | 传给 Harness 子进程；默认关闭遥测。 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 未设置 / 服务商默认值 | 可选的 DeepSeek 凭据与兼容 API 地址。 |
| ~~`DSH_MCP_NPX_COMMAND`~~ | **已移除** | 启动向量不再使用 npx。若环境里仍然设置，`doctor` 会报告它「已废弃且被忽略」并给出迁移提示。 |

数据目录布局与首跑成本：

```text
<DSH_MCP_DATA_DIR>/
├─ versions/
│  └─ <DSH 版本>/                      # 本地安装的运行时包（约 486 MB/版本，可枚举清理）
│     └─ node_modules/@deepseek-ai/dsh/lib/bin.js
└─ services/<工作区哈希>/               # 该工作区的 DSH_HOME（会话、设置、凭据引用）
```

首次使用某个 DSH 版本时，服务先执行一次 `node <npm-cli.js> install --prefix <临时目录> … <精确 spec>`，成功后把临时目录**原子改名**为 `versions/<版本>/`；随后启动一律是 `node <bin> web --no-open --port 0`（`shell:false`），**不再调用 npm、不需要网络**。安装是一次性前置成本（约 1 分钟，主要是 486 MB 落盘；暖 npm 缓存下实测 54 秒 / 486.1 MB），因此走独立的 900 秒预算，永远不计入启动预算。启动本身分三种情形：**已安装、但 DSH 家目录为空（真冷启）约 20–30 秒**（实测 22.7 秒；独立验收实测 29.4 秒），**DSH 家目录已预热后约 4 秒**（实测 3.8–4.1 秒），复用已安装的运行时是毫秒级（不重复下载）。

Harness 子进程默认关闭遥测。Web 服务只绑定回环地址并自动选择空闲端口。会话数据保留在配置的数据目录中，便于本地审计。

`doctor` 字段口径（与上表一一对应）：

| 字段 | 含义 |
| --- | --- |
| `version` | **本 MCP 服务**的版本（当前即 `package.json` 的版本）。 |
| `engines` | `{range, nodeVersion, supported, source}`，区间由本项目自带。 |
| `runtimePackage` | `{spec, installed, version, root, binPath, diskBytes, error}`，即上表 `DSH_MCP_HARNESS_PACKAGE` 解析后的运行时状态；`error` 非空表示 spec 非法。 |
| `harnessPackage` | `runtimePackage.spec` 的别名，语义是"**要安装并启动的** DSH 运行时 spec"（= `DSH_MCP_HARNESS_PACKAGE` 的当前取值）；它**不是**本服务的版本，本服务版本看 `version`。 |
| `npmCli` | `{path, source, exists}`，即上表 `DSH_MCP_NPM_CLI` 的解析结果与命中来源（不读 PATH）。 |
| `dataDirectory` | `{path, source, exists, writable}`。`source` ∈ `DSH_MCP_DATA_DIR`/`PLUGIN_DATA`/`default`（说明这个路径是谁定的）；`exists` 为假时 `writable` 必为 `unknown`。目录**已存在**时才做一次"建临时文件→删除"的真实探测（`yes`/`no`）；目录不存在时返回 `unknown` 且**不会创建它**（首跑安装时才创建）。 |
| `proxy` | `{env, noProxy}`，只报告不判断。 |
| `deprecatedEnv` | 仍被设置但已废弃、且被忽略的变量（如 `DSH_MCP_NPX_COMMAND`）。 |
| `ready` | `engines.supported && npmCli.exists && dataDirectory.writable !== "no" && runtimePackage.error === null`。**只看这四项**：报告项（例如 `orphans`、`permission`）不会改变它。不安装、不下载、不探测网络。 |
| `problems` | `string[]`：每项包含"一条问题 + 照着做就能修的说明"。两类内容：① 四项前置条件不满足（Node 不在区间 / npm CLI 找不到或不是绝对路径 / 数据目录不可写 / 运行时包 spec 非法）——这类必然让 `ready=false`；② **提示性**问题（例如检测到孤儿服务进程）。**空数组表示没有任何问题**，`ready=false` 时条目 ① 必非空。细节层仍是 `runtimePackage.error`。 |
| `orphans` | `Array<{pid, port, serviceHome, state}>`：上一次运行留下的服务状态（`<数据目录>/services/<key>/dsh.pid`）。`state`：`alive`＝进程仍活且**已确认是我们启动的那一个**（命令含我们的 `lib/bin.js` 与 `--port`）；`unverified`＝进程仍活但**身份无法确认**（绝不会按 pid 盲杀，PID 复用会误杀用户进程）；`stale-pidfile`＝pidfile 存在但进程已退出或文件损坏。无孤儿时为 `[]`。下一次 `start_service` 会自动回收已确认的孤儿，回收不成功时如实保留证据。 |
| `nodeVersion` / `nodeSupported` | 当前 Node 版本，以及它是否落在支持区间（`engines` 的扁平副本，便于一次性判断）。 |
| `platform` / `architecture` | 运行平台与架构（如 `win32`/`darwin`/`linux` 与 `x64`/`arm64`）。 |
| `apiKeyInEnvironment` | 宿主环境里是否可见 `DEEPSEEK_API_KEY`：**只报告布尔值**，既不读取也不回显其内容。 |
| `allowedWorkspaceRoots` | `DSH_MCP_WORKSPACE_ROOTS` 的解析结果：**未配置时为 `[]`**（空数组就是"不限制"的表示，不是 `null`）；配置后为按平台分隔符切分出的根路径数组（合法性仍在 `start_run` 时按工作区策略校验）。 |
| `permission` | `{mode, source, approval, advisory}`：下一次启动 Harness 会用到的权限模式。`source`：`env`（你显式设了 `DSH_PERMISSION_MODE`）或 `default`（未设置 → `workspace-write`）；`approval`：按 DSH 自身策略推导（只有 `danger-full-access` 是 `never`，其余都是 `ask`）；`advisory`：`ask` 时给出可操作说明（需要人工在 Harness 页面点批准，MCP 面无法代答），`never` 时为 `null`。**它是报告项，不是前置条件**：不会改变 `ready`。 |
| `surface` | 本服务提供的交互面，当前恒为 `web`。 |

## 排障

先调用 `doctor`。它不安装也不下载任何东西，会报告：Node 引擎区间（`^22.19.0 || >=24.0.0`，由本项目自带，因为发布的 `@deepseek-ai/dsh` 没有 `engines` 字段）、npm CLI 的实际路径与来源、运行时包是否已安装（版本 / 路径 / 占用空间）、数据目录、代理变量（只报告不判断），以及已废弃的环境变量。

**安装失败**：错误信息会带上 `npm error code …` 的 stderr 尾、运行时包路径与可操作建议。按错误码处理：

| npm 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `ETARGET` / `E404` | 该版本在 registry 上不存在（**不会重试**） | 核对 `DSH_MCP_HARNESS_PACKAGE`：`node <npm-cli.js> view <包名> versions` |
| `ENOTCACHED` | 本地 npm 缓存里没有该包（离线或未预热） | 联网一次，或预热缓存：`node <npm-cli.js> cache add "<spec>"` |
| 其他（网络 / registry） | 归类为网络问题，会**自动重试一次** | 检查代理与镜像（`npm_config_registry`、`HTTPS_PROXY`），必要时用 `DSH_MCP_NPM_CLI` 指定可用的 npm |

想提前预热、避免首跑等待，可以直接把包装到版本目录：

```sh
node "<npm-cli.js>" install --prefix "<DSH_MCP_DATA_DIR>/versions/<版本>" --no-save --no-audit --no-fund "@deepseek-ai/dsh@<版本>"
```

**启动超时**：预算按「静默」计算，失败信息里同时给出脱敏后的 Harness 日志尾、运行时包路径和 npm stderr 尾。若日志显示进程在反复输出但没有 `dsh web: http://…`，调大 `DSH_MCP_STARTUP_TIMEOUT_MS` 或检查 DSH_HOME 是否可写；若日志完全为空，用 `doctor` 确认运行时包与 npm CLI 是否可用。

## 安全模型

`start_run` 是可写工具。服务端要求工作区必须是已存在的绝对路径（会解析符号链接），并可通过 `DSH_MCP_WORKSPACE_ROOTS` 限制允许访问的根目录。复用已有会话时，Host 必须报告该会话的 `cwd` 且与本工作区一致——**无法证明归属就拒绝复用**（fail-closed），而不是放行。

凭据只有**一个**有意出口：返回给调用方的登录 URL（它就是你要点击的本地通行证）。除此之外的所有出口——启动/就绪日志尾、错误文本、服务与运行快照、`doctor` 输出、全部工具结果——都经过统一脱敏（token 与 cookie 值替换为 `[redacted]`），工具结果在 MCP 边界还会再扫一遍；cookie 值不会出现在任何输出里。全出口扫描测试（`tests/security-exits.test.ts`）会在任何一处泄漏时变红。

只与回环地址通信：启动 URL 若不是回环（`127.0.0.0/8`、`::1`、`localhost`）就拒绝用它换取凭据；回环请求不经过环境代理（把 `HTTP_PROXY` 指向死地址仍能正常工作）。启动 Harness 时使用 `process.execPath` + 已安装包的 `lib/bin.js`，全程 `shell: false`（不再有 `npx.cmd`/`cmd.exe` 这一层），npm spec 必须是精确版本号，因此不存在可被 shell 解释的外部输入。默认权限模式是 `workspace-write`。Windows 上 DSH 的 `workspace-write` 可能在工作区留下持久 ACL 标记；需要跨工具共享的代码库建议使用一次性 worktree，并避免对重要目录直接启用写权限。

与 Host 的契约只要求"我们真正读取的字段"存在且类型正确（例如 `session/list#cwd`、`turn/end#reason`）：缺失或类型不符视为协议漂移并 fail-closed；额外字段一律允许，因为那是协议演进的方式。

## 会话模型

每次调用 `start_run` 时，Codex 都可以选择会话。省略 `sessionId` 会创建新的可见 Harness 会话；传入之前已完成运行返回的 `sessionId`，会继续原有对话，并且只返回本轮新增输出。运行中的会话不能被并发复用。本地 Web 服务会持续复用，直到调用 `stop_service` 或 MCP 服务退出。

## 版本与元数据（单一事实来源）

`package.json` 的 `name`/`version` 是**唯一**版本事实，其余全部由脚本派生：

| 文件 | 来源 |
| --- | --- |
| `src/version.ts` | `npm run version:sync` 生成（文件头标注 generated，禁止手改） |
| `.mcp.json`、`.codex-plugin/plugin.json` | 同上，版本取自 `package.json` |
| `plugins/deepseek-harness/**`（市场安装内容） | 同上；该目录**已加入 `.gitignore`**，只在上一步生成 |
| README / SKILL 中的版本描述 | 不写死版本号，因此不会漂移（门禁会拒绝任何硬编码的版本钉） |

```sh
npm run version:sync     # 重新生成（写入）
npm run version:check    # 只校验、不写盘，列出漂移项与期望值
npm run check-metadata   # 打包门禁：版本一致性 + files 白名单 + 启动方式 + 插件载荷
npm run prepare:plugin   # 构建 + 生成 + 全量 check（本地安装插件前必跑）
```

`npm run check` 已包含元数据门禁，任一处版本、`files` 白名单、启动方式或生成的插件载荷被改动，
`check` 都会失败并指出期望值。之所以选择"生成 + 忽略"而不是"提交后再同步"：
两份提交的文件必然再次发散（这正是本仓库曾经跑在旧版本上的原因），
而生成物一旦被忽略就不可能在 git 里变成第二个版本事实。

## 本地开发

克隆仓库、构建并生成插件内容，然后把当前仓库的绝对路径作为本地插件市场添加到 Codex：

```sh
npm install
npm run prepare:plugin
codex plugin marketplace add /absolute/path/to/deepseek-harness-for-codex
codex plugin add deepseek-harness@deepseek-harness-for-codex
```

插件执行的是本仓库生成的 `plugins/deepseek-harness/dist/bin.mjs`，**不需要**再手工改 `.mcp.json`
指向绝对路径。注意两点：

- Codex 会把插件文件复制到自己的缓存目录，并按插件版本分目录缓存；改完内容后需要重新执行
  `npm run prepare:plugin`，并提升 `package.json` 的 `version`（或清理缓存目录）才会重新复制。
- 修改 `plugins/deepseek-harness/` 下的任何文件都不会被保留：它在下一次 `build`/`prepare:plugin`
  时被重新生成，并被门禁判为多余文件。

## 发布 npm 包

本仓库将无 scope 的公共包 `deepseek-harness-for-codex` 发布到 npm 官方 registry。`npm publish` 会自动执行类型检查、测试、构建和元数据门禁。发布包包含 `dist/`（自包含 bundle，内联运行时依赖）、`.codex-plugin/plugin.json`、`.mcp.json`、`skills/`、中英文 README、演示 GIF 和 `LICENSE`。

登录并确认 npm 账号：

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

检查发布内容、发布并验证可执行文件：

```sh
npm run release:check
npm publish
npm view deepseek-harness-for-codex version --registry=https://registry.npmjs.org/
VERSION=$(npm view deepseek-harness-for-codex version --registry=https://registry.npmjs.org/)
npx --yes --package="deepseek-harness-for-codex@$VERSION" -- deepseek-harness-for-codex
```

npm 版本不能被覆盖。发布新版本时**只需**改 `package.json`，其余版本引用由生成器派生：

```sh
npm version patch          # 或 minor / major：只改 package.json 与 package-lock.json
npm run prepare:plugin     # 重新生成 src/version.ts、.mcp.json、插件清单与市场内容
npm publish
```

不要手工编辑 `src/version.ts`、`.mcp.json`、`.codex-plugin/plugin.json` 或 `plugins/deepseek-harness/**`；
`npm run check` 会检出并报错。
