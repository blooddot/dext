# Design

## Context

[提案](proposal.md)描述了撤掉 Code Continue 的原因。当前 checkout 存在三条彼此独立的路径。

| 路径 | 当前调用链 |
| --- | --- |
| Code Continue | `src/extension.ts` 注册 `dext.history.continueTurn`。Webview 请求协议和 Sidebar 消息处理也各有独立的 `continueTurn` 分支。两条入口进入 `SidebarProvider.continueTurn`，从 `TurnExecutionCoordinator` 按会话和轮次取出一次性缓存。当前对话操作栏没有该按钮。 |
| 重新执行 | 对话操作栏经 `src/webview/main.ts` 发送 `retryTurn`，Sidebar 派发 `dext.history.retryTurn`。命令读取目标轮次并显示已有模态确认，确认后调用 `SidebarProvider.retryTurn`，在原会话以旧轮次输入和模式发起新轮次。 |
| Continue in Dext | History 的 `dext.history.continueConversation` 打开已有会话。会话输出、交互应答和 Provider 会话绑定从历史记录恢复。 |

回放缓存的生产者在 Code 执行路径。成功 API 响应经 `DextKernelHost` 序列化后被记入 `DextResumeCache`，`onCallLog` 把记录传回协调器。协调器只为有调用记录且未被取消的失败轮次保留内存条目。继续执行时，条目经 `DextApplication.executeInput` 和 Kernel `run` 消息下发。Kernel 初始化回放全局变量，运行时按顺序对方法和参数做匹配，命中时直接产生成功步骤并返回旧响应。

## Goals / Non-Goals

**Goals:**

- 使用现有轮次记录作为 Retry 的输入来源，让 Runtime 的 Dext API 调用统一经过本轮 Host 请求与响应。
- 保持步骤收集和取消保护独立于内存缓存的生命周期，并保留正常、失败和取消后的现行输出行为。
- 以 [Plan 规格增量](specs/plan-document-persistence/spec.md)和[脚本输出规格增量](specs/script-view-output/spec.md)描述保留的契约。

**Non-Goals:**

- 历史存储结构、Agent Provider 会话绑定、Plan 进度与验收状态格式，以及 Plan 保存、路径和修订规则均沿用现有实现。

## Decisions

1. **让现有 Retry 命令负责确认与重跑。** 删除 Continue 命令注册、Webview schema 分支、Sidebar 消息分支与方法。保留 Retry 查找目标会话和轮次、运行中拦截、打开原会话、从归档恢复，以及采用原模式和原输入的行为。保留旧记录没有 `mode` 时使用当前选中模式、再回退到 `"agent"` 的顺序，保留 `resourceSource` 的既有传递。将旧命令做成别名会继续暴露用户已要求撤掉的入口，且旧调用方可能仍预期复用响应。
2. **一次移除调用回放的端到端接线。** 从协调器移除 `codeContinuations`、容量限制、`takeContinuation` 和 `codeContinuation`。同步清理 `contracts/execution.ts`、`conversationSetup.ts`、Sidebar、应用及测试接线中的 `resume` 和 `onCallLog`，保留信号、Code 引用上下文、API roots 和资源来源参数。核实全仓引用后删除 `src/runner/dextResumeCache.ts` 和 `src/shared/contracts/replay.ts`。Kernel 与宿主随扩展一起构建；保留空的回放参数会给仍可注入旧响应的路径留下入口。
3. **保留 Host 请求校验与步骤边界。** 从 `dextProtocol.ts`、`dextHost.ts` 和 `dextKernel.mjs` 移除专用 `replay` 字段、回放日志和全局变量，从 `dextRuntime.mjs` 移除匹配、错误提示、旧响应注入及专用参数指纹函数。每个调用沿用参数转换、实际请求、响应解析和 `step` 发布。保留 `toBoundaryJson` 及 `ui.render` 的序列化深度、成功与失败步骤记录、`recordedOutput` 对失败或停止时已生成可见结果的收集，以及 History 的 `addFailure` 写入。保留运行实例与 child 的归属检查、取消时置换分发队列、请求 ID 的隔离和每轮 loader generation。
4. **保留从持久化记录恢复的行为。** History 打开与会话恢复继续读取原有记录，渲染此前保存的输出和交互摘要。重新执行发起的 `ui.render` 和交互属于新轮次，原轮次照常显示旧输出与已提交应答。当前回放表只存在于协调器内存；旧记录没有该依赖。规格清理采用替换 Plan 中含回放承诺的条款、修改 Script 中同时覆盖实时交互和历史展示的条款。中英文文档继续明确区分重跑脚本和打开会话。

## Risks / Trade-offs

- 重跑可能再次写文件、保存计划、调用服务或发起交互 → 沿用「重新执行」确认提示，工作流文档列出这些后果；确认取消由命令测试覆盖。
- 调用日志与步骤曾在同一请求路径产生 → 保留实际响应的 JSON 转换和步骤发布，并以源代码及新构建 Kernel 验证显示顺序、失败前可见结果和取消后迟到响应。
- 相似名称容易误删既有会话入口 → 用具体命令与协议标识符核查，保留 History 恢复、会话绑定、计划进度和验收状态的相关回归。

## Migration Plan

同一变更中发布宿主和重新构建的 Kernel。旧会话及已保存的计划按原格式读取，无需迁移文件，也无需处理已归档的 OpenSpec 变更。依赖旧命令的调用方改用现有「重新执行」确认流程；部署回退时成套恢复宿主和 Kernel 构建产物。
