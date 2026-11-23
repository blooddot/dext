# Tasks

## 1. 锁定现有行为

- [x] 1.1 以当前注册源码和设计迁移表为基线，产出界面覆盖索引及 `test/uiFoundationCoverage.test.ts`。让索引能从命令、Webview 类型和侧栏子界面定位到原实现与回归夹具，覆盖独立面板、serializer、专用宿主及其分支。verify: npm run test -- test/uiFoundationCoverage.test.ts
- [x] 1.2 为侧栏、Composer、会话回合和应答补充现有测试的特征断言。记录模式、菜单定位、IME/拖放、DOM identity、草稿与滚动、步骤顺序、复制、失败/中止及请求信封的基线。verify: npm run build && npm run check:ui:conversations && node scripts/checkComposerLayoutUi.mjs && node scripts/checkComposerImeUi.mjs && node scripts/checkResourceUi.mjs
- [x] 1.3 记录 History 搜索与懒载、Resources 标签恢复、预览文档、媒体标注和帧提取的基线。为缺覆盖的预览模板、视频面板异常和 MCP Assistant 请求增加可执行夹具。verify: npm run test -- test/uiFoundationCoverage.test.ts test/historyEditorProvider.test.ts test/resourceDocuments.test.ts test/editorTabSerializer.test.ts test/imageAnnotatorPanel.test.ts test/videoAnnotation.test.ts test/framesBridge.test.ts && node scripts/checkEditorTabsUi.mjs && node scripts/checkImageAnnotatorUi.mjs

## 2. 定稿目录与契约

- [x] 2.1 交付组件目录、部件树、介质与状态表，以及功能组合和宿主依赖检查。用最小合法和非法组合核对 Form、Dialog、Tabs、Menu、Trace 的标签、状态与关联。verify: node scripts/checkModuleBoundaries.mjs && npm run test -- test/uiFoundationCoverage.test.ts test/turnComponents.test.ts test/uiForm.test.ts
- [x] 2.2 确定 Node 判别值、合法 children、默认值、名字和路径诊断。锁定旧类型、Trace 与表单规则，加入布局深度、字段枚举和递归声明的用例。verify: npm run test -- test/runtime.test.ts test/uiForm.test.ts test/builtinTypeDefinitions.test.ts test/dextTypes.test.ts

## 3. 提取全局基础层

- [x] 3.1 提取内容、Trace、Disclosure、Feedback、结构性布局与表单标记并保留适配器接口。交付对照 fixture 验证两个介质的属性、子项顺序、禁用、转义、状态与原生披露。verify: node scripts/checkModuleBoundaries.mjs && npm run test -- test/turnComponents.test.ts test/uiFoundationCoverage.test.ts
- [x] 3.2 抽取通用 DOM 绑定、共享组件样式和主题默认值。交付各 Webview 加载方式，保留页面 class、DOM 关联和焦点；验证 CSP、本地资源、样式与高对比度。verify: npm run build && npm run test:build-assets && npm run test -- test/appearanceColors.test.ts test/appearancePalette.test.ts && node scripts/checkInteractionUi.mjs

## 4. 验证三条正常组合路径

- [x] 4.1 在正常侧栏回合渲染 Plan Todo、命令与 JSON，使用全局 CodeBlock、Trace 和 Badge。通过 History 正常渲染验证同源、原文复制、状态与验收勾选。verify: npm run test -- test/agentTodos.test.ts test/turnComponents.test.ts test/historyRender.test.ts test/planTurnHydration.test.ts && node scripts/checkStructuredOutputUi.mjs
- [x] 4.2 从 Resources 的正常 Dext 页打开 `ui.render` 详情，交付用共享 Section 与 CodeBlock 显示的首个兼容示例。增加通过真实 provider 和浏览器模板渲染的证据，记录与回合的同一 CodeBlock 定义。verify: npm run test -- test/uiFoundationCoverage.test.ts test/resourceEditorProvider.test.ts test/apiPanel.test.ts && node scripts/checkEditorTabsUi.mjs
- [x] 4.3 通过已注册的 `ui.render` 和 `ui.form` 执行多区块报告初样。交付正反 fixture，核对脚本返回值、相同 CodeBlock 定义、树记录和历史，验证通过后开始按页迁移。verify: npm run build && npm run test -- test/uiFoundationCoverage.test.ts test/dextHost.test.ts test/dextKernelBundle.test.ts test/historyRender.test.ts && node scripts/checkStructuredOutputUi.mjs && node scripts/checkInteractionUi.mjs

## 5. 分批迁移自带界面

