# Dext 界面覆盖索引

迁移从 `acba6bd` 的注册和渲染路径开始。按命令、Webview 类型或子界面查找当前实现、组件或宿主调用及回归夹具。`test/uiFoundationCoverage.test.ts` 从注册源码核对入口，并检查表中的导入和原生调用。

基础部件的属性、状态、渲染介质及宿主约定见[通用 UI 组件目录](./ui-foundation-components.zh-CN.md)。

## 注册入口

| 入口 | Webview 类型 | 注册调用 | 实现 | 组件或宿主调用 | 回归夹具 |
| --- | --- | --- | --- | --- | --- |
| `dext.focus` / `dext.newConversation` / 侧栏视图贡献 | `dext.sidebar` | `registerWebviewViewProvider(DextSidebarProvider.viewType)` | `src/extension.ts#registerWebviewViewProvider` `src/app/sidebarProvider.ts#DextSidebarProvider` `src/webview/main.ts` | `src/app/sidebarProvider.ts` → `src/shared/lib/ui/layout/layoutComponents.ts#Stack` | `test/sidebarLayout.test.ts` `scripts/checkConversationTabsUi.mjs` |
| `dext.openHistory` | `dext.history` | `createWebviewPanel(DextHistoryPanel.viewType)` | `src/extension.ts#dext.openHistory` `src/features/conversations/host/historyEditorProvider.ts#showInActiveEditor` `src/features/conversations/presentation/historyRender.ts` | `src/features/conversations/host/historyEditorProvider.ts` → `src/shared/lib/ui/layout/layoutComponents.ts#Stack` | `test/historyEditorProvider.test.ts` `test/historyRender.test.ts` |
| `dext.viewResources`，列表与详情复用编辑器标签 | `dext.globalResources` | `createWebviewPanel(descriptor.viewType)` | `src/extension.ts#dext.viewResources` `src/platform/editor-tabs/editorTabManager.ts#createWebviewPanel` `src/features/resources/host/resourceBrowserProvider.ts#ResourceBrowserProvider` | `src/features/resources/presentation/globalResourcesPanel.ts` → `src/features/resources/presentation/resourceDocuments.ts#renderResourceList` | `test/editorTabManager.test.ts` `test/resourceEditorProvider.test.ts` `scripts/checkEditorTabsUi.mjs` |
| 编辑器重载后恢复 Resources 标签 | `dext.globalResources` | `registerWebviewPanelSerializer(EDITOR_TAB_VIEW_TYPES.globalResources)` | `src/extension.ts#registerWebviewPanelSerializer` `src/platform/editor-tabs/editorTabSerializer.ts` `src/features/resources/host/resourceBrowserProvider.ts` | `src/extension.ts` → `src/platform/editor-tabs/editorTabSerializer.ts#EditorTabRestorer` | `test/editorTabSerializer.test.ts` `test/resourceEditorProvider.test.ts` |
| Composer 草稿预览消息 | `dext.resourcePreview` | `createWebviewPanel("dext.resourcePreview")` | `src/app/sidebarProvider.ts#previewResource` `src/app/sidebarProvider.ts#previewHtml` `src/features/resources/presentation/resourceDocuments.ts#renderResourcePreview` | `src/app/sidebarProvider.ts` → `src/platform/editor-tabs/editorTabHtml.ts#renderEditorTabHtml` | `test/uiFoundationCoverage.test.ts` `test/resourceDocuments.test.ts` `scripts/checkResourceUi.mjs` |
| 从附件或文件引用打开标注，按附件复用面板 | `dext.imageAnnotator` | `createWebviewPanel("dext.imageAnnotator")` | `src/app/sidebarProvider.ts` `src/features/conversations/host/imageAnnotatorPanel.ts#ImageAnnotatorPanel` | `src/app/sidebarProvider.ts` → `src/features/conversations/host/imageAnnotatorPanel.ts#ImageAnnotatorPanel` | `test/imageAnnotatorPanel.test.ts` `test/openImageReference.test.ts` |
| Agent 视频取帧，由运行时通过桥接打开 | `dext.videoFrames` | `createWebviewPanel("dext.videoFrames")` | `src/app/application.ts#FramesBridge` `src/features/agents/host/framesBridge.ts#FramesBridge` `src/features/conversations/host/videoFrames.ts#createWebviewPanel` | `src/app/application.ts` → `src/features/agents/host/framesBridge.ts#FramesBridge` | `test/framesBridge.test.ts` `test/framesMcp.test.ts` |

