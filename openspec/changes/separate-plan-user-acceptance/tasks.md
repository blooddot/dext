# Tasks

## 1. 计划文档契约

- [x] 1.1 在 `src/features/conversations/domain/planTemplate.ts` 的 `PLAN_DOCUMENT_SKELETON` 中，于 `## Verification` 与 `## Risks` 之间插入 `## Acceptance`，保持每行一个顶层章节的顺序。verify: `npm test -- test/runtime.test.ts`
- [x] 1.2 在同一文件的“How to fill each section”列表里，为 `## Acceptance` 增加填充指引：未勾选的 Markdown checklist，每行以短横线 `- [ ]` 开头（不编号）、写明具体操作与预期结果、面向用户、不带 `verify:` 子句、不使用“检查是否正常”这类空泛表述。verify: `npm run typecheck`
- [x] 1.3 在同一文件中改写 `## Verification` 的指引，把“无法用自动检查证明时补充人工检查”一句删掉，改为说明自动检查之外的步骤一律写入 `## Acceptance`；同时改写 `## Goal` 指引里与新章节撞词的“testable acceptance criteria”，避免模型把手动验收写进 Goal。verify: `npm run typecheck`
- [x] 1.4 在 `PLAN_TASKS_RULES` 中补一条：`## Tasks` 及任务的 `verify:` 只覆盖 Agent 自己可以完成的编码、测试与可执行检查，用户验收一律写入 `## Acceptance`。verify: `npm test -- test/runtime.test.ts`
- [x] 1.5 在 `test/runtime.test.ts` 的计划模板断言里，把 `## Acceptance` 加入章节列表并断言它出现在 `## Verification` 之后、`## Risks` 之前，同时断言指引文本提到具体操作与预期结果。verify: `npm test -- test/runtime.test.ts`
- [x] 1.6 在 `docs/workflows.md` 的 `### Plan documents` 与 `docs/workflows.zh-CN.md` 的 `### 计划文档` 两节里，把章节顺序句补上 `## Acceptance`（紧跟 `## Verification`），并在讲 `## Tasks` 与任务面板的那一段之后补一段：验收组与开发组分开计数、验收只能由用户勾选、验收不影响完成判定、没有该章节的旧计划不受影响。verify: `npm test -- test/runtime.test.ts`

## 2. 验收解析与状态模型

- [x] 2.1 在 `src/shared/contracts/types.ts` 的 `AgentTodoItem` 旁新增 `PlanAcceptanceItem { id: string; text: string; checked: boolean }`，并在注释里写明它归用户所有、Agent 永远不上报、也不进入开发任务列表。verify: `npm run typecheck`
- [x] 2.2 在 `src/features/conversations/domain/planTodoProgress.ts` 中新增 `planAcceptanceItems(document)`：独立扫描 `## Acceptance` 章节（标题别名 `acceptance`、`user acceptance`、`验收`、`用户验收`），跳过围栏代码块，遇到同级或更高级标题结束，接受 `- [ ]` / `* [x]` / `1. [ ]` 三种条目写法并读取初始勾选状态，返回文档顺序的 `PlanAcceptanceItem[]`。不要改动 `planTodoItems`。verify: `npm test -- test/planTodoProgress.test.ts`
- [x] 2.3 新建 `src/features/conversations/domain/planAcceptance.ts`，提供 `planAcceptanceId(text)`（归一化文本 → 稳定哈希，重复文本按出现顺序加 `-2`、`-3` 后缀）、`mergePlanAcceptance(current, previous)`（按 ID 保留勾选）、`togglePlanAcceptance(items, id, checked)` 与 `planAcceptanceProgress(items)` → `{ total, checked, complete, remaining }`；只从 `shared/contracts` 导入类型，保持领域层纯净。verify: `npm run typecheck`
- [x] 2.4 新建 `test/planAcceptance.test.ts`，覆盖：Tasks 与 Acceptance 各自解析且验收项不带 `plan-*` 形式 ID；文档顺序与 `[x]` 初始状态；三种条目写法；围栏代码块与其他章节的 checklist 不算验收；重复文本得到不同 ID；合并跨重排、插入与改写；改写后勾选被重置；toggle 往返；progress 计数。verify: `npm test -- test/planAcceptance.test.ts`
- [x] 2.5 在 `test/planTodoProgress.test.ts` 增加一个同时含 `## Tasks`、`## Acceptance`，且 Acceptance 章节内含围栏代码块的用例，断言开发任务列表只包含 Tasks 里的条目。verify: `npm test -- test/planTodoProgress.test.ts`