- [x] 5.1 迁移侧栏外壳、标签、Composer、Plan/资源制作工具栏及分段。提交组件接入与 Monaco 路径证据，保持溢出、三向菜单定位、重排、输入、滚动和草稿。移除聊天模式的 `@ for files` 提示，更新 `checkMonacoInputUi.mjs` 以验证 `@` 不触发文件候选，并保留键盘、手写引用、附件、拖放与粘贴的回归覆盖。verify: npm run build && node scripts/checkConversationTabsUi.mjs && node scripts/checkComposerLayoutUi.mjs && node scripts/checkMonacoInputUi.mjs && node scripts/checkResourceUi.mjs
- [x] 5.2 迁移回合、Process、Output、内联和 Dialog 交互、旧权限请求和 MCP Assistant。提交 DOM／HTML 对照、状态与请求流的回归 fixture，覆盖滚动锚点、Markdown/Mermaid、文件拖放、复制、取消和回焦。verify: npm run build && npm run check:ui:conversations && npm run test -- test/uiFoundationCoverage.test.ts test/uiInteractionBroker.test.ts test/conversationProtocol.test.ts
- [x] 5.3 迁移 History、Resources 列表与详情、Dext API Reference 和资源预览。提交共享壳与部件证据，验证懒载、搜索、错误、过滤、只读预览、恢复、源码和 API 流程。verify: npm run test -- test/historyEditorProvider.test.ts test/historyRender.test.ts test/resourceDocuments.test.ts test/resourceEditorProvider.test.ts test/editorTabSerializer.test.ts && node scripts/checkEditorTabsUi.mjs && node scripts/checkResourceUi.mjs
- [x] 5.4 迁移图像／视频标注外围控件，记录图层、播放器、画布与视频帧的专用宿主接入。为切换、标注回填、帧次序、错误、关闭和资源释放提交可重跑夹具。verify: npm run test -- test/uiFoundationCoverage.test.ts test/imageAnnotatorPanel.test.ts test/imageAnnotation.test.ts test/videoAnnotation.test.ts test/videoPlayback.test.ts test/framesMcp.test.ts test/framesBridge.test.ts && node scripts/checkImageAnnotatorUi.mjs
- [x] 5.5 补齐 VS Code 原生菜单、通知、选择、Diff、编辑器、剪贴板和输出通道的适配索引与调用测试。按当前注册入口复核迁移表，自动比对每处的直接基础层或专用宿主路径。verify: node scripts/checkModuleBoundaries.mjs && npm run test -- test/uiFoundationCoverage.test.ts test/vscodeSelectionActions.test.ts test/historyEditorProvider.test.ts test/webviewProtocol.test.ts

## 6. 交付公共组件与扩展示例

- [x] 6.1 交付初批 17 个公开节点及递归类型、默认值、合法组合、错误路径和 API Reference。生成声明和参考资产，核对由正常详情查看的组合示例与运行时校验。verify: npm run build && npm run check:workspace-types && npm run test -- test/apiReference.test.ts test/apiPanel.test.ts test/dextTypes.test.ts test/builtinTypeDefinitions.test.ts test/runtime.test.ts
- [x] 6.2 交付可由 Code 或自定义 API 运行的检查报告示例。用真实 runner 和模拟 UI 桥覆盖存在/缺失、提交动作与字段值、关闭、取消、中止、恢复、历史和去重，保留两次 render 之间的日志顺序。verify: npm run test -- test/uiFoundationCoverage.test.ts test/dextHost.test.ts test/dextKernelBundle.test.ts test/historyTurnHydration.test.ts test/uiInteractionBroker.test.ts && node scripts/checkStructuredOutputUi.mjs && node scripts/checkInteractionUi.mjs

## 7. 全量回归

- [x] 7.1 交付全量验证结果、从注册入口到组件的索引及可见行为差值记录。校验模块边界、构建资产、所有既有与新增自动测试和文档一致性。verify: npm run check && openspec validate unify-dext-ui-architecture --strict --json
- [x] 7.2 跑全部关键浏览器路径并对比基线。交付窄栏、主题、焦点、层级、顺序、旧/新历史和媒体回归证据，并用第 5.1 项更新后的脚本复核聊天模式的 `@` 行为及既有文件引用流程。verify: npm run check:ui && npm run check:ui:conversations && node scripts/checkResourceUi.mjs && node scripts/checkComposerImeUi.mjs && node scripts/checkMonacoInputUi.mjs

## Acceptance

由用户在真实 VS Code 中逐项验收。此处为人工操作记录，OpenSpec 通过前七组的复选框计算开发进度。

- 将侧栏调窄，切换浅色、深色和高对比度主题。在 Composer 聊天模式输入 `@`，预期不弹出文件候选，手写和拖入文件引用仍可用。用 IME 输入，打开模型子菜单，使用方向键和 Escape，再切换并返回会话。预期菜单留在可用区域，焦点恢复，草稿和滚动位置保留。
- 运行带 Plan Todo、验收项、命令输出和 JSON 的回合，勾选一项并复制原文，再从 History 打开。预期进度状态和顺序一致，历史勾选只读，复制结果保留原文，已答交互只显示摘要。
- 在 Resources 中搜索并打开工作区资源与 Dext 的 `ui.render` 详情，切换作用域，打开草稿 Preview 并重载 Resources。预期类型和示例可读，详情、过滤和资源处置符合当前规则，预览文件顺序和主题行为一致。
- 仅依赖 API Reference 和 `dext` 声明运行公开报告示例，再在缺少目标文件的样例输入上打开修复确认。选定范围并提交，预期脚本打印和返回相同的路径及范围。再运行并取消，预期得到既有取消结果；打开历史时报告可读且已答表单不重新出现。
- 使用 Tab、Shift+Tab、方向键和 Escape 操作表单与菜单，测试下拉、全屏、模态及上一输入焦点。预期停用项不可触发，逐层关闭与焦点恢复符合原有流程，草稿和文件引用保留。
- 打开图像及视频标注，绘制、撤销、添加备注并回填，重新打开后核对已保存状态。触发视频帧工具，预期取帧次序、播放时间和输出一致，帧提取面板关闭后焦点仍留在原位置。
