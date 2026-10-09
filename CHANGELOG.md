# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 结构，版本号遵循语义化版本。

> 说明：本文件记录**外部可感知**的变更（安装方式、MCP 工具行为、返回字段、运行状态语义、DSH 版本线）。
> 内部重构不记录，除非影响上述任一项。

## [Unreleased]

### 状态：**独立验收通过（GO）**，发布与否取决于分发身份决策

解包与安装路径的阻断项已在 P1 解决，运行期行为缺陷已在 P5 修完，独立验收阻断项已在 P8 修完：

- ~~测试套件存在失败用例~~ → 已修复（当前 **455 passed | 1 skipped (456)，0 条 `it.fails`**：那 2 条 expected fail 已转正为真断言）；
- ~~元数据钉了 registry 上不存在的 `0.4.0`~~ → 已消除（P1：不再有自引用钉，插件自包含）；
- ~~市场安装静默降级到 0.3.1~~ → 已消除（P1：插件载荷由生成器独占产出，门禁校验）；
- ~~首次启动预算被 npx 下载污染~~ → 已修复（P3：安装与启动分离；ADR-0002）；
- ~~`turn/end` 的 `blocked`/`max-tokens` 被判成功、cookie 失效后运行悬挂~~ → 已修复（P5：ADR-0003 状态机 + 失败分类驱动恢复）；
- ~~`npm run check:live` 会"跑 0 条用例却绿"~~ → 已修复（前置闸门 `scripts/check-live-guard.mjs`：未设 `DSH_LIVE=1` 时 **exit 2** 并打印运行指引）。

**独立验收（round 2）结论：GO**；覆盖 7 条 DoD、两条安装路径（canonical 本地载荷 + `npm pack` tarball 安装后启动）、真实 `DSH_LIVE=1` 链路、泄漏/卫生扫描、文档抽查与 CHANGELOG 完整性。**发布前唯一外部依赖**：npm 分发身份（当前包名归上游，见 ADR-0001 的未决点）；从 registry 安装这一路径因此仍属未验证。

> **R1 整改轮（评审后硬化）**：P0 组（孤儿回收 + 端口自愈、POSIX 进程树、`package-spec` 边界缺陷、版本目录 prune、`DSH_HOME` 安全断言）已落地，**动了 GO 验收的红线范围**（`supervisor`/`launch`/`process-tree`/`runtime-package`/`policy`），因此按同一判据**重新验收**；计划与专家裁定见 `reports/plan-p0-p1.md`，逐项证据见对应报告。
>
> **重新验收结论：GO（第二轮）**（`reports/verify-r1-p0.md`）。第一轮由独立验证者判 **NO-GO**，唯一阻断项是**确定性 CI 红**（见下方 Fixed 的 N-1）：本地 Windows 全绿正好掩盖了平台分支，而全仓**无平台型 `skipIf`/`runIf`**，因此 ubuntu 列会真执行那些用例——这是它致命而非被隐藏的原因。修法**不是弱修**：win32 与 POSIX 两侧**硬编码相反期望**并各自显式注入 `platform`，另加"覆盖 `process.platform` 后不注入地重跑三平台"的用例组。复验：`check` exit 0、`455 passed | 1 skipped (456)`、模拟 linux 下 `launch.test.ts` 全文件绿（40 用例）。
>
> **仍未验证（不随 GO 消失）**：真实 ubuntu runner 上的 `check.yml` 三列（模拟只覆盖 `process.platform` 条件维度，其边界已实测：不改变 `node:path` 语义、不模拟大小写敏感文件系统、不模拟平台工具可用性 / CRLF / 真信号）；`tests/unit/data-location.test.ts` 在真实 ubuntu 上是否仍绿；`browser.ts` 的三平台 opener 分支（无测试、无注入缝——新发现的信息级残留面）；真实 POSIX 进程回收行为；真实 API key 成功路径；生产数据目录上的 prune 回收量；macOS/Linux 全链路；现场孤儿成因未被独立复现（回收分支是用手工起的真 DSH 验证的）。

系统化改造的进度以 `docs/roadmap.md` 为准；架构约束见 `docs/architecture.md`。

### Fixed（Wave R6：把"检查工具自己违反被检查的规则"这类缺陷修掉）

- **`doctor` 与 `start_run` 对同一个别名给出不同结论**（预检/执法不一致）：R5-1 的别名感知入口当时只接在启动路径上，`doctor` 仍是纯拼写层，于是指向 home 的**同一个** junction 会得到"`doctor` 说没问题、启动被拒"。现在 `doctor` 的位置检查复用**同一个**入口与**同一个** realpath 解析器，消息**逐字复用**护栏原文（`prerequisites` 4→5 项，`ready` 判据与 **20 键**契约未变）。**已知边界（如实声明）**：`doctor` 的预检是**数据目录级**的（没有工作区上下文），因此若 `<dataDir>/services/<workspaceKey>` **本身**是指向他处的链接而 `<dataDir>/services` 不是，预检会 `ready:true` 而该工作区的启动会拒——**执法正确、预检覆盖不到**，已登记为下一轮的 R6-6。
- **`doctor` 的可写性探针会在不安全的位置里真的写文件**（本轮顺带发现，同类缺陷）：探针原先跑在安全检查**之前**，于是当数据目录是一个**指向用户 home 的别名**时，"建临时文件→删除"这个探测会**在真实 home 里创建一个文件**——正是 P0-5 要防的那类写。现在位置不安全时**不执行探针**，直接返回 `writable: "unknown"`（**"不测"优于"乱测"**）。
- **全量测试有 75% 概率红**（与改动无关的假红，会让 CI 门禁不可信）：`tests/run/orchestrator.test.ts` 有一处**时序假设**——"第一个观察窗口里回合恰好还活着"。独立验证量化：全量连跑 8 次 **6 次红**、同文件单独跑 **8/8 绿**，失败恒为 `expected 'succeeded' to be 'running'`（`succeeded` 正是该测试自己随后断言的正确终态）。现在 fake Host 的回合**可被测试显式放行**（`FIXTURE_TURN_HOLD=1` + `POST /__fixture/release`）：观察窗口里的"活着"成了 Host 的**状态**而非"还没到时间"，持有期间**没有计时器**，因此不再受负载压缩。**改后 15 次全量连跑：line102 命中 0/15**（8/8 那一轮逐次贴出），并新增 3 条反向验证（改回依赖时序 / 夹具忽略持有 / 移除放行路由 —— 全部变红后逐字节还原）。该用例**净增 5 条断言**（含进度投影），其余 21 条无删除、无跳过、无放宽。**`src/**` 一行未动**——产品行为本来就是对的。

### Fixed（Wave R5：把"护栏"与"发布面"补到边界上）

