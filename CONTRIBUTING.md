# Contributing

本项目的第一条纪律是**证据优先**：任何"完成了"都必须能指向原始输出、可复核的断言或代码行。
本文件只写**接手者最容易踩的坑**；架构约束见 `docs/architecture.md`，验收流程见 `docs/operations.md` §5。

## 1. 一个写者一个文件范围

多人/多智能体并行时，按**文件范围**分工，不要两人同时改同一个文件：

- `dist/`、`plugins/deepseek-harness/**` 是**生成物**：由 `npm run version:sync`（或 `npm run prepare:plugin`）产出，**任何人不得手工编辑**，也不进版本库（见 `.gitignore`）。
- **只有一个人跑 `npm run check`**（它会重写 `dist/` 与 `plugins/`）。并行开发时其他人用：
  ```sh
  npx tsc --noEmit
  npx vitest run <你的测试文件>
  ```
  否则会出现"我改了 A、你正好在跑 check"→ 生成物被另一方覆写，看起来像"别人的改动把测试弄红了"。
- 全量门禁由**集成者**在所有写者停手后串行执行：`npm run check`。

## 2. 改了 `skills/**`、`README*.md`、`assets/**` 就必须同步载荷

`skills/**`、`README.md`、`README.en.md`、`assets/**`、`LICENSE` 是市场载荷的**事实源**，载荷里的对应文件由生成器复制。因此：

```sh
npm run version:sync      # 或 npm run prepare:plugin
npm run check             # 元数据门禁会以 generated-drift 报红，若你漏了上一步
```

真实事故：一人改了 `SKILL.md`、另一人正在跑 `check`，结果 `generated-drift` 变红，被误判成"对方的改动有问题"。**改完事实源立刻同步**，别留到"稍后一起跑"。

## 3. 每条关键改动都要有反向验证

"通过"不够，要能证明这条测试**真的能咬住**它保护的行为：

1. 写/改动实现 → 测试应该**先红后绿**（或先写测试让它红）；
2. **把实现改回错误写法**（或改成另一种错法）→ 对应测试必须变红；
3. 还原实现，记录还原前后的哈希，两次运行都留原始输出。

脆弱断言（"调用过某函数"、"跑完不抛错"、与实现同义反复的表达式）不算覆盖——它们在实现写错时照样绿。反向验证记录写进对应的 `reports/*.md`。

## 4. 测试隔离：数据目录永远用临时目录

- 数据目录与 `DSH_HOME` 必须由组合根显式注入；测试统一走 `tests/support/**` 的临时目录。
- 套件级守卫（`tests/support/isolation.ts` + `tests/isolation.test.ts`）会断言**用户真实默认数据目录**（`~/.deep-seek-harness-mcp`）的存在性在整轮测试前后未改变。若你在真实 home 里看到 `profiles/`、`storages/`、`.credentials.yaml`，那是**缺陷**，不是配置问题。
- 任何新增测试文件顶部都要 `import "../support/isolation.js";`（相对路径按深度调整），否则元闸门会红。

## 5. `check` 与 `check:live` 的边界

| 入口 | 内容 | 是否进 PR 门禁 |
|---|---|---|
| `npm run check` | 类型检查 + 全部单测/契约/集成 + 元数据门禁（×2，含 build 后复验）+ 构建 + 自包含启动探针 | ✅ 必须绿 |
| `npm run check:live` | 真实安装精确版 DSH（约 486 MB）+ 启动 + 无 key 的失败路径 + 干净停止 | ❌ **不进**门禁（需网络与磁盘；在 CI 中为手动 `live-smoke`） |

`npm run check:live` 有前置闸门：**未设 `DSH_LIVE=1` 时 exit 2**（拒绝"跑 0 条用例却绿"的空跑）。跑它时请用**此前不存在**的 `DSH_MCP_DATA_DIR`，以覆盖"首次运行创建数据目录 + 安装"的真实路径。

## 6. 提交前自查

```sh
npm run check                       # exit 0
git status --porcelain              # 只含预期改动；plugins/** 不应出现在索引
git diff --check                    # 无空白错误
```

- 不要提交真实凭据（token/cookie/API key）到 fixture 或日志；
- `.gitattributes` 规定了 `eol=lf`：提交前若看到成片 CRLF 警告，说明有文件被 EOL 重写，先查清原因再提交；
- 提交信息说明**外部可感知**的变更（工具行为、字段、配置、依赖），并同步 `CHANGELOG.md`。