## 子界面与专用宿主

| 界面 | 入口或分支 | 实现 | 组件或宿主调用 | 回归夹具 |
| --- | --- | --- | --- | --- |
| 侧栏外壳、标签、会话切换 | `dext.sidebar` | `src/app/sidebarProvider.ts#DextSidebarProvider` `src/features/conversations/browser/conversationTabs.ts#renderConversationTabs` `src/webview/main.ts` | `src/features/conversations/browser/conversationTabs.ts` → `src/shared/lib/ui/navigation/navigationComponents.ts#Tab` | `test/sidebarLayout.test.ts` `test/conversationTabOrder.test.ts` `scripts/checkConversationTabsUi.mjs` |
| Composer 编辑、附件、折叠与排队 | `dext.sidebar` | `src/webview/codeEditor.ts#DextCodeEditor` `src/webview/imageAttachments.ts` `src/features/conversations/browser/queuedTurn.ts` `src/platform/browser/fileDrop.ts` | `src/webview/main.ts` → `src/webview/codeEditor.ts#DextCodeEditor` | `scripts/checkComposerLayoutUi.mjs` `scripts/checkComposerImeUi.mjs` `scripts/checkMonacoInputUi.mjs` `test/codeEditorFileDrop.test.ts` `test/queuedTurn.test.ts` |
| Composer 模式、Skills、Permission、Agent、Model 与溢出菜单 | `dext.sidebar` | `src/webview/main.ts#positionModelSubmenu` `src/features/conversations/browser/composerMenu.ts` `src/features/conversations/browser/composerOverflow.ts` | `src/features/conversations/browser/composerMenu.ts` → `src/shared/lib/ui/navigation/navigationComponents.ts#MenuItem` | `scripts/checkComposerLayoutUi.mjs` `scripts/checkResourceUi.mjs` |
| Plan、制作资源工具栏与来源分段 | `dext.sidebar` | `src/features/conversations/browser/planControls.ts#renderPlanToolbar` `src/webview/main.ts#renderResourceToolbar` `src/webview/main.ts#renderResourceSource` | `src/app/sidebarProvider.ts` → `src/shared/lib/ui/layout/layoutComponents.ts#Toolbar` | `test/planCodeApiSave.test.ts` `test/resourceConversation.test.ts` `scripts/checkResourceUi.mjs` |
| Plan Todo、验收及 Process | `dext.sidebar` / `dext.history` | `src/features/conversations/browser/agentTodoView.ts` `src/features/conversations/browser/agentTraceView.ts#AgentTraceView` `src/features/conversations/presentation/agentTodoPresentation.ts` | `src/features/conversations/presentation/agentTodoPresentation.ts` → `src/shared/lib/ui/feedback/feedbackComponents.ts#Badge` | `test/agentTodos.test.ts` `test/planTurnHydration.test.ts` `scripts/checkStructuredOutputUi.mjs` |
| 回合、流式结果、JSON、复制、文件变更和恢复 | `dext.sidebar` / `dext.history` | `src/features/conversations/browser/transcriptView.ts#TranscriptView` `src/features/conversations/presentation/turnComponents.ts#renderTurnResult` | `src/features/conversations/presentation/turnComponents.ts` → `src/shared/lib/ui/content/contentComponents.ts#CodeBlock` | `test/turnComponents.test.ts` `test/historyRender.test.ts` `scripts/checkConversationScrollUi.mjs` `scripts/checkStreamJumpUi.mjs` `scripts/checkPatchApplicationUi.mjs` |
| Agent 应答、工作流表单和旧权限请求 | `dext.sidebar` / `dext.history` 摘要 | `src/features/conversations/browser/agentInputView.ts#AgentInputView` `src/features/conversations/browser/interactionForm.ts` `src/features/conversations/browser/interactionDialog.ts` `src/app/sidebarProvider.ts#uiResponse` | `src/features/conversations/browser/interactionDialog.ts` → `src/shared/lib/ui/overlay/dialog.ts#Dialog` | `test/uiForm.test.ts` `test/uiInteractionBroker.test.ts` `test/conversationProtocol.test.ts` `scripts/checkInteractionUi.mjs` `scripts/checkQuestionVisibilityUi.mjs` |
| MCP Assistant 生成、准备与保存 | `dext.addMcp` → `dext.sidebar` | `src/webview/mcpAssistantView.ts#McpAssistantView` `src/app/sidebarProvider.ts#generateMcp` `src/app/sidebarProvider.ts#prepareMcp` `src/app/sidebarProvider.ts#createMcp` | `src/webview/mcpAssistantView.ts` → `src/shared/lib/ui/input/nativeControls.ts#Checkbox` | `test/uiFoundationCoverage.test.ts` `test/sidebarLayout.test.ts` `scripts/checkComposerLayoutUi.mjs` |
| History 搜索、懒载和回合动作 | `dext.openHistory` → `dext.history` | `src/features/conversations/host/historyEditorProvider.ts#DextHistoryPanel` `src/features/conversations/presentation/historyRender.ts` `src/extension.ts#dext.history.continueConversation` | `src/features/conversations/presentation/historyRender.ts` → `src/shared/lib/ui/content/disclosure.ts#Disclosure` | `test/historyEditorProvider.test.ts` `test/historyRender.test.ts` |
| Resources 列表，Project / Global / Dext 与 Skill pack | `dext.viewResources` → `dext.globalResources` | `src/features/resources/host/resourceBrowserProvider.ts#showList` `src/features/resources/presentation/globalResourcesPanel.ts` `src/platform/editor-tabs/editorTabHtml.ts` | `src/features/resources/presentation/resourceDocuments.ts` → `src/shared/lib/ui/navigation/navigationComponents.ts#Navigation` | `test/globalResourcesPanel.test.ts` `test/resourceEditorProvider.test.ts` `test/editorTabSerializer.test.ts` `scripts/checkEditorTabsUi.mjs` |
| 资源详情与失效资源的恢复分支 | `dext.globalResources` 详情 | `src/features/resources/host/resourceBrowserProvider.ts#showDetail` `src/features/resources/presentation/resourceDocuments.ts#renderResourceDefinition` `src/features/resources/presentation/resourceDocuments.ts#renderResourceError` | `src/features/resources/presentation/resourceDocuments.ts` → `src/shared/lib/ui/layout/layoutComponents.ts#Section` | `test/resourceDocuments.test.ts` `test/resourceEditorProvider.test.ts` `scripts/checkEditorTabsUi.mjs` |
| Dext API、类型及 Node／JavaScript Reference | `dext.globalResources` Dext 列表与详情 | `src/features/resources/presentation/apiPanel.ts` `src/features/resources/presentation/resourceDocuments.ts#renderReferenceMember` `src/features/workflow/host/apiReference.ts` | `src/features/resources/presentation/resourceDocuments.ts` → `src/shared/lib/ui/content/contentComponents.ts#CodeBlock` | `test/apiPanel.test.ts` `test/apiReference.test.ts` `scripts/checkEditorTabsUi.mjs` |
| 草稿预览只读文档及其源码段 | `dext.resourcePreview` | `src/app/sidebarProvider.ts#previewHtml` `src/features/resources/presentation/resourceDocuments.ts#renderResourcePreview` | `src/app/sidebarProvider.ts` → `src/features/resources/presentation/resourceDocuments.ts#renderResourcePreview` | `test/uiFoundationCoverage.test.ts` `test/resourceDocuments.test.ts` `scripts/checkResourceUi.mjs` |
| 图像标注、图像和画布 | `dext.imageAnnotator` 图像分支 | `src/features/conversations/host/imageAnnotatorPanel.ts#imageAnnotator.js` `src/features/conversations/browser/imageAnnotatorPage.ts` `src/features/conversations/browser/imageAnnotator.ts` | `src/features/conversations/browser/imageAnnotatorPage.ts` → `src/features/conversations/browser/imageAnnotator.ts#ImageAnnotator` | `test/imageAnnotation.test.ts` `test/imageAnnotatorPanel.test.ts` `scripts/checkImageAnnotatorUi.mjs` |
| 视频标注、播放器、时间轴与帧导出 | `dext.imageAnnotator` 视频分支 | `src/features/conversations/host/imageAnnotatorPanel.ts#videoAnnotator.js` `src/features/conversations/browser/videoAnnotatorPage.ts` `src/features/conversations/browser/videoAnnotator.ts` `src/features/conversations/host/videoPlayback.ts` | `src/features/conversations/browser/videoAnnotatorPage.ts` → `src/features/conversations/browser/videoAnnotator.ts#VideoAnnotator` | `test/imageAnnotatorPanel.test.ts` `test/videoAnnotation.test.ts` `test/videoPlayback.test.ts` `scripts/checkImageAnnotatorUi.mjs` |
| 视频取帧、顺序与独立面板生命周期 | `dext.videoFrames` | `src/features/conversations/host/videoFrames.ts#VideoFrames` `src/features/conversations/browser/videoFramesPage.ts` `src/features/agents/host/framesBridge.ts` | `src/app/application.ts` → `src/features/conversations/host/videoFrames.ts#VideoFrames` | `test/framesBridge.test.ts` `test/framesMcp.test.ts` `test/videoPlayback.test.ts` |
| Markdown/Mermaid 与 API 执行流程 | `dext.sidebar` / `dext.history` / `dext.globalResources` / `dext.resourcePreview` | `src/platform/browser/markdownDiagrams.ts` `src/webview/diagrams.ts` `src/features/resources/browser/apiFlow.ts` | `src/webview/diagrams.ts` → `src/platform/browser/markdownDiagrams.ts#renderMarkdownDiagrams` | `scripts/checkStructuredOutputUi.mjs` `scripts/checkEditorTabsUi.mjs` `scripts/assertWebviewAssets.mjs` |
| 原生菜单、通知、QuickPick 和 InputBox | Workbench 视图、编辑器、资源与 Webview 上下文菜单 | `package.json#view/title` `package.json#editor/title` `package.json#webview/context` `src/extension.ts#showInputBox` `src/extension.ts#showInformationMessage` `src/app/sidebarProvider.ts#showQuickPick` | `src/app/sidebarProvider.ts#showQuickPick` `src/extension.ts#showInputBox` `src/extension.ts#showWarningMessage` `package.json#webview/context` | `test/packageManifest.test.ts` `test/historyEditorProvider.test.ts` `test/webviewProtocol.test.ts` |
| Diff、编辑器选择、文件与剪贴板 | `dext.history.openTurnDiff` / `dext.openResourceSource` / `dext.addSelectionToChat` / `dext.copySelectionWithContext` | `src/extension.ts#dext.history.openTurnDiff` `src/extension.ts#dext.copySelectionWithContext` `src/platform/vscode/selectionActions.ts#DextSelectionActions` `src/platform/vscode/contextHost.ts#showTextDocument` `src/platform/vscode/clipboardFiles.ts` | `src/extension.ts#vscode.changes` `src/platform/vscode/contextHost.ts#showTextDocument` `src/platform/vscode/selectionActions.ts#DextSelectionActions` `src/app/sidebarProvider.ts#vscode.env.clipboard.writeText` | `test/vscodeSelectionActions.test.ts` `test/vscodePatchHost.test.ts` `test/vscodeClipboardFiles.test.ts` `test/historyEditorProvider.test.ts` |
| Dext Input 输出通道 | 侧栏的输入诊断 | `src/app/sidebarProvider.ts#createOutputChannel` `src/app/sidebarProvider.ts#Dext Input` | `src/app/sidebarProvider.ts#createOutputChannel` `src/app/sidebarProvider.ts#composerLog.appendLine` | `test/sidebarComposerTypes.test.ts` `test/sidebarInputNotifications.test.ts` |