- **P0-5 护栏的别名层（安全；红线文件）**：护栏此前只比较**路径拼写**，因此一个**指向 home 的符号链接/junction** 作为数据目录会被接受，写入真的穿透进 home（两个独立验证者分别复现）。现在新增生产入口 `dataLocationAliasProblems`（拼写层 + **磁盘身份层**）：路径存在时比较 `realpath`，不存在时回退到**最近存在祖先**的 realpath；解析失败（`ELOOP`/`EACCES`/未知 errno）一律 **fail-closed 拒绝**——"解析不出来"不是"安全"的证据。纯拼写层函数保持原样（既有 23 条穷举与跨平台断言逐字节不变），并用**结构性用例**钉住"生产只调强入口"。**修复经对抗复攻确认**：原攻击在单元层与真实 `ServiceSupervisor.start()` 上都失败，另有**正对照**证明"被拒"来自护栏而不是探针跑不起来。
- **`npm ci` 的安装生命周期钩子面**：`npm ci` 会执行 root 的 `preinstall`/`install`/`postinstall`/`prepare`，而它们**不经过任何锁文件审查**——这是把发布步骤藏进 CI 的一等位置（`release.yml` 还持有 `id-token: write`）。三处 workflow 改为 `npm ci --ignore-scripts`（**等价性已用忠实的 CI 模拟证明**：`npm run check` exit 0），并新增**结构性门禁**：`preinstall`/`install`/`postinstall`/`prepare`/`prepublish` 必须不存在，`prepack`/`prepublishOnly` 必须逐字等于审查值（带反例验证）。
- **"绝不 publish"检测器的盲点与自述**：检测面扩到 `--prefix`/`--global`/`--filter`/`--cwd`/`=` 等形态，并扫描 `package.json#scripts`、`.npmrc`、`scripts/**`；R4 复核打出的 4 个漏检形状（含 `npm --prefix . publish`）**全部被捕获**。同时把模块注释改成**与能力相符**的两节——"能看见什么 / **诚实地看不见**什么"（依赖自身的安装脚本、树外 Secrets、其它分支或 `workflow_run` 链、动态拼接命令等），**不再声称强于实现**。
- **`journal` 的 `error` 字段脱敏**：写入与读回两处统一过脱敏（与 `drift.ts` 的逐字段纪律一致）。**边界如实**：`?token=` 走模式层，`Bearer`/base64url 靠**注册表**层，未注册的串仍不会被擦（已登记为下一轮的 R6-2）。
- **折叠策略不再有默认值**：`foldForComparison` 的 `platform`/`policy` 均**必填**——漏传即 `TS2554` 编译失败（历史形态是"默认取最宽的折叠"，未来某个破坏性调用点忘传就会静默扩大杀/删面）。**强度边界如实**：它消灭"意外漏参"，蓄意用 `@ts-expect-error`/断言绕过会**运行期崩**（fail-loud），不会静默放宽。

### Added（Wave R4：发布工程、跨平台证据与进度可见性）

- **`release.yml`（tag 触发）+ `npm run sbom`**：`push.tags: v*` → `npm ci` → `npm run check` → `npm pack` → SBOM（CycloneDX）→ 上传 `npm-tarball`/`sbom-cyclonedx` → `attest-build-provenance`。**流水线里没有任何发布动作**，而且这不是靠注释保证的：仓库不允许新增 YAML 依赖，于是新增了一个**只读的子集解析器**把 workflow 解析成 `{jobs:[{steps}]}` 模型，17 条不变量覆盖"每个 `run`/`uses`/`with`/`env` 都不含发布面"、触发条件只能是 tag、有效权限必须含 `id-token`/`attestations`、两个 artifact 都上传、`npm pack` 产物面 == `package.json#files`。`npm run sbom` 与 CI 同一套参数：生产依赖面 **0 个组件**（`dependencies` 为空），除 `serialNumber`/`timestamp` 外逐字节确定。
- **`RunSnapshot.progress`（第 18 个键）与自适应轮询**：`{started, finished, current:{turn,step,seq}|null}`——**只含数字**的进度投影，来自已录制实证的 `step/start`。**刻意不含工具名/参数/命令/输出**：录制里 `step/start` 的 data 只有 `{turn, step}` 与 schema 强制的 `seq`，工具名**无证据**，因此**不投影**（宁可少显示，也不猜字段，更不让参数文本进入快照或日志）。轮询在有进展时 400ms → **150ms**、静默退回 400ms，策略是**纯函数且有界**（最坏 ≈7 轮/秒；实测：3 秒静默回合带退避约 9 次 `session/page`，去掉退避为 20 次）。
- **跨平台证据包**（`tests/platform/**`）：把全部平台条件分支逐条清点（含行号、"本机是否执行"、"另一侧有无测试"），并为"另一侧"补**行为级**模拟证据（POSIX 终止走进程组而非 `taskkill`、mac 的 `open` 拿到正确 URL、路径分隔符按平台生成），同时如实列出**从未在真实 ubuntu/mac 上执行过**的条目。

### Fixed（Wave R4）

- **P0-5 护栏的 macOS 绕过（安全；红线文件）**：路径比较原先**只在 `win32`** 折叠大小写，而 macOS 默认 APFS 大小写不敏感——`DSH_MCP_DATA_DIR=/Users/Bob`（home 为 `/Users/bob`）可以绕过"数据目录不得指向用户 home"的护栏，重演本会话修过的"写脏用户真实 home"那类事故。现在只有一个助手 `foldForComparison(value, platform, policy)`，并**刻意做成非对称**：
  - `"filesystem"`（`win32` + `darwin`）用于**保护性**比较——**匹配越多 = 拒绝越多**（护栏、workspace 白名单、`dataLocationProblems`）；
  - `"win32-only"` 用于**不可逆动作**的比较——`identityOwnsRecord` 成立会**真的 signal 进程**、prune 的 blocker 判定会影响**真的删目录**，折叠在这里等于放宽，故保持平台原生语义。

  **原则（可引用）**：折叠只用在"匹配越多 = 拒绝越多"的保护性比较上；凡"匹配越多 = 动作越多（杀/删）"的比较，一律保持平台原生大小写语义。linux 保持大小写敏感（未变），Windows 逐字等价。
  **已知残余（已登记，不粉饰）**：这道护栏比较的是**路径拼写**，**不解析 `realpath`**（工作区护栏会解析，数据目录护栏不会）。因此一个**指向 home 的符号链接/junction** 作为 `DSH_MCP_DATA_DIR` 时仍会被接受——独立验证（`reports/verify-r4-adversarial.md` A-1）与终验（`reports/verify-r4.md` N-R4-1）都复现了这一点。它需要主动构造别名，且能设置该变量者本就能直接写 home，故不作为阻断；**修法已登记为 `docs/roadmap.md` 的 Wave R5-1**（存在时比较 `realpath`、不存在时取最近存在祖先，并让两道护栏的 realpath 语义一致）。
