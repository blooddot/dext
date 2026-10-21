# 会话开发说明

本文说明 Dext 会话的组成：每个状态由谁拥有、模块之间允许的依赖，以及本轮迁移把代码从哪里移动到了哪里。这里是当前操作指引；历史记录单独标注。

## 基线

- 第二轮从 `a26b4ab`（`fix(conversation): retain token usage in completed and historical turns`）开始，工作区干净。
- 第一批迁移（Project、Resources、Workspace 搜索、Agent 配置、编辑器标签）已提交，并在 `src/` 留下 36 个只做转发的文件。本轮把这些入口和消费者一起更新后删除。

## 已删除入口与目标路径

下表中每个路径都在同一批次里删除并更新消费者。没有 alias、mock、构建插件或汇总文件恢复它们：`scripts/checkModuleBoundaries.mjs` 会对静态导入、仅类型导入、字面量动态加载、mock 说明符、内嵌构建入口字符串以及被恢复的文件直接报错。

| 已删除路径 | 目标 |
| --- | --- |
| `src/agentProfiles.ts` | 契约在 `src/features/agents/contracts.ts`，存储与辅助函数在 `src/features/agents/host/agentProfiles.ts` |
| `src/apiEditorProvider.ts` | `src/features/resources/host/apiEditorProvider.ts` |
| `src/core/archifyAdapter.ts` | `src/features/project/host/diagrams/archifyAdapter.ts` |
| `src/core/projectAiGeneration.ts` | `src/features/project/host/generation/projectAiGeneration.ts` |
| `src/core/projectArchitecture.ts` | `src/features/project/knowledge/projectArchitecture.ts` |
| `src/core/projectContext.ts` | `src/features/project/knowledge/projectContext.ts` |
| `src/core/projectDiagram.ts` | `src/features/project/contracts/projectDiagram.ts` |
| `src/core/projectDiagramAdapter.ts` | `src/features/project/contracts/projectDiagramAdapter.ts` |
| `src/core/projectDiagramHistory.ts` | `src/features/project/knowledge/projectDiagramHistory.ts` |
| `src/core/projectDiagramPresentation.ts` | `src/features/project/presentation/projectDiagramPresentation.ts` |
| `src/core/projectDiagramRegistry.ts` | `src/features/project/host/diagrams/projectDiagramRegistry.ts` |
| `src/core/projectEvidenceSettings.ts` | `src/features/project/contracts/projectEvidenceSettings.ts` |
| `src/core/projectIntent.ts` | `src/features/project/contracts/projectIntent.ts` |
| `src/core/projectKnowledge.ts` | `src/features/project/contracts/projectKnowledge.ts` |
| `src/core/projectMermaid.ts` | `src/features/project/presentation/projectMermaid.ts` |
| `src/core/projectReference.ts` | `src/features/project/knowledge/projectReference.ts` |
| `src/core/projectSettings.ts` | `src/features/project/contracts/projectSettings.ts` |
| `src/core/projectTopics.ts` | `src/features/project/knowledge/projectTopics.ts` |
| `src/core/toml.ts` | `src/features/agents/host/toml.ts` |
| `src/editorTabHtml.ts` | `src/platform/editor-tabs/editorTabHtml.ts` |
| `src/editorTabManager.ts` | `src/platform/editor-tabs/editorTabManager.ts` |
| `src/editorTabSerializer.ts` | `src/platform/editor-tabs/editorTabSerializer.ts` |
| `src/editorTabState.ts` | `src/platform/editor-tabs/editorTabState.ts` |
| `src/editorTabTypes.ts` | `src/platform/editor-tabs/editorTabTypes.ts` |
| `src/projectDiagramViewer.ts` | 校验在 `src/features/project/host/diagrams/projectDiagramViewer.ts`，桥接在 `src/features/project/browser/archifyBridge.ts` |
| `src/projectService.ts` | `src/features/project/host/projectService.ts` 及 `src/features/project/contracts/lifecycle.ts` 中的生命周期契约 |
| `src/projectStore.ts` | `src/features/project/host/persistence/projectStore.ts` |
| `src/resourceDocuments.ts` | 契约 `src/features/resources/contracts/resourceDocuments.ts`，宿主 `.../resources/host/resourceEditorProvider.ts`，展示 `.../resources/presentation/resourceDocuments.ts` |
| `src/resourceSession.ts` | `src/features/resources/contracts/resourceSession.ts` |
| `src/vscodeProjectHost.ts` | `src/features/project/host/projectPanelDataSource.ts`、`src/features/project/host/persistence/vscodeProjectFileHost.ts` 与 `src/features/project/contracts/` |
| `src/webview/apiPanel.ts` | `src/features/resources/presentation/apiPanel.ts` |
| `src/webview/archifyBridge.ts` | `src/features/project/browser/archifyBridge.ts` |
| `src/webview/fileSearchClient.ts` | `src/features/workspace/browser/fileSearchClient.ts` |
| `src/webview/globalResourcesPanel.ts` | `src/features/resources/presentation/globalResourcesPanel.ts` |
| `src/webview/outputLink.ts` | `src/features/workspace/browser/outputLink.ts` |
| `src/webview/projectPanel.ts` | `src/features/project/presentation/projectPanel.ts` |

