# 配置参考（冻结）

本文是环境变量与数据目录布局的**权威契约**。实现与本文冲突时，先改本文（走 ADR），再改实现。
冻结日期：2026-10-08（随 ADR-0002 落地生效）。

## 1. 环境变量

| 变量 | 默认值 | 语义 | 变更记录 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 未设置 | 透传给 DSH 的模型凭据。也可放在目标工作区未提交的 `.env`，或在 Harness 页面 **Settings → Models** 配置。 | 不变 |
| `DEEPSEEK_BASE_URL` | 服务商默认 | 可选的 DeepSeek 兼容 API 地址。 | 不变 |
| `DSH_MCP_DATA_DIR` | 见下方优先级 | 数据根目录，见 §2 布局。优先级：`DSH_MCP_DATA_DIR` → `PLUGIN_DATA`（宿主插件数据目录约定，若宿主设置了它，就绪状态与运行时都放在宿主管理的目录下）→ `~/.deep-seek-harness-mcp`。解析只发生在组合根，service 层不接受隐式默认（见 §2 末）。 | 不变（优先级显式化） |
| `DSH_MCP_WORKSPACE_ROOTS` | 未设置 = 不限制 | `start_run` 允许的绝对根目录列表，按当前平台路径分隔符（Windows `;`）。 | 不变 |
| `DSH_MCP_HARNESS_PACKAGE` | `@deepseek-ai/dsh@0.2.1-alpha.1` | 要安装并启动的 DSH 运行时，**必须是精确版本**（`name@x.y.z[-tag]`）。range（`^`/`~`/`>`/`*`）、tag（`latest`）与省略版本一律拒绝并给出可操作提示。 | 语义收紧（ADR-0002） |
| `DSH_MCP_NPM_CLI` | 由 `process.execPath` 推导 | npm CLI **入口 js 的绝对路径**，用于 `node <npmCli> install …`。文件不存在即失败并提示。 | 新增 |
| `DSH_MCP_INSTALL_TIMEOUT_MS` | `900000`（15 分钟） | 运行时包安装预算。一次性前置步骤，独立于启动预算。 | 新增 |
| `DSH_MCP_STARTUP_TIMEOUT_MS` | `180000`（3 分钟） | 子进程启动到打印 `dsh web: <url>` 的预算；**每产生一行输出即重置**：有进展不算超时，静默挂死才失败。 | 替代旧的固定 120 s |
| `DSH_MCP_PRUNE_VERSIONS` | 启用 | 安装成功后是否回收非当前 pin 且未被在用服务引用的 `versions/<version>/` 与超期 `.tmp-*`。`off`/`0`/`false`/`no`/`disabled` 关闭（关闭后旧版本目录永久保留，便于随时回滚）。该变量已列入 `.mcp.json` 的 `env_vars` 白名单，宿主可透传。 | 新增（P0-4 / R2-7 归口） |
| `DSH_MCP_DRIFT_LOG` | 启用 | 协议漂移遥测：写 `<数据目录>/logs/drift.jsonl`（**只记录指针**：`ts/kind/method/path/expected/gotType/pluginVersion/dshVersion/runId?`，**不含** message 原文、token、cookie、prompt 或模型输出）。`0`/`off`/`false`/`no`/`disabled` 关闭。`logs/` 目录**由第一条记录按需创建**；写入失败静默降级，绝不影响运行。 | 新增（R3-2） |
| `DSH_MCP_RUN_LIMIT` | `4` | **每进程**同时处于非终态的运行上限（跨工作区；**同一数据目录的单个 MCP 进程内**，同一工作区只允许一个）。越界**拒绝**而不是排队：调用方拿到带占位明细的可操作错误，**不产生运行记录**（因此没有 `queued` 状态，`RunStatus` 语义不变）。`settle()` 到终态即释放槽位；对账收养的运行同样占位。**上限与工作区串行都是进程内的**：多进程各自 N 且各自串行（跨进程共享额度本轮**不做**；跨进程的安全约束来自"每工作区一个服务"的结构与 `runs/.adopt.lock`）。已列入 `.mcp.json` 的 `env_vars` 白名单。 | 新增（R3-4） |
| `DSH_PERMISSION_MODE` | `workspace-write` | DSH 权限模式。**默认值会映射为 `approval: ask`**：需要写文件/执行命令的动作会在 Harness 页面等人工批准，而 MCP 面无法代答（见 `docs/operations.md` §7）。`read-only` 用于审查类任务；只有 `danger-full-access` 会变成 `approval: never`，必须由调用方显式传入。`doctor.permission` 会报告实际生效的模式、来源与审批策略。 | 语义补充（R2-3） |
| `DSH_TELEMETRY_DISABLED` | `1` | 子进程遥测默认关闭。 | 不变 |
| `DSH_MCP_NPX_COMMAND` | — | **已废弃**：不再参与启动（启动不再经过 npx/shell）。若仍设置，`doctor` 会在 `deprecatedEnv` 中报告"已废弃且被忽略"。 | 移除 |

