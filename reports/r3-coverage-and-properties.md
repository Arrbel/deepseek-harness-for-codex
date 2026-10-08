# R3-6：coverage 基线（非门禁）+ 定向属性测试

任务：task-28 · 执行者：`layering-impl` · 时间：2026-10-09 02:10–02:25 +08:00

| 验收项 | 结果 |
|---|---|
| `npm run coverage`（非门禁，未接入 `check`） | ✅ 新增 devDependency `@vitest/coverage-v8@4.1.10` + 脚本 `coverage` |
| 分层覆盖率基线 | ✅ §1：总计 **88.38% stmts / 84.61% branch / 88.25% funcs / 91.07% lines**，含 10 个目录分层表 |
| 低覆盖高风险清单（可推翻候选） | ✅ §2：6 个文件，含**实测未覆盖行号**与"值不值得补"的成本判断 |
| 属性测试 ≥4 组 | ✅ **4 组 63 条断言**（`tests/property/**`，5 个文件、69 个用例） |
| 反向验证 ≥2 条 | ✅ **4 条**，全部"改坏→红→逐字节还原"（§4） |
| 结论与建议（成本/收益） | ✅ §6：2 个值得下一步做，5 个明确不值得 |
| `npm run check` 影响面说明 | ✅ §5（**未运行** `check`，按指令） |
| 未验证项 | ✅ §7 |

> **本次任务发现 2 个真实契约违约 + 1 处死代码重复**（§3），全部是**跑出来的**，不是读出来的。发现未修（`src/**` 不在写权内），已用 `it.fails` 钉住。

---

## 0. 先说结论：这个基线可信在哪、不可信在哪

**必须前置的警告：本次任务期间另一个写者正在并发修改 `src/**`。**

开工时仓库干净于 `a5bd5a9`；任务结束时 `git status` 显示 8 个 `src/**` 文件被修改、5 个新模块（`dsh/drift.ts`、`dsh/matrix.ts`、`run/{journal,reconcile,adopt-lock}.ts`）出现，测试文件从 **31 → 42** 个，用例从 **507 → 657** 个。因此：

1. **不存在"一个"基线**——同一个 `npm run coverage` 在两次运行之间测的是两棵不同的树。§1 给出两个采样并各自标注了它测的是哪棵树。
2. **我的贡献可以精确归因**：在同一棵树上跑两次（含/不含 `tests/property/**`），差值就是属性测试的贡献（§1.3）。这是唯一诚实的口径。
3. 结束时**全仓有 1 个红测试**，且与本次改动无关：`tests/diagnostics/doctor-doc.test.ts` 报 README 文档列出的 doctor 字段里有 `contract`，而当前 `src/diagnostics/doctor.ts` 不再输出它。这是并发写者 `doctor.ts` 的**在飞工作**（`README*` 与 `doctor.ts` 都在我的写权之外），我**没有**去改任何一边。

记录在案的被测树状态：`E:\AI\test\.verify-scratch\r3-src-hashes.txt`（40 个 `src/**/*.ts` 的 SHA256 前 12 位）。原始日志：`r3-coverage-run1.txt`（开工采样）、`r3-coverage-A-with-props.txt`、`r3-coverage-B-without-props.txt`、`r3-property-final.txt`。

---

## 1. 覆盖率基线

### 1.1 配置（新增，非门禁）

`vitest.config.ts`（新文件，本任务创建的第二个文件）：

```ts
test: {
  coverage: {
    provider: "v8",
    reporter: ["text", "json-summary"],
    reportsDirectory: "coverage",   // 已在 .gitignore 中
    reportOnFailure: true,          // 红测试时也要出数字；不改变任何退出码
    include: ["src/**/*.ts"],       // 含"没有任何测试 import 的模块"——空模块正是基线该暴露的
    exclude: ["src/version.ts", "**/*.d.ts"],
  },
}
```

`package.json` 只加两处：脚本 `"coverage": "vitest run --coverage"`、devDependency `"@vitest/coverage-v8": "4.1.10"`。
**刻意不做的事**：不设 `thresholds`（非门禁脚本里的阈值是惰性的；接进 `check` 则会逼迫写"把行跑一遍"的填充测试）；不设 `test.include`（保证本文件**不可能**改变测试发现范围）；不接 `check`。

> `reportOnFailure` 是为这次基线加的：并发写者让树上有 1 个红测试，而 vitest 默认在红时**不打印**覆盖率表。对一个诊断命令来说，"红了也要给数字"是正确行为，且它不改变退出码。

### 1.2 分层基线（采样 A：当前树，42 文件 / 657 用例，含属性测试）

| 层 | % Stmts | % Branch | % Funcs | % Lines | 判断 |
|---|---|---|---|---|---|
| **All files** | **88.38** | **84.61** | **88.25** | **91.07** | 中上；差距集中在 service/run |
| `src`（`bin.ts`） | 0 | 0 | 0 | 0 | 设计如此，见 §2.1 |
| `src/app` | 95.65 | 89.65 | 92.85 | 95.65 | 好 |
| `src/config` | 95.55 | 97.61 | 84.61 | 95.23 | 好（funcs 低是 `config/types.ts` 纯类型） |
| `src/diagnostics` | 95.45 | 89.47 | 100 | 96.34 | 好 |
| `src/dsh` | 97.15 | 94.07 | 100 | 99.06 | 最好 |
| `src/policy` | 99.45 | 95.12 | 100 | 99.34 | 最好（纯函数，属性测试又加固了一遍） |
| `src/run` | 85.43 | 81.62 | 90.35 | 89.40 | **偏弱** |
| `src/service` | 84.98 | **76.21** | 81.31 | 88.28 | **最弱，且是最危险的层** |
| `src/tools` | 100 | 88.88 | 100 | 100 | 好（分支低来自 catalog 的可选字段） |
| `src/util` | 84.61 | 76.47 | 86.66 | 84.37 | **偏弱**（样本小，见 §2.4） |

