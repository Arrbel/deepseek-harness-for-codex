# ADR-0001：分发模型与单一版本事实来源

- 状态：**已接受**（实现中：task-5）
- 日期：2026-10-08
- 相关：`docs/architecture.md` §9、审计报告 §3.2/§4 P0-1、P0-2

## 背景

同一仓库里存在三套互不相等的版本事实：

1. `package.json` / `package-lock.json` / `src/server.ts` 的 `0.4.0`（工作区改动，未提交）；
2. 根 `.mcp.json` 钉 `deepseek-harness-for-codex@0.4.0`——**registry 上不存在**（实测 E404，只发布过 0.3.0/0.3.1）；
3. 内嵌插件副本 `plugins/deepseek-harness/` 仍为 `0.3.1+codex.20260813212556`、钉 `@0.3.1`，而 `.agents/plugins/marketplace.json` 的 `source` 恰好只指向这份副本。

后果：按 README 主路径安装的用户**能装上、能启动、不报错，但跑的是 0.3.1**（静默降级）；按独立 MCP 路径安装的用户**直接 E404**。根因不是"某处写错了版本"，而是**没有单一事实来源，也没有任何门禁**：`check = typecheck && test && build` 只验证代码，四份元数据可以任意发散。

此外，`.mcp.json` 采用"用 npx 安装本包的一个具体版本"的自引用形态，天然存在**发布前死锁**（要装 0.4.0 必须先发布 0.4.0；而发布又被失败测试与 `prepublishOnly` 卡住）。

## 决策

1. **`package.json` 的 `name`/`version` 是唯一权威**。任何其它出现版本号的地方都必须由脚本派生：`src/version.ts`、根 `.mcp.json`、根 `.codex-plugin/plugin.json`、内嵌副本、README 中的安装命令。
2. **生成而非同步**：新增 `scripts/version-sync.mjs`（写入模式）与 `scripts/check-metadata.mjs`（`--check` 模式）。内嵌副本若保留，必须由生成器产出，**禁止手工维护**；能删除则删除（首选）。
3. **自包含启动**：插件 `.mcp.json` 改为 `{"command":"node","args":["./dist/bin.mjs"],"cwd":"."}`（与同目录的 `deepseek-harness-relay-mcp` 既有做法一致）。运行时依赖（bash/node MCP SDK）随插件目录一起交付，不再用 npx 拉取本包。这同时消灭"自引用死锁"与"拉到旧版本"两种失败模式。
4. **门禁进 check**：`check-metadata --check` 并入 `npm run check` 与 `prepack`，断言：四处版本一致、`files` 白名单覆盖插件运行所需文件（`dist/`、`.codex-plugin/`、`.mcp.json`、`skills/`、`README*`、`LICENSE`）、`src/version.ts` 与 `package.json` 相等。
5. **两条安装路径，一份内容**：canonical = `npm run prepare:plugin` 后以本地路径加入 marketplace（今天就能端到端验证，不依赖任何发布权限）；可选 = 从已发布的 npm 包安装。两条路径解析出的插件内容必须一致，由门禁保证。

## 备选方案与被否原因

| 方案 | 否决原因 |
|---|---|
| 保留 npx 自引用，靠"先发布再改 pin"的流程纪律 | 死锁仍在（发布被 check 卡住时无人能装）；纪律不是门禁，同类漂移必然复发 |
| 继续手工同步内嵌副本 | 本次事故的最小复现路径；两处事实必然发散 |
| 把插件内容打进 npm 包并让 marketplace 用 npm source（relay 的形态） | 方向正确，但需要本方能发布该包名（见"未决点"）；作为 canonical 的后续形态保留 |
| 用 `file:` 依赖或 postinstall 生成副本 | 增加安装期隐式行为与失败面；生成器显式执行更容易诊断 |

## 后果

- 正面：版本只有一处可改；两种安装路径天然一致；插件自包含，不依赖 registry 可用性；`check` 成为真正的发布前置。
- 代价：本地安装需要先执行 `npm run prepare:plugin`（构建 + 生成 + 校验），这一步必须写进 README 与 SKILL，否则用户会装到没有 `dist/` 的目录（该坑在 relay 的 `AGENTS.md` 中有明确记录）。
- 约束：任何新增"出现版本号的文件"都必须接入生成器或校验器，否则门禁失败。

## 验证

1. 人为把内嵌副本版本改回 0.3.1 → `npm run check` 必须失败并指出期望值；
2. 人为把 `.mcp.json` 改回 npx 自引用 → 门禁失败；
3. `npm run check` 全绿；`npm run prepare:plugin` 后按本地路径加入 marketplace，`doctor` 报告的版本与 `package.json` 相等。

## 未决点（需要用户决策）

- 若希望提供"从 npm 安装"的路径，需要一个**属于本方的包名/命名空间**（当前包名归上游作者，我方无法发布）。可选：(a) 维持本地路径为 canonical；(b) 改名到自有 scope（如 `@<scope>/deepseek-harness-for-codex`）后发布；(c) 使用内网 registry。该决策只影响 `.agents/plugins/marketplace.json` 的 `source` 与 README 的一行命令，架构上已参数化。
- 是否要把生成载荷 `plugins/deepseek-harness/**` 提交进 git，以支持"克隆即可安装"（当前为生成 + 忽略）。门禁在两种形态下都逐字节校验，因此不会重新引入漂移；差别只在仓库体积与 git 源安装是否需要 prepare。

## 实现落地记录（task-5，2026-10-08；证据见 `reports/impl-distribution-ssot.md`）

实际实现与本文决策一致，并有四处需要留档的细化：

1. **运行时依赖改为内联 bundle**，而不是"随插件目录交付 `node_modules`"：Codex 会把插件文件复制到自己的缓存目录（实测缓存插件自带 `node_modules`，说明复制行为真实存在），因此 `tsdown.config.ts` 采用 `deps.alwaysBundle`（除 `node:` 外全部内联），`dist/bin.mjs` ≈ 710 kB。这样插件目录是真正自包含的：无 `node_modules` 也能启动。
2. **`check` 在 `build` 前后各跑一次元数据门禁**：`build` 末尾会执行生成器，若只在 build 后校验，人为篡改会被"自动治好"，ADR-0001 的验证 1/2 就不成立。
3. **`prepare:plugin` = `version:sync && check`**（`build` 自身先 sync），顺序保证载荷生成时 `dist/` 已存在。
4. **`doctor` 暂不输出版本字段**（受"不得修改 src 逻辑"的任务边界限制）：版本一致性改由 MCP `initialize` 的 `serverInfo.version` 验证，并固化进 `check-metadata --self-contained`（比 `doctor` 更贴近客户端实际看到的版本）。P7 补 `doctor.version` 后把同一断言挂上去。
5. **载荷目录已从 git 索引移除**（`git rm -r --cached plugins/deepseek-harness`），工作区文件保留、由生成器独占产出。
6. **`package.json#dependencies` 仍声明 `@modelcontextprotocol/sdk` 与 `zod`**：bundle 已内联，它们实际只在构建期需要，属 P1 收尾项（移到 `devDependencies` 可减小安装体积；需要同步 `package-lock.json`）。
