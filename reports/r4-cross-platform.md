# R4-3 跨平台证据包：平台条件分支清点、模拟行为证据与残余风险

- **项目**：`E:\AI\test\deepseek-harness-for-codex`（HEAD `cf04b8c`，checkout 内 `package.json` 仍写 `0.4.0`）
- **执行主机**：Windows（`win32`，当前唯一真实执行过的平台），Node v22.22.2
- **本报告的性质**：把"未验证"变成**可核对**的东西。**没有**真实 ubuntu/mac 执行；下文每一条模拟证据都显式标注 `[模拟]`。
- **本次新增**：`tests/platform/{posix-reap,opener-platform,path-platform}.test.ts`（**33 用例**，全部通过）+ 本报告
- **修订**：`rev 2`（task-34 rev 5 复核）—— §7 的两项发现都已由他人修复，本报告已更新为**已修**并记录裁定；`tests/platform/path-platform.test.ts` 的 3 处"修复前行为"标记已翻到新期望（§2 注记），并新增 3 条把裁定固化为断言；§6 的两条"空转"结论已改为**已修成真证明**。
- **未修改** `src/**`（反向验证期间的 5 次临时改动已逐条还原并校验哈希，见 §3 与 §8）

## 判定摘要

1. **能证明的**：所有 POSIX/Windows 分支的**选择行为**都可以在本机通过既有注入点驱动并断言 —— 分支互斥、argv 形状、大小写与折叠 policy、分隔符规则。
2. **不能证明的**：任何依赖真实内核/文件系统的**语义**（`/proc` 的真实内容、`pgrep -P` 是否存在、`ps -o command=` 是否截断、APFS 大小写不敏感、`kill(-pid)` 是否真的够到孙进程、POSIX 位是否生效）—— 见 §4/§5。
3. **曾发现 1 个会红的既有测试**：`tests/config/resolve.test.ts` 硬编码 `;` 分隔符，在 ubuntu/mac 列上必然失败 → **已修**（§7-A）。
4. **曾发现 1 个真实缺陷**：macOS 默认 APFS 大小写不敏感，而保护性比较在 `darwin` 上不折叠 → P0-5 的"不得指向 home"保护可被同一目录的另一种拼写绕过 → **已修**，并裁定出两种折叠 policy（§7-B）。
5. **能证明的边界要说清**：`isWithin` 的折叠在**本机不具判别力**（宿主 `path.win32.relative` 自带大小写不敏感，NEG-3' 实测），只在 ubuntu/mac 上判别 —— 这是本证据包的已知检测盲区，写在 §2 注记与 §4 末行。
6. 任务开始前工作树**并非干净**（与 briefing 不符），另有并发写入者；当时两次 `tsc` 报错来自他们的文件，从不来自 `tests/platform/**`（§8）。

---

## §1 平台条件分支清点表（完整，含行号）

"本机是否执行"= 当前 Windows 主机在这次审计/自测中是否真的走了该分支。"另一侧测试"列中 **无** 表示在此之前没有任何用例覆盖。

> **读表注记（重要）**：本列写"有测试"时，指的是**带平台注入的行为级模拟**（多为 `tests/platform/**` 与
> `tests/unit/paths.test.ts`）—— 它证明的是"**分支选择与规则**在注入平台下成立"，**不是**"该平台真的跑过"。
> 两者是两回事：前者可以在任何宿主上核对，后者只有真实 ubuntu/mac 能给。**所有"另一侧"结论的清单及其
> 不可证明项见 §5**（8 条），例如 `pgrep -P` 是否存在于 PATH、`ps -o command=` 是否截断、APFS 是否大小写
> 不敏感、`kill(-pid)` 是否够到孙进程、POSIX 位是否生效。

### `src/service/process-tree.ts`

| 行 | 分支条件 | 本机执行 | 另一侧测试（本次之前） |
|---|---|---|---|
| 80-88 | `defaultListChildren`：`platform === "linux"` → 读 `/proc/<pid>/task/<pid>/children` | 否（无 `/proc`） | **无** → 本次 `[模拟]` 覆盖其"降级安全"（`posix-reap` #8），**值读取未覆盖** |
| 89-97 | 非 win32 且非 linux（darwin/BSD）→ `spawnSync("pgrep", ["-P", pid])` | 否 | **无** → 本次 `[模拟]` 只覆盖"取不到子进程仍杀父"（#9）；`pgrep` 的 argv/存在性无法从 Windows 断言 |
| 106-122 | `killDescendants`：叶子优先递归 | 否 | 有：`tests/service/process-tree.test.ts:105-122` |
| 125-142 / 135 | `taskkillTree` → `taskkill.exe /PID n /T /F` | 是 | 有：`process-tree.test.ts:58-67, 164-168`；+ 本次互斥（#3） |
| 146-150 | `reapProcessTreeByPid`：win32 → taskkill，否则 group kill | win32 是 | 有：`process-tree.test.ts:164-194`；+ 本次（#4） |
| 151-156 | POSIX：group kill 失败 → 树遍历 → 杀 pid 本身 | 否 | 有：`process-tree.test.ts:170-194`；+ 本次互斥（#1） |
| 173 / 179-182 | `reapProcessTree`：win32 → taskkill + `child.kill("SIGKILL")` 兜底 | 是 | 有：`process-tree.test.ts:58-85`；+ 本次（#3） |
| 184-193 | POSIX：`killGroup` → 失败则 `killDescendants`+`killPid` | 否 | 有：`process-tree.test.ts:87-139`；+ 本次互斥（#1/#2） |
| 197-207 / 202 | `isProcessAlive` = `kill(pid, 0)` | 是 | 有：`process-tree.test.ts:234-239` |
| 210-218 / 212 | `commandOutput` `spawnSync(..., { windowsHide: true })` | 是（`windowsHide` 在 POSIX 无效，无行为差异） | 无（无行为分支，仅窗口属性） |
| 226-238 | `readProcessIdentity` win32 → `powershell.exe … Get-CimInstance` | 是 | 有：`process-tree.test.ts:241-251`；+ 本次（#7） |
| **239-246** | `readProcessIdentity` linux → 读 `/proc/<pid>/cmdline` | 否 | **无** → 本次 `[模拟]` 新增（#5） |
| 247 | 其余（darwin/BSD）→ `ps -o command= -p <pid>` | 否 | 有：`process-tree.test.ts:253-260`；+ 本次（#6） |

