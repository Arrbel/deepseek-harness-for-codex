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
| `DSH_MCP_PRUNE_VERSIONS` | 启用 | 安装成功后是否回收非当前 pin 且未被在用服务引用的 `versions/<version>/` 与超期 `.tmp-*`。`off`/`0`/`false`/`no`/`disabled` 关闭（关闭后旧版本目录永久保留，便于随时回滚）。 | 新增（P0-4） |
| `DSH_PERMISSION_MODE` | `workspace-write` | DSH 权限模式。切到 `danger-full-access` 必须由调用方显式传入。 | 不变 |
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
