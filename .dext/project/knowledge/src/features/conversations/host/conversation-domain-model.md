## Responsibility

- **Names**: Conversation Domain Model → src/features/conversations/contracts/execution.ts
- 拥有一个会话轮次在契约层被钉住的事实：轮次模式 `ConversationMode`、运行中身份 `ExecutionSnapshot` / `ActiveExecution`，以及四个互不重叠的端口——`TurnExecutionHost`（应用能力）、`TurnInteractionPort`（问答归属）、`ConversationSessionPort`（会话表写入）、`TurnNotifier`（结果发布）。整份文件只有 `import type`，没有运行时逻辑。
- 索引标题与代码名不同源：仓库里没有叫 “Conversation Domain Model” 的类型，实际公开符号就是上述导出；使用者只有 `src/features/conversations/host/turnExecutionCoordinator.ts` 与 `test/conversationHarness.ts`。

## Design

- 之所以是端口而不是应用对象：`TurnExecutionHost` 的注释写明 “Deliberately not the whole application”，会话模块因此拿不到设置、资源浏览与 Provider 发现，只能调用显式列出的 `executeConversation` / `executeInput` / `draftResource` / `profiles` 与两个计划钩子。
- 之所以把身份做成快照：`ExecutionSnapshot` 固定 `sessionId`、`turnId`、`mode`、`source`、`startedAt`，标签切换、迟到的 Provider 事件或过期 Webview 回调都拿它比对，而不是比对“当前可见会话”，后台轮次因此不会被前台标签串味。
- 之所以拆成三个单向口：会话表只有一个写入者（控制器），协调器只通过 `ConversationSessionPort` 上报发生了什么，不改标签、布局或当前会话；`TurnInteractionPort` 让 broker 自己判定答复是否仍匹配 session/turn；`TurnNotifier` 承担发布，协调器不持有 IPC 通道。
- 之所以落在 `contracts/` 的单个主题文件：层级词表规定 feature 之间只经 `contracts`/`domain` 协作，禁止 `contracts.ts` 与 `contracts/index.ts`，消费者显式导入具体文件；契约因此能同时供 host、测试与将来的注入点使用，又不把 VS Code 或 Node 拖进来。

## Boundary

- Allowed: 仅类型导入 `shared/contracts/types.js`、`shared/contracts/planProject.js`、`shared/contracts/replay.js`、`agents/contracts/agent.js`、`resources/contracts/resourceSession.js`、`workflow/contracts/skill.js` 与同目录 `history.js`；被 `host/turnExecutionCoordinator.ts`、`test/conversationHarness.ts` 引用。
- Forbidden: 任何运行时值（`vscode`、Node 内置模块、DOM）；导入 `app/application.ts`、`app/sidebarProvider.ts`、`webview/main.ts`；直接调用 `historyStore` / `conversationPreferences` 等实现；由契约自己改会话表、改布局或发 IPC；Provider SDK 与 CLI 传输类型。