- **三处会让 CI 的 ubuntu/macOS 列必然变红的测试硬编码**：`tests/config/resolve.test.ts`（硬编码 `;`，而实现用 `path.delimiter`）、`tests/unit/layering.test.ts`（宿主分支断言）、`tests/diagnostics/doctor-doc.test.ts`（`C:\one` 在 POSIX 上同时含盘符冒号与列表分隔符）。`tests/unit/data-location.test.ts` 也从"宿主绑定 + 在 POSIX 上退化为空转"改成**显式平台**断言。

### Added（Wave R3：韧性、可恢复性与并发）

- **`doctor.contract`（第 20 个顶层字段）与契约版本矩阵**：wire 适配按 **DSH 版本线**声明（`src/dsh/matrix.ts` 的 `CONTRACT_MATRIX`，只有 baseline 带完整形状，其余行只记差异），录制夹具按版本线分档（`tests/fixtures/recorded/<dshLine>/` + `current.json` 指针，**只有一份录制集**）。`status` 四态：`exact`/`compatible`/`unknown`（尚未安装——**正常状态**）/`unsupported`。纪律：**只有 `unsupported` 会影响 `problems`/`ready`**，由唯一判据 `contractBlocksReadiness` 决定，`unknown` 刻意不算失败（否则每个全新安装都会显示不可用）。
- **漂移遥测 `<数据目录>/logs/drift.jsonl`**：形状不符时落一条**指针级**记录（`ts/kind/method/path/expected/gotType/pluginVersion/dshVersion/runId?`）——**不含** message 原文、token、cookie、prompt 或模型输出；载荷只以**类型名**离场，`method` 走白名单，写盘前再过统一脱敏，且返回与落盘是同一对象。目录由**第一条记录**按需创建（启用后从未漂移 → 不建空目录）；`DSH_MCP_DRIFT_LOG=0` 关闭；写入失败静默降级。
- **运行态持久化与启动对账**：每次运行在该工作区服务目录下留 journal（`services/<hash>/runs/<runId>.json`，`.tmp` + rename 原子写）。MCP host 崩溃/重启后，下一次工具调用会按 journal 对账：服务仍活 → **收养**（保持 `running`，从 journal 的 `lastKnownSeq` 恢复进度）；服务已死 → `failed(service-unreachable)`（同时 `webUrlStale: true`）；会话空闲但日志缺 `turn/end` → 复用既有 fail-closed 规则判 `failed`（**绝不写成 `succeeded`**）。跨进程安全由 `runs/.adopt.lock` 保证：**抢不到锁就整轮跳过**，不替别人的运行下结论。**`RunStatus` 不新增成员**（对账仍只经 `settle()` 写终态）。
- **`DSH_MCP_RUN_LIMIT`（默认 `4`）与并发门**：同一工作区同时只允许一个运行，跨工作区受该上限约束。越界**拒绝而不是排队**，错误里给出 `wait_run`/`get_run`/`cancel_run` 的可操作指引，且**不产生运行记录**（因此没有 `queued` 状态，`RunStatus` 语义不变）；`settle()` 到终态立即释放槽位；对账收养的运行同样占位，但**收养本身不受门限制**（否则会重造"永久 running"）。上限是**每进程**的，跨进程共享额度明确**不做**。
- **`npm run coverage`（非门禁）与定向属性测试**：新增 `@vitest/coverage-v8` 与覆盖率基线（分层报告见 `reports/r3-coverage-and-properties.md`）；`tests/property/**` 4 组属性测试（`wire` 分类全函数性、引擎区间单调性、活动重置预算、`settle` 幂等）。**刻意不接入 `npm run check`**，也不设覆盖率阈值——属性测试买的是不变量，不是数字。

### Fixed（Wave R3）

