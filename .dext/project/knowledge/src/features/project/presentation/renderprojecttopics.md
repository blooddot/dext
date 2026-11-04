## Responsibility

- **Names**: Project Reader View → `renderProjectTopics`（`src/features/project/presentation/projectTopicsView.ts`）；同一责任的其余入口是 `renderProjectSettings` / `projectSettingsScript`（`projectSettingsView.ts`）、`renderProjectMarkdown`（`projectMarkdown.ts`）、`renderRules` / `renderDecisions`（`projectArchitectureNotes.ts`）、`buildC4Topics` / `systemContextRelationships`（`projectC4.ts`）与 `projectPlaybackSteps`（`projectDiagramPresentation.ts`）。界面把这一块叫 Knowledge / Project 阅读器，代码的公开符号是 `renderProjectTopics`，标题取代码名。
- 它拥有「已保存的 Project 数据怎么变成读者能看的东西」：可搜索的目录树（按索引分配的 `area` 分组、按 `parentId` 折叠、`overview` 分组不重复缩进）、单主题文章（说明、分析状态、评审警告、证据与新鲜度、相关主题、分组子模块）、已存图画廊、项目引言（`readingOrder` 排出的 **Start here**、术语表、架构规则与决策）、`readerDiagramFrame` 的图表面板骨架与 `data-reader-*` 钩子、整份 `ProjectReaderData` 的 `<template data-project-reader-data>` 序列化、以及 Overview 与 Knowledge 共用的 `renderProjectQuality` 问题清单。
- 它也拥有同一批数据的三类纯投影：Markdown → HTML 的受信边界（`renderProjectMarkdown`）、`intent.c4` → C1/C2 两个 `ProjectTopic` 与派生图表（`buildC4Topics` / `systemContextRelationships`）、已存图表 → 合法回放步骤（`projectPlaybackSteps`）；以及设置面板的表单 HTML 与它自包含的绑定脚本。
- 它不拥有页面外壳：`presentation/projectPanel.ts` 的导航、`renderProjectPanel` 组页与 `projectPanelScript` 的总脚本在它之外；也不拥有阅读行为（`browser/projectReader.ts` 的选择、缩放、播放、全屏、导出）、`.dext` 读写、索引、AI 生成与新鲜度检查结果本身的写入。

## Design

- **形状被纯层边界逼出来，不是风格偏好。** `scripts/checkModuleBoundaries.mjs` 把 `presentation/` 归入 `isPureLayer`，并对它执行 DOM 全局检查；唯一的放行是「被序列化、从未在本层调用的函数声明」。于是设置面板把交互写成 `bindProjectSettings.toString()` 由 `projectSettingsScript()` 注入页面，而不是在这里 `querySelector`。
- **一次序列化，浏览器层只读。** `renderProjectTopics` 把 `topics` / `checks` / `diagrams` / `brief` / `gallery` / `terms` / `architecture` 放进 `<template>`，`projectReader.ts` 之后只用 `readerTopicArticle`、`readerGalleryArticle`、`readerIntroduction` 重渲染文章；表现层不能 import `browser/`，所以契约只能单向地从这里流向浏览器。
- **结构与行为分离。** 文章里的「Edit this norm」「Confirm this norm」「Plan a change」「Analyze this module」「Check sources」只是按钮与 `data-*` 锚点，落点由浏览器层与侧边栏决定；打开阅读器不比对文件、不调用 AI，`data-topic-check` 的警告只在 `ProjectTopicCheck` 的指纹匹配且 `state` 为 `changed` / `missing`、或 `analysisState` 为 `stale` 时出现。
- **新鲜度宁可说不知道。** `topicFingerprint(topic)` 与保存的检查对齐才算「已检查」；没有检查时文案明说这是保存的引用，未读通的文件与缺失哈希不冒充「未变化」。
- **目录只信索引。** 分组来自 `topic.area`，没有按路径推导的回退；只包含其它分组的分组（`src` > `features`）被隐藏，因为那只是缩进；搜索文本由 area 标题、标题、说明与入口拼成，`overview` 模块单独标成 Directory grouping。
- **文章是三个兄弟节点。** prose、图表面板与 tail 并列，宽编辑器把图停靠在说明旁边，窄编辑器保持阅读顺序；质量与评审信号放在模块自己的图表之上，而不是拖到页尾。
- **C4 是按需派生、从不持久化。** `buildC4Topics` 从 `intent.c4` 投出 `system_context`（C1）与 `containers`（C2），节点 `semanticIds` 带上 context id，证据逐项拷贝行号与内容哈希；`systemContextRelationships` 只折叠进程边界、不折叠交互，保留方向、合并描述并去重证据。旧 contexts 不会被重新分类，因此历史主题仍然读得懂。
- **播放顺序保守到愿意放弃。** `sequence` 只按 `message.order` 排序；`workflow` 只认 `mainPath`，或「唯一无入边起点 + 每步唯一出边 + 覆盖全部节点」的连通路径；两条都不成立就返回空数组——没有回放好过按数组顺序乱播。
- **Markdown 是不可信文本的唯一入口。** `MarkdownIt({ html: false, linkify: true })`、图片降级为转义文本、`h1` 一律降为 `h2`（工作区自己占有 `h1`），宿主渲染与浏览器导航因此共用同一套协议校验。
- **设置面板按「用户意图」保存。** 表单带整数 `data-version`，输入去抖 500ms 后 `postMessage`，`saving` / `queued` 保证单飞，失败保留 dirty 状态并只在状态行说明；阅读深度的预设值只作 placeholder，空数字字段表示跟随预设；`evidenceConfigured === false` 时先要求保存阅读深度再建索引。
- **质量清单只有一份实现。** Overview 与 Knowledge 共用 `renderProjectQuality`，单条问题只出一个复制按钮（同一段文本两个按钮毫无意义），已决定的分组走折叠分支，因为那是历史而不是待办。

