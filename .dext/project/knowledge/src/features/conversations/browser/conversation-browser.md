## Responsibility

- **Names**: Conversation Browser UI → `ConversationBrowser`（`src/features/conversations/browser/conversationController.ts`）与同目录的 DOM 视图类，装配入口在 `src/webview/main.ts`（`new ConversationBrowser()`、`new TranscriptView(...)`、`new AgentTraceView(...)`）。
- 该区域拥有 webview 侧会话面板的全部 DOM 及其 DOM 级状态：会话标签条与拖拽（`conversationTabs`、`conversationTabDrag`）、回合行与选择（`transcriptView`、`turnTitle`）、Process 时间线与工具分组（`agentTraceView`）、Todo 折叠（`agentTodoView`）、Plan 工具栏（`planControls`）、输入区草稿/附件/溢出（`composerController`、`composerOverflow`、`skillSelection`）、问题与交互卡片（`agentInputView`、`interactionForm`、`interactionDialog`、`interactionMarkdown`、`selectField`、`selectionGroupField`）、图片标注（`imageAnnotation`、`imageAnnotator`、独立文档 `imageAnnotatorPage`）、滚动跟随与探测（`outputScrollController`、`scrollProbe`），以及 `turnDomAdapter` 这类 DOM 注入适配。
- 它不拥有业务状态：会话集合、权威 activeId、待回答问题、计划进度与 provider 会话都在 `features/conversations/host/*` 中；也不决定呈现语义，那属于 `features/conversations/presentation/*` 的纯函数。

## Design

- **每个视图一个类、依赖从构造函数注入**：`AgentTraceView` 只要 `AgentTraceHost`（document、markdown、codeBlock、panel、progress 钩子），`OutputScrollController` 只要 `ScrollViewport` 与 `requestFrame`/`cancelFrame`，`AgentInputView` 只要 `respond`、`InteractionDraftStore`、`InteractionFileHost`。`turnDomAdapter` 把 `document` 显式传进 `renderTurnSection`，因此渲染逻辑不依赖全局 DOM，能在无浏览器环境下测试。
- **渲染预算被显式管理，而不是交给调用方**：流式 Markdown 通过 `requestFrame` 合并成每帧一次（`flushMessageRenders`），且只有 `data-final` 的行才触发图表渲染；工具调用按 `groupId` / `solo` 折叠成相邻分组，Process 标题的计数来自 `commandIds` 而非所有事件，所以文件与图片步骤不会把命令数撑大。
- **异步竞态在视图内部收口**：`ConversationBrowser` 用 `switchId`、`renderGeneration`、`renderedSignature` 判断迟到 IPC 是否过期；`AgentTraceView.isolate()/restore()` 让历史回放拥有独立的事件 id 映射，避免重放事件覆盖正在流式的回合；`AgentInputView.put` 拒绝把已终态卡片重新置为 waiting，重放事件不会复活已回答的表单；`OutputScrollController` 在标签切换、用户手势和释放时作废旧帧。
- **DOM 就是状态的容器，因此按生命周期切分**：`AgentTodoView` 每回合一个实例，缓存会话仍保留进度与用户展开的选择；`ComposerDraftStore` 每标签一份草稿，并按 `@relativePath` 过滤附件，避免已删除引用的图片被复活；`ConversationViewStore` 只保留最近 `MAX_CONVERSATION_VIEW_CACHE`（6）个会话 DOM，否则一次普通标签切换的代价会随会话长度增长。
- **展示决策外置**：所有文案、图标与行内容来自 `presentation` 导出的展示模型（`presentAgentMessage`、`agentTodoRows`、`presentTurn`、`presentAnswerField`、`answeredCardTitle`），视图只负责建节点与挂事件，于是实时流、历史回放和“复制 Process”共用同一份呈现结果。

## Boundary

- Allowed:
  - 同 feature 的非实现层：`../contracts/*`、`../presentation/*`。
  - 其它 feature 的非 host 层，如 `features/workspace/domain/fileReference.js`。
  - `src/shared/*`（契约与协议类型）。
  - `src/platform/browser/*`（`markdownDiagrams`、`fileReferenceChip`）与本目录内部模块。
  - 由构造函数注入的宿主能力（`AgentTraceHost`、`InteractionFileHost`、`UiFormResult` 回调），调用方向由装配层决定。
- Forbidden:
  - `vscode` 模块与 node 内置模块；`src/app/`、`src/webview/`、`src/runner/`（`scripts/checkModuleBoundaries.mjs` 对 browser 层直接报错）。
  - `src/features/*/host/*`：状态必须经注入的回调或展示模型到达，不能直接读取宿主存储。
  - 任何 `src/platform/*` 下非 `browser` 的适配层。
  - 拥有或裁决业务状态（当前会话、待答问题、计划进度、provider 会话），以及发起执行、读写文件系统或工作区。