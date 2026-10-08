## 变更说明

<!-- 这个改动做了什么、为什么。若属于外部可感知变更（安装方式、MCP 工具行为、返回字段、运行状态语义、DSH 版本线），
     请同时在 CHANGELOG.md 的 Unreleased 段落记录。 -->

## 依据

- 关联 ADR / 设计文档：`docs/decisions/ADR-____` / `docs/architecture.md` §__
- 若与现有设计冲突：已更新对应 ADR（是/否）

## 自检清单

- [ ] `npm run check` 通过（typecheck + 测试 + 元数据门禁 + build + `--self-contained` 探针）
- [ ] 关键行为有**反向验证**记录：把实现改回错误写法后对应用例确实变红
- [ ] 外部可感知变更已写入 `CHANGELOG.md`
- [ ] 未手工修改生成物：`src/version.ts`、`.mcp.json`、`.codex-plugin/plugin.json`、`plugins/deepseek-harness/**`（均由 `npm run version:sync` 产出）
- [ ] `README.md` 与 `README.en.md` 同步更新（如涉及用法/配置/排障）
- [ ] 安全相关声明与实现一致（尤其 shell/凭据/工作区策略；不要留下过度声明）
- [ ] 新增的测试覆盖"如果失效会抓住什么缺陷"，而不是只断言 mock 调用
