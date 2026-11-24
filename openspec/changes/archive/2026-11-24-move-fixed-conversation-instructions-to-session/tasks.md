# Tasks

## 1. 普通对话请求与回合快照

- [x] 1.1 扩展普通对话宿主与 `AgentConversationRequest` 的内部边界，拆分 Dext 固定规则与 `input`，复用现有语言渲染，并给 Plan 内部跟进传递同一回合语言快照。扩展正常入口测试，覆盖读取过程中修改设置、后续回合使用新设置、清空已解析语言、用户明确语言优先，以及脚本、Code、结构化调用和资源草稿的原有契约。verify: npm run test -- test/outputLanguage.test.ts test/outputLanguageSettings.test.ts test/runtime.test.ts test/turnExecutionCoordinator.test.ts
- [x] 1.2 从 `conversationSkillInstruction` 提取 Lazy 通用范围和读取规则，保留紧凑 JSON、实际 Agent 路径、revision、必要的空范围和不可用事件。扩展测试，覆盖 Ask、Plan、Agent 的无 Skill、Lazy、Always、`/command`，以及部分或全部取消勾选、正文改变、后端切换、恢复或压缩后正文缺失、Plan 跟进和只读边界。verify: npm run test -- test/runtime.test.ts test/turnExecutionCoordinator.test.ts
- [x] 1.3 在会话路由和适配器派发边界选择原生、精简内联或原生加语言覆盖，记录规则版本与已生效的语言状态。用模拟后端验证原生正文与当轮输入无重复、旧会话缺少元数据、内联来源声明、语言切换及撤销，以及提交消息后取消或传输失败不会重复执行。verify: npm run test -- test/agentRouter.test.ts test/agentRunner.test.ts test/runtime.test.ts

## 2. 后端接入

- [x] 2.1 在 Codex 普通界面使用的 App Server 入口接入 `thread/start.developerInstructions`。扩展现有协议 fixture，核对 `turn/start` 的用户消息、配置保留及原生与回退互斥。覆盖带基线与旧线程的冷恢复、分叉首轮忽略覆盖、进程重启、语言清空和 `codex exec` 兼容入口。启用前用所支持的 App Server 版本和隔离的测试请求验证首个模型请求与压缩后的来源。verify: npm run test -- test/codexConversationRunner.test.ts test/agentRunner.test.ts
- [x] 2.2 在 Claude Code 两种 `-p` 启动方式组合 `--append-system-prompt`，兼容现有用户附加参数。正常派发分叉时传递 `--resume <source-id> --fork-session`。用现有测试覆盖新建、续聊、分叉、附加参数无法无损合并、快照保留或重建、语言变化及版本回退，并核对用户消息不重复携带固定正文。verify: npm run test -- test/agentRunner.test.ts test/claudeConversationRunner.test.ts test/claudeConversation.integration.test.ts
- [x] 2.3 在 Pi RPC 启动复用 `--append-system-prompt`，保留显式追加参数和适用的 `APPEND_SYSTEM.md` 自动发现语义。扩展启动及 RPC 测试，覆盖活进程复用、进程重启后恢复同一会话、Dext 指令变动与现有绑定、分叉历史引导、不能保留用户提示时的回退，以及只读与 Full access 工具边界。verify: npm run test -- test/piCommand.test.ts test/piRpcTransport.test.ts test/piAgentRunner.test.ts test/piCapabilities.integration.test.ts
- [x] 2.4 在 DeepSeek Harness 现有 ACP policy／preset 叠加链路验证并按支持范围启用 `personaSuffix` 合并。扩展 fixture，核对显式 preset 和默认路径在 `agents.create`／`agents.resume` 最终选定后保留唯一 Dext 块、用户后缀和工具权限。覆盖 RPC 进程复用与重启、恢复拒绝、分叉、无法合并时的内联回退。verify: npm run test -- test/deepseekHarnessPolicy.test.ts test/deepseekHarnessRunner.test.ts test/harnessPresetSelection.test.ts
- [x] 2.5 拆分 `ask`、`plan`、`agent`、`template` 的固定载荷及格式说明与当次调用的数据。用脚本 API 的正常入口验证连续调用选用不同规则及 Skill、随后省略选择、规则与 Skill 的全文和顺序、读取失败、路径校验、信任与读写权限，以及模板按原字段约束渲染。verify: npm run test -- test/runtime.test.ts test/templateRuntime.test.ts
- [x] 2.6 为结构化派发按实际后端和执行路径选择原生追加或精简内联。扩展适配器 fixture，核对单次执行隔离、用户附加提示、固定说明只有一份生效来源、schema 与结果工具及校验兼容、派发前的回退，以及任务提交后不会因交付方式切换而重发。verify: npm run test -- test/agentRouter.test.ts test/agentRunner.test.ts test/piAgentRunner.test.ts test/deepseekHarnessRunner.test.ts

