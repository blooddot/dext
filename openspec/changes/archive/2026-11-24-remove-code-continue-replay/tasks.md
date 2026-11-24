# Tasks

## 1. 对话入口和执行接线

- [x] 1.1 删除 `dext.history.continueTurn` 注册、`continueTurn` 请求协议与 Sidebar 方法及处理分支。保留原有 Retry 命令、确认弹窗、会话定位、输入和模式选择、`resourceSource` 及 History 的 Continue in Dext。调整 Sidebar 私有调用签名和全部位置参数调用点，验证 Webview Retry 路由和旧消息拒绝，并覆盖原模式和资源来源的既有行为。verify: `npm run test -- test/webviewProtocol.test.ts test/sidebarLayout.test.ts test/turnActions.test.ts test/resourceConversation.test.ts test/historyForkCommand.test.ts`
- [x] 1.2 移除 `TurnExecutionCoordinator` 的失败轮次回放缓存、容量限制和读写分支，清理 `codeContinuation`、`resume`、`onCallLog` 在对话宿主契约、`conversationSetup.ts`、`DextApplication.executeInput` 和测试夹具中的传递。保留输入引用、执行元数据、取消信号、普通失败记录与失败前输出；删除协调器中专测回放缓存的用例。verify: `npm run test -- test/turnExecutionCoordinator.test.ts`
- [x] 1.3 为生产 Retry 路径增加回归。沿用 `test/historyForkCommand.test.ts` 捕获 `activate` 注册命令的测试方式，复用真实 Sidebar、协调器、History Store 和执行真实脚本的 `DextKernelHost`，在 VS Code 适配层控制确认结果，在 Host API 边界提供可区分的两次响应。原 Code 脚本在首个 API 成功并留下可见输出后失败；先取消确认并断言执行和轮次数都不变，再确认并验证调用重新发生、下游收到新响应、同一会话产生新轮次且原错误和输出可从 History 查看。verify: `npm run test -- test/historyForkCommand.test.ts`
- [x] 1.4 同步 `docs/workflows.md` 和 `docs/workflows.zh-CN.md` 的 Code 失败处理，说明「重新执行」的确认、新轮次、从头运行及写文件、保存计划和外部调用可能再次发生的语义。检查两份文档的内部锚点及相关链接。

## 2. Kernel 请求路径和运行回归

- [x] 2.1 从 `dextHost.ts`、`dextProtocol.ts`、`dextKernel.mjs`、`dextRuntime.mjs` 删除调用记录、`run.replay`、回放全局变量、匹配和旧响应注入。保留请求参数转换、`toBoundaryJson`、响应与步骤记录、失败及取消时可见结果收集、子进程与运行归属校验、队列重置和加载器隔离；核实引用后删除 `DextResumeCache`、`DextReplayEntry` 及仅供回放的匹配错误。verify: `npm run typecheck`
- [x] 2.2 审查并移除 `test/dextResume.test.ts` 及其他用例中只断言 Continue 匹配、复用和缓存的部分。按源码和构建版共享的 `test/dextWorkflowCases.ts` 保留两次 `ui.render` 与 stdout 的相对顺序、`void` 返回、失败前可见结果、大流输出和未等待调用的收尾，以及取消后的迟到响应、已排队请求与下一轮隔离。保留 `test/dextHost.test.ts` 的报告、表单提交或取消和失败历史展示覆盖，删去同一用例中的回放分支。verify: `npm run test -- test/dextHost.test.ts`
- [x] 2.3 更新 `docs/development.md`、`docs/development.zh-CN.md`、相关源码注释和现行验证命令。描述实际请求与响应的归属检查、结果序列化和步骤收集，删除仅适用于回放的说明和 `test/dextResume.test.ts` 参数；验证文档中的源码和构建版测试路径可运行。verify: `npm run build && npm run test -- test/dextHost.test.ts test/dextKernelBundle.test.ts`

## 3. Plan 和 History 兼容性

- [x] 3.1 复用 `test/planCodeApiSave.test.ts` 核对默认保存、可读取的 `planPath` 和 JSON 边界，验证 `save: false` 即使携带显式 `location` 也不写文件且返回正文，以及 `global` 和 `workspace` 单次覆盖仍符合原位置、路径形态及设置回落规则。verify: `npm run test -- test/planCodeApiSave.test.ts test/planSaveWrite.test.ts test/planFilePath.test.ts`
- [x] 3.2 核对 History 打开和会话恢复仍展示已保存输出、失败轮次及已回答交互的静态摘要，保留会话绑定、Plan 路径、任务进度和验收状态。复用历史渲染、会话打开和 Plan 水合测试作为兼容性回归。verify: `npm run test -- test/historyRender.test.ts test/historyTurnHydration.test.ts test/historyForkCommand.test.ts test/turnActions.test.ts test/planTurnHydration.test.ts test/planTodoProgress.test.ts test/planAcceptance.test.ts`

## 4. 集成验证

- [x] 4.1 核对生产入口、协议、运行时及现行中英文文档已清除 Code Continue 专用引用。按具体符号查找残留，并复核 Continue in Dext、Agent 会话恢复和历史展示仍在，归档目录保留原样。verify: `rg -n -i 'continueTurn|codeContinuation|takeContinuation|DextResumeCache|DextReplayEntry|onCallLog|__dextReplay|CHANGED_SINCE_STOPPED|dextResume\.test|continu(e|es|ing) (a |the )?failed|继续失败的 Code 运行' src docs scripts package.json README.md README.zh-CN.md`
- [x] 4.2 完成类型检查、相关对话、History、Plan 和源码 Kernel 测试，再重新构建并执行 `test/dextKernelBundle.test.ts`。确认构建版实际执行了测试。verify: `npm run typecheck && npm run test -- test/webviewProtocol.test.ts test/sidebarLayout.test.ts test/turnActions.test.ts test/resourceConversation.test.ts test/turnExecutionCoordinator.test.ts test/historyForkCommand.test.ts test/historyRender.test.ts test/historyTurnHydration.test.ts test/planCodeApiSave.test.ts test/planSaveWrite.test.ts test/planFilePath.test.ts test/planTurnHydration.test.ts test/planTodoProgress.test.ts test/planAcceptance.test.ts test/dextHost.test.ts && npm run build && npm run test -- test/dextKernelBundle.test.ts`

## Acceptance

- 在 VS Code 的 Code 模式运行一段先产生可观察输出、随后失败的脚本，记下原轮次的输出。
- 在原失败轮次点击「重新执行」，确认弹窗提示写入可能再次发生。接受确认后观察脚本从头运行并生成新轮次。
- 重新打开原失败轮次，确认原输出与错误仍可查看。再通过 History 的 Continue in Dext 打开既有会话，确认会话恢复正常。
