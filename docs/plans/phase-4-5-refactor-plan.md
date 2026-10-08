# 执行计划：Phase 4 分层重构与 Phase 5 状态机

依据：`docs/architecture.md`（§2/§3）、ADR-0003、ADR-0004、ADR-0005。
纪律：**P4 是纯搬运，行为必须逐字节等价**；任何行为变化都属于 P5/P6，必须单独提交并带对应测试。

> ## ⚠️ P4 已执行完毕（2026-10-08，task-8）——本文 §1/§2 的行号与文件清单已被现实取代
>
> - 本文写于 P3 之前，§1 按"`run-manager.ts` 673 行"编排；**实际冻结时它是 785 行**（P3 改过它），行号全部位移。
> - 实际执行时按现状重算的映射表、删除/新增清单、分步记录见 **`reports/impl-layering.md` §1–§3**（该表的行号以现状为准，是权威版本；本文 §1 保留作"当初的设计意图"对照）。
> - 实际结构（P4 交付）：`src/{bin.ts, app/container.ts, config/*, policy/*, dsh/*, service/*, run/*, tools/*, diagnostics/*, util/*, version.ts}`；`run-manager.ts`、`server.ts`、`runtime.ts`、`types.ts` **均已删除且无转发壳**。
> - 与本文的 8 处偏差（D1–D8）见 `reports/impl-layering.md` §7：其中 D1（`bin.ts` 不改名）、D6（一并删除 `runtime.ts`/`types.ts`）是 Lead 决策，D3/D4/D7 是刻意留给 P5/P6 的行为边界。
> - §3 的分步顺序、§4 的 P5 行为清单、§5 的反模式清单**仍然有效**；P5 的落地口径以 **task-9 任务书（revision ≥5）的「裁决」表**为准（例如 `settle` 返回 boolean、`stopUnconfirmed` 只在 `ServiceSnapshot`、`FailureReason` 模板字面量、`doctor.dataDirectory` 四字段）。

---

## 1. 当前文件 → 目标模块映射（`src/run-manager.ts` 673 行）

| 当前区间 | 内容 | 去向 |
|---|---|---|
| 1–16 | 常量（`READY_PATTERN`、三种超时、`MAX_LOG_CHARACTERS`） | `dsh/contract.ts`（协议常量）、`config/types.ts`（预算默认值） |
| 18–49 | `ServiceRecord` / `RunRecord` 内部记录 | `service/supervisor.ts`（服务记录）、`run/registry.ts`（运行记录），**不导出** |
| 51–73 | `RpcEnvelope` / `SessionSummary` / `HistoryEvent` / `SessionPage` | `dsh/types.ts`（DTO）+ `dsh/contract.ts`（schema） |
| 75–84 | `RunManagerOptions`（进程/浏览器/命令工厂注入） | 各模块自己的 options：`supervisor.ts`（`spawn`、`commandResolver`）、`service/runtime-package.ts`（`npmRunner`）、`tools/register.ts`（`openBrowser` 回调） |
| 86–98 | `defaultSpawnProcess` | `service/supervisor.ts` |
| 100–108 | `defaultOpenBrowser` | `service/browser.ts`（新，唯一副作用点） |
| 110–121 | `killWindowsProcessTree` | `service/process-tree.ts`（跨平台：`reapTree(child)`） |
| 123–126 | `isWithin` | `policy/workspace.ts` |
| 128–132 | `samePath` | `policy/paths.ts`（新，`samePath`/`normalize`） |
| 134–136 | `redactLaunchToken` | `service/credentials.ts`（`redact()`） |
| 138–140 | `errorText` | `util/errors.ts` |
| 142–160 | `recordText` / `turnFailure` | `dsh/events.ts`（`turnOutcome(reason)` 表驱动） |
| 162–178 | `assistantText` | `dsh/events.ts`（`projectAssistantText(events)`） |
| 181–203 | 类字段与构造器 | `app/container.ts`（唯一组合根） |
| 205–255 | `startService`/`openService`/`listServices`/`stopService` | `service/supervisor.ts` 的公开 API；工具层薄适配 |
| 257–340 | `start()`（建 workspace/session、提交 prompt、登记 run） | `run/orchestrator.ts`（新） |
| 342–375 | `list`/`get`/`wait`/`cancel` | `run/orchestrator.ts` + `run/registry.ts` |
| 377–382 | `close()` | `app/container.ts#dispose()`（逆序关闭） |
| 384–451 | `launchService` | `service/supervisor.ts` + `service/readiness.ts`（解析）+ `service/runtime-package.ts`（获取） |
| 453–502 | `refresh` | `run/orchestrator.ts#refresh()` + `dsh/events.ts` + `run/state.ts#settle()` |
| 504–523 | `rpc` | `dsh/client.ts#call()` |
| 525–548 | `authenticate` | `dsh/client.ts#ensureCredentials()` |
| 550–582 | `eventsSince` | `dsh/client.ts#readEvents()`（含分页保护：无进展即抛） |
| 584–593 | `resolveWorkspace` | `policy/workspace.ts#resolveWorkspace()` |
| 595–615 | `require*` / `releaseSession` | `run/registry.ts` 内部 |
| 617–638 | `terminate` | `service/supervisor.ts#stop()` |
| 640–672 | 快照投影 | `run/registry.ts#snapshot()`、`service/supervisor.ts#snapshot()` |

