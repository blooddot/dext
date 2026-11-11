# 会话开发说明

本文说明 Dext 会话的组成：每个状态由谁拥有、模块之间允许的依赖，以及本轮迁移把代码从哪里移动到了哪里。这里是当前操作指引；历史记录单独标注。

## 基线

- 第三轮从 `3d81b48`（`feat(conversations): collapse Process by default for new turns`）开始。
- 第二轮已将会话状态、执行、计划与补丁审核迁入 `features/conversations/`，并删除第一轮遗留的 36 个转发入口。
- 第三轮解散 `src/core/`，按所有者迁入 `features/{agents,workflow,mcp,workspace}`、`shared/` 与 `platform/`；VS Code 适配器进入 `platform/vscode/`，组合根进入 `src/app/`，剩余会话 DOM 进入 `features/conversations/browser/`。`src/` 根目录现在只有 `extension.ts`。

## 已删除入口与目标路径（仅历史）

下表中每个路径都在同一批次里删除并更新消费者。该表只用于记录迁移，**不是当前导入指引**。没有 alias、mock、构建插件或汇总文件恢复它们：`scripts/checkModuleBoundaries.mjs` 会对静态导入、仅类型导入、字面量动态加载、mock 说明符、内嵌构建入口字符串、注释以及被恢复的文件直接报错。

| 已删除路径 | 目标 |
| --- | --- |
| `src/agentProfiles.ts` | 契约在 `src/features/agents/contracts/agent.ts`，存储与辅助函数在 `src/features/agents/host/agentProfiles.ts` |
| `src/apiEditorProvider.ts` | `src/features/resources/host/apiEditorProvider.ts` |
| `src/core/toml.ts` | `src/features/agents/host/toml.ts` |
| `src/editorTabHtml.ts` | `src/platform/editor-tabs/editorTabHtml.ts` |
| `src/editorTabManager.ts` | `src/platform/editor-tabs/editorTabManager.ts` |
| `src/editorTabSerializer.ts` | `src/platform/editor-tabs/editorTabSerializer.ts` |
| `src/editorTabState.ts` | `src/platform/editor-tabs/editorTabState.ts` |
| `src/editorTabTypes.ts` | `src/platform/editor-tabs/editorTabTypes.ts` |
| `src/resourceDocuments.ts` | 契约 `src/features/resources/contracts/resourceDocuments.ts`，宿主 `.../resources/host/resourceEditorProvider.ts`，展示 `.../resources/presentation/resourceDocuments.ts` |
| `src/resourceSession.ts` | `src/features/resources/contracts/resourceSession.ts` |
| `src/webview/apiPanel.ts` | `src/features/resources/presentation/apiPanel.ts` |
| `src/webview/fileSearchClient.ts` | `src/features/workspace/browser/fileSearchClient.ts` |
| `src/webview/globalResourcesPanel.ts` | `src/features/resources/presentation/globalResourcesPanel.ts` |
| `src/webview/outputLink.ts` | `src/features/workspace/browser/outputLink.ts` |

消费者按符号而非文件名拆分：Agent 类型与常量来自契约，只有 `AgentProfileStore`、`codexConfiguredDefaults`、`modelOptionsFromCodexCache` 来自宿主；Resources 分为契约、宿主与展示三部分；编辑器标签统一使用 `src/platform/editor-tabs/*`。Workspace 搜索使用浏览器客户端与宿主控制器两条路径，`scripts/monaco-ref-lab/main.ts` 保留无扩展名的类型引用。

## 清理批次的验证

改动 import 或已删除入口后都要执行：

```powershell
node scripts/checkModuleBoundaries.mjs
npm run lint
npm run typecheck
npx vitest run test/moduleBoundaries.test.ts test/agentProfiles.test.ts test/agentSelectionDefaults.test.ts test/agentRunner.test.ts test/builtinCli.test.ts test/harnessPresetSelection.test.ts test/harnessPresets.integration.test.ts test/toml.test.ts
npx vitest run test/apiReference.test.ts test/apiSource.test.ts test/editorTabState.test.ts test/resourceDocuments.test.ts
```

边界检查会读取 `src`、`test` 和 `scripts`，因此藏在脚本构建入口或测试 mock 里的引用会像普通 import 一样报错。