## 会话迁移前的行为

- Composer 模式菜单按 Agent、Ask、Plan、Code 排列。宿主确认选择后，Plan 显示 Send，Code 显示 Run。模型子菜单在侧栏可用范围内依次尝试右侧、左侧和上方，并通过 Escape 恢复焦点。参见 `scripts/checkComposerLayoutUi.mjs`。
- IME 合成保留当前草稿和引用，合成期间不发送。编辑器接收文件拖放并在落点插入引用。参见 `scripts/checkComposerImeUi.mjs` 和 `test/codeEditorFileDrop.test.ts`。
- 标签各自保有草稿，滚动跟随和停留由阅读位置决定。流式更新保留已展开的 Process 节点和焦点。参见 `scripts/checkConversationTabsUi.mjs`、`scripts/checkConversationScrollUi.mjs` 和 `scripts/checkStructuredOutputUi.mjs`。
- 只读显示和 `stdout` 保留声明顺序，JSON 复制保留原始 CRLF。失败或停止的回合在实时侧栏和重开时都先显示已产生的输出。参见 `scripts/checkStructuredOutputUi.mjs`。
- 工作流表单沿用 `uiResponse`，一次提交携带原有 `sessionId`、`turnId`、`requestId`、答案和动作。参见 `scripts/checkQuestionVisibilityUi.mjs`。

