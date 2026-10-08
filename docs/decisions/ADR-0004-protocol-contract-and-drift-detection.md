# ADR-0004：协议契约与漂移检测

- 状态：**已接受**（契约文件在 Phase 4 建立，随后补契约回放）
- 日期：2026-10-08
- 相关：`docs/architecture.md` §5、审计报告 §3（协议 9 项对拍）

## 背景

本项目的全部价值建立在一组**未文档化的内部 Web RPC** 之上（`/api/<method>` + `client-request` 信封 + cookie 认证）。审计确认当前 9 项协议假设中 7 项与官方源码/官方 e2e 完全一致，说明改造方向正确；但适配逻辑以"字符串 + 手工取字段"的形式散落在 `run-manager.ts`（673 行）中：

- 字段路径靠 `as Record<string, unknown>` 逐层下钻，读错时**静默**得到 `""`/`undefined`；
- `turn/end` 的 `reason.kind` 用字符串 if 链处理，DSH 新增 kind 时静默判成功；
- HTTP 路径、参数名（含 `session/list` 的 `_request`）、状态码语义（401/403/404/415）没有集中声明；
- 测试用自造假服务验证，**不能**证明真实 wire 兼容（夹具 `assistant/message` 甚至缺必填字段）。

## 决策

1. 建立 `dsh/contract.ts` 作为"我们依赖 DSH 什么"的唯一声明：
   - 方法表：方法名 + wire 参数名 + 请求/响应 schema（zod，仅在 wire 边界使用）；
   - 事件契约：消费的事件类型与字段路径；`TurnEndReasonMap` 全集镜像；
   - 能力常量：HTTP 前缀、认证握手形状、Node 引擎区间、支持的 DSH 版本线。
2. `dsh/client.ts` 在解码时**校验**：不符合契约即抛 `ProtocolDrift`，错误信息含方法名、JSON 路径、期望/实际。**不猜测、不降级、不静默穿透。**
3. 契约回放测试：用真实 0.2.1 采集并脱敏的 wire 片段（`tests/fixtures/recorded/`）驱动 client 与事件投影，替代"只对自造假服务断言"。
4. 版本升级流程：DSH 升级 → 只需改 `contract.ts` + 录制新 fixture → 契约测试给出全部差异点。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 继续用 `as Record<string, unknown>` + 可选链 | 静默失败是本次事故（假成功、空文本）的直接成因 |
| 生成 DSH 的类型定义并直接引用 | DSH 未发布 Web RPC 的类型契约；且会把编译期耦合到未稳定内部实现，升级时爆炸半径更大 |
| 只在集成测试里断言字段 | 运行期仍然静默；测试不能替代边界校验 |
| 用 JSON Schema 而非 zod | 项目已依赖 zod（MCP SDK 同源），不引入第二个校验器 |

## 后果

- 正面：协议漂移变成**明确、可定位**的失败；字段读取只有一处；升级工作量集中；契约回放让测试具备证据力。
- 代价：zod schema 需要与真实 wire 同步维护；契约校验会拒绝 DSH 的兼容性扩展（有意为之：宁可明确失败）。
- 注意：校验只放在 wire 边界（外部输入），进程内接口之间不做重复校验（与 DSH 的"信任 TypeScript 类型化边界"一致）。

## 验证

1. 契约回放：真实 wire 通过；人为删字段/改类型 → 必须 `ProtocolDrift` 且信息可定位；
2. 未知 `turn/end` kind → `failed(turn-unknown:<kind>)`；
3. 升级演练：把 pin 切到另一个已发布版本（如可用）后，契约测试指出全部不匹配点。