- **并发准入的 check-then-act 竞态**（由独立验证发现，严重度：高）。两个**并发**的 `start_run` 在"检查占用"与"登记运行"之间交错，导致**同一工作区同时有两个运行**被准入：`DSH_MCP_RUN_LIMIT` 在并发下不再是上限，磁盘上留下**两条同工作区 `running` 记录**（而对账会扫描所有工作区，等于把一次瞬时竞态变成持久错误）；被拒调用本应"不产生运行记录"，却在竞态下产生了记录。现在改为**同步原子预留**：判定与占位发生在**同一个同步块**内、且在**任何 `await` 之前**，全部 `await` 都在持有预留下进行，`finally` 释放（早退/异常都不留占位）。预留**不是**运行记录——不进 `list_runs`/`get_run`、不写 journal，因此"没有 `running` 记录就没有 `queued`"这条口径继续成立，`RunStatus` 仍是四项。工作区键用 `realpathSync` 归一化，同一真实目录的不同写法（`…\ws`、`…\ws\`、`…\ws\.`、`…\ws\..\ws`、大小写变体）在任何 `await` 前就收敛为同一个键。
- **并发上限与工作区串行是"进程内"的，现在文档也这么说**：三处文档原先把"同一工作区只允许一个"写成无限定的绝对表述，而原子预留是实例内的 `Map`（没有跨进程协调）。`README.md`/`README.en.md`/`docs/configuration.md` 已明确限定为"同一数据目录的单个 MCP 进程内"，并写明跨进程共享额度**不做**、跨进程的安全约束来自服务结构与 `runs/.adopt.lock`（N-R3-3，独立验证提出）。
- **防御性去重：磁盘上若出现同一 `sessionId` 的多条非终态记录**（历史竞态产物，修复后不会再产生），对账只让**最新**的一条参与收养/结算，旧的收敛为 `failed(turn-unknown:superseded-duplicate-journal)`（`error` 指名取代它的 runId），**不留下任何非终态证据**；"最新"由全序决定（`startedAt`↓ → `lastKnownSeq`↓ → `runId`↑），不依赖目录遍历顺序。理由使用既有开放形态，故不新增闭集 reason、`nextAction` 仍为 `report-only`。
- **`classifyThrownFailure` 不再对合法的异常值抛异常**：`thrownText` 的兜底曾是 `String(error)`，而 `String([Symbol()])` 会抛（`Array.prototype.join` 用 ToString 转换元素，符号被拒），于是一个"可分类"的异常值逃出了分类器。现在由一个**永不抛**的渲染器（符号感知 + 递归 + 兜底 `unprintable value`）处理，`classifyThrownFailure` 对任意值都给出文本（属性测试 `wire-totality` 的排除项因此消失）。
- **`message` 保证非空**：字段文档写明"never empty"，但抛 `""` 或 `message`/`name` 皆空的 `Error` 会产出空串。现在两处入口都有显式非空兜底（`unrecognized value`）。
- **删除逐字节重复的死代码**：`src/service/runtime-package.ts` 曾保有一份与 `service/npm-cli.ts` **34 行逐字节相同**的 `findNpmCli`/`resolveNpmCli`，且**全仓无人导入**——一份无人到达的副本比没有副本更糟，它诱使未来在错误的文件里修 bug（由 R3-6 的覆盖率工作发现）。现在只有 `service/npm-cli.ts` 一份实现。
- **凭据落盘按生命周期收口**：journal 的**终态**记录只保留 `origin + path`（写盘 choke point + 读回净化双重保证），**非终态**记录保留完整链接（token 此时本就在生效，收养后仍要能给出可点击链接）。`0600` 有断言（Windows 无 POSIX 位，断言自校准）。残余风险如实记录在 `docs/operations.md` §8.3：能在服务存活期间读到非终态文件者等于拿到有效 token（与读 DSH 自身数据等价）——**窗口从"永久"缩到"运行存活期间"，不是消除**。

### Added（Wave R2：使用体验与可诊断性）

- **`RunSnapshot.nextAction`（失败恢复建议）**：由 `reason` **单向派生**的闭集动作（`relogin` / `restart-service` / `new-session` / `retry-narrower` / `report-only` / `none`），非 `failed` 时为 `none`。开放形态（`rpc:<code>` / `turn-aborted:<cause>` / `turn-unknown:<kind>`）**一律 `report-only`**——不确定的原因不猜恢复动作（失败词典见 `docs/operations.md` §4；`NEXT_ACTION_BY_REASON` 用 `satisfies Record<ClosedFailureReason, RunAction>` 约束，新增闭集 reason 忘配动作是**编译错误**）。刻意**不自动执行**：唯一自动重试仍是既有的 `auth` 换 cookie 一次。
- **`RunSnapshot.webUrlStale`**：仅当 `failed(service-unreachable)` 时为 `true`——服务重启会重分配端口并轮换 token，旧 `webUrl` 与旧 cookie 都作废，必须重新 `start_service` 取新链接。
- **`doctor.permission`（第 19 个顶层字段）**：`{mode, source, approval, advisory}`，镜像 DSH 自身表达式（`DSH_PERMISSION_MODE ?? 'workspace-write'`；只有 `danger-full-access` 是 `approval: never`）。它让"默认模式会在页面等人工批准"这件事在**起服务之前**可见。**它是报告项，不是前置条件**——四项制 `ready` 语义不变。
- **协议漂移可定位**：漂移类失败现在同时携带**方法名**与出错字段的 **JSON 路径**（如 `payload.args.request.sessionId`），错误文本里也包含它们；`client.ts` 的 `DshRpcError` 增加 `path`。**修正一处未分类出口**：请求侧的参数校验失败此前以裸 validator 错误逃出 `call()`，现在归类为 `protocol-drift`。
- **`npm run dsh:try -- <version>`（升级演练）**：验证版本存在 → 以 env 传入（**不改任何文件**）→ 全新临时数据目录 → 真实安装/启动/8 步链路/逐方法协议形状 → 生成演练报告 → `finally` 清理。自带**仓库指纹自检**（跑前跑后比对受跟踪文件）与"真实数据目录必须仍未创建"的断言；并发写者会被如实拦下（`--tolerate-concurrent-writes` 可显式降级）。
- **CI**：`check.yml` 新增 `macos-latest` 列（覆盖 POSIX-but-not-Linux：无 `/proc` → `pgrep -P` 回退、`open` 而非 `xdg-open`、大小写不敏感路径）；新增独立 `supply-chain` job（`npm audit --omit=dev`，可见不阻塞 + 离线 `npm sbom --sbom-format=cyclonedx` 上传 artifact）。
- **工程卫生**：`.gitattributes`（`text=auto eol=lf`）消除成片 EOL 警告；`CONTRIBUTING.md` 写明写权纪律、`version:sync` 与 `generated-drift` 的因果关系、反向验证要求、`check`/`check:live` 边界；`docs/architecture.md` §12 增加组件依赖 / `start_run` 时序 / 数据目录与 pidfile 三张 mermaid 图。

### Changed（Wave R2）

- **零运行时依赖**：`dependencies` 清空，`@modelcontextprotocol/sdk` 与 `zod` 移入 `devDependencies`（已内联进 `dist/bin.mjs`）。证据：`npm pack` + `npm install --omit=dev` 得到的安装树里没有它们，而该产物仍能完成 MCP 握手并列出 10 个工具；`npm audit --omit=dev` 为 0 漏洞。
- **失败词典定稿**：`turn-blocked → new-session`（回合在**任何 step 之前**被拒，重试对象是会话/权限，不是"缩窄任务"）；`turn-interrupted → report-only`（官方源码核实：`interrupted` 是**崩溃恢复**语义——`repair.ts` 只是"balance a persisted log"，`agent-loop` 修复后以 `resume` 用**同一个 sessionId** 继续，disposal 是独立带外事件；因此"换新会话"会断言我们没验证过的事实）；`turn-truncated → retry-narrower`。
- **`DSH_MCP_PRUNE_VERSIONS` 归口**：env 解析移入 `config/resolve.ts`（`resolvePruneVersionsEnabled`），`runtime-package.ts` 只保留同名转发别名，消除重复解析；该变量同时加入 `.mcp.json` 的 `env_vars` 白名单（此前 Codex 侧无法透传）。
- **`browser.ts` 平台分支可测**：三平台 opener 改为可注入（`browserLaunch(platform, url)` + `OpenBrowserOptions`），`shell: false` 由运行期约定升级为**类型约束**；此前该文件的三平台分支**全仓零测试引用**。
- **`DSH_PERMISSION_MODE` 文档口径**：README 中英与 `docs/configuration.md` 明确"默认映射为 `approval: ask`"，并指向 `docs/operations.md` §7（含操作指引与"为什么 MCP 不能代答"）。

### Fixed（Wave R2）

- **`doctor.ready` 文档口径修正**：此前文档写 `ready = problems.length === 0`，而实现早已是"四项前置条件 + 提示性 `problems`"（孤儿、权限提示）——文档与实现不一致会让读者用 `problems.length` 反推可用性。现在明确：`ready` 只看四项，`problems` 可含提示项。
- **`orphans` 文案与 `port: null` 一致**（独立验证者 N-2 的收尾）：全部端口未知时不再谎称"still hold a port"。

### Fixed（N-1/N-2：平台分支门禁与孤儿文案，独立验证者复验项）

- **N-1（确定性 CI 阻断）**：`tests/service/launch.test.ts` 断言 `detached === false` 时**没有注入 `platform`**，于是读到 `process.platform`——`launch.ts` 的 `detached: platform !== "win32"` 在 ubuntu 上返回 `true`，而 `check.yml` 的矩阵含两个 `ubuntu-latest`，该列**必然红**（Windows 本地全绿掩盖了它）。现在：原有两条用例**显式 `platform: "win32"`**；新增 POSIX 用例（`linux`/`darwin` → `detached === true`，把 P0-2 的进程组前提钉进门禁）；并新增"**不管宿主是什么平台**都跑两个分支"的模拟用例（在测试内覆盖 `process.platform` 后再构建 launch 向量），使该文件在 Windows 与 ubuntu 上都确定性全绿。
- **N-2（文案与事实不符）**：`orphanProblem` 原先只要存在存活条目就写"N process(es) still hold a port"，而 `port` 可能为 `null`（子在绑定端口前被杀）。现在：`port` 全部未知时写"still running, port unknown"；部分未知时写"still holding port(s) <已知端口> (port unknown for N of them)"，pid 仅在已知时列出。
- **N-3（不做，按 Lead 裁定）**：`ServiceSnapshot` 不新增 `orphan` 字段——`doctor.orphans` 已提供该可观察面，扩快照属外部契约变更且收益不足。

### Fixed（P0 进程生命周期：孤儿回收与端口自愈、POSIX 进程树、DSH_HOME 安全断言）

- **P0-1 孤儿服务进程与端口自愈**：MCP host 被强杀/客户端崩溃时，单层的 `node …/lib/bin.js` 子进程会**带着监听端口**存活，此前没有任何跨进程对账（现场事故：26 个各带端口的孤立 DSH 服务进程）。现在：
  - spawn 成功后原子写 `<服务目录>/dsh.pid`（`.tmp` + rename；含 `pid/port/version/binPath/startedAt/dataDirectory/workspace/serviceHome`；端口未知时先写 `null`，就绪后再原子重写真实端口），确认停止后删除、未确认则保留为证据；
  - `start_service` **启动前对账**：pidfile 存在时先判存活、再判身份；**损坏的 pidfile 只会被丢弃，绝不按其中数字杀进程**；
  - **安全规则 fail-closed**：只有 OS 报出的命令行**同时**包含我们记录的 `binPath` 与 `--port` 参数才认定"是我们的进程"并回收；**拿不到身份（或身份不符）绝不杀**，上报 `unverified`（PID 复用会误杀用户进程）；
  - `terminate()` 增加**端口已释放**校验：进程退出但端口仍被占用时再收一次进程树，仍不成功就保持 `stopUnconfirmed: true`（不谎报）；
  - `doctor` 新增 `orphans` 字段（`state: alive | unverified | stale-pidfile`），并把"存在孤儿"作为**提示性** `problems` 输出——`ready` 仍是四项制，语义不变。
- **P0-2 POSIX 进程树修补**：POSIX 上子进程改为 `detached: true`（**不 `unref()`**，stdout/stderr 管道保留），使 `kill(-pid)` 真正可用；进程组不可用时走新增的**自叶向根递归保底路径**（Linux 读 `/proc/<pid>/task/<pid>/children`，其它 POSIX 用 `pgrep -P`），最后再杀已记录的 pid。`process-tree.ts` 由**零测试**变为 15 例缝级单测（win32 `taskkill /T /F`、POSIX 有/无进程组、无 pid、killer 启动失败、`hasExited`/`waitForExit` 竞态、身份与存活探针）；Windows 保持 `detached: false`。
- **P0-5 `serviceHome` / `DSH_HOME` 安全断言（fail-closed）**：创建目录/启动之前校验解析后的数据目录与 `DSH_HOME`——必须绝对路径、不得是文件系统根、不得等于用户主目录或其直接父级、`DSH_HOME` 必须严格位于数据目录之下；违反时抛可操作错误且**不创建任何目录**（真实事故：`DSH_HOME` 被误指到 `C:\Users\<user>`，主目录当场生出 `profiles/`、`storages/`、`.credentials.yaml`）。校验位于 `supervisor.ts`（唯一知道数据目录的层，覆盖注入的 spawn 缝），`launch.ts` 保持叶子模块。

### Changed（P0-4：运行时版本目录清理，fail-closed）

- **自动回收不再使用的 DSH 版本目录**：每个版本约 486 MB，此前只有 `doctor` 报告占用、没有任何清理动作（现场数据目录已到 948 MB 量级）。现在**安装成功后**（仍持有 `<dataDir>/versions/.install.lock` 时）会运行一次 prune：删除「非当前 pin + 未被在用服务引用 + 目录内是完整安装」的 `versions/<版本>/`，以及**超过 24 小时**的 `versions/.tmp-*` 残留。
- **fail-closed，绝不误删**：拿不到 `.install.lock`（不是本进程持有）→ 整个 prune 跳过、零改动；`services/` 不可读、pidfile 损坏、pidfile 描述的不是本数据目录/本 binPath → 该轮**一个版本目录都不删**；当前 pin 永不删除；名字不是精确版本的目录永不删除；无法确认完整安装的目录永不删除。「在用」判定用既有的 `services/<key>/dsh.pid`（P0-1 写入，含 `version`/`binPath`）：记录的进程存活即视为在用，**存活但身份无法证实**（PID 复用、查不到命令行）同样视为在用。Windows 上 `EBUSY`/`EPERM` 记入 `skipped` 而**不重试、不抛错**，不影响已成功的安装。
- **可观察**：prune 结果通过 `ensureRuntimePackage` 的返回值新字段 `prune {ran, reason, removed, skipped, reclaimedBytes}` 暴露，并在既有安装日志通道输出一行摘要（例如 `[runtime-package] prune: reclaimed 486.1 MB (1 version directory, 0 staging); skipped 1 (current-pin x1)`）。**未新增 MCP 工具，`doctor` 行为与字段完全未变**（仍是零副作用）。
- **开关**：`DSH_MCP_PRUNE_VERSIONS`（默认启用；`off`/`0`/`false`/`no`/`disabled` 关闭）。
- **⚠️ 行为变更（回滚成本）**：切换 `DSH_MCP_HARNESS_PACKAGE` 到新版本后，旧版本目录会被自动回收——原先"旧目录保留即可回滚"的便利需要主动保留（`DSH_MCP_PRUNE_VERSIONS=off`，或把目录复制到别处）。`docs/configuration.md`/`docs/operations.md`/`docs/roadmap.md`/`ADR-0002` 已同步为当前行为。

### Fixed（P0-3：Node 区间判定不再静默放行被排除的版本）

- **`parseExactPackageSpec` 的同源缺陷修复**：`satisfiesNodeRange` 的版本解析原先只做**前缀**匹配，导致三类静默误判——复合子句丢上界（`satisfiesNodeRange("2.5.0", ">=2.3.0 <2.5.0")` 曾返回 `true`）、连字符范围被当作下界（`"1.2.3 - 1.3.0"` 曾与 `1.2.3` 判等）、带后缀/超长版本被当作数字核心（`1.2.3-junk`、`1.2.3.4` 曾判为支持）。现在：解析**锚定**为恰好 `major.minor.patch`；子句按空白拆成多个比较器并**全部成立**才算通过；未实现的语法（连字符范围、`v`/`=` 前缀、带后缀版本）一律返回 `false`（fail-closed）而不是近似。
- **影响**：当前 pin（`^22.19.0 || >=24.0.0`）不含复合子句，故**无实害**；但把区间改成自然写法（如 `>=22.19.0 <23.0.0 || >=24.0.0`）此前会静默放行不支持的 Node。`package-spec.ts` 由 2 条形状的隐式覆盖变为 **84 例**显式覆盖，并新增"声明区间若使用未覆盖的比较器形式就直接失败"的守卫（`tests/unit/package-spec.test.ts`）。

### Fixed（P8：修复独立验收阻断项 B1–B3）

- **B1（真实缺陷）隔离守卫把"被配置的数据目录"当成用户真实 home**：`tests/support/isolation.ts` 原先对 `DSH_MCP_DATA_DIR`/`PLUGIN_DATA` 与默认目录使用同一条规则（存在性任何变化都失败），而配置目录按设计就是首跑要创建的——于是 `DSH_LIVE=1 DSH_MCP_DATA_DIR=<新目录> npm run check:live` **首次必然 exit 1**（`Test results: 1 failed`，`… was created during the test run`），第二次才通过。现改为**带策略的观察**：默认目录（`~/.deep-seek-harness-mcp`）仍"任何变化都失败"（D-07 保护不退化）；**被配置的目录允许出现、不允许消失**；两者同路径（含 Windows 大小写/相对写法归一）时取更严规则。新增纯函数 `dataDirectoryViolations()` 与 `watchedDataDirectories()`，四条策略回归测试（+7 条用例）全部用合成观察 + 桩探针断言，**不会真的创建** `~/.deep-seek-harness-mcp`。CI 同根因（`.github/workflows/live-smoke.yml` 使用不存在的 `<ws>\.verify-scratch\live-data`）随之解除，workflow 未改。
- **B2（文档事实性）`allowedWorkspaceRoots` 的取值**：README 中英原称"`null` 表示不限制"，实测恒为 `[]`。改为按实现描述（**未配置时为 `[]`**，空数组即"不限制"）。同时把**取值语义**纳入门禁：测试除 key 集合外，还断言 `allowedWorkspaceRoots` 是数组且未配置为 `[]`、配置后为切分出的根路径数组，`ready === (problems.length === 0)`、`dataDirectory.writable ∈ {yes,no,unknown}`，并断言 README 不再出现 `null` 表示不限制的措辞。
- **B3（文档事实性）启动耗时分三种情形**：README 中英原称"冷态约 4 秒"，与实测矛盾（真冷启实测 22742 ms，独立验收 29366 ms；仅 DSH 家目录已预热时为 3812 ms）。改为区分**首次安装**（约 1 分钟 / 486 MB，实测 54 s / 486.1 MB）、**真冷启（DSH 家目录为空）约 20–30 秒**、**预热后约 4 秒**，并加测试防止回退到旧说法。

### Changed（P7：工具面单表驱动与文档一致性门禁）

- **注解由行为类派生**：`ToolSpec` 不再各自声明 `annotations`，改为声明语义类 `behavior`（`read-only` / `idempotent-write` / `mutating-write` / `destructive-idempotent`），三个 hint 由 `annotationsFor(behavior)` 计算，`register.ts` 只做装配。`noArgs` 字段删除，改为从入参 schema 派生的 `toolAcceptsNoArgs()` / `NO_ARGUMENT_TOOLS`（同一事实不再写两处）。新增 `result` 字段声明返回语义，并由测试断言处理函数真的返回该形状。
- **失败出口统一**：`toolFailure()` 成为唯一失败构造器（`isError: true` + 单条可读文本 + 统一脱敏），`register.ts` 直接使用它；工具不再各自拼装错误结果。
- **`wait_run` 契约写明并测试**：可重复调用、无副作用、已结束的运行反复调用返回同一终态快照、超时返回当前快照而不是失败（工具描述与 README 中英同步）。
- **新增文档↔工具面门禁**：`scripts/check-metadata.mjs --self-contained` 现在会把真拉起的插件所广告的工具名与 `README.md`/`README.en.md` 的工具表逐一比对，缺一个或多一个都会以 `tool-surface-drift` 失败（`check` 与 `prepack` 链均已覆盖，无需新增 npm script）。
- **`doctor` 字段↔README 对齐**：README 补齐 `nodeVersion`/`nodeSupported`/`platform`/`architecture`/`apiKeyInEnvironment`/`allowedWorkspaceRoots`/`surface` 七项，并新增测试断言 `doctor` 的顶层键集合与中英 README 的字段表完全一致（`docs/operations.md` §4 的同一清单见 `reports/impl-tool-surface.md`，由 Lead 收编）。

### Security（P6：出口全脱敏、回环校验、契约 fail-closed）

- **凭据只有一个有意出口**：新增凭据值对象 `LaunchCredentials`（`src/service/credentials.ts`）——构造时把 token/cookie 登记进 `src/util/redaction.ts` 的秘密表，`toString()`/`toJSON()`/模板插值默认返回**脱敏形态**，真实值只能经 `loginUrl`/`cookieHeader` 两个显式访问器取得；所有错误文本经 `redactErrorText` 单一入口脱敏（修掉 `browserError` 直写未脱敏错误的旧缺陷），工具结果在 MCP 边界（`tools/register.ts`）再用 `redactDeep` 扫一遍。新增全出口扫描测试 `tests/security-exits.test.ts`（正常/401/浏览器失败/启动失败/工具错误五类场景）。唯一允许携带 token 的字段是返回给调用方的登录 URL（`webUrl`/`loginUrl`），该例外在代码里显式声明为 `LOGIN_URL_KEYS`。
- **cookie 解析改用 `Headers#getSetCookie()`**：优先数组 API（带逗号的 `Expires=` 不再可能被误切），仅在运行时缺少该方法时回退单头读取；且 `parseSetCookie` 现在拒绝无名 cookie（`"=; Path=/"`、`"HttpOnly"`），避免把垃圾当 cookie 发出去。
- **只与回环通信**：交换凭据前校验启动 URL 是回环（`127.0.0.0/8`、`::1`、`localhost`），否则以 `protocol-drift` 拒绝且**不发任何请求**；回环请求不传任何 `dispatcher`，因此不受 `HTTP(S)_PROXY` 影响（有"死代理仍成功"的测试）。
- **契约收紧（ADR-0004）**：`session/list#cwd` 由可选改为**必填**，`session/page` 的 `turn/end`/`assistant/message` 事件按我们实际读取的结构显式类型化（其余事件类型保持 `data: unknown`）；额外字段一律允许，缺失或类型不符即协议漂移。⚠️ **行为变更**：`cwd` 缺失的会话不再可复用（旧版本会放行复用），现在会以 `protocol-drift` 失败并给出字段路径。
- **归属 fail-closed**：无法证明会话属于本工作区（Host 未报告 `cwd` 或与工作区不一致）时拒绝复用并给出可操作提示（省略 `sessionId` 新建会话）。
- **安全不变量测试**：新增 `tests/security-invariants.test.ts`，把"声明即事实"钉成可执行断言——`src/**` 无 `shell: true`、启动路径无 `npx`、无任何代理 dispatcher、凭据模块无 IO/无 console、cookie 两条路径、契约取舍、归属 fail-closed。README 安全段同步改写为中英双语的可验证表述。