### `src/service/launch.ts`

| 行 | 分支条件 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| 68 / 85 | `detached = platform !== "win32"` | win32 是 | 有：`tests/service/launch.test.ts:124-169`（`process.platform` 注入） |
| 70 | `command = process.execPath`（无 `.cmd`、无 PATH 查找） | 是 | 有：`launch.test.ts`、`tests/metadata.test.ts:346` |
| 23 / 83 | `shell: false`（全平台字面量） | 是 | 有：`tests/security-invariants.test.ts:54`（静态扫描） |
| 24 / 84 | `windowsHide: true` | 是（POSIX 忽略） | 无（仅窗口属性） |
| 102 | `mkdirSync(serviceHome, { mode: 0o700 })` | 是（Windows 忽略 mode） | **无断言** → §4 第 5 行 |

### `src/service/browser.ts`

| 行 | 分支条件 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| 24 | `darwin` → `open <url>` | 否 | 有：`tests/service/browser.test.ts:45,55-71`；+ 本次 `[模拟]` argv 级（`opener` #7） |
| 25 | `win32` → `cmd /c start "" <url>` | 是 | 有：同上；+ 本次（#8，标题槽位置） |
| 26 | 其余 → `xdg-open <url>` | 否 | 有：`browser.test.ts:50,52`；+ 本次（#9） |
| 36-40 | `BrowserSpawnOptions` 字面量 `shell: false` | 是 | 有：`security-invariants.test.ts:54` |
| 59 | `platform ?? process.platform` 默认 | 是 | 有：`browser.test.ts:93-97`；+ 本次（#10） |
| 61 | spawn 选项 `{shell:false, stdio:"ignore", windowsHide:true}` | 是 | 有：`browser.test.ts:70`；+ 本次（#4-6） |

### `src/policy/paths.ts`

> **本表已按 task-35 的修复更新**（原表记录的是修复前的形态）。折叠规则现在集中在
> `foldForComparison(value, platform, policy)`，`FoldPolicy = "filesystem" | "win32-only"`
> （`paths.ts:20-34`），两种 policy 的平台表在 `paths.ts:22-25`。

| 行 | 分支条件 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| 22-25 | `CASE_FOLDING`：`filesystem → ["win32","darwin"]`；`win32-only → ["win32"]` | win32 是 | 有：`tests/unit/paths.test.ts:19-43`（三平台、宿主无关）；+ 本次 `[模拟]`（`path` #1-3） |
| 28-34 | `foldForComparison`：按 policy 决定是否 `toLowerCase` | win32 是 | 有：`tests/unit/paths.test.ts:19-43` |
| 45-55 | `isWithin(root, candidate, platform)`：折叠后 `relative`；**保护性**（`filesystem`） | win32 是 | 有：`tests/unit/paths.test.ts:65-82`、`layering.test.ts:34-44`；+ 本次（`path` #9/#10，其中折叠那一半在本机**不具判别力**，见 §4 末行） |
| 58-64 | `samePath(left, right, platform)`：折叠后严格比较；**保护性**（`filesystem`） | win32 是 | 有：`tests/unit/paths.test.ts:45-63`、`layering.test.ts:46-58`（显式平台）；+ 本次（`path` #1-3） |
| 81-83 | `canonicalPath(path, platform)` → `foldForComparison(resolve(...))` | win32 是 | 有（间接）：`tests/unit/data-location.test.ts:31-65`（显式平台） |
| 104-148 | `dataLocationProblems` 全部规则；平台由 `input.platform` 注入 | win32 是 | 有：`tests/unit/data-location.test.ts:31-65`（显式平台）；+ 本次（`path` #4-6） |
| 117 / 133 | `parse(...).root` 文件系统根判定 | 是 | 有：`data-location.test.ts`（显式平台用例内） |
| 122 | `dataDirectory === canonicalPath(dirname(home), platform)`（home 的**父目录**） | 是 | 有：`data-location.test.ts:61-65`；+ 本次（`path` #5b，darwin 已翻转） |
| 140 | `isWithin(dataDirectory, serviceHome, platform)`（传的是 canonical 值） | 是 | 有：`data-location.test.ts`；+ 本次（`path` #9） |

### `src/policy/orphans.ts`