消费者按符号而非文件名拆分：Agent 类型与常量来自契约，只有 `AgentProfileStore`、`codexConfiguredDefaults`、`modelOptionsFromCodexCache` 来自宿主；Resources 分为契约、宿主与展示三部分；Project 图按契约、知识、宿主注册表与浏览器桥接分别引用；编辑器标签统一使用 `src/platform/editor-tabs/*`。Workspace 搜索使用浏览器客户端与宿主控制器两条路径，`scripts/monaco-ref-lab/main.ts` 保留无扩展名的类型引用。

## 状态所有权

| 状态 | 所有者 | 存储 / 生命周期 |
| --- | --- | --- |
| 已保存回合、计划上下文、provider session | `features/conversations/host/historyStore.ts` | `dext.history` 工作区 memento，串行写入 |
| 置顶、收藏、标题、布局、每会话选择、排序 | `features/conversations/host/conversationPreferences.ts` | `dext.pinnedConversations` 等键，键名不变 |
| 会话集合、当前标签、打开标签、标签顺序 | `features/conversations/host/conversationController.ts` | 内存；布局写入 750ms 防抖 |
| 布局写入定时器 | 同上 | 随控制器释放 |
| 活动执行、取消控制器、Code 续跑调用 | `features/conversations/host/turnExecutionCoordinator.ts` | 内存，每会话一条 |
| 缓冲的 Agent 事件与刷新定时器 | `features/conversations/host/agentEventStream.ts` | 内存，`dispose()` 清理 |
| 待审核补丁 | `features/conversations/host/patchReviewController.ts` | 内存，按回合 |
| 待回答的问题与表单 | `features/conversations/host/interactionController.ts` | 内存，按会话/回合/请求 |
| 计划文件、任务进度与验证 | `features/conversations/host/planController.ts` + `domain/plan*` | 内存加 `dext.history` 进度 |
| 浏览器标签身份、切换编号、渲染代次、已渲染签名 | `features/conversations/browser/conversationController.ts` | 内存；切换时重置 |
| 已缓存会话 DOM 及淘汰顺序 | `features/conversations/browser/conversationController.ts`（`ConversationViewStore`） | 内存，最近 6 个会话 |
| 每会话草稿与图片附件 | `features/conversations/browser/composerController.ts` | 内存，每标签一份 |
| 跟随输出状态、用户手势与延迟滚动帧 | `features/conversations/browser/outputScrollController.ts` | 切换/释放时取消帧 |
| 会话标签条 DOM | `features/conversations/browser/conversationTabs.ts` | 依据宿主摘要重建 |
| 回合行（创建、选择、删除、缓存行复用） | `features/conversations/browser/transcriptView.ts` | 由已渲染视图持有；每个可见会话一份映射 |
| 实时 Process 时间线、工具分组、延迟 Markdown 渲染队列 | `features/conversations/browser/agentTraceView.ts` | 内存；历史回放时隔离 |
| Plan 工具栏与回合内的 Plan/打开操作 | `features/conversations/browser/planControls.ts` | 依据宿主状态重建 |
| 差异布局偏好、补丁审核按钮与结果提示 | `features/conversations/browser/patchReviewView.ts` | DOM 与 `diffMode`；写入仍由宿主调用 |
| Webview 生命周期、HTML 外壳、消息分发、资源/MCP/附件 | `sidebarProvider.ts` | VS Code 对象 |