**为什么"service 层最弱"值得单独说**：这一层是唯一真正碰操作系统的地方（子进程、进程树、npm、文件锁、版本目录重命名），也是最不可能靠 code review 发现回归的地方。它的分支覆盖率 76.21% 与 `src/policy` 的 95.12% 之间的差距，恰好就是"纯函数 vs 系统调用"的差距。

### 1.3 属性测试的贡献（同树 A/B 对照，可精确归因）

| | 文件 | 用例 | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|---|---|
| **B** 不含 `tests/property/**` | 37 | 588 | 88.08 | 84.00 | 88.25 | 90.82 |
| **A** 含属性测试 | 42 | 657 | **88.38** | **84.61** | 88.25 | **91.07** |
| **差值（我的贡献）** | +5 | +69 | **+0.30 pp** | **+0.61 pp** | 0.00 | **+0.25 pp** |

逐层差值：`src/dsh` 95.85→97.15（stmts）/ 92.52→94.07（branch）；`src/service` 84.76→84.98 / 75.46→76.21；其余各层**完全相同**。

**这个差值小，是对的，而且我会把话说清楚**：属性测试打的是 `wire`/`package-spec`/`readiness`/`state` 四个**纯函数**模块，而它们在属性测试之前就已经是 95–100%。属性测试在这里买到的**不是覆盖率，是"不变量"**——`0.61 pp` 的分支增量是副产品。一个把属性测试写成"为了数字"的任务，会去挑低覆盖的文件（`process-tree.ts`、`runtime-package.ts`）；我没有，因为那些文件的缺口是**平台边界与失败注入**，不是"生成式输入能咬住的数学性质"（§2 逐条说明）。

### 1.4 开工时的采样（对不上的原因）

开工第一个采样（31 文件 / 507 用例）为 `88.38 / 84.49 / 87.17 / 90.51`。它与 §1.2 的 `88.38 / 84.61 / 88.25 / 91.07` **不可直接比较**：那 11 个测试文件与 5 个新 `src` 模块是并发写者在窗口内加入的，两个采样测的是不同的树。列在这里只为留下时间线，不作为 delta 的依据。**唯一可用于归因的对照是 §1.3。**

---

## 2. 低覆盖 + 高风险清单（先量化，再定向）

排序口径：**先按绝对缺口**（未覆盖分支数 × 该文件的重要性），再看百分比。百分比对小文件会骗人——`src/util/errors.ts` 只有 9 条语句，掉 4 条就显示 55%，但它不是风险。

未覆盖行号由 `coverage-final.json` 的 `statementMap` 反查（不是直接读 `s` 的键——那是**语句 ID**，不是行号；按 ID 读会把注释行和类型行误报成缺口）。

### 2.1 值得下一步投入的 2 个（按 ROI 排序）

**① `src/service/runtime-package.ts` — 82.0% stmts / 73.5% branch，绝对缺口最大（75 条语句 / 63 个分支未覆盖，417 条语句）**

但**先做的不是补测试，是删死代码**。实测发现：

- `runtime-package.ts:59-91` 的 `findNpmCli` / `resolveNpmCli` 与 `src/service/npm-cli.ts:16-47` 是**逐字节重复的实现**；
- `grep` 全仓：**没有任何文件**从 `runtime-package.js` 导入这两个函数（`doctor.ts`、`supervisor.ts`、5 个测试文件全部从 `npm-cli.js` 导入）；
- 也就是说这两个导出是**死代码**，而且是**未被覆盖**的死代码——`runtime-package.ts` 未覆盖行 `60-96` 的绝大部分正是它们。

删掉它们（约 35 行）预计把该文件语句覆盖率从 82.0% 抬到 **≈87%（+5 pp）**，**一行测试都不用写**；同时消除"两处实现同一策略、其中一个没人测"的漂移风险——这正是本仓库在别处反复强调的"单一实现"原则（见 `dsh/wire.ts` 头部注释）。我**没有**动手，因为 `src/**` 不在写权内。

剩下的真实缺口才是值得补的：`845-846, 863-879`（`installedPackageDirs` 的 scoped-package 遍历与两次 `catch`）、`1040, 1060-1062, 1087, 1127-1130`（版本目录重命名/prune 的失败分支）、`377, 407-467`（`classifyNpmFailure` 的部分 npm 错误分类）。**补法**：给 `installedPackageDirs` 用真实临时目录 + 一个"读不了的 scope 目录"（权限/删掉）来打 `catch`；给 prune 打"staging 目录被第三方占用"的分支。这些是**注入式**测试，不是属性测试。

**② `src/service/process-tree.ts` — 78.3% stmts / 59.2% branch（全仓最低分支覆盖）**

