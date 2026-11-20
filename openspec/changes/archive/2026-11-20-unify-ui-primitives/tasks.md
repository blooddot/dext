# Tasks

## 1. Trace 与双介质部件

- [x] 1.1 在 `presentation/` 构建八个 Trace 部件及 Text、Markdown、Code、CodeBlock、Separator、Badge、Spinner，沿用 `element` 契约和已有 CSS。补比对解析后的 HTML/DOM 结构、void 元素、布尔属性、文本转义和 Markdown 安全性的测试。verify: npm run test -- test/turnComponents.test.ts
- [x] 1.2 用同一套 Trace 导出写 Plan 与 agent trace 两个组合 fixture。比较标签、class、属性、层级及 A 群两个交互状态，仅记录禁用语义的必要差值。verify: npm run test -- test/turnComponents.test.ts

## 2. 回合和实时 trace

- [x] 2.1 将回合分隔、JSON、引用及消息详情接入共享部件，保持复制原文、折叠、受信 Markdown 和现有布局。verify: npm run test -- test/turnComponents.test.ts test/turnPresentation.test.ts test/sidebarLayout.test.ts
- [x] 2.2 迁移 `AgentTraceView` 的事件、工具组和命令行，保留事件 id、流式增量、命令分组和焦点行为。单独跑结构结果脚本和完整检查。verify: node scripts/checkStructuredOutputUi.mjs
- [x] 2.3 校验实时回合迁移后的仓库构建、类型和测试。verify: npm run check

## 3. Todo 和 Acceptance

- [x] 3.1 共享开发行、验收行和两组外壳构建，实时使用 DOM，保留 HTML 薄入口。保留分组、状态标签、Markdown、`verify:` 文案、原生 checkbox 和标签对应。verify: npm run test -- test/agentTodos.test.ts
- [x] 3.2 保留 `acceptanceSection`、`acceptanceList` 与现有回调消费者，锁定委托切换、消息关联、已确认勾选和恢复焦点。对只读结构断言原生 disabled。verify: npm run test -- test/agentTodos.test.ts test/planTurnHydration.test.ts test/conversationProtocol.test.ts

## 4. 历史静态渲染

- [x] 4.1 将历史 Todo、命令组、过程消息、结果披露和回合内容迁移到 A 群，覆盖旧历史、静态验收、复制文本、控制台输出和交互答案摘要，保持现有排序和 Markdown 导出。verify: npm run test -- test/historyRender.test.ts test/historyStore.test.ts test/agentTodos.test.ts test/uiInteractionPresentation.test.ts

## 5. 计数和模型映射

- [x] 5.1 将 `planExecutionLabel`、`agentTodoProgress`、`agentAcceptanceProgressLabel` 接到共享标题和描述槽。保留原文案、独立分母、Enum、持久化和既有完成条件。verify: npm run test -- test/agentTodos.test.ts test/planExecution.test.ts test/planTurnHydration.test.ts

## 6. Dialog 与表单控件

- [x] 6.1 在现有浏览器脚本补模态背景 inert、Tab 焦点范围、动作按钮保持同一对象和 Escape 层次的特征断言，并先对现行实现运行。verify: node scripts/checkInteractionUi.mjs
- [x] 6.2 迁移 Dialog、Form、Field、Label、Input、Textarea、Select、Radio、Checkbox、Button、Alert 的标记和局部绑定。保留选择焦点、草稿、校验、刷新、文件拖放、secret、防重复提交和输出时序，记录迁移前后的证据。verify: node scripts/checkInteractionUi.mjs
- [x] 6.3 单独运行表单阶段的完整检查。verify: npm run check

## 7. Tabs

- [x] 7.1 扩充会话标签和资源分段的特征检查，先锁定角色、选中状态、焦点、关闭/固定/运行态、拖拽重排及 Escape 取消。verify: node scripts/checkConversationTabsUi.mjs && node scripts/checkResourceUi.mjs
- [x] 7.2 共享选中态写入及 Button、Spinner、标签构建，保留窗口静态 tablist、拖拽和会话草稿职责。记录四处迁移及行为等价证据。verify: node scripts/checkConversationTabsUi.mjs && node scripts/checkResourceUi.mjs

## 8. Menu

- [x] 8.1 在现有 Composer 浏览器脚本补并先运行菜单特征检查，覆盖 pack、skill、命令说明、分类与空态、选中/禁止、键盘和父子菜单焦点。几何 fixture 验证右、左、上回退及 .app-shell 实际裁切边界。verify: node scripts/checkComposerLayoutUi.mjs && node scripts/checkResourceUi.mjs
- [x] 8.2 抽取共享项、分类、Empty 和键盘绑定，保留 Composer 的业务分支、溢出、CLI/模型切换与回调。记录前后构建点数量和未迁分支。verify: node scripts/checkComposerLayoutUi.mjs && node scripts/checkResourceUi.mjs
- [x] 8.3 证明 CSS 锚点在支持的 Webview 几何等价后移除定位方法，限制 CSS 例外并逐条记录源断言替换。若行为失去等价，保留旧定位并记录失败条件。单独验证菜单与回归测试。verify: node scripts/checkComposerLayoutUi.mjs && npm run test -- test/sidebarLayout.test.ts
- [x] 8.4 单独运行菜单阶段的完整检查。verify: npm run check

## 9. 脚本显示 API 和最终检查

- [x] 9.1 注册 `ui.render` 和内部 `view` kind，增加 `nodes: UiNode[]`、`ui.Node` 递归 schema、上限、路径诊断及 Tier 2 保留名称目录。测试公开部件名、顶层顺序、合法嵌套、空值、超限、深层非法子节点、所有禁止字段与交互节点拒绝。verify: npm run test -- test/runtime.test.ts test/builtinTypeDefinitions.test.ts
- [x] 9.2 在运行器的现有 `ui` 对象导出 `render`，复用 step 与 replay，记录完成后返回 void 并默认可见。验证显示调用无需用户应答、两次调用夹带日志的顺序、Continue 重放去重、同一输出反复重绘及历史惰性，包括 URL 和文件路径。verify: npm run test -- test/dextHost.test.ts test/dextKernelBundle.test.ts test/historyRender.test.ts test/turnComponents.test.ts
- [x] 9.3 复用现有 `ui` 分组并扩展具名递归支持，运行构建后验证 `dist/dext.d.ts` 中 `ui.render` 的 `Promise<void>` 和 `UiNode` 递归类型、`dist/api-reference.json` 及工作区脚本类型检查。verify: npm run build && npm run test -- test/dextTypes.test.ts test/apiReference.test.ts && npx tsc -p .dext/tsconfig.json --noEmit
- [x] 9.4 运行全量检查与浏览器回归，提交部件清单、两处实际组合代码、迁移前后计数、Tier 2 schema、断言改动和第 6/7/8 阶段的等价证据。verify: npm run check && npm run check:ui:conversations

## Verification

实现阶段逐条执行任务中的命令，汇总结构、计数、类型、重放和浏览器回归的实际结果。无法证明等价的阶段保留现有路径，并记录触发输入和失败断言。

## Acceptance

真实 VS Code Webview 的操作与预期结果见 [用户验收清单](design.md#acceptance)。