窄接口位于 `contracts/`：`TurnExecutionHost`、`TurnInteractionPort`、`ConversationSessionPort`、`TurnNotifier`、`TurnPatchPort`、`ConversationHistoryStore`、`ConversationPreferences`；计划文件读取与进度保存通过 `PlanFileHost` / `PlanSessionPort`，补丁写入能力由 `app/conversationSetup.ts` 注入 `applyPatch`。会话模块不导入 `DextApplication`、`DextSidebarProvider`、`webview/main.ts`，也不接收整个侧栏状态。`ConversationSummary` 与会话消息 schema 位于 `contracts/protocol.ts`，`src/webviewProtocol.ts` 只做组合。

### 本轮保留的真实共享依赖

边界检查以 `migrationExceptions` 逐条登记，均带原因与移除条件：`domain/planTodoProgress.ts` → `src/core/agentTodoTracking.ts`；`presentation/historyRender.ts` → `src/core/fileReference.ts`、`src/markdownCopy.ts`；`host/historyStore.ts` → `src/core/fileReference.ts`；`host/historyEditorProvider.ts` → `src/vscodeContextHost.ts`；`host/uiInteractionBroker.ts` → `src/core/uiForm.ts`、`src/core/executionErrors.ts`；`contracts/protocol.ts` → `src/core/uiForm.ts`；会话控制器与执行协调器 → `src/core/harnessPresetDefault.ts`；`browser/transcriptView.ts` → `src/core/fileReference.ts`、`src/webview/fileReferenceChip.ts`、`src/webview/sourceHighlight.ts`（@ 引用展示与编辑器同源）。

## 验证（本轮）

结果分别记录；未执行的项目不计为通过。

| 检查 | 结果 |
| --- | --- |
| `node scripts/checkModuleBoundaries.mjs` | 通过：36 个已移除路径受到保护，新会话边界与已登记例外通过 |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过 |
| `npx vitest run` | 通过：162 个文件 / 1568 个测试，13 个原有跳过 |
| `npm run build` | 通过：`dist/webview/main.js`、`main.css` 等既有产物名不变 |
| `npm run check`（边界、lint、类型、测试、构建、声明与 API 参考检查、打包资源） | 通过 |
| `npm run check:ui` | 通过：输入框、流式跳转、会话滚动、问题可见性、编辑器标签、Project 阅读器与图表 |
| `node scripts/monaco-ref-lab/check.mjs` | 通过 |
| `npm run check:ui:conversations` | 通过：标签、会话滚动（含延迟滚动与停止跟随）、流式跳转、问题可见性、结构化输出，以及完整交互套件（过期图片回退、秘密字段、重复提交） |
| `npm run test:host` | 通过：激活、编辑器标签、类型生成与 Monaco Webview 验证（含剪贴板）完成 |

本轮**未**执行真实 Provider 冒烟（需要已配置的 Provider、临时工作区与人工交互）；不声称浏览器或 Provider 结果。

## 本轮不包含的内容

- 会话浏览器拆分已完成：标签身份/缓存、草稿、标签条、滚动、回合行、实时 Process trace、Plan 工具栏与补丁审核均位于 `features/conversations/browser/`；`src/webview/main.ts` 只负责连接协议与范围外界面（资源、MCP、模型菜单、编辑器）。`test/conversationBrowserState.test.ts` 与浏览器 UI 检查覆盖已提取状态与 DOM。
- Agent 执行器、CLI 传输、工作流内核、MCP、补全与资源编辑除清理所需的导入修改外未改动。
- 下一轮以本文与 `docs/project-development.zh-CN.md` 的历史记录为起点；那里的表格不是当前导入指引。