未覆盖行：`30, 37`（`waitForExit` 的 promise 内部：`finish` 的幂等守卫与 `onClose` 回调——说明只测过"已退出"的快速路径）、`76-96`（POSIX `defaultListChildren` 的两个实现体与 catch）、`107, 130`、`216, 240-244`（`taskkill` 与强杀路径）。

**关键判断：这个文件"低覆盖"里有一半是不可得的，也不该追。** 文件头自己写明了边界（`reports/fix-process-lifecycle.md`）：POSIX 分支在 Windows 上无法真实执行，所以用 `platform: "linux"/"darwin"` + `killGroup`/`listChildren` 注入来测——`tests/service/process-tree.test.ts` 已经有 5 处这样的注入。真正剩下的是：
- `waitForExit` 的**事件驱动**路径（`30, 37`）——**这个值得补**，用注入一个"永不退出"的假 child（`once`/`removeListener` 打桩 + `setTimeout` 触发），断言超时返回 `false` 且监听器被摘掉（否则是监听器泄漏）。这是纯注入式，跨平台可测。
- `taskkill` 失败/超时的分支（`240-244`）——**值得补**，注入 `spawnKiller` 返回一个立刻 `error` 的 handle。
- `defaultListChildren` 的 POSIX 实现体（`76-96`）——**不值得**：需要真跑 `pgrep`/`ps`，在 CI 的 Windows 矩阵上永远红或永远 skip，测试价值低于维护成本。

### 2.2 有实质缺口但优先级次之的 2 个（并发写者的在飞模块）

**③ `src/run/adopt-lock.ts` 81.2% / 73.0%、`src/run/journal.ts` 82.8% / 80.0%** —— 这两个文件是本任务窗口内**新出现**的（`git status` 显示 `?? src/run/adopt-lock.ts`、`?? src/run/journal.ts`）。它们的未覆盖行（`adopt-lock.ts: 65-71, 97-99, 133-134, 145, 166-168, 189, 208-210`；`journal.ts: 128-137, 143-145, 192, 218, 231, 236-237, 272-278, 294, 304, 316`）几乎肯定是**同一作者的 in-flight 工作**，`tests/run/adopt-lock.test.ts`、`tests/run/journal.test.ts` 也已随之上线。

**建议：不要由第三方（包括下一个 agent）去补这两个文件的测试。** 与在飞作者并行补测同一文件，是"两个写者猜同一套契约"的典型场景，只会产生互相削弱的断言。等其落定后由原作者一次性补齐。

**④ `src/service/supervisor.ts` 88.2% / 79.6%（28 个未覆盖分支）、`src/run/orchestrator.ts` 85.3% / 80.1%（29 个）** —— 未覆盖行高度分散（supervisor：`172, 182, 186-187, 210, 219, 254-257, 295, 347, 408, 429, 446, 454-459, 549, 555, 591, 630, 645-653`；orchestrator：`97, 128, 136, 153-154, 215-236` 区段、`374, 394, 418-419` 的 reconcile 报告路径、`510-542`、`565-566, 604-605`）。特征：**"已经出错了，再出错一次"的二阶失败路径**（stop 时 cancel 也失败、recovery 里 report 失败、dispose 期间的竞态）。

**判断：值得补，但要挑，不是全补。** 只值得补那些**能让进程卡住或泄漏**的分支：`supervisor` 的"stop 超时后强杀失败"、`orchestrator` 的"cancel 期间 session 消失"。不值得补纯日志/纯报告的 `catch`（`374, 394, 418`）——它们只影响错误文案，且属于已测路径的变体。

### 2.3 `src/run/registry.ts` — 70.8% stmts / 75.0% branch / **69.2% funcs**（全仓 funcs 最低）

未覆盖行：**`92`、`103-104`、`110`**，也就是三个完整的公开方法/分支：

- `92`：`throw new Error("Harness session already has an active MCP run: ...")` —— **锁的核心拒绝路径**没有被直接测试；
- `103-104`：`releaseService()` 的整个方法体 —— 没有任何测试调用过它；
- `110`：`runningRunIds()` 的整个方法体 —— 同上。

**为什么这个比其他都值得注意**：`releaseService` 是"服务停止/崩溃时回收该服务全部会话锁"的清理路径。它一旦回归，症状是**该 session 之后每次启动都报"already has an active MCP run"**——一个和根因（锁没释放）相距很远的报错。这正是"低覆盖 + 高诊断成本"的组合：**3 个方法，加起来约 10 行，一次会话就能补完，收益是删掉一类难查故障。**

### 2.4 明确不值得投入的（附理由，避免下一次有人又去追）