## 3. 跨入口回归

- [x] 3.1 用现有宿主及运行时测试驱动完整普通会话流程，校对 Ask、Plan、Agent 跨后端切换和切回的原生会话 ID、指令来源与当轮 Skill 范围。检查 Plan 回合输出、命令以及请求用量事件仍走原有记录路径。verify: npm run test -- test/turnExecutionCoordinator.test.ts test/runtime.test.ts test/agentRouter.test.ts test/piCapabilities.integration.test.ts
- [x] 3.2 运行仓库检查和变更严格校验，确认会话适配器、公开类型和其他入口通过集成检查。verify: npm run check && openspec validate move-fixed-conversation-instructions-to-session --strict --json

## Acceptance

这些验收由用户在真实后端和 VS Code 工作区完成，独立于开发任务进度。对每个后端使用同一模型和相同的任务序列比较变更前后，记录后端版本、模型、入口、会话阶段和适用的配置。

- 新建普通会话后连续追问，用 Ask、Plan 和 Agent 验证实际进入用户角色的消息长度和固定正文出现次数，确认原生提示中的固定说明有单一生效来源，用户附加提示、工具能力和 Plan 输出协议仍有效。用一个不支持原生入口的版本或路径验证精简内联。
- 在 Lazy 会话勾选多个 Skill，按相关任务触发首次读取和同路径、同 revision 的复用。依次取消一项和全部选项，确认当前范围立即生效。切换 Agent 时核对实际路径和 revision，并检查 Always 全文和 `/command` 直属正文依旧在对应请求中应用。
- 保持会话连续，语言从简体中文切到英语，再切到解析不出语言的 `auto`。确认运行中回合沿用原快照，下一回合使用新值或撤销旧值，并用显式翻译请求验证用户指定语言优先。
- 恢复一个旧会话，从支持原生规则的会话恢复、分叉，重启后端进程，并在压缩后继续相关任务。检查首个和后续模型请求的固定说明来源、重复副本和实际生效语言。按当轮 Skill 范围检查正文完整时复用、缺失或版本不明时从正确路径重新读取。记录哪些路径使用了原生恢复、启动重传或精简内联。
- 分别记录每轮 Dext 用户消息字节数、后端可见上下文中的固定段数量及模型真实用量 `inputTokens`、`cachedInputTokens`。提供时记录缓存写入和对应计费数据，标明模型请求或回合汇总的统计粒度及缓存状态。无法观察的字段标记为不可用。比较用量或费用时计入后端实际仍送给模型的正文。
- 在真实后端验证脚本 API 的结构化结果和提示来源。用连续调用分别传入不同的 `rules`、`skills`，再执行一次省略选择的调用。核对全文仅在指定调用生效，`template` 在原生追加及精简内联路径下均符合原 schema 和渲染约束。对同一组请求参数分别记录结构化载荷、完整用户消息的字节数，以及模型实际的 `inputTokens`、`cachedInputTokens`，与普通续聊分别统计。
