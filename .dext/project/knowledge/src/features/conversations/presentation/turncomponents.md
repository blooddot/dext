## Responsibility

- **Names**: TurnComponents → `src/features/conversations/presentation/turnComponents.ts`，连同同目录 `turnPresentation.ts`、`agentMessagePresentation.ts`、`agentTodoPresentation.ts`；界面上的 Input / Process / Output 只是它渲染出的区块标签，Agent result 是消息卡片的界面叫法，职责名仍取代码名。
- 拥有一次 turn 的呈现模型：三段结构与区块标签（`TurnRenderModel`、`TurnSectionPresentation`）、模式胶囊（`presentTurnMode`）、耗时与用量文案（`presentTurn`、`formatTurnTokenUsage`、`updateTurnTokenUsage`），以及宿主命令与工具栏共用的动作文案（`TURN_COPY_ACTION`、`TURN_DELETE_CONFIRMATION`、`presentPlanProject`）。
- 拥有「哪些结果进 Output」的唯一分派：`renderTurnResult` 按 `DextResult.kind` 决定走 markdown、JSON、计划链接还是 patch 提示，`terminal` 与未声明 `kind` 的返回值不渲染；`resultCopyText` 复用同一规则，看不到的也复制不到。
- 拥有两种输出介质的唯一渲染路径：`TurnRenderAdapter<E>` 只要求 `element(tag, attributes, children)`，`turnHtmlAdapter` 用转义字符串实现，DOM 侧由 `browser/turnDomAdapter.ts` 实现，因此 `renderTurnSection`、`renderTurnInput`、`renderTurnJson`、`renderTurnMessage` 只写一遍。
- 拥有 agent 消息的结构化呈现：`presentAgentMessage` 解析 `dext-result` 信封、```json 围栏或裸 JSON，产出标题、meta、changes、`files` 引用与 terminal 段落；解析失败返回 `structured: false` 并把原文交回，`agentMessageCopyText` 是同一模型的复制形态。
- 拥有待办与 Plan 结算文案：`latestAgentTodos`、`agentTodoProgress`、`agentTodoRows`、`planExecutionLabel` 提供 `n/m completed` 进度、行片段与 Completed / Incomplete / Blocked / Stopped 标签，History 与实时 Todo 面板共用。
- 不拥有：DOM 状态与刷新时机、历史面板外壳、ANSI 分段、交互请求生命周期与 `DextResult` 契约本身（分别归 browser 视图、History render、UiInteractionBroker 与 `shared/contracts/types.ts`）。

## Design

- 按「谁解释同一件事」成形，而不是按目录成形：这些文件同时被宿主 `presentation/historyRender.ts`（静态安全 HTML）与 `browser/agentTraceView.ts`、`browser/transcriptView.ts`、`browser/agentTodoView.ts`、`webview/main.ts`（DOM）消费，所以必须留在无环境纯层。把整个 `presentation/` 目录并成一个「呈现层」节点的方案两次评审被否，因为它会让 `terminalText.ts`（已归 History render 的 ANSI 规则）和 `uiInteractionPresentation.ts`（已归 UiInteractionBroker 的答案生命周期）变成第二个主人。
- 适配器而不是分支：唯一的介质差异是文本如何安全落地（HTML 要转义，DOM 作为文本节点追加），把它压进 `element()` 之后，段落骨架、结果分派与消息结构只剩一份实现，两种视图无法各自漂移。
- 无状态模型与有状态视图分开：`turnPresentation.ts` 只产出不可变模型，不持有流；实时视图自己决定何时更新，History 一次渲染，于是标签、mode 与计时口径不会各写一套。
- 快照语义写在更新函数里：`updateTurnTokenUsage` 让计费快照整体替换、ACP 的仅上下文更新合并，避免后者抹掉先到的计费；`formatTurnTokenUsage` 对 `contextTokens` 使用 context 措辞而不是伪装成费用。
- 解析保守：`presentAgentMessage` 只认能解析出 `kind` 的 JSON，未知 `kind` 退回 JSON 文本，解析失败退回原文，从不猜测结构；meta 只由已知字段拼出（文件数、引用数、status、exit code、duration）。
- terminal 结果刻意不渲染：`renderTurnResult` 对 `kind === "terminal"` 返回空数组，注释写明它的返回值是给 API 读的，要给人看由 API 自己 `console.log`；未声明 `kind` 的普通返回值同理，于是「Output 只放给人看的内容」只有一处判定。
- 复制与显示同源：`agentMessageCopyText` 由同一个 `AgentMessagePresentation` 重建，`resultCopyText` 与 `renderTurnResult` 共享分派规则，新增一种结果只需改一处。
- 待办文案是纯函数：`agentTodoProgress` 给出进度与 `complete` 标志，`agentTodoRows` 只生成 `<li>` 片段并复用共享 Markdown 渲染，History 的 `renderAgentTodos` 与实时 `agentTodoView` 用的就是同一套行，避免两套状态措辞。

## Boundary

- Allowed: `src/shared/contracts/types.ts`（`DextResult`、`ApplyResult`、`AgentStreamEvent`、`AgentTodoItem`、`AgentTokenUsage`、`PlanExecutionOutcome`）、`src/shared/contracts/planProject.ts`（`PlanProjectContext`）、`src/shared/lib/` 的 `markdown`、`jsonOutput`、`duration`、`html`，以及同目录 `uiInteractionPresentation.ts`（仅取 `uiResultText`）。
- Allowed: 被 `presentation/historyRender.ts`、`browser/turnDomAdapter.ts`、`browser/agentTraceView.ts`、`browser/transcriptView.ts`、`browser/agentTodoView.ts`、`browser/planControls.ts`、`webview/main.ts` 与 `extension.ts` 引用；产出不可变模型或 HTML 字符串，不修改入参。
- Forbidden: 触碰 DOM、`vscode`、Node 内置模块，或 import `src/app/`、`src/webview/`、`src/runner/` 与任何 `host/`、`browser/` 实现（含本 feature 的历史外壳）；纯层边界检查会直接报错。
- Forbidden: 读写会话历史、Plan 文本与设置，推进 turn 状态或订阅 agent 流；这些分别归 `DextHistoryStore`、`PlanController`、`TurnExecutionCoordinator` 与 `AgentEventStream`。
- Forbidden: 决定何时刷新、缓存 DOM 行、抢占滚动或写入剪贴板；时机与副作用属于实时视图和宿主，本节点只回答「长什么样」与「复制什么」。
- Forbidden: 另写一套 ANSI 分段、交互卡片或结果契约：`terminalSegments` 归 History render 节点，交互答案归 UiInteractionBroker，`DextResult` 等类型归 `shared/contracts/types.ts`。