## 3. 持久化与消息通路

- [x] 3.1 在 `src/features/conversations/contracts/history.ts` 中，为 `DextHistorySession` 与 `DextHistorySummary` 的 `planProgress` 增加可选字段 `acceptance?: PlanAcceptanceItem[]`。`historySummaryOf` / `historySessionOf` 已整对象透传 `planProgress`，无需改动。verify: `npm run typecheck`
- [x] 3.2 把可选验收列表贯通到 `ConversationHistoryStore.updatePlanProgress`、`DextHistoryStore.updatePlanProgress`、`ConversationController.savePlanProgress`、`contracts/execution.ts` 的 `savePlanProgress` 端口以及 `app/conversationSetup.ts` 的装配，保持现有调用点源码兼容。写入语义固定为“只有传入 `acceptance` 时才替换，未传入时保留已存值”。verify: `npm run typecheck`
- [x] 3.3 在 `src/features/conversations/host/planController.ts` 中：`startRun` 用 `mergePlanAcceptance(planAcceptanceItems(source), stored)` 播种验收列表并放进 `PlanRunContext`；`saveProgress` 在写入时保留同路径的既有验收，不做整体替换；新增 `toggleAcceptance(planPath, itemId, checked)`，校验依据是 `session.planProgress?.path === planPath` 且 `itemId` 存在于该列表（**不得**使用 `activePlanPath`，它在 `completed` 时被 `settle` 删除），只翻转一条、持久化并回发；在 `PlanSessionPort` 上增加回发验收状态的方法。verify: `npm test -- test/planComposerLifecycle.test.ts`
- [x] 3.4 在 `src/features/conversations/contracts/protocol.ts` 中增加请求 `togglePlanAcceptance { planPath: 最长 512, itemId: 最长 128, checked: boolean }` 与响应 `planAcceptance { sessionId, planPath, items }`；在 `src/app/sidebarProvider.ts` 的 `buildPlan` 分支旁增加该请求的分发。verify: `npm run typecheck`
- [x] 3.5 在 `test/historyStore.test.ts` 用 `MemoryHistoryBackend` 增加持久化用例：经 `updatePlanProgress` 写入带验收的进度，重新构造 `DextHistoryStore` 后勾选状态与计数仍在；只写 todos 的更新不会清除已存验收；另一个会话不受影响。verify: `npm test -- test/historyStore.test.ts`
- [x] 3.6 在 `test/planComposerLifecycle.test.ts` 增加宿主级用例：计划以 `completed` 结束后 `activePlanPath` 已被删除，此时 `toggleAcceptance` 仍能成功并写入 `session.planProgress.acceptance`；路径不匹配或 ID 不存在时抛错且不写任何进度。verify: `npm test -- test/planComposerLifecycle.test.ts`

## 4. Todo 面板