## 状态所有权

| 状态 | 所有者 | 存储 / 生命周期 |
| --- | --- | --- |
| 已保存回合、计划上下文、provider session | `features/conversations/host/historyStore.ts` + `historyFileState.ts` | `<storageUri>/conversation-history/`，每会话一个 `<sha256>.json` 加 `overflow/`；旧 `dext.history*` Memento 键一次性导入后删除 |
| 置顶、收藏、标题、布局、每会话选择 | `features/conversations/host/conversationPreferences.ts` | `dext.pinnedConversations` 等键，键名不变 |
| 会话集合、当前标签、打开标签、标签顺序 | `features/conversations/host/conversationController.ts` | 内存；布局写入 750ms 防抖 |
| 布局写入定时器 | 同上 | 随控制器释放 |
| 活动执行、取消控制器、Code 续跑调用 | `features/conversations/host/turnExecutionCoordinator.ts` | 内存，每会话一条 |
| 缓冲的 Agent 事件与刷新定时器 | `features/conversations/host/agentEventStream.ts` | 内存，`dispose()` 清理 |
| 待回答的问题与表单 | `features/conversations/host/interactionController.ts` | 内存，按会话/回合/请求 |
| 计划文件、任务进度与验证 | `features/conversations/host/planController.ts` + `domain/plan*` | 内存加 `conversation-history/<sha256>.json` 内的 `planProgress` |
| 浏览器标签身份、切换编号、渲染代次、已渲染签名 | `features/conversations/browser/conversationController.ts` | 内存；切换时重置 |
| 已缓存会话 DOM 及淘汰顺序 | `features/conversations/browser/conversationController.ts`（`ConversationViewStore`） | 内存，最近 6 个会话 |
| 每会话草稿与图片附件 | `features/conversations/browser/composerController.ts` | 内存，每标签一份 |
| 跟随输出状态、用户手势与延迟滚动帧 | `features/conversations/browser/outputScrollController.ts` | 切换/释放时取消帧 |
| 会话标签条 DOM | `features/conversations/browser/conversationTabs.ts` | 依据宿主摘要重建 |
| 回合行（创建、选择、删除、缓存行复用） | `features/conversations/browser/transcriptView.ts` | 由已渲染视图持有；每个可见会话一份映射 |
| 实时 Process 时间线、工具分组、延迟 Markdown 渲染队列 | `features/conversations/browser/agentTraceView.ts` | 内存；历史回放时隔离 |
| Plan 工具栏与回合内的 Plan/打开操作 | `features/conversations/browser/planControls.ts` | 依据宿主状态重建 |
| Webview 生命周期、HTML 外壳、消息分发、资源/MCP/附件 | `app/sidebarProvider.ts` | VS Code 对象 |

窄接口位于 `contracts/`：`TurnExecutionHost`、`TurnInteractionPort`、`ConversationSessionPort`、`TurnNotifier`、`ConversationHistoryStore`、`ConversationPreferences`；计划文件读取与进度保存通过 `PlanFileHost` / `PlanSessionPort`，补丁由 `features/workflow/host/runtime.ts` 在返回 Agent 结果前调用 apply 宿主自动处理；历史只展示结果，旧补丁明确忽略。会话模块不导入 `DextApplication`、`DextSidebarProvider`、`webview/main.ts`，也不接收整个侧栏状态。`ConversationSummary` 与会话消息 schema 位于 `contracts/protocol.ts`，`src/platform/webviewProtocol.ts` 只做组合。

### 回收迁移前的存储

历史位于 `<storageUri>/conversation-history/`：每个会话一个 `<sha256>.json`，`overflow/` 保存被截断原文，`legacy-backup/` 保存旧 Memento 键的原始副本。`openFileHistoryStore()` 首次激活时导入旧 `dext.history*` 键并删除它们；`legacy-backup/` 在导入完成 7 天后自动删除，因此需要保留回滚余地时请在升级前复制该目录。

工作区存储目录里的 `state.vscdb` 与 `state.vscdb.backup` 属于该工作区的所有扩展，VS Code 运行期间 Dext 无法 VACUUM。请先复制这两个文件、关闭 VS Code，然后执行：

```
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec('VACUUM')" <storage>/state.vscdb
```

