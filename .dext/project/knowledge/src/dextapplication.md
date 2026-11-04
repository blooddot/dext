## Responsibility

- **Names**: DextApplication → `src/app/application.ts`；同一职责的装配入口与会话身份入口是 `createConversationServices`（`src/app/conversationSetup.ts`）、`ConversationController`（`src/features/conversations/host/conversationController.ts`）、`DextConversationPreferences`（`src/features/conversations/host/conversationPreferences.ts`）、`normalizeConversationLayout` / `orderedConversationIds` / `orderHistorySessions`（`src/features/conversations/domain/conversationOrder.ts`）、`ConversationBrowser` / `ConversationViewStore`（`src/features/conversations/browser/conversationController.ts`）、`enableConversationTabDrag`（`src/features/conversations/browser/conversationTabDrag.ts`）。
- 它拥有「扩展在宿主里被装配几次」：`createConversationServices` 按固定顺序构造 `ConversationController`、`AgentEventStream`、`InteractionController`、`PlanController`、`TurnExecutionCoordinator`，并在 `dispose()` 里按「abortAll → 停事件 → 关交互 → 关控制器」的顺序收尾。Webview 重载、标签切换与 `ready` 处理都只能重放状态，不能再建第二份实例、第二条订阅或第二个计时器。
- 它拥有会话标签这一组身份：`ConversationController` 持有内存会话集合、打开的标签、活动标签与每个标签的 `AgentSelection`；`DextConversationPreferences` 只把 pin、favorite、title、layout 与选择写进 Memento（`dext.pinnedConversations`、`dext.conversationLayout`、`dext.conversationSelections` 一类键），整份历史属于 `ConversationHistoryStore`；`conversationOrder` 决定置顶在前、收藏优先与 `favoritesOnly` / `archivedOnly` 过滤。
- 它拥有「谁的命令覆盖谁」这一条前端判定：`ConversationBrowser` 用 switch id 与渲染代数决定一次迟到的宿主消息能不能改写读者刚按下的标签；`ConversationViewStore` 缓存最近 6 份已渲染 DOM。
- 形状如此，是因为装配只能发生一次而身份却会被三方同时改写——读者手势、宿主回执与运行中的回合。于是「建一次」被收进一个函数，「谁当前有效」被收进两个单调计数，标签拖动只交出 `(sessionId, beforeSessionId)`，任何一侧都不必知道另一侧的对象。

## Design

