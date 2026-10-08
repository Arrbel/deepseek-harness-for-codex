# ADR-0003：生命周期状态机与终态保证

- 状态：**已接受**（实现在 Phase 5；测试网在 task-6 先建立）
- 日期：2026-10-08
- 相关：`docs/architecture.md` §3、审计报告 §4 P1-2、P1-3、P2-2、P2-3

## 背景

当前的运行生命周期散落在 `RunManager` 的多个方法里（`start`/`refresh`/`wait`/`cancel`/`terminate`/`stopService`），导致三类可复现缺陷：

1. **无终态保证**：`refresh()` 的 catch 只写 `run.error`，不动 `status`，也不释放活动会话锁；cookie 失效（401）后 `authCookie` 永不复位 → 运行**永久停在 `running`**，调用方拿到的永远不是终态；
2. **终态判定错误**：`turnFailure()` 只识别 `error`/`aborted`/`interrupted`，其余一律 `null` → `blocked`（回合在任何 step 前被拒，通常无任何助手文本）与 `max-tokens`（输出被截断）都被判为 `succeeded`，属于**静默假成功**；`kind === "disposed"` 是死分支（真实形态是 `aborted.reason.kind`），用户从 Web UI 取消会被误报为 `failed` 而非 `cancelled`；
3. **收尾竞态**：`terminate()` 的早退分支（`exitCode !== null`）不写 `status`/`stoppedAt`、不清理工作区索引；Windows 宽限期 1 s（POSIX 5 s），慢死进程可能在仍占端口时被标记 `stopped`。

架构层面还缺一条不变量：**任何异步操作都必须由单一生命周期控制器持有，并且只在成功提交点发布状态**（这条在 DSH 官方 `packages/AGENTS.md` 中已是成文规则）。

## 决策

1. 引入显式状态机：服务 `idle→starting→running→stopping→stopped|failed(cause)`；运行 `pending→running→{succeeded|failed(reason)|cancelled}`（见 architecture §3.1/§3.2）。
2. **settle-once**：终态只由 `settle(run, outcome)` 写入一次，内部统一处理 `finishedAt`、活动会话锁释放、终态快照与回调。任何路径（异常、超时、取消、服务崩溃、认证失效）都必须经由 `settle`；"只写 error 不改状态"被不变量排除。
3. **错误分类驱动恢复**（`dsh/wire.ts` 分类 → `run/state.ts` 策略表）：`AuthExpired` 清 cookie 重换一次；`Transport` 退避重试 ≤3 次；`ProtocolDrift` 不重试、立即以可诊断信息失败；`Rpc` 按 contract 登记的处理表，未登记即失败。
4. **turn 结局显式穷尽 + fail-closed**：以官方 `TurnEndReasonMap` 全集建表（completed/error/blocked/max-tokens/aborted(+cause)/interrupted/forked），未知 kind → `failed(turn-unknown:<kind>)`。**只有 `completed` 判成功。**
5. 删除基于 `agent/error` 会话事件的分支（该事件不属于会话日志，见 architecture §3.2 注）。
6. 服务停止在所有分支收敛状态，并区分"确认退出"与"未确认退出"（后者附带告警字段，不谎报 `stopped`）。
7. 状态迁移是唯一写入点；对外只暴露派生快照（不含内部可变引用）。

## 备选方案

| 方案 | 否决原因 |
|---|---|
| 在 `refresh()` 的 catch 里加 `run.status = "failed"` | 逐点修补：仍有其它路径绕过终态；且把可恢复错误（401/瞬时网络）直接判死，与恢复策略冲突 |
| 只把 `turnFailure` 改成白名单 | 只解决 2，1 与 3 仍在；且没有类型层面的穷尽约束，DSH 新增 kind 时仍会静默 |
| 给 `RunStatus` 增加 `incomplete`/`truncated` 等新状态 | 会扩散到 MCP 表面与文档；本阶段用 `failed` + 明确 `reason` 表达"不完整"，保持状态集合最小（未来需要时经 ADR 扩展） |
| 用 `EventEmitter` 广播状态变化替代显式状态机 | 仍是分散写入；不变式无法在单点保证 |

## 后果

- 正面：不存在"永久 running"；不存在"静默假成功"；收尾状态可信；错误分类可测试、可回归。
- 代价：`RunStatus` 语义收敛到三值 + `reason` 字段；需要同步更新工具描述、SKILL 与测试。
- 兼容性：`RunSnapshot` 增加 `reason`/终态标识等字段是**外部可感知变更**，需进 CHANGELOG。**`stopUnconfirmed` 只加在 `ServiceSnapshot`**（服务级事实：未能确认子进程退出）；运行级不设该字段，因服务停止而失败的运行使用 `reason = service-unreachable`。

## 验证

1. 纯单测覆盖状态机全部迁移与 settle-once（含非法迁移）；
2. 事件投影表驱动测试：`TurnEndReasonMap` 每个成员各一条断言，未知 kind 判 `failed`；
3. 集成测试：注入 403/401、瞬时连接失败、协议字段缺失、服务中途被杀，断言各自落到预期终态且不再悬挂；
4. 反向验证：把 `turnFailure` 改回"其余返回 null" → 对应 `blocked`/`max-tokens` 用例必须变红。

## 裁决补充（Lead，2026-10-08，早于 task-9 开工；与上文冲突时以本节为准）

| 议题 | 裁决 | 理由 |
|---|---|---|
| `settle` 二次调用 | 主 API 为 `settle(record, outcome) => boolean`（已终态则不写、返回 false）；严格抛错变体仅供测试 | 停机/释放路径不得因重复 settle 中断，否则会跳过后续服务停止 |
| `stopUnconfirmed` | **只在 `ServiceSnapshot`**；运行级用 `reason = service-unreachable` | "未能确认子进程退出"是服务级事实，运行级语义无法确证 |
| 错误分类 | `dsh/wire.ts` 的分类器为**唯一实现**；`dsh/client.ts` 抛带 kind 的类型化错误；`run/state.ts` 改成"类型化错误 → 策略表"的纯函数，删除按 message 正则猜测 | 双轨分类会导致"测试绿但线上走到另一条路径"，且正则猜测无法区分 `ProtocolDrift` |
| `FailureReason` | 模板字面量联合（`rpc:<code>` / `turn-aborted:<cause>` / `turn-unknown:<kind>` 等） | 穷尽 + fail-closed 需要类型支撑，否则扩展只能靠字符串约定 |
| `RunState` / `RunRecord` | 合并为 `RunRecord`，删除无人构造的 `RunState` 死钩子 | 避免"有状态类型但没有实例"的伪抽象 |
| 就绪失败 cause | 统一 `no-first-output` / `no-url-line` / `install-timeout` / `install-failed` / `exit-before-ready`；删除 `quiet-timeout` 与别名展示 | 单预算 + 活动重置模型下 `quiet-timeout` 无对应物；别名让日志与文档出现两套词汇 |
| 契约严格性 | 不属本 ADR 落地的 P5 范围（见 ADR-0004/P6） | 收紧 `contract.ts` 会把当前可用的调用变成失败，属行为变更，需独立任务与回归 |