| 文件 | 数据 | 为什么不值得 |
|---|---|---|
| `src/util/errors.ts` | 55.6% stmts / 50.0% lines，**全仓最低** | 未覆盖行只有 `31-34`：`ConfigError` 的构造体。9 条语句的纯工具，写一个"new 一下"的测试能把数字从 55% 拉到 100%——**这正是要拒绝的注水**。`ConfigError` 真被用到时自然被覆盖；它现在的缺口不产生任何风险。 |
| `src/bin.ts` | 0% | 进程入口（`new HarnessContainer` → stdio 装配 → 信号）。它**只能**由真实子进程启动来覆盖，即 `tests/e2e/live.test.ts`——该文件按 `DSH_LIVE` 默认 skip，这是既有设计。**为了 0% 而删掉/改写入口是拿架构换数字。** |
| `src/util/redaction.ts` | 92.8% / 87.0% | 未覆盖 `23`（`registerSecret` 的"非字符串直接返回"守卫）、`30`（`registeredSecretCount()`，注释自称"diagnostics for tests"但没测试用）。安全敏感的脱敏逻辑其**主路径已有 92.8%**；`registerSecret(null)` 这种守卫分支是防御性代码，不是风险点。**注意**：脱敏真正的风险在"忘了注册/忘了调用"，而那个已被 `tests/security-exits.test.ts` 从架构层拦住（单一 scrub 边界），不是覆盖率能表达的。 |
| `src/service/credentials.ts` | 91.5% / 73.5% | 未覆盖 `86, 114, 130, 173`。分支偏低集中在 cookie 解析的畸形输入。**倾向不值得**：真实的畸形 cookie 空间巨大且无法穷举，已测的 `parseSetCookie`/`isCookieBearing303` 覆盖了有意义的形状；再往下按单点补只会变成"追分支百分比"。若要投入，正确做法是**属性测试**（"任意 Set-Cookie 字符串都不抛、且要么给出 (name,value) 对、要么给出 null"）——但这个模块当前**不是纯的**（`describeCredentials` 路径涉及读盘），所以我没有把它放进本轮 4 组。**这是本轮明确的"未做但可做"项，见 §7。** |
| `src/service/npm-cli.ts` | 82.4% / 91.7% | 未覆盖 `20, 43, 45`——`findNpmCli` 的 `catch { return null }`，以及 `resolveNpmCli` 里两个 `throw`。分支已 91.7%，缺口是"候选全不存在"的环境依赖分支。**已被 §2.1① 覆盖**：删掉 `runtime-package.ts` 的重复实现后，应把这两处补在 `npm-cli.ts`（它才是文档指定的家）。 |

---

## 3. 本次跑出来的 3 个发现（未修，已钉住）

### 发现 A（真实违约，已钉）：`classifyThrownFailure` 会**抛异常**而不是分类

```ts
classifyThrownFailure([Symbol("x")])
// TypeError: Cannot convert a Symbol value to a string
```

- **根因**：`thrownText` 对非 `Error`/非字符串的兜底是 `String(error)`（`wire.ts:208`）。而 `String([symbol])` 会抛——`Array.prototype.join` 用 ToString 转换元素，ToString 对 symbol 抛 `TypeError`。
- **边界**（我特意实测了，避免夸大）：**顶层** symbol 是安全的（`String(sym)` 合法 → `"Symbol(x)"`）；只有 symbol 作为**聚合值的元素被渲染**时才炸。`{a: Symbol()}` 也安全（对象走 `String({})` → `"[object Object]"`）。
- **影响面**：`ClassifiedWireFailure` 的文档承诺是"Classifies any thrown failure"，而这个模块是 ADR-0003 §3.2 指定的**唯一分类器**。投一个含 symbol 的数组在 JS 里合法（`throw [...]`），但当前代码路径不会产生它——所以是**契约不成立**，不是线上故障。严重度：低；确定性：100%。
- **钉住方式**：`known-gaps.prop.test.ts` 2 条 `it.fails`（含"symbol 在第 2 位"的变体），外加 1 条**通过**的边界测试记录"顶层 symbol 已 OK"。
- **建议修法**：给 `thrownText` 的兜底包一层 `try`/`catch`，失败时回退到 `Object.prototype.toString.call(error)`。约 4 行。

### 发现 B（真实违约，已钉）：`message` 可以是空字符串

```ts
classifyThrownFailure("").message                     // ""
classifyThrownFailure(Object.assign(new Error(""), { name: "" })).message  // ""
```

- **根因**：`thrownText` 对字符串原样返回（`""` → `""`），对 `Error` 只在 `message === ""` 时回退到 `name`——而 `name` 也可能是 `""`。
- **违反的是明文契约**：`wire.ts:185` 写着 `/** Operator-facing text; never empty. */`。
- **严重度**：低（同样不可达当前调用路径），但**分类不同**——这是"文档承诺了、实现没做到"，比"没承诺也没做到"更该钉住。
- **建议修法**：`message === "" ? "(no message)" : message`，或与发现 A 的兜底合并成一个 `describeThrownValue()`。

### 发现 C（**刻意不钉**）：`describeParseFailure(undefined | null)` 会抛

```
describeParseFailure(undefined)  // TypeError: Cannot read properties of undefined (reading 'issues')
describeParseFailure(null)       // 同上
```

**我拒绝把它写成第 3 个 `it.fails`**，理由是这两条：

1. **它没有违反任何承诺**。该函数自己的文档（`wire.ts:127-132`）只说"把校验失败渲染成 `path: message` 对"，从未声称全函数性。对比发现 B——那里有明文的 `never empty`。把"没承诺的事"也钉成 expected-failure，就是把测试当情绪表达，而不是当契约。
2. **它在当前调用图里不可达**。两处调用点（`dsh/client.ts:224`、`:274`）都在 `catch` 里包着 zod 的 `.parse()`，而 zod 只会抛带 `issues` 的对象。

**结论：记为建议**（若 `describeParseFailure` 将来被复用到"分类任意 throw"的路径上，先加守卫）。**这恰恰是本报告要声明的取舍：我把 2 条真实违约钉住了，把 1 条边缘鲁棒性留在了散文里。**