`6280d78` 移除了原先接入文件建议的 `registerMonacoLanguage` 调用。迁移后，聊天占位文字也移除了 `@ for files`。`scripts/checkMonacoInputUi.mjs` 核对键入 `@` 和主动补全都不弹出文件候选，Enter 仍发送，手写路径仍生成引用。

## 独立面板与 MCP Assistant 迁移前的行为

- History 初始列表按会话展示记录，展开时才请求回合明细。搜索合并列表中可见的文本命中和宿主返回的回复命中。参见 `test/historyEditorProvider.test.ts`。
- Resources 恢复时使用原标签 key。序列化器和主动恢复同时命中时复用一个标签，已失效的资源仍可用原 key 打开错误页。浏览器中分类沿用原生披露，搜索保留输入焦点。参见 `test/editorTabSerializer.test.ts` 和 `scripts/checkEditorTabsUi.mjs`。
- 草稿预览在旁列打开，同一面板可复用。主源码排在辅文件之前，API 流程在源码之前。预览保留打开时的主题、转义源码和受 CSP 约束的本地流程脚本。参见 `test/uiFoundationCoverage.test.ts`。
- 图像标注保留缩放、滚动、图层开关、标注编号和备注焦点，重新打开可读回已保存标注。视频标注按时间保存标记，浏览器夹具模拟解码失败与宿主转换失败，验证错误文案和停用的播放与时间轴。参见 `test/imageAnnotatorPanel.test.ts` 和 `scripts/checkImageAnnotatorUi.mjs`。
- 帧提取面板保留原编辑器焦点。收到捕获结果时保留页面返回的帧顺序，收到明确的解码错误时将错误返回调用方并关闭面板。参见 `test/framesBridge.test.ts`。
- MCP Assistant 的生成进度和草稿携带原请求 ID，停止仅中止匹配的生成，复核结果携带对应请求 ID，保存转发选中的工具和指定作用域。参见 `test/uiFoundationCoverage.test.ts`。