搬运完成后 `src/run-manager.ts` **删除**（不得保留 facade 薄壳，否则逻辑会回流）。

---

## 2. 模块接口（实现即按此签名，不再另行设计）

```ts
// dsh/contract.ts —— 唯一声明"依赖 DSH 什么"
export interface MethodSpec<Req, Res> {
  readonly method: string;
  readonly request: z.ZodType<Req>;
  readonly response: z.ZodType<Res>;
}
export const METHODS: {
  'workspace/create': MethodSpec<{request: {path: string}}, {workspace: {workspaceId: string}; created: boolean}>;
  'session/create': MethodSpec<{request: {workspaceId: string}}, {sessionId: string}>;
  'session/list': MethodSpec<{_request: Record<string, never>}, {items: SessionSummary[]}>;
  'session/projections': MethodSpec<{request: {sessionId: string}}, {asOfSeq: number} | null>;
  'session/page': MethodSpec<{request: SessionPageRequest}, SessionPage>;
  'session/prompt': MethodSpec<{request: PromptRequest}, {accepted: true}>;
  'session/cancel': MethodSpec<{request: {sessionId: string}}, {accepted: true}>;
};
export const CAPABILITIES: { apiPrefix: '/api'; engineRange: '^22.19.0 || >=24.0.0'; dshLine: string };
export function turnOutcome(reason: unknown): TurnOutcome;   // 表驱动 + fail-closed

// dsh/client.ts
export interface DshClient {
  ensureCredentials(signal?: AbortSignal): Promise<LaunchCredentials>;
  invalidateCredentials(): void;                            // 401 恢复用
  call<M extends keyof typeof METHODS>(m: M, args: ArgOf<M>, opts?: {signal?: AbortSignal}): Promise<ResOf<M>>;
  readEvents(sessionId: string, since: number, through: number): Promise<SessionEvent[]>;
}

// service/runtime-package.ts
export interface RuntimePackage { readonly binPath: string; readonly version: string; readonly root: string; }
export interface EnsureRuntimeOptions { prefix: string; spec: string; timeoutMs: number; onProgress?: (line: string) => void; }
export function ensureRuntimePackage(o: EnsureRuntimeOptions): Promise<RuntimePackage>;

// service/supervisor.ts
export interface Supervisor {
  start(workspace: string): Promise<ServiceSnapshot>;       // 幂等：同工作区复用
  open(serviceId: string): Promise<ServiceSnapshot>;
  list(): ServiceSnapshot[];
  stop(serviceId: string): Promise<ServiceSnapshot>;        // 幂等、必收敛
  dispose(): Promise<void>;                                 // 逆序关闭全部服务
}

// run/state.ts —— 纯模块
export type RunOutcome = {kind: 'succeeded'} | {kind: 'failed'; reason: FailureReason; message: string} | {kind: 'cancelled'};
export function settle(run: RunState, outcome: RunOutcome, now: Date): RunState;   // settle-once，二次调用抛错
export function classifyFailure(error: unknown): FailurePolicy;                    // 分类 → 重试/终态策略

// run/registry.ts
export interface RunRegistry {
  create(init: RunInit): RunState;
  require(runId: string): RunState;
  list(): RunState[];
  acquireSession(serviceId: string, sessionId: string): void;   // 活动会话锁
  releaseSession(serviceId: string, sessionId: string): void;
}

// tools/catalog.ts —— 单表驱动
export interface ToolSpec { name: string; title: string; description: string; input: z.ZodRawShape;
  annotations: ToolAnnotations; handler: (ctx: ToolContext, input: never) => Promise<ToolResult>; }
export const TOOLS: readonly ToolSpec[];
```