- **依赖是窄函数，不是回调对象。** `ConversationSetupDependencies` 里没有 `DextApplication`、没有侧栏，只有 `post`、`currentSelection`、`executeConversation`、`readPlan`、`isTrustedLocalWorkspace` 这类单点能力，因此 `src/app/conversationSetup.ts` 之外任何 feature 模块都无法反向 import 组合根。
- **先建被引用的端口，后填协调器。** `executionRef` 在 `TurnExecutionCoordinator` 尚未构造时就让 `ConversationController`、`InteractionController` 与 `PlanController` 能读到「是否在跑」与 turn id，且注释明确写清：装配期间没有人会调用它们。
- **身份用 id，不用位置。** `conversationTabIds` 只映射 `id`；`enableConversationTabDrag` 回调同样是 `(sessionId, beforeSessionId)`，所以宿主重排、裁剪或插入标签时动作仍指向同一个会话。
- **拖动只属于 tab 条。** `enableConversationTabDrag` 在 strip 上 `setPointerCapture`，位移不足 5px 不算拖动，`suppressClick` 只吞掉拖动自己那一次 click（`event.detail === 0` 放行键盘触发），被取消的拖动不会连带封掉下一次关闭按钮；拖动只与同 `pinned` 分组的标签比较，越出 strip 边界就停止落点计算，边缘 36px 内用 `requestAnimationFrame` 自动滚动；`pointercancel`、`lostpointercapture`、窗口 `blur` 与 `Escape` 全部走 `finish(false)`。
- **渲染要能被作废。** `beginSelection` 返回递增的 switch id，`beginRender` 返回渲染代数，`isCurrentRender` 同时比对代数、活动 id 与已渲染 id；`acceptsHostActiveId` 让没有 switch id 的宿主消息只在 host 主动发起、或与本地选择一致时才生效，因此后到的 IPC 不能把视图倒回上一张标签。
- **缓存按最近使用淘汰。** `conversationSignature` 用 `updatedAt`、轮次数量、最后一轮 id 与过程长度构成稳定签名；`putConversationView` 先 `delete` 再 `set` 把再次访问的会话重插到尾部，超过 `MAX_CONVERSATION_VIEW_CACHE`（6）淘汰最旧，长对话的普通切换因此不再随会话大小线性变慢。
- **偏好只存用户意图。** `setTitle` 去空白后截到 140 字符，空串表示删键并回落到「用第一条消息重新命名」；`conversationLayout()` 与 `setConversationLayout()` 两侧都过 `normalizeConversationLayout`，`normalizeConversationLayout` 去掉重复与非字符串 id、丢弃空串、只在 `activeConversationId` 是字符串时保留；`conversationSelection()` 读回时过 `normalizeAgentSelection`，旧记录照旧可用。
- **去重读取时也要去重写入时。** 只有长度真的变化才 `state.update`，`pruneConversations(known)` 在启动时清掉仍不存在的置顶、收藏、标题与选择，`forget()` 依次清 pin、favorite、title、selection 并从 `openConversationIds` 中移除，避免留下一个重载即复活的标签。
- **排序是纯函数。** `lastActivity` 取 `max(updatedAt, createdAt)`，因此尚未产生轮次的会话也按创建时间参与排序；`orderHistorySessions` 先按 `archivedOnly` / `favoritesOnly` 过滤，再以「收藏差 → 时间方向」两个键排序；`orderedConversationIds` 只把置顶项前移，其余保持原有相对顺序。

## Boundary

- Allowed: `vscode` 的 `Memento` 与命令/Webview 宿主 API，`src/app/` 内的模块边界；构造并持有 `ConversationController`、`AgentEventStream`、`InteractionController`、`PlanController`、`TurnExecutionCoordinator`；用 `normalizeConversationLayout`、`normalizeAgentSelection` 校验存储值与入站选择；用 `conversationSignature`、`putConversationView` 与 `MAX_CONVERSATION_VIEW_CACHE` 管理浏览器侧 DOM 缓存；用 `post` / `postWhenReady` 把 `executing`、`execution`、`executionFailed` 发给 Webview。
- Allowed: 把能力以窄函数注入会话层（`ConversationSetupDependencies`），使会话层拿不到 `DextApplication`、`DextSidebarProvider` 或整份侧栏状态；`domain/conversationOrder.ts` 保持无环境纯函数，测试可直接断言排序与归一化。
- Forbidden: 在 `src/` 根目录新增第二个文件（只有 `src/extension.ts`）；在 Webview 重载、标签切换或 `ready` 处理里再建一份 `ConversationServices`、第二个 `EditorTabManager`、第二条订阅或第二个计时器。
- Forbidden: 让 feature 模块 import `src/app/application.ts`、`src/app/sidebarProvider.ts` 或 `webview/main.ts`；把整份会话历史写进 Memento——偏好只存 pin、favorite、title、layout 与 selection，正文落盘归 `ConversationHistoryStore`。
- Forbidden: 在本节点执行 Agent、校验 `DextResult`、渲染轮次 DOM 或决定滚动落点（分别归 `DextRuntime`、结果修复层、browser 层与 `OutputScrollController`）；用数组下标或 DOM 位置代替会话 id 表达标签身份；让迟到的宿主消息覆盖读者刚提交的标签选择，或在拖动取消后继续吞掉点击。
- Forbidden: 把凭据、`isSecret` 答案、stderr 原文或 MCP token 写进诊断、历史与 Webview 状态；在路径未校验时打开证据文件，或让 Project 图表历史绕过 registry 的准入直接成为预览。