## 已验证的可见变化

- 侧栏 HTML 使用 `Stack`、`Toolbar`、`TabList`、`Tab`、`Menu`、`Alert` 和 `Badge`。会话标签的选择与关闭／取消固定动作由同级按钮承担，保留原有标签容器、拖放和焦点管理。Composer 的 Monaco 编辑器仍由 `DextCodeEditor` 创建和管理。参见 `scripts/checkConversationTabsUi.mjs`、`scripts/checkComposerLayoutUi.mjs`、`scripts/checkMonacoInputUi.mjs` 和 `scripts/checkResourceUi.mjs`。
- 会话回合的原生披露和运行标志接入 `Disclosure`、`Spinner`。已答表单在侧栏和 History 通过 `renderInteractionSummary` 使用同一披露结构。Claude 工具权限请求经现有 `ui.form` 桥呈现，已提交的权限请求可回放为只读摘要。MCP Assistant 和本地确认使用共享 `Dialog` 与 `Form`，MCP 保留原生 textarea 和 scope 下拉及请求 ID。参见 `scripts/checkStructuredOutputUi.mjs`、`scripts/checkInteractionUi.mjs` 和 `test/uiFoundationCoverage.test.ts`。
- History 与 Resources 的搜索使用共享 `Toolbar`、`Input` 和 `Empty`，会话和资源分组使用 `Disclosure`。资源详情与只读预览通过 `resourceSource` 使用同一 `Section` 和 `CodeBlock` 渲染源码。资源作用域按钮现在向辅助技术报告当前选中项，恢复与筛选仍由原宿主负责。参见 `test/historyEditorProvider.test.ts`、`test/uiFoundationCoverage.test.ts` 和 `scripts/checkEditorTabsUi.mjs`。
- 图像与视频标注使用共享工具栏、按钮、备注、编号、空态和错误提示。图层、计时、画布和顺序由各自的媒体宿主管理，视频帧提取仍使用独立 Webview。浏览器夹具验证图像关页释放与解码失败后的 URL 释放，宿主夹具验证帧顺序、转发错误及面板关闭。参见 `scripts/checkImageAnnotatorUi.mjs` 和 `test/framesBridge.test.ts`。
- Resources 的 `ui.render` 详情增加示例。在窄编辑器标签中，导航容器允许换行，源码示例在自身代码块内滚动。对应 `dext-ui-foundation` 的主题与布局场景及 `script-view-output` 的 API Reference 场景。由 `scripts/checkEditorTabsUi.mjs` 从正常列表入口验证。
- 脚本输出原先只能平铺普通内容及嵌套 Trace，现在可以组合分区、横排换行、反馈色调和显式空态。原有根节点顺序和回放继续可用。Resources 的 `ui.render` 详情同时列出首批 17 个公开节点、子项约束、默认值和组合示例。对应 `script-view-output` 的公开报告与类型场景，见 `test/apiReference.test.ts`、`test/runtime.test.ts` 和 `test/dextHost.test.ts`。