### 发现 D（顺带，非覆盖率范畴）：`runtime-package.ts` 有一对死导出

已在 §2.1① 详述：`findNpmCli`/`resolveNpmCli` 在 `runtime-package.ts` 与 `npm-cli.ts` 中重复，前者无人导入。这是**同一策略的两份实现**——本仓库在其它地方（`dsh/wire.ts` 的"single classification implementation"、`run/state.ts` 的"classify once"）明确反对的模式。

---

## 4. 属性测试（4 组，只打纯函数）

### 4.1 为什么**不**加 `fast-check`（论证）

**结论：不加。**理由按权重排序：

1. **价值不匹配**。本轮的 4 组性质全是**小输入的代数/区间性质**（区间包含、单调性、合取分解、幂等、边界包含性）。`fast-check` 的相对优势在：① 自动 **shrinking**（把反例最小化）；② 丰富的 `Arbitrary` 组合子（递归结构、相互依赖的生成器）。这两点对我这里的性质**都不关键**——我的输入空间本来就是"版本三元组 / 比较器串 / 布尔时钟序列 / 结果序列"，手工生成器只有 30–60 行且**可逐行审计**，反例本身就是可读的（`0.4.9 <= 4.6.2 under <1.7.6`），不需要缩小。
2. **它是一个 devDependency，但仍是一个供应链面**。本仓库刚在 R2 特意把 `dependencies` 清成 `{}`（零运行时依赖），并把"bundle 必须内联"写进了元数据校验（`scripts/lib/metadata.mjs:534`）。在一个刚刚收紧依赖姿态的仓库里，为一个诊断性测试工具引入一个会**传递依赖 4 个子包**（`@vitest/coverage-v8` 自己就带来了 19 个包）的框架，需要比"写起来方便"更强的理由。
3. **它引入第二套词汇**。项目已有的测试词汇是"seeded sweep + 显式边界枚举"（§4.2）。`fast-check` 会带来 `fc.assert`/`fc.property`/`Arbitrary`/`shrink path` 另一套概念，而收益只有"少写 60 行生成器"。
4. **我的可复现性方案已经够用**：每个迭代**独立种子**（`baseSeed + index`），失败信息里打印 `index + seed + 输入`，所以**一条失败可以只重跑一个索引**。这解决了 `fast-check` 最主要的使用动机（复现）。

**什么情况下我会改口**：如果要做的是**协议/解析器的鲁棒性**（例如 `service/credentials.ts` 的 cookie 解析、`dsh/wire.ts` 的 `isRpcEnvelope` 对畸形 JSON 的判定），需要**递归结构 + 自动 shrinking**，那时 `fast-check` 的 `Arbitrary` 会真的省下几百行并且找到人手想不到的形状——那种场景值得为它加一个 devDependency，并且应在报告里单独论证。本轮不在此列。

### 4.2 设计

- 位置：`tests/property/**`（本任务唯一可新建的测试目录）；共享生成器在 `tests/property/support/generators.ts`（226 行），**不是** `*.test.ts`，因此不被 vitest 收集。
- **确定性**：`mulberry32` PRNG，固定 `BASE_SEED = 0x5eed1a7e`。每个迭代用自己的种子。失败信息形如：`property counterexample at index 2 (seed 1592597120): 0.4.9 <= 4.6.2 under <1.7.6`。
- **显式边界与随机扫描并存**：每组都同时有 `forAll(...)`（随机）和 `forEachValue([...])`（钉死边界值）。随机扫描负责"我没想到的组合"，边界枚举负责"恰好等于阈值"。
- **测试隔离**：5 个文件全部 `import "../support/isolation.js"`（`tests/isolation.test.ts` 强制要求，缺了会把套件打红）。

### 4.3 四组性质与"哪条会先红"

| 组 | 文件 | 断言数 | 钉住的不变量 |
|---|---|---|---|
| **1. wire 分类全函数性** | `wire-totality.prop.test.ts` | 19 | 分类结果恒在词表内；**无 `kind` 的值永不被判为 auth/drift/rpc**；`cause` 链走 4 层即止且**循环链不死循环**；`classifyHttpStatus` 对任意数完合作划分；`isRpcEnvelope`/`parseFailurePath` 对任意值不抛 |
| **2. 引擎区间** | `node-range.prop.test.ts` | 14 | `>=` 单调递增、`<` 单调递减；`^X` ≡ `[X, nextAfterCaret(X))`；多比较器子句 ≡ **合取**；`SUPPORTED_NODE_RANGE` 与文档读法逐点一致（含 23.x 空洞）；未实现形式**fail-closed** |
| **3. 活动预算** | `activity-budget.prop.test.ts` | 17 | 有任何间隙 < 预算则**永不超时**；静默 ≥ 预算则超时且**边界含等号**；`touch()` 真的重置；观察者**无副作用**；超时对时间**单调**；`readyUrl` 一旦出现**永不回退**；日志有界；启动失败文案**恒带三项诊断且脱敏** |
| **4. settle 幂等** | `settle-once.prop.test.ts` | 13 | 只有**第一个** writer 返回 `true`；终态**只取决于胜出者**；**失败者顺序无关**；`settleStrict` 第二次抛且**抛时零副作用**；`reason` 非空 ⟺ `failed`；`nextAction`/`webUrlStale` 对全词表（含未见过的 code）完备 |
| （附）**已钉缺口** | `known-gaps.prop.test.ts` | 6（4 × `it.fails`） | 发现 A、发现 B |

