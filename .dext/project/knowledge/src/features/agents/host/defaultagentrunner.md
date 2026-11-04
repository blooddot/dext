## Responsibility

- **Names**: Agent Runner → `src/features/agents/host/agentRouter.ts`（`DefaultAgentRunner`；同一节点还包含 `src/features/agents/domain/agentTimeout.ts`、`agentToolActivity.ts`、`cliCompletion.ts`）
- 拥有 provider → runner 的分派：`codex` / `claude` → `CliAgentRunner`，`deepseek-harness` → `DeepSeekHarnessRunner`，`pi` → `PiAgentRunner`；其余 provider 直接抛出 `Unsupported Agent backend`，不做猜测性回退。
- 拥有 `AgentRunner` 端口上三种调用形态的统一入口：`run`（带 Dext 结果契约的类型化调用）、`runConversation`（无信封的普通对话，返回纯文本）、`runStructured`（走 provider 原生 schema 通道，返回符合 schema 的原文），并负责在能力缺失时报出带 `profile.label` 的错误。
- 拥有超时与生命周期的扇出：`setTimeouts` 把总时长与空闲超时同时写到三个 runner；`endSession` 只交给持有原生会话的 harness 与 pi；`dispose` 并行关闭它们。
- 拥有回合看门狗的三个原语：`agentTimeout`（总时长 / 空闲 / 静默工具三层计时）、`trackCliToolActivity`（从 CLI 原始事件流识别工具起止）、`cliCompletion`（识别协议终止事件并给出退出码）。

## Design

- 端口与实现分开：`AgentRunner` 接口在 `agentRunner.ts`，`DefaultAgentRunner` 在 `agentRouter.ts` 实现它；`application.ts` 构造一次并注入 `WorkflowRuntime.setAgentRunner`，而 `runtime.ts` 保存的字段类型只是端口，`profile.provider` 到具体 runner 的分叉只发生在这一个类里。
- 路由本身无状态：Codex thread、Claude session、Pi/ACP session 都留在各自 runner 的映射中，所以 router 不缓存会话，`endSession` 只需盲转发；`CliAgentRunner` 没有实现这个可选方法，CLI 的会话映射因此随宿主进程存活，router 不替它编造清理路径。
- 能力差异在调用点声明，而不是靠类型收窄：`runConversation` / `runStructured` 是端口上的可选方法，缺失即抛错。Harness 的 ACP 没有 schema 字段，所以结构化输出被显式拒绝，而不是静默降级为“把 schema 写进提示词再解析文本”。
- 组合根保留具体句柄：`harness` 与 `pi` 是公开只读字段（`cli` 为 private），`application.ts` 因而能直接 `pi.configure(...)`、`harness.preloadSettings()` 并挂 `onModels`；router 不假装隐藏后端差异，只统一调用形态。
- 超时扇出用 `undefined` 表示“本次不改”：只设置总时长或只设置空闲时，另一项保持原值；runner 在回合开始时读取字段，所以配置变更只影响新回合，进行中的回合不受影响。
- 三层计时回答三个不同问题：总时长默认 0（关闭）并被 `setTimeout` 的 2^31-1 毫秒上限截断；空闲计时只在没有进行中工具时运行，任何进程输出都会重置它；静默工具上限只在工具未结束时运行，任何进展只做 `refresh`，超时时报出仍未结束的调用 id，避免一个永不回报的工具把空闲检测永久挂住。`completedTools` 只保留最近 256 个已结束 id，够吞掉迟到的重复 `toolStarted`，又不会让长计划回合无限增长内存。
- `cliCompletion` 与 `trackCliToolActivity` 在展示过滤之前读 JSON 行：空结果或被合并的多工具消息在 UI 上会被折叠，但生命周期必须完整；无法识别的 provider 与事件一律不暂停看门狗，宁可让普通空闲超时生效。

## Boundary

- Allowed: 按 `profile.provider` 分派到已注册的 runner；把超时、配置与生命周期调用转发给具体 runner；在 domain 层解析 CLI 输出的原始协议行，只用于计时与结束判定；定义 provider 之间的能力差异并以错误形式暴露。
- Forbidden: 不实现任何 CLI 进程启动、登录探测、会话恢复或结构化输出协议（属于 `agentRunner.ts` 的 `CliAgentRunner`、`deepseekHarnessRunner.ts`、`piAgentRunner.ts`）；不持有 agent 档案、模型缓存或全局选择（属于 `agentProfiles.ts` 的 `AgentProfileStore`）；不持有标签页与对话生命周期（属于 `ConversationBrowser`）；不决定权限分层，只透传调用方给定的 `allowWorkspaceWrite` 与 `permission`；不写入 Project 索引，也不生成 Project 结构。