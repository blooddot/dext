## Responsibility
- **Names**: History render → `src/features/conversations/presentation/historyRender.ts`（宿主外壳 `DextHistoryPanel`，`src/features/conversations/host/historyEditorProvider.ts`；终端分段 `terminalSegments`，`src/features/conversations/presentation/terminalText.ts`）
- 拥有历史面板的全部 HTML 生成：`renderHistorySession` 输出会话行（收藏星标、归档标记、回合数、时间、会话动作按钮、原生右键菜单的 `data-vscode-context`），`renderHistorySessionBody` / `renderHistoryRecord` 输出单个回合的输入、todo、Process、输出四段，以及复制按钮与回合动作按钮。
- 拥有标题推导：`historyTurnTitle`（用户命名优先，否则 Plan 名或输入首行）与 `conversationTitle`（未命名会话取首条消息首行并展开 `@` 引用）。这两者不只是历史面板使用，`host/conversationController.ts` 也用它生成侧栏标签标题和 `turnRenamed` 消息的 `displayTitle`，因此必须留在与执行无关的纯层。
- 拥有终端输出的样式语义：`terminalSegments` 把 ANSI SGR 序列、256 色/真彩色与裸回车重绘切成 `TerminalSegment[]`，宿主侧 `highlightTerminal` 转成 `<span>`，Webview 侧 `src/webview/main.ts` 的 `terminalText` 用同一批分段构造 DOM。
- 拥有文本导出与剪贴板载荷：`historyTurnMarkdown` / `conversationMarkdown` 决定历史内容离开面板后的 Markdown 形态，`copyButton` 决定复制按钮的 `data-copy` 编码。

## Design
- 分层职责按"谁判断、谁拼接、谁持有面板"切分：`contracts/history.ts` 定义 `DextHistorySession` / `DextHistoryRecord` schema；`domain/historyResponse.ts` 负责解析历史里存的旧 JSON 响应，`domain/agentTraceReplay.ts` 提供稳定 id 的 Process 回放，`domain/conversationOrder.ts` 负责排序；presentation 只做字符串拼接；`host/historyEditorProvider.ts` 只持有 `vscode.WebviewPanel` 生命周期与消息分发。结果是渲染函数全是纯字符串函数，宿主可以直接对已持久化数据产出 HTML，既不需要 DOM，也不需要重跑执行。
- 历史与实时视图必须给出同一种解释，所以结构来源于共享组件而不是各自实现：`historyTurnSection` 的注释明确它是"Thin host adapter"，段落骨架与结果分发由 `turnComponents` / `turnPresentation` / `turnResult` 决定；Process 走 `prepareHistoryTrace`，避免重开的会话对同一事件产生不同分组；`renderProcessMarkdown` 特意复用 `dextMarkdown` + `markdownCodeCopy`，因为用 pre-wrap 渲染已存源码会把 Markdown 空行变成异常的间距。
- ANSI 规则只写一次：`terminalText.ts` 输出的是中立的分段而不是 HTML 或节点，因此宿主和浏览器两个环境共享同一套解析，样式回退（无 ANSI 的 CLI 输出按 fail/pass/prompt 等小词汇表着色）也只有一处。
- 懒加载是刻意的：`renderHistorySession({ lazy: true })` 只输出会话行，用户展开时面板 `postMessage({ type: 'loadHistorySession' })`，宿主用 `renderHistorySessionBody` 回传 HTML，Webview 注入 `innerHTML` 后再对子树重跑图表渲染。长历史首屏因此不必渲染全部回合。
- 会话标题重命名走原地更新：`refreshTurnTitle` 只发 `historyTurnTitle` 消息替换 `summary` 里的文字与 `named` 类，避免整页重渲染把已展开的回合折叠回去。
- 排序与视图过滤不归本模块：面板读取 `preferences.historyOrdering()` 后调用 `orderHistorySessions(history.list(true), ordering)`，收藏/归档视图也要求读到全部会话。
- 安全与编码边界写在渲染处：所有用户文本经 `escapeHtml`；复制载荷把 `\r` / `\n` 换成字符引用以躲过 HTML 的 CRLF 归一化；页面的 CSP nonce 与资源 URI 由宿主外壳负责。`historyTokenStyles()` 目前返回空串，终端令牌样式已由 `media/styles.css` 承担。

## Boundary
- Allowed: 同 feature 的 `contracts/`、`domain/` 与 `presentation/`（`historyResponse.ts`、`agentTraceReplay.ts`、`conversationOrder.ts`、`turnComponents.ts`、`turnPresentation.ts`、`agentMessagePresentation.ts`、`uiInteractionPresentation.ts`、`agentTodoPresentation.ts`、`terminalText.ts`）。
- Allowed: 其他 feature 的纯层依赖，例如 `src/features/workspace/domain/fileReference.ts`（跨 feature 只允许 contracts/domain）；以及 `src/shared/lib/html.ts`、`markdown.ts`、`markdownCopy.ts` 与 `shared/contracts/types.ts`。
- Allowed: 宿主外壳使用 `src/platform/vscode/contextHost.ts`（`openDextFileReference`）与 `DextStorage` 类型，并通过 `vscode.commands.executeCommand` 转发 `dext.history.*` 动作。
- Forbidden: 纯层导入 `vscode`、Node 内置模块、`src/app/`、`src/webview/`、`src/runner/`，或任何 host/browser 层实现（含本 feature 的 `host/historyEditorProvider.ts`）——边界检查会直接报错。
- Forbidden: 在渲染层修改状态。历史与偏好只读 `DextHistorySession`；新增、删除、重命名、收藏、归档都由 `extension.ts` 注册的命令配合 `host/historyStore.ts` 与 `host/conversationPreferences.ts` 完成，面板只做 `refresh` / `refreshTurnTitle`。
- Forbidden: 另写一套 ANSI 解析或另造回合/结果结构（必须复用 `terminalSegments` 与共享 turn 组件），也禁止在历史里生成 Plan 文档内容——`planLink` 只负责打开已存在的计划文件。