之后可以删除 `state.vscdb.backup`，它是 VS Code 自己保留的上一份数据库副本。

### Provider 会话身份

每次执行都会把当前会话自己的 Agent 控件（Profile、模型、推理、速度、服务档位、权限）快照进 `ExecutionMetadata`。应用级选择会跟随当前激活的标签，因此后台 Plan 轮次或快速切换标签时，不能用另一个会话的 Provider 执行。

Provider 会话 id 按 Provider 分别保存，且只会由上报它的 Provider 写入。执行快照是唯一的配对依据：Profile 与 Provider 会话都来自同一个会话选择，因此 Harness 的 `dsh1:...` 不可能到达 Codex 并触发 `thread/resume` 的 `-32600 invalid session id`。实现不做跨 Provider 的静默回退，真正的 Provider 错误仍会如实上报。

## 验证（第三轮）

结果分别记录；未执行的项目不计为通过。

| 检查 | 结果 |
| --- | --- |
| `node scripts/checkModuleBoundaries.mjs` | 通过：根目录白名单、`shared` 纯度、`platform`/feature 环境方向、`declaredTypeEdges`（6 条）、`crossFeatureHostCouplings`（4 条）、`contracts.ts` 禁令、浏览器包输入以及全部已移除路径 |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过 |
| `npx vitest run` | 通过：163 个文件 / 1589 个测试，另有 2 个原有跳过文件（4 个跳过测试） |
| `npm run build` | 通过：`dist/webview/main.js`、`main.css` 等既有产物名不变 |
| `npm run check`（边界、lint、类型、测试、构建、声明与 API 参考检查、打包资源） | 通过 |
| `npm run check:ui` | 通过：输入框、流式跳转、会话滚动、问题可见性、编辑器标签 |
| `npm run check:ui:conversations` | 通过：标签、延迟滚动、流式跳转、问题可见性、结构化输出与完整交互套件 |
| `node scripts/monaco-ref-lab/check.mjs` | 通过 |
| `npm run test:host` | 通过：激活、编辑器标签、类型生成与 Monaco Webview 验证 |

本轮**未**执行真实 Provider 冒烟（需要已配置的 Provider、临时工作区与人工交互）；不声称浏览器或 Provider 结果。

## 本轮不包含的内容

- `sidebarProvider.ts` 与 `webview/main.ts` 仍是较大的入口。本轮只整理路径、契约、环境边界与剩余会话 DOM；资源/MCP/附件与历史补载的行为拆分留到下一轮。
- Agent 执行器、CLI 传输、工作流内核、MCP、补全与资源编辑只更新了路径，行为未改。
- `core/types.ts` 搬到 `shared/contracts/types.ts`，本轮未拆分内容；下一轮按所有者拆分并收缩共享契约。
- 下一轮请从本文的迁移记录开始；不要把历史表格当作当前导入指引。

### 本轮保留的真实共享依赖

`migrationExceptions` 已为空：上一轮保留的依赖都已有了新所有者。

| 从 | 到 | 允许原因 |
| --- | --- | --- |
| `features/conversations/domain/planTodoProgress.ts` | `features/agents/domain/agentTodoTracking.ts` | 共享 todo reducer；feature domain → feature domain 允许 |
| `features/conversations/presentation/historyRender.ts` | `features/workspace/domain/fileReference.ts`、`shared/lib/markdownCopy.ts` | 跨 feature domain 与共享内核 |
| `features/conversations/host/historyStore.ts` | `features/workspace/domain/fileReference.ts` | 跨 feature domain |
| `features/conversations/host/historyEditorProvider.ts` | `platform/vscode/contextHost.ts` | host → VS Code 适配器允许 |
| `features/conversations/host/uiInteractionBroker.ts` | `shared/contracts/uiForm.ts`、`shared/protocol/executionErrors.ts` | 共享内核 |
| `features/conversations/browser/transcriptView.ts` | `features/workspace/domain/fileReference.ts`、`platform/browser/fileReferenceChip.ts` | browser → 共享 workspace domain 与 chip 基础组件 |

剩余的跨 feature host 耦合登记在 `crossFeatureHostCouplings`：`workflow/host/runtime` → `agents/host/*`。下一轮通过 `app` 注入端口后删除登记。
