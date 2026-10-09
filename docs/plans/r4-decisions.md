# R4 决策包：需要用户决定的三件事（其余全部由团队自行推进）

> 这三件事要么**不可逆**（发布、推送远端），要么会**改变仓库形态**（生成物入库），因此按纪律停在"决定"而不是替你执行。
> 每件事都写清：事实（可自己核对）、选项、代价、我的建议。**在你决定前，代码与文档都按"单进程本地使用"这一现状保持一致**。

## 用户答复（2026-10-09）

| 事项 | 答复 | 我的执行 |
|---|---|---|
| ① 推送与发布 | **先只推 Git，发布留待单独决定** | 推 `main` 与全部 tag 到 `origin`；**不执行 `npm publish`** |
| ② `plugins/**` 是否入库 | **保持现状：不入库** | 零改动（`.gitignore` 不动） |
| ③ `deepseek-harness-relay-mcp` | **删除以清空工作区** | 删除前核对解析后的绝对路径与内容归属，再删 |

> 答复之后，本节以下的"选项/建议"文字保留为**决策依据的历史记录**（解释当时为什么这样问、代价分别是什么），不再表示待决状态。

---

## 1. npm 发布身份与版本推进（不可逆）

### 已核实的事实

| 事实 | 证据 |
|---|---|
| `deepseek-harness-for-codex` 这个**非作用域名字已经被占用**，且**就是你自己的包** | `npm view deepseek-harness-for-codex`：`version 0.3.1`、`repository = github.com/Seann0824/deepseek-harness-for-codex`、`maintainers = sean_xyb <sean@englife.space>`、`time.created = 2026-08-13` |
| 本地 `package.json` 是 `0.4.0`，且 `publishConfig = { access: public, registry: npmjs.org }` | `package.json` |
| `dependencies` **为空**（SDK 与 zod 已进 `devDependencies`，产物自包含） | `package.json` |
| 有 **3 个未推送提交**（`16b8029`、`a5bd5a9`、`cf04b8c`），远端 `origin` 是上面那个 GitHub 仓库 | `git log origin/main..HEAD` |

### 选项

| 选项 | 说明 | 代价 / 风险 |
|---|---|---|
| **A. 按现状发布 0.4.0 → 0.4.2（推荐，若你想要"可安装"）** | 沿用你已有的非作用域名，`npm publish` 前先 `npm run check` + `npm run sbom`；provenance 由 R4-1 的 workflow 提供（发布动作**不在** workflow 里，仍由你手动执行） | 发布**不可逆**（unpublish 受限）；`0.4.x` 一旦发出，后续任何修正都必须以**新版本**出现 |
| **B. 只推 Git、不发 npm** | `git push origin main` + `git push --tags`；使用者通过 `git clone` + `npm install` 或 `npm pack` 的 tarball 安装 | 使用者体验多一步；但零 registry 暴露、零不可逆动作 |
| **C. 换作用域名（如 `@sean-xyb/deepseek-harness-for-codex`）** | 面向未来避免名字歧义 | 现有 0.3.x 使用者需要改安装名；收益不明确 |

**我的建议**：先做 **B**（把 3 个提交与 3 个 tag 推上去，零风险），**是否发布 0.4.x 由你单独决定**。理由：发布是唯一不可逆的动作，而"推 Git"随时可再推一次。

**无论选哪个，我现在都不会替你执行 `npm publish` 或 `git push`。**

---

## 2. 是否把生成的 Codex 插件负载（`plugins/**`）提交进仓库

### 事实
- `.gitignore` 忽略 `dist/` 与 `plugins/deepseek-harness/`；`git ls-files plugins` = **0**，即 `git clone` 拿不到插件负载。
- 生成物由 `npm run build` + `npm run version:sync` 产出；仓库有门禁 `generated-drift` 防止"生成物与源不一致"被提交。

### 选项

| 选项 | 效果 | 代价 |
|---|---|---|
| **A. 保持现状（生成物不入库）** | 仓库干净、不会有"源码与生成物双写"的漂移问题 | `git clone` 后必须跑一次 `npm install && npm run build` 才能装插件 |
| **B. 入库 `plugins/deepseek-harness/**`** | `git clone` 即可直接安装（对不想跑构建的使用者最友好） | 每次改动都要 `version:sync` 后一起提交，否则 `generated-drift` 报红；仓库体积增加；评审 diff 里出现机器生成物 |
| **C. 折中：只在 **release** 分支/tag 上入库** | 日常开发干净，发布产物带插件负载 | 多一套分支纪律，容易忘记 |

**我的建议**：**A（保持现状）**。理由：本项目已有 `check` 与 `version:sync` 保证生成物可复现，而"生成物入库 + 手改"是历史上漂移的高发区（本会话 R2 就被 `generated-drift` 抓到过一次）；若你更看重"clone 即用"，选 B 也可以，但请明确接受"以后每次改 `skills/**`/`README*` 都必须同步生成物"。

---

## 3. 保留还是删除 `deepseek-harness-relay-mcp`（同级目录，约 1.7 MB）

- 事实：它是**独立**项目（不是本项目的依赖），本会话只把它当作**设计参考**（R3-3 的对账思路参考了它的 `run-reconciler.ts`）。
- 选项：**A. 保留**（历史参考、可能仍在自用）；**B. 删除**（清空工作区，本会话已完成它的定位说明并记入报告）。
- **我的建议**：**保留但不要再改**——它不干扰本项目的任何门禁（不在 `files`、不在 git、不在 CI），删除的收益只是"目录更干净"，而万一你还在用它，删除不可逆。

---

## 附：本会话已完成的不可逆动作（供你核对）

| 动作 | 内容 | 可逆性 |
|---|---|---|
| 提交 | `16b8029`（基线）、`a5bd5a9`（R2）、`cf04b8c`（R3） | 本地可 `reset`，**未推送** |
| 打标签 | `v0.4.0`、`v0.4.1`、`v0.4.2` | 本地可删，**未推送** |
| 清理工作区 | 删除了本项目以外的无关目录/暂存（按你的指令） | 不可逆，当时已确认只删临时与冗余目录 |
| 用户真实数据目录 | **始终未被写入**（`~/.deep-seek-harness-mcp` 至今 ABSENT；所有实验走临时目录） | — |