- [x] 4.1 在 `src/features/conversations/presentation/agentTodoPresentation.ts` 中新增 `agentAcceptanceRows(items, options)`：每条一个带 `id` 的原生 `<input type="checkbox">` 与 `<label for>` 配对，带 `data-acceptance-id` 钩子，`interactive` 为假时加 `disabled`；文本复用 `todoMarkdown`，属性值用 `escapeHtml`。verify: `npm test -- test/agentTodos.test.ts`
- [x] 4.2 在同一文件里扩展 `renderAgentTodos(items, acceptance?)`：开发组渲染保持原样，验收组作为紧随其后的独立分组，带自己的 `checked/total` 头部，常驻展示而不折叠；`agentTodoProgress` 仍然只统计开发任务。verify: `npm test -- test/agentTodos.test.ts`
- [x] 4.3 在同一文件里扩展 `planExecutionLabel(events, error, outcome, acceptance?)`：`completed` 且有未勾选验收时输出 `Completed · awaiting acceptance`；全部勾选时输出 `Completed · acceptance complete`；没有验收项时保持 `Completed`；`incomplete` / `blocked` / `cancelled` / `Failed` 措辞不变；`outcome` 缺省时由 todos 推断的分支同样应用验收措辞。verify: `npm test -- test/agentTodos.test.ts`
- [x] 4.4 在 `src/features/conversations/browser/agentTodoView.ts` 中持有验收列表，增加 `setAcceptance(items)`，把验收组渲染进同一个面板，并把验收列表上的 `change` 事件委托给注入的 `onToggleAcceptance(itemId, checked)` 回调；重渲染后按 `data-acceptance-id` 把焦点还给刚切换的复选框。verify: `npm run typecheck`
- [x] 4.5 在 `src/features/conversations/browser/transcriptView.ts` 的 `OutputTurnElements` 上暴露该回合的 `planPath`（已有 `TranscriptTurnOptions.planPath`，只是没有保留到元素上），供 Webview 判断哪一回合显示验收组。verify: `npm run typecheck`
- [x] 4.6 在 `src/webview/main.ts` 中：按会话缓存 `planProgress.acceptance` 与路径，来源是 `outputSession` 与新 `planAcceptance` 消息；`renderStoredTurn` 只对该计划匹配 `planProgress.path` 的最后一个回合调用 `todos.setAcceptance(...)`，其余回合传空数组；构造视图时注入 posting `togglePlanAcceptance` 的回调；收到 `planAcceptance` 后按 `sessionId` + `planPath` 重渲染所有可见的匹配回合，并刷新这些回合的 `planExecutionStatus`。verify: `npm run build`
- [x] 4.7 在 `src/webview/main.ts` 的实时结果路径（`execution` / `executionFailed` 两处 `planExecutionLabel` 调用）把验收列表传进去，避免实时回合显示 `Completed`、存下来后变成“待验收”。verify: `npm run build`
- [x] 4.8 在 `src/features/conversations/presentation/historyRender.ts` 中让 `renderHistorySessionBody` 把该会话的验收状态传给 `renderHistoryRecord`，静态历史渲染出同样的只读复选框，并把验收列表传给 `planExecutionLabel`。verify: `npm test -- test/historyRender.test.ts`
- [x] 4.9 在 `media/styles.css` 中为验收组、条目行与复选框补样式，使它在开发列表下方读起来是独立一块，复用现有 `data-status` 约定与主题色变量。verify: `npm run test:build-assets`

## 5. 完成语义与回复指引

- [x] 5.1 在 `planTodoProgress.ts` 的 `planTodoInstruction` 中补协议规则：验收复选框归用户所有，永远不通过 `dext-todo` 上报，也永远不作为开发任务出现，使用验收 ID 的上报会被整条丢弃；最终回复先说明开发内容与通过的自动检查，再列出仍需用户执行的验收步骤。现有的上报节奏、blocked 与验证规则保持不变。verify: `npm test -- test/planTodoProgress.test.ts`
- [x] 5.2 保持 `PlanExecution.finishRound`、`verifying` 与 `resumePlanTodos` 不变，并在 `test/planExecution.test.ts` 增加用例：存在未勾选验收时，验证轮仍返回 `completed` 且不再请求下一轮；验证未通过或仍有未完成任务时返回 `incomplete` / `blocked`，绝不返回 `completed`。verify: `npm test -- test/planExecution.test.ts`
- [x] 5.3 在 `test/agentTodos.test.ts` 增加一条断言：`PlanTodoProgress.consume` 收到使用验收 ID 的 `dext-todo` 上报时整条丢弃，验收状态不变，同一份上报里的开发任务更新也不生效。verify: `npm test -- test/agentTodos.test.ts`
- [x] 5.4 在 `test/agentTodos.test.ts` 与 `test/planTurnHydration.test.ts` 增加标签回归：有未勾选验收时不出现 `Blocked`；最后一条勾选后标签变为 `Completed · acceptance complete`；没有验收章节的旧计划仍然是 `Completed`。verify: `npm test -- test/agentTodos.test.ts test/planTurnHydration.test.ts`
- [x] 5.5 在 `test/historyRender.test.ts` 增加静态渲染用例：History 页面渲染出验收条目，复选框带 `disabled` 而不是可点击控件。verify: `npm test -- test/historyRender.test.ts`

## 6. 验证与交付

- [x] 6.1 一起运行相关测试套件并修掉失败，不弱化断言。verify: `npm test -- test/planAcceptance.test.ts test/planTodoProgress.test.ts test/planExecution.test.ts test/agentTodos.test.ts test/historyStore.test.ts test/historyRender.test.ts test/planTurnHydration.test.ts test/planComposerLifecycle.test.ts test/runtime.test.ts`
- [x] 6.2 运行仓库完整门禁。verify: `npm run check`
- [x] 6.3 交付时分两段汇报：已由自动检查验证的开发结果与检查项，以及仍需用户在自己环境里执行的验收步骤。不把用户验收写回开发 Todo，也不因验收发现的问题自动启动新的开发流程。