**退化 → 先红的属性**（这条是任务要求的"能不能咬住"）：

| 若实现这样退化 | 先红的属性 | 是否已由反向验证实证 |
|---|---|---|
| `classifyThrownFailure` 丢掉 `isWireFailureKind` 守卫，盲信 `kind` | 组1「结果恒在词表内」 | ✅ **RV1**（1 红） |
| `classifyThrownFailure` 改回"从 message 文本猜类别" | 组1「无 `kind` 的值永不被判为 auth/drift/rpc」 | — |
| `satisfiesClause` 的 `.every` 改成 `.some`（**R1 那个"上界被吞"缺陷的原形**） | 组2「多比较器 ≡ 合取」 | ✅ **RV2**（3 红） |
| `parseVersion` 去掉 `$` 锚点（回到前缀匹配） | 组2「`^X` 是区间」+「拒绝 prerelease 后缀」 | — |
| `ActivityBudget.touch()` 不再重置静默窗口 | 组3「`touch()` 真的重置」 | ✅ **RV3**（3 红） |
| `expired()` 的 `>=` 改成 `>` | 组3「恰好等于预算即超时」 | — |
| `settle()` 丢掉 `isTerminal` 守卫 | 组4「只有第一个 writer 通过」 | ✅ **RV4**（4 红） |
| `settleStrict` 先写后判 | 组4「抛时零副作用」 | — |
| `nextActionFor` 对开放族回退到某个具体动作（而非 `report-only`） | 组4「开放族 → report-only」 | — |
| `ReadinessWatcher.push` 每次都覆写 `url` | 组3「`readyUrl` 永不回退」 | — |

### 4.4 反向验证（4 条，全部"改坏 → 红 → **逐字节还原**"）

因为**并发写者正在改 `src/**`**，我没有采用"备份→覆盖还原"（那样可能把别人的新编辑盖掉）。做法是：单个 PowerShell 进程内完成 **记录原始字节 → 断言锚点唯一 → 打补丁 → 跑测试 → 重读校验文件未被第三方改动（否则中止且不还原）→ 写回原始字节 → 校验字节相等**。脚本：`E:\AI\test\.verify-scratch\r3-reverse-verify.ps1`。

| # | 改坏的地方 | 补丁 | 结果 | 还原 |
|---|---|---|---|---|
| **RV1** | `wire.ts` — `classifyThrownFailure` 的 `isWireFailureKind(typedKind)` → `typedKind !== undefined` | 盲信 `kind` | `1 failed \| 18 passed`，命中「kind for …」 | ✅ byte-exact |
| **RV2** | `package-spec.ts` — `satisfiesClause` 的 `.every(...)` → `.some(...)`（**R1 缺陷原形**） | 上界被吞 | `3 failed \| 11 passed`，命中「under …」 | ✅ byte-exact |
| **RV3** | `readiness.ts` — `touch()` 删掉 `this.lastActivityAt = this.clock();` | 静默窗口不再重置 | `3 failed \| 14 passed`，命中「resets both the silence」 | ✅ byte-exact |
| **RV4** | `run/state.ts` — `settle()` 删掉 `if (isTerminal(record)) return false;` | settle-once 失效 | `4 failed \| 9 passed`，命中「sequence …」 | ✅ byte-exact |

还原后用文件哈希与任务前备份逐字节比对，4 个文件全部 `IDENTICAL`。

---

## 5. 我对 `npm run check` 的影响面（**未运行** `check`，按指令）

**我运行的命令**：`npx tsc --noEmit`、`npx vitest run tests/property`、`npm run coverage`（3 次）、`npx vitest run`（含全量，用于验证 §5.1 的发现范围声明）、`npm ls --depth=0`。**没有运行** `npm run check`。

### 5.1 `vitest.config.ts` **不会**改变 `npm run test`

这是我最担心的副作用，已用全量运行验证：

- 配置文件**没有**设置 `test.include`／`test.exclude`／`test.environment`／`test.setupFiles`——所有 `test.*` 字段都保持 vitest 默认，只有 `test.coverage.*` 被设置，而 `coverage.*` **只在 `--coverage` 时被读取**。
- 实证：全量 `npx vitest run` 发现 **42 个文件 / 657 用例**，其中 `tests/property/**` 正好 5 个文件 / 69 个用例；`tests/isolation.test.ts`（它断言"每个测试文件都必须 import 隔离护栏"且 `files.length > 10`）保持通过。**没有测试被静默丢弃。**

### 5.2 逐段影响

| `check` 的步骤 | 影响 | 说明 |
|---|---|---|
| `typecheck`（`tsc --noEmit`） | **无** | 实测 exit 0；`tests/property/**` 与 `vitest.config.ts` 都在 `tsconfig` 覆盖范围内且类型干净 |
| `test`（`vitest run`） | **无** | §5.1 |
| `check-metadata` | **无** | 只读 `package.json` / `package-lock.json` / 插件清单的**版本字段**；`scripts/lib/metadata.mjs` 中没有任何对 `dependencies`/`devDependencies` 的断言（已 grep 确认）。devDependency 不影响版本一致性 |
| `build`（tsdown） | **无** | `entry: ["src/bin.ts"]` 未变；coverage 包只在测试期使用，不进 bundle。`files` 白名单也不含 devDependencies，`npm pack` 体积不变 |
| `check-metadata --self-contained` | **无** | 探针启动 `dist/bin.mjs`，与测试依赖无关 |