### Changed（P5：生命周期状态机与错误恢复，ADR-0003）

- **运行终态唯一**：`RunSnapshot.status` 只有 `running`/`succeeded`/`failed`/`cancelled`，并新增 `reason` 字段（仅在 `failed` 时非空）说明失败类别。终态只由 `settle()`（settle-once）写入：重复 settle 返回 `false` 且不覆盖，取消/停止/淘汰路径不会被竞态打断——不再存在"永久 `running` 只留一条 error"或"静默判成功"。
- **回合映射穷举官方 `TurnEndReasonMap`**：`completed` 是唯一成功；`blocked`→`failed(turn-blocked)`、`max-tokens`→`failed(turn-truncated)`（旧版本把两者误报为成功）；`aborted`+`user` 与用户取消 → `cancelled`，`aborted`+`parent/hook/disposed/legacy` → `failed(turn-aborted:<cause>)`；`interrupted`→`failed(turn-interrupted)`；任何未识别的原因 → `failed(turn-unknown:<kind>)`（fail-closed）。会话停止 running 却没发出终态回合 → `failed(turn-unknown:missing-turn-end)`。
- **失败分类单一来源**：`dsh/wire.ts` 是唯一的分类实现（HTTP 401/403→`auth-expired`、404→`not-found`、其余→`transport`；信封/响应 schema 漂移→`protocol-drift` 并带方法名与 JSON 路径；业务错误→`rpc:<code>`），`DshRpcError` 携带 `kind`/`method`/`rpcCode`。`run/state.ts` 只按类别决定策略：`auth` 重换凭据后重试一次、`transport` 退避重试至多 4 次、`protocol-drift`/`rpc`/未知**不重试**、调用方错误（`ENOENT`/`ENOTDIR`）原样上抛。取消"用错误信息猜类别"的正则路径。
- **`doctor.dataDirectory` 变为对象**：`{path, source, exists, writable}`，`source` 说明路径由 `DSH_MCP_DATA_DIR`/`PLUGIN_DATA`/默认值哪一层决定；仅目录已存在时才做真实可写探测（建临时文件→删除），目录不存在返回 `unknown` 且**不创建**。
- **`doctor.ready` 取四项制 + 新增 `problems`**（裁决 D-a）：`ready = engines.supported && npmCli.exists && dataDirectory.writable !== "no" && runtimePackage.error === null`，且**严格等价于 `problems` 为空数组**（`ready` 由 `problems.length === 0` 推导，二者不可能漂移）。`problems: string[]` 每项是一条"未满足的前置条件 + 可照做的修法"，至少覆盖 Node 不在区间、npm CLI 找不到/不是绝对路径、数据目录不可写、运行时包 spec 非法；`ready=false` 因此永远自带解释，`runtimePackage.error` 保留为细节层。非法 spec 重新计为 `ready=false`（此前在这点上是过度乐观的）。
- **停止/处置语义**：所有分支（含"进程已退出"早退与取消失败）都收敛并结算该服务的运行；无法确认退出时 `ServiceSnapshot.stopUnconfirmed` 为真，运行本身按 `failed(service-unreachable)` 结算。
- **测试网**：新增 `tests/unit/state.test.ts`、`tests/unit/wire.test.ts`，并把旧的 `tests/{run-manager,runtime,server}.test.ts` 按被测模块拆分为 `tests/{service,run,config,diagnostics,tools}/`；每条新路径至少有一次反向验证（把实现改回旧行为即变红，见 `reports/impl-lifecycle.md`）。