## 全量验证

本次在 Windows、Node.js 22 上执行。

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 模块边界、lint、类型检查及构建通过。186 个测试文件通过，2 个按条件跳过。2,103 项测试通过，6 项按条件跳过。发布声明、API Reference 和 Webview 资产校验通过。 |
| `openspec validate unify-dext-ui-architecture --strict --json` | 变更通过严格校验，无问题。 |

## 浏览器回归

使用 Edge 157 执行构建后的 Webview 夹具。对照上面的迁移基线，验证下列路径。

| 命令 | 验证结果 |
| --- | --- |
| `npm run check:ui` | 通过。Composer 菜单右、左、上三向定位及回焦，回合滚动跟随和问答层级，Resources 详情及搜索，图像标注缩放、编号和备注焦点，视频解码失败与资源释放均符合基线。使用生成的 API Reference，在 320px 高对比度视口用 Enter 打开 `UiInline` 类型，核对默认值及示例代码块滚动。 |
| `npm run check:ui:conversations` | 通过。会话标签重排、草稿和焦点，Process 原生披露，760／480／320px 输出，旧 JSON 与新报告回放、原文复制、流程顺序、侧栏与 History 验收状态、表单取消和补丁结果均通过。 |
| `node scripts/checkResourceUi.mjs` | 通过。320px 浅色、深色和高对比度主题中的制作工具栏、预览、保存、失败重试和标签隔离通过。 |
| `node scripts/checkComposerImeUi.mjs` | 通过。IME 合成及取消、引用延后写入、光标位置、多光标和撤销／重做通过。 |
| `node scripts/checkMonacoInputUi.mjs` | 通过。聊天模式键入 `@` 或主动补全均无文件候选，Enter／Shift+Enter、手写路径、拖放、粘贴和引用样式通过。 |

截图位于 `.tmp-tb/editor-tabs-ui`、`.tmp-tb/interaction-ui`、`.tmp-tb/resource-ui` 和 `.tmp-tb/monaco-ref-lab`。真实 VS Code 中的主题、原生焦点、媒体编解码和完整工作流由 [Acceptance](../openspec/changes/unify-dext-ui-architecture/tasks.md#acceptance) 验收。