**纯模块**（不得 `import node:fs|child_process|net`）：`dsh/events.ts`、`dsh/wire.ts`、`dsh/contract.ts`、`policy/*`、`run/state.ts`、`service/credentials.ts`、`util/*`。

---

## 3. 搬运顺序（每一步结束都必须 `npm run check` 全绿）

| 步 | 动作 | 验证 |
|---|---|---|
| 4.1 | 建 `util/`、`policy/paths.ts`、`policy/workspace.ts`，把 `isWithin`/`samePath`/`resolveWorkspace` 搬入并单测 | 新增单测覆盖符号链接/大小写/越界 |
| 4.2 | 建 `dsh/types.ts` + `dsh/events.ts`，把 `assistantText`/`turnFailure` 搬入（**行为不变**，仍保持现有判定），加表驱动骨架 | 现有 run-manager 测试全绿；新增 events 单测（当前行为快照） |
| 4.3 | 建 `dsh/wire.ts` + `dsh/client.ts`，把 `rpc`/`authenticate`/`eventsSince` 搬入，**保持签名与错误消息不变** | 现有集成测试全绿 |
| 4.4 | 建 `service/credentials.ts` + `service/readiness.ts` + `service/supervisor.ts`，把 `launchService`/`terminate`/`killWindowsProcessTree` 搬入 | 集成测试（真子进程 + 夹具）全绿 |
| 4.5 | 建 `run/registry.ts` + `run/orchestrator.ts`，把 `start`/`refresh`/`wait`/`cancel`/`list`/`get` 搬入 | 现有用例全绿 |
| 4.6 | 建 `tools/catalog.ts` + `tools/register.ts` + `diagnostics/doctor.ts` + `app/container.ts` + 新 `index.ts`，删除 `run-manager.ts` 与 `server.ts` | 工具面测试 + 元数据测试全绿 |
| 4.7 | 启用 `tests/module-boundaries.test.ts`（由 task-6 预置骨架）：断言依赖方向与"纯模块无 IO 导入" | 边界测试通过；故意引入反向依赖必须失败 |

## 4. P5 行为变更清单（每项独立提交 + 测试）

1. `settle()` 成为唯一终态写入点；`refresh` 的异常路径改走 `classifyFailure` → 重试或 `settle`（P1-2：永久 running）。
2. `turnOutcome` 切换为 ADR-0003 的显式映射表 + fail-closed（P1-3：静默假成功）。
3. `aborted + reason.user` → `cancelled`；删除 `agent/error` 分支与 `disposed` 死分支。
4. `supervisor.stop()` 在所有分支收敛状态；Windows 宽限期与 `CANCEL_GRACE_MS` 统一；未确认退出时写 `stopUnconfirmed`。
5. 就绪三段预算 + 逐行进度（ADR-0002）；失败消息带脱敏日志尾。
6. `DshClient` 401 → `invalidateCredentials()` + 重试一次；`Transport` 退避重试 ≤3。

## 5. 反模式清单（评审时直接拒绝）

- 在 `tools/*` 或 `app/*` 里写业务判断（编排必须在 `run/*`）。
- 为兼容旧调用而保留 `run-manager.ts` 转发壳。
- 用字符串匹配解析 RPC 结果（必须走 contract 校验）。
- 用 `try/catch` 吞掉错误后只改一个字段（必须 `settle` 或按策略重试）。
- 新增"看起来无害"的隐式默认值（默认值只在 `config/*`）。
- 为通过测试而放宽 fixture 与实现的一致性（夹具是协议的一部分）。