### Changed（P3：启动向量＝数据目录本地安装 + 直接 `node` 启动，ADR-0002）

- **获取与启动分离**：首次使用某个 DSH 版本时，先把精确 pin 的 `@deepseek-ai/dsh@<版本>` 安装到 `<DSH_MCP_DATA_DIR>/versions/<版本>/`（临时目录安装 → 原子改名；`.install.lock` 防并发重复安装；已安装则**一次 npm 都不调用**，可离线复用），随后启动一律为 `process.execPath <已安装包>/lib/bin.js web --no-open --port 0`。
- **不再需要 shell**：启动向量 `shell: false`，`npx`/`npx.cmd`/`cmd.exe` 从运行路径消失；由此消除 Windows 命令注入面，进程树由 4 层降为 1 层，`child.kill()` 即可收尾（平台收树仅作兜底）。实测稳态就绪由 6.43–7.47 s 降到约 3.5 s。
- **配置契约变更**：新增 `DSH_MCP_NPM_CLI`（npm CLI 的 js 绝对路径，默认由 `process.execPath` 推导）、`DSH_MCP_INSTALL_TIMEOUT_MS`（默认 `900000`，一次性安装预算）；`DSH_MCP_STARTUP_TIMEOUT_MS` 默认值改为 `180000` 且语义改为**活动重置**（子进程每产生一行输出即重置，只有静默才算超时）；`DSH_MCP_NPX_COMMAND` **移除**（仍设置时 `doctor` 报告"已废弃且被忽略"）。
- **失败可诊断**：npm 安装失败按 `ETARGET`/`E404`（版本不存在，不重试）、`ENOTCACHED`（缓存/离线，提示预热）、其余（按网络重试一次）分级，错误信息带 npm stderr 尾与可操作提示；启动失败信息带脱敏日志尾 + 运行时包路径 + npm stderr 尾。
- **停止语义**：所有分支（含"进程已退出"早退）都收敛 `status`/`stoppedAt` 并释放工作区索引；无法确认退出时写 `stopped` 但附 `stopUnconfirmed: true`，不再谎报。
- **`doctor` 扩展**：新增 `version`、`engines`（本项目自带 `^22.19.0 || >=24.0.0`，因为发布的 DSH 没有 `engines` 字段）、`runtimePackage {spec, installed, version, root, binPath, diskBytes}`、`npmCli`、`dataDirectory`、`proxy {env, noProxy}`、`deprecatedEnv`；`start_service` 快照新增 `stopUnconfirmed` 与 `runtimeRoot`。
- **⚠️ 行为变更（首跑成本）**：首次使用某版本时需一次性安装约 486 MB 运行时包（暖缓存约 1 分钟）；该成本走独立预算，**不再**计入启动就绪时间。迁移到本版本后首跑会明显变慢一次，之后启动不再触网。

