# Proposal

## Why

Dext 的 Plan 模式只有一个进度通道：`## Tasks` 既通过 `dext-todo` 协议驱动 Todo 面板，又被 `PlanExecution.finishRound` 用来判定 `completed` / `incomplete` / `blocked`。因此凡是需要用户在真实环境里亲手确认的事项，只能被塞进 `## Tasks`，再由 Agent 声称完成——结果要么是面板宣称完成而实际无人验收，要么是 Agent 用一段文字把人工检查勾掉，要么是计划因为一项人工步骤没人勾选而永久卡在 Blocked。

`## Verification` 解决不了这个问题：它记录的是 Agent 自己可以执行的命令与预期输出，而不是用户在自己的环境、界面或业务系统里执行的操作。

## What Changes

- 计划文档在 `## Verification` 之后新增顶层章节 `## Acceptance`，内容是未勾选的 Markdown checklist，每条写明具体操作与预期结果。`## Tasks` 只保留 Agent 负责的编码、测试和可执行检查，任务的 `verify:` 永远不是用户确认。
- 新增独立的验收解析与状态模型：验收项从自己的章节解析，绝不进入开发任务列表；身份由归一化文本派生而不是位置，因此重排或插入条目不会继承别人的勾选，改写的条目会重置为未勾选。
- 验收状态随会话的 `planProgress` 持久化（`session.planProgress.acceptance`），沿用现有 `updatePlanProgress` 写入路径，不新增存储、文件格式或依赖；重载 Webview、切换会话、重启扩展后仍然保留。
- Todo 面板在开发任务组下方增加验收组，两组独立计数；验收行提供可访问的复选框，只有用户点击（新增 `togglePlanAcceptance` 请求）才能改变状态，Agent 的任何 `dext-todo` 上报都无法触及验收。
- 完成判定不变：开发任务全部完成且 Agent 的最终验证通过即结束自动执行，验收从不阻断、也从不触发续跑；回合标签在尚有未勾选验收时显示“已完成 · 待用户验收”，全部勾选后显示“已完成 · 验收完成”。
- 执行指令新增规则：验收项归用户所有，不得通过 `dext-todo` 上报，也不得作为开发任务出现；最终回复要分别说明开发与自动检查结果、以及仍需用户执行的验收步骤。
- 兼容性：没有 `## Acceptance` 的计划与历史记录行为完全不变——不批量迁移、不重写历史计划、不改开发任务 ID、续跑与恢复行为不变，历史上已被标记 blocked 的任务也不会被重新标注。

## Capabilities

### New Capabilities

- `plan-acceptance`: Agent 开发任务与用户验收的分离——文档章节契约、验收项的文本派生身份、面板上的两组独立计数、复用 `planProgress` 的验收持久化，以及“完成判定只看开发工作”的执行语义。

### Modified Capabilities

无。`openspec/specs/` 目前为空，这是本项目第一个 spec 能力。

## Impact

- 领域层：`src/features/conversations/domain/planTemplate.ts`、`planTodoProgress.ts`，新增 `planAcceptance.ts`；`planExecution.ts` 行为不变（由测试锁定）。
- 表现层：`src/features/conversations/presentation/agentTodoPresentation.ts`、`historyRender.ts`；`src/features/conversations/browser/agentTodoView.ts`、`transcriptView.ts`。
- 宿主层：`src/features/conversations/host/planController.ts`、`historyStore.ts`、`conversationController.ts`。
- 契约层：`src/features/conversations/contracts/history.ts`、`execution.ts`、`protocol.ts`、`src/shared/contracts/types.ts`。
- 装配与消息分发：`src/app/conversationSetup.ts`、`src/app/sidebarProvider.ts`。
- Webview：`src/webview/main.ts`、`media/styles.css`。
- 文档：`docs/workflows.md`、`docs/workflows.zh-CN.md` 中 `### Plan documents` / `### 计划文档` 一节的章节顺序与任务面板段落。
- 测试：新增 `test/planAcceptance.test.ts`；更新 `test/planTodoProgress.test.ts`、`test/planExecution.test.ts`、`test/agentTodos.test.ts`、`test/historyStore.test.ts`、`test/historyRender.test.ts`、`test/planTurnHydration.test.ts`、`test/planComposerLifecycle.test.ts`、`test/runtime.test.ts`。
- 不新增依赖，不改 `dext-todo` 载荷形状，不改 `PlanExecution.finishRound` 的判定。
- 明确不做：迁移历史计划文件、在 History 页面勾选验收、用户报告验收失败后自动启动修复轮次。
