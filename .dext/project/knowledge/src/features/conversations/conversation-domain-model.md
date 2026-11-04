## Responsibility

- **Names**: Conversation Domain Model → src/features/conversations/domain 与 src/features/conversations/contracts（DextHistoryRecord、PlanResponse、planTodoProgress、orderHistorySessions）。
- 拥有会话与计划的**数据形状**：`contracts/history.ts` 定义 `DextHistoryRecord` / `DextHistorySession` / `ConversationHistoryStore`，`contracts/protocol.ts` 定义会话消息 schema 与 `ConversationSummary`，`contracts/preferences.ts` 定义按会话存储的偏好与布局。
- 拥有一轮执行的**能力切口**：`contracts/execution.ts` 的 `ExecutionSnapshot`、`TurnExecutionHost`、`TurnInteractionPort`、`ConversationSessionPort`、`TurnNotifier`，把“一次 turn 需要什么”写成端口，而不是把整个应用交出去。
- 拥有**纯逻辑**：事件行归并与截断（`agentEventLog`、`truncation`）、智能体选择归一（`agentSelection`）、历史排序与布局归一（`conversationOrder`）、历史响应兼容解码（`historyResponse`、`agentTraceReplay`）、计划文档协议与流过滤（`planResponse`、`planDocumentStream`、`planTemplate`）、计划文件命名（`planFile`）、计划任务进度与轮次推进（`planTodoProgress`、`planExecution`）。

## Design

- 这一层被刻意做成“无环境”的：不 import `vscode`、Node 内置模块或 DOM 全局，也不 import `src/app/`、`src/webview/`、`src/runner/`。于是 extension host、webview 打包、History 页面和测试共用同一份规则，规则只有一处定义。这正是 `scripts/checkModuleBoundaries.mjs` 对纯层（`contracts`/`domain`/`knowledge`/`presentation`）强制的方向：运行时可依赖同 feature 与 `shared/`，对 feature 的 host/browser 只能是已在 `declaredTypeEdges` 登记的 type-only 边。
- 契约与实现分开，是为了让持久化实现可替换：`ConversationHistoryStore` 与 `ConversationPreferences` 只描述能力，真正的文件/Memento 存储留在 `host/historyStore.ts`、`host/conversationPreferences.ts`，控制器和测试只依赖契约。
- 协议解析放在数据边界而不是渲染端：`splitPlanResponse` / `PLAN_DOCUMENT_START` / `PLAN_DOCUMENT_END` 让 Plan 回合同时产出“给聊天看的短回复”和“落盘的完整文档”；`PlanDocumentFilter` 按 `message.id` 累积**原始文本**再计算可见文本，因为 provider 分片会把分隔符截断在两块之间；过滤通过 `guardPlanDocumentEvents` 包在 runner 的 `onEvent` 回调外侧，Codex app-server、Codex CLI、Claude、Harness 因此共享同一规则，而不必各自理解 Plan 文档。
- 计划进度只承认显式状态：`planTodoItems` 从文档的 Tasks 区段取初始列表（跳过代码围栏与其它清单），此后只有 `<!-- dext-todo: {...} -->` 这类结构化报告能改状态；`PlanTodoProgress` 只重扫上一条未剥离的尾部，单块成本随分片长度而不是整条消息增长。`PlanExecution` 用 64 轮上限、连续 3 轮“无新完成且无新工具活动”即停、以及 blocked 与 verification 判定，把“没进展”变成一个可解释的结局，而不是无限续跑。
- 兼容逻辑集中在持久化边界：`normalizeHistoryResponse` / `readHistoryResponse` 只解码旧记录，绝不改写已保存输出；`appendAgentEvent` 与 `compactAgentEvents` 顺手修复行压缩之前写入的历史；`truncateMiddle` 保留首尾两端，因为一条命令的结论和开头同样重要。
- 命名与顺序规则同样归这里：`planSlug` / `planFileName` / `planPathSegments` 给出唯一的合法计划路径定义（拒绝 `..`、绝对路径与盘符），`orderHistorySessions` / `orderedConversationIds` / `normalizeConversationLayout` 让 host 存储、History 页面与标签条按同一套规则排序和归一。

## Boundary

- Allowed: 依赖 `src/shared/`（contracts/protocol/lib）与同 feature 的 `contracts/`、`domain/` 类型；允许跨 feature 的纯层类型与纯逻辑（如 `agents/domain/agentTodoTracking`、`workflow/contracts/skill`）；被本 feature 的 `host/`、`browser/`、`presentation/` 以及 `webview/main.ts`、`app/application.ts`、`features/workflow/host/runtime.ts` 读取。
- Forbidden: 不得 import `vscode`、Node 内置模块或 DOM 全局；不得 import `src/app/`、`src/webview/`、`src/runner/`；不得运行时依赖任何 feature 的 `host/` 或 `browser/`（type-only 也须显式登记）；不持有 VS Code 存储、IPC 通道、定时器、中止控制器或可变会话状态——这些归 `host/` 与 `browser/`。