### 5.3 `package.json` / `package-lock.json` 的确切 diff

`package.json` **只有 2 处新增**（已确认无其它改动）：
```diff
     "test": "vitest run",
+    "coverage": "vitest run --coverage",
@@
     "@types/node": "22.20.0",
+    "@vitest/coverage-v8": "4.1.10",
```

`package-lock.json`：**纯新增 242 行，0 删除**（`@vitest/coverage-v8@4.1.10` 及其 19 个传递包）。`npm ls --depth=0` exit 0，依赖树一致。

> **一处需要说明的副作用（已修回）**：`npm install --save-dev` 会自动删掉 `package.json` 里空的 `"dependencies": {}` 块。虽然没有任何代码/校验断言它（已 grep），但那**超出了"只授权 devDependency + 新增脚本"**的范围，所以我手工把它加回去了。当前 `package.json` 的 diff 严格等于上面这 2 行。

### 5.4 关于 1 个红测试

当前全量运行是 `1 failed | 651 passed | 4 expected fail | 1 skipped`。那 **1 个红**是 `tests/diagnostics/doctor-doc.test.ts` 的 `contract` 字段不一致，属于并发写者在 `src/diagnostics/doctor.ts` 的在飞改动，**与我的改动因果无关**（我的 diff 不含 `src/**`、不含 `README*`、不含 `tests/diagnostics/**`）。我**没有**去修它——两边都不在我的写权内——但它意味着**现在跑 `npm run check` 不会绿**，且**不是我的改动导致的**。这一点请你（Lead）在做最终验收时先处理。

---

## 6. 结论与建议（成本/收益）

### 值得做（按 ROI）

1. **删掉 `runtime-package.ts` 里重复的 `findNpmCli`/`resolveNpmCli`**（约 35 行，`src/**` 改动）。
   收益：`runtime-package.ts` 覆盖率 82.0%→**≈87%**（估算，无需写测试）＋ 消除"两份 npm 定位实现"的漂移面。
   成本：一次删除 + 确认无导入（已确认：全仓无人从 `runtime-package.js` 导入这两个名字）。
2. **给 `run/registry.ts` 补 3 个方法级测试**（约 10 行代码，3–5 条断言）。
   收益：`70.8%→接近 100%`，并且钉住"服务停止/崩溃时释放全部会话锁"这条**症状远离根因**的清理路径；直接消除"already has an active MCP run" 类难查故障的可能性。
   成本：一个会话。**这是全报告里性价比最高的一条。**

### 值得做，但要挑分支

3. **`process-tree.ts`：只补 `waitForExit` 的事件驱动路径与 `taskkill` 失败路径**（注入式，跨平台）。
   明确**放弃** `defaultListChildren` 的 POSIX 实现体——平台不可得，追它等于拿 CI 稳定性换数字。
4. **`supervisor.ts` / `orchestrator.ts`：只补"能卡住或泄漏"的二阶失败分支**（stop 强杀失败、cancel 期间 session 消失）。**不补**纯日志/纯报告的 `catch`。

### 明确不值得做

5. `util/errors.ts`（55.6%）、`bin.ts`（0%）、`util/redaction.ts` 的两个防御分支、`credentials.ts` 的畸形 cookie 单点分支——理由见 §2.4。**别把 `errors.ts` 的 55.6% 当成待办**：它只是"小分母"的假象。
6. **不要给 `check` 接阈值**，也不要给 `coverage` 接阈值。一旦接上，"补测"的动机就从"消除风险"变成"过线"。
7. **不要为了 `adopt-lock.ts` / `journal.ts` 的覆盖率去找第三方补测**——见 §2.2③。

### 我明确**拒绝**的诱惑（重点）

1. **拒绝写"跑一遍不抛错"的填充测试**。具体的诱惑是 `ConfigError`（`util/errors.ts:31-34`）与 `registeredSecretCount()`（`redaction.ts:30`）——各写 1 条 `expect(() => new ConfigError(...)).not.toThrow()` 就能把两个文件从 55%/92% 拉满。**拒绝了**：它们不产生任何风险信息。基线难看就是难看，我把它留在表里并标注"不值得"。
2. **拒绝把难覆盖的文件从 `include` 里排除**。曾有人会想排掉 `bin.ts`（0%）和 `process-tree.ts` 的 POSIX 段"让数字好看"。**拒绝了**：`bin.ts` 的 0% 本身就是一条真实信息（入口只由 e2e 覆盖），抹掉它是自欺。
3. **拒绝加覆盖率阈值**。非门禁脚本里的阈值是惰性的；接进 `check` 则会逼迫填充测试。**两者都不做。**
4. **拒绝新增 `fast-check`**（§4.1 有完整成本论证）。我用 60 行可审计的种子生成器 + 显式边界枚举替代，并把"什么情况下我会改口"写清楚。
5. **拒绝把发现的缺陷"测成通过"**。发现 A/B 是真实契约违约，最省事的做法是把断言写成"当前行为"（把 bug 锁死）或干脆不写。**拒绝了**：我用 `it.fails` 钉住"应该成立的不变量"，并在文件头写明"修好后这条会变成报错，逼你回来改"。（共 4 条 expected-failure；若你认为 R3 阶段不该引入 expected-failure，删掉 `known-gaps.prop.test.ts` 是**一个文件的事**，但我的建议是留着——它把两个文档级矛盾变成了可执行语句。）
6. **拒绝把发现 C 也钉成 `it.fails`**（§3 发现 C）。它既无明文承诺又不可达，钉它就是把测试当情绪。
7. **拒绝直接相信"未覆盖行号"**。第一遍我按 Istanbul `s` 的**键**当行号读，于是 `util/redaction.ts` 报出"第 2、6 行未覆盖"——那是**注释行**。改用 `statementMap` 反查后才得到真实行号。**如果我把第一遍的数字写进报告，你会看到一堆毫无意义的"注释行缺口"。**方法已写在 §2 开头以便复核。
8. **拒绝把随机扫描次数调大来显得"充分"**。`SWEEP` 保持 600–1000：单文件运行 8–190 ms，全套 `tests/property` **690 ms**。种子是固定的，所以"跑得久"不等于"发现得多"。