Node 引擎要求由本项目自带：`^22.19.0 || >=24.0.0`（`doctor.engines` 会报告当前是否满足）。
之所以自己维护：已发布的 `@deepseek-ai/dsh` 包里**没有** `engines` 字段（实测），npm 不会替我们拦住不兼容的 Node。

## 2. 数据目录布局

```
<DSH_MCP_DATA_DIR>/
  versions/
    <version>/                      # 每个 DSH 运行时版本一个目录（约 486 MB）
      node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}
    .install.lock                   # 安装互斥（跨进程）
    .tmp-<random>/                  # 安装中；成功后原子 rename 为 <version>/
  services/
    <workspace-hash>/               # 每个工作区的 DSH_HOME（profiles/、sessions/、storages/、.credentials.yaml）
      dsh.pid                       # 该工作区 Harness 服务的进程记录（pid/port/version/binPath/workspace/…）
```

要点：

- **安装与启动解耦**：`versions/<version>/` 存在且版本匹配时，启动**不触网、不调用 npm**。首跑的一次性成本（实测约 1 分钟、约 486 MB）因此不会计入就绪预算。
- **版本可并存**：切换 DSH 版本等于换目录（改 `DSH_MCP_HARNESS_PACKAGE`）。安装成功后会运行一次 `prune`：**非当前 pin 且未被在用服务引用**的 `versions/<version>/`（每个约 486 MB）会被回收，超过 24 小时的 `versions/.tmp-*` 同样回收。要保留旧版本以便随时回滚，设 `DSH_MCP_PRUNE_VERSIONS=off`，或先把目录复制到别处（见 §1 的环境变量表与 `docs/operations.md` §3）。
  > 边界（设计意图）："证据不可读"等阻断条件**只冻结版本目录的删除**——`versions/.tmp-*` 暂存目录与"谁在用哪个版本"无关，超期即回收（删错也只损失一次未完成的安装拷贝）。
- **不污染用户全局状态**：DSH 的 `DSH_HOME` 指向 `services/<hash>/`，与用户自己的 `~/.dsh` 或 `%APPDATA%\DSH` 完全隔离。
- **凭据**：`services/<hash>/.credentials.yaml` 含 DSH 自身的会话签名密钥，属敏感文件；`data` 目录应保持仅当前用户可读。
- **解析责任**：数据目录与环境默认值只在**组合根**（`src/app/container.ts` → `config/resolve.ts`）解析一次后显式注入 service 层；service 层不得自行读环境或回退默认值——否则"注入假启动"的测试路径会写到真实目录（该缺陷的真实案例见 `reports/fix-test-isolation.md`）。
- **位置护栏（含别名解析，R5-1 起）**：数据目录必须满足**拼写层**四条——绝对路径、不是文件系统根、不是用户主目录或其直接父级、`DSH_HOME` **严格**位于数据目录之下。在此之上还要比较**磁盘身份**：路径存在时解析其 `realpath`，不存在时回退到**最近存在祖先**的 `realpath`，并用同一张规则表再判一次。因此：
  - **指向 home（或 home 的某个子目录）的符号链接 / junction 也会被拒**，即使它的拼写看起来无害——被拒的是"被别名藏起来的落点"；
  - **解析失败一律拒绝**（`ELOOP` 符号链接环、`EACCES`、未知 errno、解析器抛异常）：**"解析不出来"不是"安全"的证据**（fail-closed）；
  - **唯一例外**：**显式写出的** home 相对布局（默认的 `~/.deep-seek-harness-mcp`）照常接受——它与"别名藏起来的落点"是两种意图，不是两种路径。
  - **预检与执法一致（在数据目录这一层）**：`doctor` 的位置检查与 `start_run` 的启动检查走**同一个**入口（同一个 `dataLocationAliasProblems` + 同一个 realpath 解析器），对**数据目录级**的不安全位置两者结论一致——不允许出现"`doctor` 说没问题、启动却被拒"。**已知边界**：`doctor` 的预检是**数据目录级**的（它没有工作区上下文），因此若 `<dataDir>/services/<workspaceKey>` **本身**是指向他处的链接、而 `<dataDir>/services` 不是，预检会 `ready:true`、而该工作区的 `start_run` 会拒——**执法正确、预检覆盖不到**（已登记为下一轮的 R6-6：给 `doctor` 增加**可选**的工作区参数）。
  - **"不测"优于"乱测"**：位置不安全时 `doctor` **不执行**可写性探针，直接返回 `writable: "unknown"`——因为"建临时文件→删除"这个探针**本身**会在别名指向的目录里写一个文件；若不安全的位置恰好是用户 home，探针就成了 P0-5 要防的那种写（该缺陷已在 R6 轮修掉，见 `reports/r6-doctor-alias-consistency.md` 的 N-R5-1b）。
  - 大小写语义遵循同一条原则：**保护性比较**（拒绝越多越安全）在 `win32`+`darwin` 折叠（macOS 默认 APFS 大小写不敏感），而**不可逆动作**的比较（真的 signal 进程、真的删目录）保持平台原生语义。详见 `reports/r5-alias-hardening.md` 与 `reports/verify-r5-adversarial.md`。