| 行 | 分支条件 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| 115-118 / 117 | `canonical`：`normalize` + `\`→`/` + `foldForComparison(..., "win32-only")` —— **刻意不折叠 darwin**（§7-B 裁定） | win32 是 | 有：`tests/unit/orphans.test.ts:81-82`；+ 本次 `[模拟]`（`path` #7-8，含 policy 对照） |
| 125-133 | `identityOwnsRecord(platform = process.platform)` | 是 | 有：同上；+ 本次（#7-8） |

### `src/service/runtime-package.ts`

| 行 | 分支条件 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| 271-273 | npm 以 `node <npm-cli.js>` 启动、`shell:false`、`windowsHide` | 是 | 有：`tests/unit/runtime-package.test.ts`（注入 spawn） |
| 421 / 977 | `host === hostname()` 才认锁（跨主机不回收） | 是 | 有：`tests/run/adopt-lock.test.ts:134` |
| 806-809 / 808 | prune 的 `canonicalPath`：`foldForComparison(..., "win32-only")` —— **刻意不折叠 darwin**（任何扩大的匹配都会**真的删目录**） | win32 是 | **无直接用例**（未导出；平台参数未被测试注入）→ §4 第 4 行 |
| 937-938, 946 | 用 `canonicalPath` 判定 pidfile 是否属于本机/本版本 | 是 | 同上 |
| 990 | `pruneRuntimeVersions` 的 `platform` 参数 | 是 | 同上（经 prune 整体行为间接覆盖） |
| 545-546 / 993 | `.tmp-<rand>` 暂存 + `rm(maxRetries: 0)`（Windows `EBUSY` 容忍） | 是 | 有：`runtime-package.test.ts`（暂存与跳过） |

### 其余平台相关点

| 位置 | 内容 | 本机执行 | 另一侧测试 |
|---|---|---|---|
| `src/config/resolve.ts:71` | `DSH_MCP_WORKSPACE_ROOTS.split(delimiter)`（`;` / `:`） | 是 | 有：`tests/config/resolve.test.ts:64-67`（**已修**为 `join(delimiter)` + "另一分隔符是数据"双断言，宿主无关；见 §7-A）；+ 本次 `[模拟]`（`path` #10） |
| `resolve.ts:113-133` | npm CLI 候选：121 Windows 布局、123 POSIX 布局、130 `%APPDATA%` | 是 | 有：`tests/service/npm-cli.test.ts:55`（候选顺序，宿主无关）。**POSIX 布局在本机从不命中** |
| `src/run/journal.ts:300-301` | `mkdir 0o700` / `writeFileSync 0o600` | 是（Windows 忽略） | 有：`tests/run/journal.test.ts:215-233`（**按能力探测**，不满足即跳过） |
| `src/run/adopt-lock.ts:113,129,147` | `mkdir 0o700`、锁文件 `0o600` + `flag:"wx"`、`host` 比对 | 是（Windows 忽略 mode） | 有：`adopt-lock.test.ts:78-156`；mode 断言缺（同 §4 第 5 行） |
| `src/dsh/drift.ts:280-281` | `mkdir 0o700` / `appendFileSync 0o600` | 是（Windows 忽略） | 有：`tests/unit/drift.test.ts`；mode 断言缺 |
| `src/service/supervisor.ts:572` | pidfile `writeFileSync(..., { mode: 0o600 })` | 是（Windows 忽略） | 有：`tests/service/pidfile-orphans.test.ts`；mode 断言缺 |
| `src/diagnostics/doctor.ts:275` | 报告字段 `platform: process.platform` | 是 | 有：`tests/diagnostics/doctor.test.ts`（无分支语义） |
| `src/bin.ts:25` | `process.once("SIGTERM", …)` | 是（Windows 上 SIGTERM 语义与 POSIX 不同） | 有：`tests/security-exits.test.ts`（关闭路径） |
| `tests/support/isolation.ts:51` | 守卫自身的大小写归一 | 是 | 有：`tests/isolation.test.ts:149` |

---

## §2 本次新增的模拟证据（`tests/platform/**`，33 用例）

驱动方式**只用既有注入点**：`ReapOptions` 的 `platform`/`spawnKiller`/`kill`/`killGroup`/`listChildren`；`readProcessIdentity` 的第 2、3 个参数；`OpenBrowserOptions.platform`/`spawnImpl`；`samePath`/`isWithin`/`dataLocationProblems`/`identityOwnsRecord` 的 `platform` 参数；以及在只验证"默认参数 = 宿主"时对 `process.platform` 的临时覆盖（沿用 `launch.test.ts` 的手法）。

> **task-35 标记翻转**：本目录最初把**缺陷 B 修复前**的 darwin 行为（`samePath` 大小写敏感、
> `dataLocationProblems` 放过 home 的大小写变体）当作期望写下来，并注明"这是现状，不是它正确的声明"。
> 修复落地后 3 处标记已翻到新期望（`path` #1/#3/#5），并新增 #5b（父目录大小写变体）、#7b（policy 对照）、
> #9b（`isWithin` 折叠）把裁定固化成断言。翻转的**原因**写在测试文件头部：保护性比较折叠
> `["win32","darwin"]`，不可逆比较只折叠 `["win32"]`。

### `tests/platform/posix-reap.test.ts`（9）—— POSIX 终止路径

| # | 用例 | 断言的行为（非字符串存在） |
|---|---|---|
| 1 | POSIX reaping never reaches the Windows tree killer | `platform:"linux"` 时 `spawnKiller` 记录为空 —— `taskkill.exe` **从不被咨询**，即使失败也不会静默兜底（`taskkillTree` 会吞掉 spawn 异常，所以"抛错"不算证据，只有"零调用"才算） |
| 2 | darwin takes the same POSIX group path as Linux | darwin 走 group kill、不碰 taskkill（mac 与 linux 同类，与 win32 不同类） |
| 3 | Windows reaping never signals a POSIX process group and never walks descendants | `platform:"win32"` 时 `killGroup` 与 `options.kill` 均为空、`listChildren` 未被调用（未注入则走真实 `pgrep`/`/proc`，故用 sentinel 记录） |
| 4 | orphan reclamation by pid keeps the same split | 两条入口（有/无 `ChildProcess`）的互斥一致 |
| 5 | returns null for an absent pid and never delegates to the injected runner | `readProcessIdentity(ABSENT_PID, "linux", spy)` → `null` 且 spy 零调用：linux 分支是 `/proc` 读，**不回退** `ps`/`powershell` |
| 6 | keeps the darwin probe on `ps -o command=` | darwin 必须落在 `ps -o command=`（避免 linux 分支遮蔽它） |
| 7 | keeps the win32 probe on PowerShell | win32 必须落在 `powershell.exe`（避免两个 POSIX 分支遮蔽它） |
| 8 | reclaims the recorded pid on POSIX when /proc and the group are both unavailable | **不注入 `listChildren`**，即真正执行 `defaultListChildren(…, "linux")` 的 `/proc` 读取；在无 `/proc` 的主机上必须降级为 `[]` 并仍然杀掉记录 pid（不抛错、不静默放弃） |
| 9 | reclaims the recorded pid on darwin when its child probe cannot be run either | 同上，darwin 的 `pgrep -P` 路径不可用时必须兜底 |

### `tests/platform/opener-platform.test.ts`（11）—— opener 平台选择

| # | 用例 | 断言的行为 |
|---|---|---|
| 1-3 | hands a metacharacter URL to {darwin,win32,linux} as one untouched argv element | 用一个含 `&`/`|`/`>`/空格的 URL：URL **逐字节**只出现在一个 argv 元素里；除 URL 自身外 argv 中不出现任何 shell 元字符；`shell === false`。这是"URL 被拼进命令字符串"这一整类缺陷的行为级否定 |
| 4-6 | never lets {darwin,win32,linux} inherit our stdio or a visible window | spawn 选项恰为 `{shell:false, stdio:"ignore", windowsHide:true}` |
| 7 | darwin passes the URL as open's only argument | `open` 的 argv 恰为 `[url]`（未来若改成 `open -a <browser> <url>` 会红） |
| 8 | win32 keeps start's empty title slot | `["/c","start","",url]` 且 `args[2] === ""`、`args[3] === url`（空标题槽是位置性的，不是装饰） |
| 9 | unknown POSIX platform gets xdg-open, never the Windows vector | `freebsd` → `xdg-open`，且显式断言**不是** `cmd` |
| 10 | uses the host platform when none is injected | 无注入时 == `browserLaunch(process.platform)`，并按已知平台枚举具体程序 |
| 11 | rejects with the chosen program's name | 打开失败时不静默换平台重试（恰 1 次 spawn，且是该平台的程序） |

### `tests/platform/path-platform.test.ts`（13）—— 路径分隔符与大小写假设

| # | 用例 | 断言的行为 |
|---|---|---|
| 1 | is case-insensitive on win32 **and darwin**, case-sensitive on linux | 只差大小写的两个路径，走**默认**平台参数（生产路径）：win32 `true`、**darwin `true`（已翻转）**、linux `false`。折叠表 `paths.ts:22-25` |
| 2 | is reflexive and rejects a genuinely different directory | 三平台下自反为真、不同目录为假 |
| 3 | still uses the host platform when the override is lifted | **已翻转**：宿主默认参数 == `win32 \|\| darwin`（mac runner 上同样必须为真） |
| 4 | rejects a case-variant of the home directory on win32 | `dataDirectory` 与 `home` 只差大小写时被拒（真正的行为，不是"字段存在"） |
| 5 | rejects the case-variant on every folding platform and still allows it on linux | **已翻转**：win32/darwin 都必须报 `must not be the user's home directory`；linux 仍是 `[]`（那里两个拼写确实是两个目录） |
| 5b | also refuses the case-variant of the home directory's **parent** on folding platforms | 规则 3 的父目录分支（`paths.ts:122`）走同一 canonical 形式，必须一起翻转；linux 仍 `[]` |
| 6 | keeps the structural rules identical on every platform | 三平台下"专用目录通过 / 文件系统根被拒"一致（差异只在拼写规则） |
| 7 | accepts a differently-cased command line on win32 only | 裁定证据：该比较用 `foldForComparison(..., "win32-only")`（`orphans.ts:117`） |
| 7b | folds darwin on the protective side and not on the irreversible one, for the same two strings | 同一对字符串两个问题：`samePath(…, "darwin") === true` 而 `identityOwnsRecord(…, "darwin") === false`；win32 两侧都为真。这条把"两种 policy"直接变成可执行断言 |
| 8 | requires both the recorded bin path and the --port argument | 三平台下缺任一证据都判否（`null`/空串也判否，fail-closed） |
| 9 | isWithin is a path-segment test, not a string-prefix test | `/data` 不包含 `/database`、不接受 `/data/../etc` |
| 9b | folds a case-only difference wherever the default filesystem folds (allow-list shape) | win32/darwin 下 `/data/root/services/a` 在 `/DATA/ROOT` 内；**但本机不具判别力**（见下） |
| 10 | splits on the host delimiter and treats the other delimiter as data | 用 `delimiter` 拼的列表被正确拆分；用**另一个**平台分隔符拼的列表是**单个**条目 —— 这条规则正是 `resolve.test.ts:57` 缺失的（§7-A） |

> **#9b 的诚实限制（NEG-3' 实测发现）**：`isWithin` 通过宿主 `node:path` 的 `relative` 比较，而
> `path.win32.relative` **自带**大小写不敏感。因此在本机即使把 darwin 折叠去掉，#9b 依然为真 —— 它
> **不能**证明折叠策略，只在 ubuntu/mac（宿主 `relative` 大小写敏感）上才具判别力。本机真正具判别力的
> 是 #1/#3/#5/#5b/#7b（都不经过 `relative`）。这一点已同时写进测试文件注释与 §4 末行。

**明确不可模拟（不硬凑）**：

| 条目 | 原因 |
|---|---|
| 路径分隔符的**归一化语义** | 由宿主 `node:path` 的 `resolve`/`relative`/`normalize` 实现决定，`src/` 里没有可注入点（`samePath`/`isWithin` 只注入平台、不注入 path 实现）。在 POSIX 上 `\` 是普通文件名字符，在 Windows 上等价于 `/`，这个差异在 Windows 上无法制造 |
| `defaultListChildren` 的 darwin 分支**是否真的调用 `pgrep`** | 未导出；且"命令不存在"与"命令返回空"在 `spawnSync` 下产生同一可观察结果（`[]`） |
| `readProcessIdentity(pid,"linux")` 在真实 Linux 上**读出的值** | 依赖真实 `/proc`；本机只能证明"分支被选中且失败时 fail-closed" |
| `isWithin` 的**折叠判别力** | 见上注：被宿主 `relative` 的大小写行为掩盖；本机无法制造一个"去掉折叠就会红"的 `isWithin` 用例 |
| `canonicalPath`（`runtime-package.ts:808`）的独立行为 | 未导出；只能经 `pruneRuntimeVersions` 的证据树整体进入，构造 `versions/ + services/ + pidfile` 证据树的成本超出本任务预算（**非**不可模拟，属未补） |

---

## §3 反向验证（5 条，原始输出 + 还原哈希）

第一轮 3 条（NEG-1/2/3）覆盖任务要求的三类：POSIX 终止路径、opener 平台选择、大小写假设。
第二轮 2 条（NEG-3'/NEG-4）是针对 task-35 修复后的实现重做的，用来证明**翻转后的标记**与**两种折叠 policy**都是承重的。

方法：记录哈希 → 改坏实现 → 目标用例必须红 → 还原 → 哈希必须逐字节相等 → 复跑绿。

### NEG-1 POSIX 终止路径

改动：`src/service/process-tree.ts` 的 `reapProcessTree` 忽略 `options.platform`（`const platform = "win32"`）。

```
 × … > POSIX reaping never reaches the Windows tree killer
   → expected [ [ 'taskkill.exe', '/PID', …(3) ] ] to deeply equal []
 × … > darwin takes the same POSIX group path as Linux, not the Windows one
   → expected [ [ 'taskkill.exe', '/PID', …(3) ] ] to deeply equal []
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```
- 还原哈希：`729C7DED3ABAF58B477DE1EC5EBEE0AE69276A0074E8E3BC7E18656FB6EE99CE`（= 改动前，一致）
- 还原后复跑：`Test Files 1 passed (1) / Tests 9 passed (9)`

### NEG-2 opener 平台选择

改动：`src/service/browser.ts:24` 的 darwin 向量 `open` → `xdg-open`。

```
 × … > darwin passes the URL as open's only argument (no browser selection, no extra flags)
   → expected 'xdg-open' to be 'open' // Object.is equality
 × … > rejects with the chosen program's name, so a failure names the platform vector
   → expected 'xdg-open' to be 'open' // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 9 passed (11)
```
- 还原哈希：`DAD5E5C7E5E1A80139023186C53C8A3BC39905F6AB1C510044C1F7C0A67538F2`（一致）
- 还原后复跑：`Tests 11 passed (11)`

### NEG-3 大小写假设（第一轮，针对修复前的实现）

改动：`src/policy/paths.ts:20` 去掉 win32 折叠（只留 `first === second`）。

```
 × … > is case-insensitive on win32 and case-sensitive on linux and darwin
   → expected false to be true // Object.is equality
 × … > still uses the host platform when the override is lifted
   → expected false to be true // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```
- 还原哈希：`1AD8294234CAB591C029CB05118661D7587D3A87F653EB620C0EBB11BBB7E0F5`（一致）
- 还原后：`git diff HEAD --` 三个文件为空；全套 `Tests 30 passed (30)`（当时本目录共 30 条；rev 2 复核为 33 条）
- ⚠️ **该哈希与行号已作废**：`paths.ts:20` 那一行在 task-35 修复后不存在了（折叠集中到了
  `foldForComparison`）。下面的 NEG-3'/NEG-4 是针对**当前**实现重做的，基线哈希见每条。

### NEG-3' 保护性折叠丢掉 darwin（标记翻转后的重做）

改动：`src/policy/paths.ts:23` `filesystem: ["win32", "darwin"]` → `filesystem: ["win32"]`。

```
 × … > is case-insensitive on win32 and darwin, case-sensitive on linux
   → expected false to be true // Object.is equality
 × … > rejects the case-variant on every folding platform and still allows it on linux
   → darwin: the case-variant must be refused: expected '' to match /must not be the user's home directory/u
 × … > also refuses the case-variant of the home directory's *parent* on folding platforms
   → darwin: the parent case-variant must be refused: expected '' to match /must not be the parent of the user's…/u
 × … > folds darwin on the protective side and not on the irreversible one, for the same two strings
   → expected false to be true // Object.is equality
 Test Files  1 failed (1)
      Tests  4 failed | 9 passed (13)
```
- **`isWithin` 的折叠用例（#9b）没有红** —— 这正是本机 `path.win32.relative` 自带大小写不敏感造成的掩盖，
  已作为诚实限制写进测试注释、§2 注记与 §4 末行。
- ⚠️ **还原方式**：`paths.ts` 此时已被 launch-impl 修改（`git status` 显示 ` M`），**不能**用
  `git checkout --`（那会毁掉他的修复）。改用**精确 edit 反向改回**，并以哈希验收：
  还原后 `0FEE82F9F5B657D35891A40608866F7518E728FCB19FC021EB23F1727FA61258`（= 改动前，一致），
  且 `Select-String 'filesystem: \['` 仍为 `["win32", "darwin"]`；复跑 `Tests 13 passed (13)`。

### NEG-4 不可逆比较被放宽到 darwin

改动：`src/policy/orphans.ts:117` `"win32-only"` → `"filesystem"`（即把"允许真的 signal 进程"的比较放宽）。

```
 × … > accepts a differently-cased command line on win32 only
   → expected true to be false // Object.is equality
 × … > folds darwin on the protective side and not on the irreversible one, for the same two strings
   → expected true to be false // Object.is equality
 Test Files  1 failed (1)
      Tests  2 failed | 11 passed (13)
```
- 还原（同样是精确 edit，`orphans.ts` 也是 dirty）：`8C48DB24E379F6336F6210733F2F3FFE65B53C18BD156AEF2D87522E350747DA`（= 改动前，一致），
  `orphans.ts:117` 仍为 `"win32-only"`；复跑 `Tests 13 passed (13)`。
- 意义：这条把 task-35 的裁定（两种 policy）变成**可执行**约束 —— 谁把不可逆比较放宽到 darwin，测试立刻红。

---

## §4 残余风险表（逐条可核对）

| # | 只有真实平台能验证什么 | 若失败会以什么形式暴露 |
|---|---|---|
| 1 | **mac/linux `pgrep -P`**：是否在 PATH 上、是否只列直接子进程、是否要求 `-P` 与 pid 之间有空格 | `spawnSync` 错误被吞 → `defaultListChildren` 返回 `[]` → 后代树不遍历 → `dsh-subprocess-local` 孙进程存活并占端口。暴露：`stop_service` 报 stopped 但 `lsof -i :<port>` 仍显示监听；下次 `doctor.orphans` 报 unverified/或端口冲突导致新服务绑定失败 |
| 2 | **mac `ps -o command=` 的格式与截断**：macOS 的 `ps` 默认按终端宽度截断（需 `-ww`），非 tty 下的宽度上限未知 | 截断后 `identityOwnsRecord`（要求同时含 `binPath` 与 `--port`）为 false → `orphanState` = `unverified` → **fail-closed：不误杀**，但孤儿永不被回收。暴露：`doctor.orphans` 在多次重启后仍非空，且提示语为 "unverified" 而非 "stale-pidfile" |
| 3 | **mac `open <url>`**：无 GUI 会话（SSH/launchd 上下文）时是否返回非 0（典型 `LSOpenURLsWithRole() failed`） | `openInDefaultBrowser` reject → `service.browserError` 被填入（已按 `redactFailure` 脱敏）→ 工具结果里 `browserOpened:false`。**不会**影响服务可用性（`--no-open` 是默认路径） |
| 4 | **APFS 大小写不敏感 vs 折叠策略**：卷是否真的大小写不敏感（`diskutil info / \| grep -i "Case-sensitive"`）；以及 darwin 上**刻意不折叠的两处**在真实 mac 上留下什么残留 | (a) 保护性比较（`samePath`/`isWithin`/`dataLocationProblems`，policy `filesystem`）现在 darwin 也折叠 → "放过 home 大小写变体"的绕过**已修**（§7-B）；(b) `identityOwnsRecord`（`orphans.ts:117`，policy `win32-only`）在默认 APFS 上遇到大小写不同的命令行 ⇒ `unverified` ⇒ **不杀**（fail-closed，代价：孤儿可能永不被回收 —— 暴露为 `doctor.orphans` 长期非空且状态为 unverified 而非 alive）；(c) prune 的 blocker（`runtime-package.ts:808`，同样 `win32-only`）⇒ 判为 `pidfile-foreign`/`pidfile-binpath-mismatch` ⇒ **少删/不删**（fail-closed，暴露为 prune 报告 skipped 增加、磁盘不回收）。只有真实 mac 能确认这些残留是否真的出现 |
| 5 | **POSIX 权限位**：`0o700`/`0o600`（`launch.ts:102`、`journal.ts:300-301`、`adopt-lock.ts:113,129`、`drift.ts:280-281`、`supervisor.ts:572`）在真实 POSIX 上是否真的成立，且**原子 rename 后**目标文件仍是 0600 | Windows 忽略 mode（由用户 profile ACL 保护）；POSIX 上若被 umask/挂载选项削弱，暴露为 `stat -c %a` 显示 0644，凭证/锁/pidfile 对其他本机用户可读。`journal.test.ts:228-230` 已按"文件系统是否兑现 mode"探测，Windows 上该断言被跳过 |
| 6 | **`kill(-pid)` 是否真的覆盖整棵树**：依赖 `detached:true` 使子进程成为组长；而 DSH 自身会再 spawn `dsh-subprocess-local`，孙进程是否留在同组未知 | 若孙进程自建进程组，group kill 命中不到它 → 只能靠 `pgrep` 树遍历兜底（回到第 1 行）。暴露同第 1 行 |
| 7 | **Windows `powershell.exe` + `Get-CimInstance Win32_Process`**：在受限语言模式/被策略禁用时的行为 | `commandOutput` 捕获异常/空输出 → `readProcessIdentity` 返 `null` → unverified → **不回收**（fail-closed）。暴露：`doctor.orphans` 恒为 unverified，孤儿服务与端口长期残留 |
| 8 | **Windows 的 `kill(pid, 0)` 语义**（`process-tree.ts:202`、`adopt-lock.ts:15`）：对其它用户/受保护进程可能返回 `EPERM` 而非 `ESRCH` | 被当作"死"→ 锁被判定为 stale 并打破（`adopt-lock.ts`）或 pidfile 被判 stale。真实 Windows 上可用 `tasklist /FI "PID eq <n>"` 交叉核对；本报告未做该核对 |
| 9 | **CI 三平台列是否真的会跑绿** | `.github/workflows/check.yml:33-41` 声明 windows-latest / ubuntu-latest(22,24) / macos-latest，但 checkout 内**没有任何一次真实运行的证据**。已知会红的宿主绑定用例（`tests/config/resolve.test.ts`）**已修**（§7-A），但那只是"已知的一颗"；mac 列真正要覆盖的是 §5 第 1-4 条，它们的首次真实执行仍未发生 |
| 10 | **本证据包自带的检测盲区**：`isWithin` 的折叠判别力（见 §2 注记） | 无平台能"验证一个盲区"——它是**测量限制**，不是待验证行为。本机 `path.win32.relative` 自带大小写不敏感，掩盖了 `isWithin` 内的折叠；若将来有人删掉 `isWithin` 的折叠，**本机不会红**（NEG-3' 实测：#9b 仍绿）。消除该盲区只能靠 ubuntu/mac 列（宿主 `relative` 大小写敏感）——在那之前，`isWithin` 的折叠只由 `samePath` 与 `dataLocationProblems` 间接担保 |

**没有出现的措辞**：本报告不使用"应该没问题"；上表每行都写明"未验证"与失败暴露形式。

---

## §5 以下条目至今**从未**在真实 ubuntu/mac 上执行过

本节是验收要求的一节，逐条列出**没有真实平台执行证据**的东西：

1. `src/service/process-tree.ts` 的**全部 POSIX 分支**：`defaultListChildren` 的 `/proc` 读（:81-88）与 `pgrep -P` 回退（:89-97）、`killDescendants`（:106-122）、`reapProcessTreeByPid` 的 group-kill 路径（:151-156）、`reapProcessTree` 的 group→descend→pid 路径（:184-193）、`readProcessIdentity` 的 `/proc/<pid>/cmdline`（:239-246）与 `ps -o command=`（:247）。
2. `src/service/launch.ts:85` 的 `detached: true`（POSIX 侧）及其与 `kill(-pid)` 的耦合。
3. `src/service/browser.ts:24` 的 `open <url>`（darwin）与 `:26` 的 `xdg-open <url>`（linux/BSD）：两者都只被 argv/行为模拟覆盖。
4. `src/policy/paths.ts` 与 `src/policy/orphans.ts` 在 POSIX 上的**分隔符语义**：`\` 是普通字符、`relative` 大小写敏感、`parse().root === "/"`。
5. `src/config/resolve.ts:71` 的 `split(":")` 行为、`:123` 的 POSIX npm CLI 布局候选是否真的存在。
6. POSIX 权限位：`0o700`/`0o600` 是否兑现（含 rename 之后）。
7. **本目录的 33 条用例全部是模拟证据**（`tests/platform/**`），它们证明"分支选择与 argv/规则"在模拟下成立，**不**证明真实 ubuntu/mac 上的运行结果。其中 1 条（`isWithin` 折叠，#9b）在本机**连判别力都没有**（见 §2 注记）。
8. CI：`.github/workflows/check.yml` 的 ubuntu/macos 列在本 checkout 内没有任何执行记录；macos 列要覆盖的三件事（无 `/proc` 时的 `pgrep -P` 回退、`ps -o command=`、`open`、大小写不敏感文件系统）恰好就是第 1-4 条。

---

## §6 既有"平台模拟"用例审查（是否有空转）

| 用例 | 判定 | 说明 |
|---|---|---|
| `tests/service/launch.test.ts:124-169` | **真实**（不是空转） | 用 `process.platform` 覆盖驱动 `detached`，断言的就是平台差异本身；但每侧只在"被注入的那次"成立，宿主真值由 `:117` 单独覆盖 |
| `tests/service/browser.test.ts:44-71` | **真实** | 三平台向量 + spawn 选项，断言行为 |
| `tests/service/process-tree.test.ts:57-195` | **真实** | 每条分支都断言"调用序列/参数"，非字符串存在 |
| `tests/unit/orphans.test.ts:81-82` | **真实** | 显式传 `platform`，win32 `true` / linux `false` |
| `tests/unit/paths.test.ts`（task-35 新增） | **真实，且是标准形态** | 全部断言显式传 `platform`，无 `process.platform` 覆盖；三平台并行、宿主无关。**这是折叠规则的第一证据源** |
| `tests/unit/layering.test.ts:46-58` | **已从"宿主绑定"修成真证明**（task-35） | 原先是 `if (process.platform === "win32") … else …`（每侧只能验一半）。现在 `samePath(upper, lower, "win32")===true`、`("darwin")===true`、`("linux")===false` 三条**显式平台**断言，默认参数仅作最后一行补充 —— 不再依赖宿主 |
| `tests/unit/data-location.test.ts:25-65` | **已从"空转"修成真证明**（task-35） | 原先的大小写断言**没传 `platform`**：在 Windows 上证明折叠，在 POSIX 上同一输入**也**返回 `[]` 但原因完全不同（根本没匹配上 home），断言绿而不再证明注释声称的事。现在显式分平台：win32/darwin 一律被拒（含 home 的**父目录**变体），linux 一律 `[]` —— 与 `tests/platform/path-platform.test.ts` #4/#5/#5b 形成互证 |
| **`tests/config/resolve.test.ts`（原 `:57`）** | **曾会红的宿主绑定 → 已修** | 硬编码 `;` 的那条已改为 `join(delimiter)` 双断言（现 `:64-67`）；见 §7-A |

---

## §7 首轮交付的两项发现（**均已修**，含裁定记录）

### A. `tests/config/resolve.test.ts` 的宿主绑定分隔符断言 → **已修**（本轮复核确认）

**原始缺陷**（当时 `:57`）：
```ts
expect(resolveAllowedRoots({ DSH_MCP_WORKSPACE_ROOTS: "C:\\a;C:\\b" })).toEqual(["C:\\a", "C:\\b"]);
```
`resolveAllowedRoots` 用 `node:path#delimiter` 拆分（`src/config/resolve.ts:71`）：Windows `;`、POSIX `:`。本机实测：

```
win32 delim= ";"
win32 (;): ["C:\\\\a","C:\\\\b"]      ← 2 个元素，用例绿
posix (:): ["C","\\\\a;C","\\\\b"]     ← 3 个元素，用例红（且第三段被驱动盘冒号切碎）
```
（输出为 PowerShell 转义后的显示，元素个数与切分位置即结论。）

**现状**：该断言已改为宿主无关形态（`tests/config/resolve.test.ts:64-67`）——
`["/a","/b"].join(delimiter)` 必须拆成两项，而**另一个**平台的分隔符必须被当成数据（`["/a${other}/b"]`）。
这与本目录 `tests/platform/path-platform.test.ts` #10 是同一规则的两处独立断言，互为印证。

### B. macOS 默认 APFS 上，P0-5 的"不得指向 home"保护可被大小写变体绕过（真实缺陷）→ **已修**（task-35，含裁定）

**原始缺陷**：`dataLocationProblems` 只在 `platform === "win32"` 时折叠大小写（当时 `paths.ts:34-37`）；`samePath` 同理（当时 `:20`）；`orphans.ts`、`runtime-package.ts` 同一模式。在 **darwin** 上 `canonicalPath` 不折叠，而默认 APFS 卷大小写不敏感 → `/Users/Bob` 与 `/Users/bob` 是**同一个目录**，但守卫看不出；`DSH_MCP_DATA_DIR=/Users/Bob` 不会被拒 → Harness 会把 `profiles/`、`storages/`、`.credentials.yaml` 写进用户 home，正是 P0-5 记录的那次事故。

**修复与裁定**（task-35 §3）：折叠规则集中到 `foldForComparison(value, platform, policy)`（`src/policy/paths.ts:20-34`），平台表 `CASE_FOLDING`（`:22-25`）分两种 policy：

| policy | 平台 | 用于 | 站点 |
|---|---|---|---|
| `"filesystem"`（默认） | `win32`, `darwin` | **匹配越多 = 拒绝越多**的保护性比较 | `isWithin`（`:45-55`）、`samePath`（`:58-64`）、`canonicalPath`→`dataLocationProblems`（`:81-83`, `:104-148`）、workspace 白名单 |
| `"win32-only"` | `win32` | **匹配越多 = 动作越多**的不可逆比较（真的 signal 进程 / 真的删目录），**刻意不折叠 darwin** | `identityOwnsRecord`（`src/policy/orphans.ts:117`）、prune 的 blocker（`src/service/runtime-package.ts:808`） |

裁定理由（Lead）：护栏的契约是"身份不可证就不杀""没把握就不删"，任何**扩大**匹配的都是**放宽**不可逆面；在这一点上先前的预判被否决。

**我的标记**：`tests/platform/path-platform.test.ts` 的 3 处标记已翻到新期望（#1 darwin `true`、#3 宿主默认含 darwin、#5 darwin 必须进 `problems`），并新增 #5b（home 的**父目录**大小写变体）、#7b（policy 对照：同一对字符串在保护侧 `true`、在不可逆侧 `false`）、#9b（`isWithin` 折叠，附其在本机不具判别力的限制）。翻转原因写在测试文件头部与 §2 注记。

**剩余（有意为之，非缺陷）**：darwin 在不可逆两处仍不折叠 → §4 第 4 行 (b)/(c) 的 fail-closed 残留（孤儿可能不被回收、prune 少删）；只有真实 mac 能确认这些残留是否真的出现。

---

## §8 自测、约束遵从与并发工作树说明

**自测（任务指定的两条，rev 2 复核）**
- `npx vitest run tests/platform` → `Test Files 3 passed (3) / Tests 33 passed (33)`（标记翻转后复跑多次一致）
- `npx tsc --noEmit`（仓库级）→ **rev 2 时 `exit=0`**。第一轮交付时曾不绿，原因**不在本任务范围**：当时工作树已有并发写入者的在飞文件（`M src/dsh/events.ts`、`M src/run/{orchestrator,registry,types}.ts`、`?? tests/release/`、`?? scripts/sbom.mjs` 等）。观测序列：
  1. 03:11 `npx tsc --noEmit` → `exit=0`（当时干净）
  2. 03:13 `tests/unit/events.test.ts`（mtime 03:13:30，他人）报 5 条 `TS2345`（`events.test.ts:234,290-293`），与 `src/dsh/events.ts` 的 +87 行改动（mtime 03:09:27）相关 → 03:13:45 被其作者修好
  3. 03:14 出现 `tests/release/workflow.test.ts(59,12): error TS2304: Cannot find name 'findSuspiciousStrings'`（他人新建文件）→ 随后自行消失
  4. rev 2 复核：`npx tsc --noEmit` → `exit=0`
  - `tests/platform/**`、`src/service/process-tree.ts`、`src/service/browser.ts`、`src/policy/{paths,orphans}.ts` **从未出现在任何一次 tsc 报错中**。
- 为把"我的范围是否干净"变成可核对的事实，另跑了一次**隔离编译**（不加载项目的其它文件）：
  ```
  npx tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess \
    --exactOptionalPropertyTypes --esModuleInterop --skipLibCheck \
    --target ES2023 --module NodeNext --moduleResolution NodeNext \
    --types node,vitest/globals tests/platform/*.test.ts
  → exit 0（无 error TS）
  ```

**反向验证的还原方式在 rev 2 发生了变化（重要）**
- 第一轮（NEG-1/2/3）改的三个文件当时相对 HEAD **干净**，因此用 `git checkout -- <file>` 还原即可，并以哈希验收。
- 第二轮（NEG-3'/NEG-4）改的 `src/policy/paths.ts` 与 `src/policy/orphans.ts` **已带有 task-35 的修复**（`git status` 显示 ` M`）。此时 `git checkout --` 会**毁掉修复**，所以改用**精确 edit 反向改回**，并逐条以哈希验收：
  - `paths.ts` → `0FEE82F9F5B657D35891A40608866F7518E728FCB19FC021EB23F1727FA61258`（= 改动前）
  - `orphans.ts` → `8C48DB24E379F6336F6210733F2F3FFE65B53C18BD156AEF2D87522E350747DA`（= 改动前）
  - 还原后均复跑 `Tests 13 passed (13)`，并确认 `filesystem: ["win32","darwin"]` 与 `"win32-only"` 仍在原位。

**约束遵从**
- 写入仅限 `tests/platform/**`（3 个新文件）与 `reports/r4-cross-platform.md`；未动 `README*`、`docs/**`、其它 `tests/**` 目录、`package.json`、`scripts/**`、`.github/**`；未新增依赖；未 commit；未跑 `npm run check`。
- `src/**` 仅在反向验证期间被临时改动 5 次，**全部已还原并逐字节校验哈希**（§3）；对他人已修改的文件不使用 `git checkout`。
- 新增测试文件顶部均 `import "../support/isolation.js";`（`tests/isolation.test.ts:53-63` 的守卫扫描要求）。

**给 lead 的三点提醒**
1. 本报告按任务写权写入**项目内** `reports/`（与既有 `reports/r3-coverage-and-properties.md` 同族）。若你要的是 `E:\AI\test\reports\`，请告知，我移动（当前路径：`E:\AI\test\deepseek-harness-for-codex\reports\r4-cross-platform.md`）。
2. 首轮 briefing 说"树干净"，实际不是（§8 观测序列 1 之前的 `git status` 已列出 4 个已修改文件与 5 个未跟踪条目）；当时 `tsc` 的红点因此有噪声，验收时请以"文件归属"而不是"退出码"归因。
3. **仍然没有真实 ubuntu/mac 的执行记录**：§5 的 8 条一条都没变，包括 CI macos 列的首次真实运行。本报告做的只是把"未验证"变成可核对。