---

## 7. 未验证项与残留风险

| # | 未验证/未做 | 为什么 | 风险 |
|---|---|---|---|
| 1 | **`npm run check` 未运行** | 任务明令不要跑 | 我无法声称 `check` 绿。§5 逐段分析了影响面，但那是推理不是实测。**建议由你跑一次全量作为最终验收。** |
| 2 | 全仓当前有 **1 个红测试**（`doctor-doc.test.ts` 的 `contract` 字段） | 并发写者在飞；`README*` 与 `doctor.ts` 都不在我的写权内 | `check` 现在必红。**必须先解决，否则我的改动会被误判为元凶。** |
| 3 | `credentials.ts` 的属性测试（cookie 解析鲁棒性） | 该模块当前不是纯函数（含读盘路径），不符合本轮"只打纯函数"的约束 | 分支覆盖率停在 73.5%。**这是本轮最明确的"可做但未做"**；建议在 R4 单独立项，并**那时重新论证 `fast-check`**（§4.1 末段）。 |
| 4 | `process-tree.ts` 的 POSIX 真实行为 | Windows 上不可能执行；只能靠注入 | 注入测试证明的是"给定这些系统调用，我们的顺序是对的"，**不是**"真机上 Linux 会这样"。文件头已声明该边界。 |
| 5 | 属性测试的"通过"**不等于**实现正确 | 属性只覆盖我写下的那几条不变量；`forAll` 只扫 600–1000 个种子，不是证明 | 我刻意把"哪条会先红"逐条列出（§4.3），就是为了让"没红"的含义可被评估，而不是被当作保证。 |
| 6 | 我**没有**对 `src/**` 做任何永久修改 | 写权限制 | 发现 A/B/D 的修复仍需他人执行。反向验证期间的 4 次临时改动已逐字节还原并校验（§4.4）。 |

---

## 8. 复现方式

```powershell
cd E:\AI\test\deepseek-harness-for-codex

# 基线（非门禁；当前树上有 1 个与本次无关的红测试，reportOnFailure 保证仍出数字）
npm run coverage

# 属性测试（4 组 + 已钉缺口）
npx vitest run tests/property          # → 5 passed / 65 passed | 4 expected fail (69)，约 0.7s

# 归因：同一棵树上关掉我的贡献
npx vitest run --coverage --exclude "tests/property/**"

# 反向验证（会临时改 src 并逐字节还原；脚本内含"第三方写入则中止"的保护）
pwsh -NoProfile -File E:\AI\test\.verify-scratch\r3-reverse-verify.ps1
```

留档：`E:\AI\test\.verify-scratch\` 下 `r3-coverage-run1.txt`、`r3-coverage-A-with-props.txt`、`r3-coverage-B-without-props.txt`、`r3-summary-A.json`、`r3-summary-B.json`、`r3-property-final.txt`、`r3-src-hashes.txt`、`r3-reverse-verify.ps1`、`r3-backup/`。

## 9. 交付物清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `vitest.config.ts` | 新增 | 仅 coverage 配置；无阈值；不接 `check` |
| `package.json` | 修改（**+2 行**） | `coverage` 脚本 + `@vitest/coverage-v8` devDependency |
| `package-lock.json` | 修改（**+242 行 / −0**） | 上述 devDependency 的锁 |
| `tests/property/support/generators.ts` | 新增（226 行） | 种子 PRNG + 生成器 + 反例渲染 |
| `tests/property/wire-totality.prop.test.ts` | 新增（213 行，19 条） | 组 1 |
| `tests/property/node-range.prop.test.ts` | 新增（200 行，14 条） | 组 2 |
| `tests/property/activity-budget.prop.test.ts` | 新增（259 行，17 条） | 组 3 |
| `tests/property/settle-once.prop.test.ts` | 新增（236 行，13 条） | 组 4 |
| `tests/property/known-gaps.prop.test.ts` | 新增（62 行，6 条含 4 `it.fails`） | 发现 A/B 的钉子 |
| `reports/r3-coverage-and-properties.md` | 新增 | 本报告 |

**未触碰**：`src/**`、`tests/` 下其它目录、`README*`、`docs/**`、`scripts/**`、`.github/**`；未 commit/push。