### Changed（P1：分发与版本单一事实来源）

- **安装方式变更**：插件不再通过 `npx --package=deepseek-harness-for-codex@<版本>` 启动，改为**自包含启动** `node ./dist/bin.mjs`（`cwd` = 插件根目录）。因此不再存在"发布前自引用"死锁，也不会再出现"装上了插件却拉到另一版本"的静默降级。
- **构建产物自包含**：`dist/bin.mjs` 内联全部运行时依赖（约 710 kB，仅保留 `node:` 内置导入），使 Codex 把插件文件复制到自己的缓存目录（无 `node_modules`）后仍能启动。
- **版本只有一个来源**：`package.json` 为唯一权威；`src/version.ts`、`.mcp.json`、`.codex-plugin/plugin.json` 与市场载荷 `plugins/deepseek-harness/**` 全部由 `npm run version:sync` 生成，并由门禁逐字节校验。
- **市场载荷不再提交**：`plugins/deepseek-harness/` 加入 `.gitignore`，只在上一步生成（提交生成副本等于制造第二份版本事实，正是 0.3.1/0.4.0 并存事故的成因）。
- **本地安装步骤变更为**：`npm install && npm run prepare:plugin` 之后再执行 `codex plugin marketplace add <本地绝对路径>`。
- 已知限制：Codex 按插件版本缓存内容，同版本内容更新需要提升 `package.json` 的 `version`（或清理缓存目录）才会重新复制。

