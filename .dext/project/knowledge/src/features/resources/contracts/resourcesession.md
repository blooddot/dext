## Responsibility

- **Names**: Resource document session → `ResourceSession`（`src/features/resources/contracts/resourceSession.ts`；页面侧契约在 `src/features/resources/contracts/resourceDocuments.ts`）。
- 拥有六种资源（`api`、`mcp`、`rule`、`skill`、`file`、`project`）与两种作用域（`project`、`global`）的唯一词汇表，以及一次资源编辑的会话形状：`ResourceSession` 的 `type`/`scope`/`target`/`draft`/`saved`/`origin`，配套的 `ResourceDocument`、`ResourceFile`、`ResourceTarget`。
- 拥有由 kind 派生的全部规则：`RESOURCE_LABELS`/`RESOURCE_ICONS`/`RESOURCE_DIRECTORIES`、`resourceFileName`、`resourcePathSegments`、`resourceDirectorySegments`，以及生成提示词 `resourcePrompt`、模型输出的支持文件校验与合并 `resourceFiles`/`mergeResourceFiles`。
- 拥有编辑器标签页的页面契约：`ResourceEntry`、`ResourceListDocument`、`ResourceDefinitionDocument`、`ResourcePanelOptions`、`ResourceTreeNode`，以及宿主实现、渲染层消费的窄端口 `ResourceEditorDataSource`、`ResourceEditorProviderOptions`、`FileResourceDataSourceOptions`、`ApiDataSourceOptions`。
- 不拥有：草稿落盘与路径根决策、AI/Agent 调用、标签页生命周期与状态恢复、删除规划。

## Design

- `resourceSession.ts` 刻意不 import 任何模块。资源草稿要跨 Webview ↔ 扩展宿主 ↔ 历史存储传输，因此形状必须待在纯层：`src/webview/main.ts`、`src/app/application.ts`、`src/app/sidebarProvider.ts`、conversations 的 `contracts/execution.ts`/`protocol.ts`/`history.ts` 与 resources 的 host 全部引用同一个 `ResourceSession`，不引入环境依赖，也不会形成环。
- 契约只描述形状，不持有状态：草稿 Map 在 `src/webview/main.ts` 的 `resourceSessions`，持久化走 `DextHistoryStore.updateResourceContext`，落盘与限流在 `app`，三者各自拥有自己的状态，避免同一份可变数据被两处改写。
- kind 是唯一的派生源：标签、图标、目录名与文件名/路径分段共用同一张 kind 表，Webview 渲染、列表构建与宿主路径解析因而不会各写一份规则。`project` 是显式例外——它的身份是 Project 模型节点 id，`resourceFileName` 直接原样返回而不拼路径。
- 路径规则是拒绝式而非拼接式：`resourcePathSegments` 拒绝空段、`.`/`..`、反斜杠与冒号、以及码点 <32 的控制字符，并要求扩展名匹配 kind（`api` 为 `.ts`、`mcp` 为 `.jsonc`/`.json`、`skill` 必须以 `SKILL.md` 结尾）；`resourceFiles` 再把支持文件限制在 `rules/`、`templates/`、`skills/`（只有导入 pack 才开放 `skill-packs/`），并施加文件数、单文件字节、总字节与大小写不敏感去重上限。模型输出必须在此处被拒绝，任何路径才允许触盘。
- 提示词属于契约而不属于组合根：`resourcePrompt` 按 kind/scope 生成指令，逐 kind 说明 `name`/`content` 语义（`api` 要求一个只含单个顶层 API 调用的包装函数与布尔判定；`mcp` 要求保留 tools/auth；`project` 只改正文、先读 evidence、`name` 不变、正文逐字节相同即视为确认）。`app` 只把提示词交给 runtime 并解析回包。
- `mergeResourceFiles` 兼容旧响应与局部修订：省略的支持文件不删除，同名（大小写不敏感）以已有路径大小写覆盖内容。
- 页面契约把列表与详情分开：`apiFlow` 只在详情页解析（`describeApiFlow` 因此是可选端口），列表页不承担源码解析成本。`ResourceEditorProviderOptions` 需要 `manager`/`restorer`，所以 `resourceDocuments.ts` 通过三条已登记的 `declaredTypeEdges`（`editorTabManager`、`editorTabSerializer`、`editorTabState`，全部 `import type`）引用 editor-tabs：契约能命名标签页类型，却不运行标签页代码。

## Boundary

- Allowed: 纯 TypeScript 类型与纯函数；`import type` 指向 `workflow/contracts`（`ApiFlow`、`ApiReference*`）、`shared/contracts`（`RegisteredCallable`）与上述三条 editor-tabs 类型边；被 `app`、resources 的 host/presentation/domain、`src/webview/main.ts` 与 conversations 契约引用。
- Forbidden: 读写工作区或 `.dext/`、调用 AI/Agent、访问 `vscode`、DOM 或 Node 内建；决定保存根路径、创建或删除资源；持有草稿、`saved` 标志或标签页生命周期（`EditorTabManager` 仅以类型出现）；把页面渲染结果、命令处理或删除规划写进契约。