## Boundary

- Allowed: 读取 `ProjectTopic` / `ProjectTopicCheck` / `ProjectDiagram` / `ProjectIntent["c4"]` / `ProjectQualityIssue` / `ArchitectureViewInput` / `ProjectWorkspaceSettings` / `ProjectEvidenceSettings` 等已保存数据；同 feature 纯层依赖（`knowledge/projectTopics` 的 `readingOrder`、`topicFingerprint` 与类型，`contracts/*`，`presentation/projectDiagramPresentation`、`presentation/projectArchitectureNotes`）；`shared/lib/html` 的 `escapeHtml` 与 `markdown-it`；产出 HTML 字符串、`data-*` 钩子与 `<template>` 载荷。
- Allowed: 被 `browser/projectReader.ts`、`presentation/projectPanel.ts`、`knowledge/projectTopics.ts`（`buildC4Topics`）、`host/generation/projectModelQuality.ts`（`systemContextRelationships`）以及 `test/projectTopics.test.ts`、`test/projectPanel.test.ts`、`test/projectIndexQuality.test.ts`、`test/projectIndexEvolution.test.ts` 直接引用。
- Allowed: 在本层调整目录扁平化规则、文章分区、质量清单文案、C4 投影的折叠与证据去重、播放路径的判定条件，以及表单字段与预设的呈现方式。
- Forbidden: 运行时触碰 `window` / `document` / `navigator`（唯一例外是从不被本层调用的序列化绑定函数）；依赖 `vscode`、Node 内置模块、`src/app/*`、`src/webview/*`、`src/runner/*`，或本 feature 与跨 feature 的 `host/`、`browser/` 实现。
- Forbidden: 读写 `.dext`、读取源码、调用 AI、初始化或迁移 Project、生成或保存新的 `ProjectDiagram`、写入 `ProjectTopicCheck`；持有选择、缩放、播放、导出、滚动与布局测量的状态；决定标签页生命周期或 Webview 消息路由（属 `host/projectEditorProvider.ts` 与 `presentation/projectPanel.ts`）。
- Forbidden: 在渲染时重新判定架构违规或把 baseline 违规混进 New violations；把界面叫法当职责名（Reading / Knowledge 只记在 **Names** 记录里）；用路径回退代替索引给出的 `area` 分组；把 C4 主题或派生图表落盘成为第二份模型。