### Added（P1/P2：工程门禁与测试网）

- `npm run prepare:plugin`：构建 + 生成 + 全量 `check`（本地安装插件前必跑）。
- `npm run version:sync` / `npm run version:check`：生成与校验所有派生的版本元数据。
- `npm run check-metadata`：版本一致性、`files[]` 白名单、脚本门禁链、marketplace 解析、README 硬编码、`.gitignore`、`dist` 自包含与**运行期启动探针**（真拉 MCP 断言握手与工具目录）；已接入 `check` 与 `prepack`。
- 测试体系：`tests/contract/`（真实 0.2.1 wire 采集 + 脱敏回放）、夹具保真度对齐官方 wire、`tests/unit/`（运行时包安装幂等/并发/失败分级、就绪预算、进程树）、`tests/e2e/live.test.ts`（需 `DSH_LIVE=1` 的真实 smoke）、`tests/module-boundaries.test.ts`（分层落地后启用的骨架）。
- **CI 门禁**：`.github/workflows/check.yml`（`windows-latest`/`ubuntu-latest` × Node 22/24 跑 `npm ci && npm run check`）、`.github/workflows/live-smoke.yml`（仅手动触发的真实 DSH smoke）、`.github/pull_request_template.md`（自检清单）。
- 文档：`docs/architecture.md`、`docs/decisions/ADR-0001..0005`、`docs/roadmap.md`、`docs/plans/phase-4-5-refactor-plan.md`、`docs/configuration.md`（**冻结的配置契约**）、`docs/operations.md`（安装/升级/排障/验收手册）、`CHANGELOG.md`（本文件）。

### Known issues（在本版本中未修复，见路线图）

- 无运行期阻断项。（已随 P5 解决并从本清单移除：`turn/end` 的 `blocked`/`max-tokens` 被误判为成功；cookie 失效后运行可能永久停留在 `running`。详见上方 P5 Changed 段。）

（已随 P3 解决并从本清单移除：首次运行仍走 `npx` 获取 DSH；`DSH_MCP_NPX_COMMAND` 未校验而 Windows 上经 shell 启动；`doctor` 未输出版本字段。详见上方 P3 Changed 段。）

### Changed（0.4.0 协议重写：DSH 版本线与 Web RPC 适配）

- **DSH 版本线**：`DSH_MCP_HARNESS_PACKAGE` 默认值由 `@deepseek-ai/dsh@0.1.0-rc.6` 升级为 `@deepseek-ai/dsh@0.2.1-alpha.1`。
- **协议适配**：RPC 方法改用当前 DSH 路由（`workspace/create`、`session/create`、`session/projections`、`session/page`、`session/prompt`、`session/cancel`），请求改为命名参数信封 `payload.args`。
- **会话读取**：移除 `session.history`，改用 `session/projections` 的 `asOfSeq` 游标配合 `session/page` 向前分页读取。
- **认证**：新增通过 DSH 启动链接换取本机登录 cookie 的流程（`GET <启动URL>` → `303` + `set-cookie`），此后 `/api` 调用携带该 cookie。
- **浏览器**：启动参数改为 `dsh web --no-open --port 0`，默认不打开浏览器；`openBrowser` 默认 `false`。
- ~~**Windows 启动**：通过隐藏的 `cmd.exe` 执行 `npx.cmd`，并校验传入的 DSH 包名不含 shell 元字符。~~ → 已由 P3 取代（数据目录本地安装 + 直接 `node <bin.js>`，无 shell）。
- ~~**Windows 停止**：关闭时按进程树清理（`taskkill /PID <pid> /T /F`），避免 npx 派生进程逃逸。~~ → 已由 P3 取代（常规路径 `child.kill()`，平台收树仅作宽限期后的兜底）。
- **日志脱敏**：启动日志与 `logTail` 中的 `token=` 参数替换为 `[redacted]`。
- **版本元数据同步**：`package.json`、`package-lock.json`、`.codex-plugin/plugin.json`、`.mcp.json` 与 MCP 服务元数据版本一致（P1 后由生成器 + 门禁保证）。

> 本版本的未修复项统一见上方「Known issues」清单，不再重复。

## [0.3.1]

当前 npm 上的最新版本（`latest`）。

- 基于 `@deepseek-ai/dsh@0.1.0-rc.6` 的旧协议实现（`workspace.create` / `session.create` / `session.history`），无 cookie 认证流程。
- 插件市场与内嵌副本均指向 `0.3.1`。