- **可写性探测不创建目录**：`doctor` 只在目录**已存在**时做"建临时文件→删除"的真实可写探测；目录不存在时返回 `exists=false, writable="unknown"`。任何"顺手 mkdir 一下"的行为都被禁止——诊断工具的副作用必须为零。
- **doctor 字段**：18 个顶层字段，其中 `dataDirectory = { path, source, exists, writable }`；`source ∈ {DSH_MCP_DATA_DIR, PLUGIN_DATA, default}`（见 §1 的优先级）；`orphans` 列出各服务目录里的进程记录（`state ∈ {alive, unverified, stale-pidfile}`），存在孤儿只会**追加提示性 `problems`**。`ready` 为四项制（引擎/ npm CLI /可写性/spec 合法性），失败原因在 `problems` 数组里逐条给出——新增字段不会扩大 `ready` 的语义。

## 3. 失败分类 → 处置

启动前可能失败在三个阶段，`doctor` 与错误信息会明确区分：

| 阶段 | 症状 / npm 码 | 含义 | 处置 |
|---|---|---|---|
| 安装 | `ETARGET` / `E404` | `DSH_MCP_HARNESS_PACKAGE` 指向的版本不存在（不是网络问题） | 改 pin 到已发布版本；不要重试 |
| 安装 | `ENOTCACHED` | 离线或 npm 缓存缺失 | 联网重试，或先用同一 spec 预热缓存 |
| 安装 | `ECONNREFUSED` / 其它非零退出 | 网络/registry/磁盘问题 | 按 `doctor` 给出的 stderr 尾定位；实现会自动重试一次 |
| 安装 | `install-timeout` | npm 静默超过 `DSH_MCP_INSTALL_TIMEOUT_MS`（不是 npm 退出码，单独分类） | 检查网络与磁盘；必要时提高预算 |
| 启动 | `no-first-output` | 子进程启动后从未产生任何输出即触发启动预算 | 多为 DSH_HOME 不可写、二进制/依赖损坏；看错误附带的日志尾与运行时包路径 |
| 启动 | `no-url-line` | 有输出但 `DSH_MCP_STARTUP_TIMEOUT_MS` 内未打印 `dsh web:` URL 行 | 看脱敏日志尾定位；多为端口/配置/凭据问题 |
| 启动 | 未打印 URL 行即退出 | 子进程崩溃 | 错误信息带退出码与 stderr 尾 |
| 停止 | `stopUnconfirmed: true` | 已发出停止但未确认进程退出（宽限期后已尝试按平台收树） | 手动确认端口与进程；不要假定已停止 |

## 4. 与安全相关的配置约束

- **不拼命令行**：所有外部命令以 argv 形式启动且 `shell:false`；外部输入必须经 `policy/trusted-input.ts` 校验或显式标注为受信输入（如 `DSH_MCP_NPM_CLI` 必须是已存在的绝对路径）。
- **凭据不落日志**：`token=`、`Cookie`、`Set-Cookie` 在日志、错误、快照中一律脱敏；`webUrl` 因设计需要返回给用户，视同本机 bearer 凭据（服务停止前一直有效，非一次性）。
- **工作区策略 fail-closed**：绝对路径 + realpath + 目录校验 + 允许根；复用会话要求能证明归属同一工作区，无法证明即拒绝。
- **Windows**：`workspace-write` 可能在工作区留下持久 ACL 标记；共享代码库建议用一次性 worktree。

## 5. 变更纪律

新增/重命名/删除任何环境变量或改变默认值，都属于**外部可感知变更**，必须同时：

1. 更新本文件与 `README` 双语的环境变量表；
2. 在 `CHANGELOG.md` 记录；
3. 若涉及兼容性，先在 `docs/decisions/` 增补 ADR。
