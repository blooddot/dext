# Tasks

## 1. 会话状态与迁移

- [x] 1.1 将加载策略接入会话选择的归一化、创建和持久化。扩展打开、重启与历史恢复测试，覆盖初始空会话、新对话、清空、历史分支、旧记录字段缺失或无保存选择，以及切换后重新打开的策略和勾选状态。verify: npm run test -- test/conversationPreferences.test.ts test/conversationController.test.ts test/agentSelectionDefaults.test.ts test/historyStore.test.ts
- [x] 1.2 在现有 Skills 菜单显示并切换「按需加载」与「每轮应用」，补齐现有选择消息及宿主处理。扩展模式变更、字段省略、包勾选、切换 Agent、会话隔离、运行中拒绝修改和卸载清理断言，更新中英文工作流说明。verify: npm run test -- test/sidebarAgentSelection.test.ts test/skillSelection.test.ts test/conversationPreferences.test.ts && npm run typecheck

## 2. 目录解析与请求组装

- [x] 2.1 复用 SkillCatalog 的目录及版本解析，提供实际名称、短描述及路径。扩展测试覆盖工作区相对路径、配置根、全局绝对路径、本地优先、Agent 专用版本、共享回退、无可用版本、缺失文件、链接越界与版本刷新。verify: npm run test -- test/skillCatalog.test.ts test/skillVariants.test.ts test/skillMetadata.test.ts
- [x] 2.2 在普通 Ask、Plan 和 Agent 请求中组装按需清单和读取指令。以不同正文标记检查只列出勾选项、未选时没有清单、常规按需请求未调用全文加载、每轮应用仍加载正文、不可用项有反馈。覆盖恢复、切换 Agent 与更新后仍提供当前解析结果，保持现有信任检查、权限和 Plan 文档组装。verify: npm run test -- test/runtime.test.ts test/turnExecutionCoordinator.test.ts
- [x] 2.3 将命令所属 Skill ID 与展开指令一起传递并复用显式加载。扩展测试覆盖按需命令每个请求只直接加载所属 Skill、其他项只进入清单、命令拒绝、下一普通回合及 Plan 执行跟进。复验脚本 `ask`、`plan`、`agent`、`template` 和 `skill()` 的正文、规则与输出契约，以及 Code 和资源草稿分流。verify: npm run test -- test/turnExecutionCoordinator.test.ts test/skillCommand.test.ts test/runtime.test.ts test/templateRuntime.test.ts test/planExecution.test.ts

## 3. 读取能力与条件接入

- [x] 3.1 复验各 Runner 的 cwd、只读启动参数、已有读取工具和宿主工具交接测试。补充按需输入的回归断言，确保普通路径继续发送文本且 Ask 权限保持只读。verify: npm run test -- test/codexConversationRunner.test.ts test/claudeConversationRunner.test.ts test/piAgentRunner.test.ts test/piCapabilities.integration.test.ts test/deepseekHarnessRunner.test.ts test/deepseekHarnessPolicy.test.ts test/runtime.test.ts
- [x] 3.2 若有可复现的原生读取缺口，按设计复用宿主 MCP 并记录证据。扩展现有测试覆盖工作区信任、已勾选 ID、实际版本、会话与回合隔离、取消、路径限制、文件缺失或读取失败，以及其他后端仍优先使用原生读取。缺少触发证据时，记录该条件项不适用，并通过回归确认默认请求维持原生路径。verify: npm run test -- test/runtime.test.ts test/turnExecutionCoordinator.test.ts test/skillCatalog.test.ts test/framesMcp.test.ts test/piAgentRunner.test.ts test/deepseekHarnessRunner.test.ts

## 4. 集成检查

- [x] 4.1 复验类型、模块边界、构建和回归测试，确认开发任务统计与用户验收独立。verify: npm run check && openspec validate load-conversation-skills-on-demand --strict --json

## Acceptance

由用户在真实 VS Code 与 Agent 中执行。对于每个受测后端，使用同一模型、版本、权限、工作区、Skill 版本和问题序列，对比「每轮应用」与「按需加载」，每组从独立新会话开始。逐轮记录 Dext 直接注入正文次数、原生或宿主工具成功读取正文次数、读取失败原因、`inputTokens`、`cachedInputTokens` 和任务结果。缺少计数时标记为不可用，并说明提供方的上报口径。此处使用普通条目，独立于开发进度。

- **整包勾选后问无关问题**。用同一包发同一个与包内容无关的请求。预期按需组可以正确回答，工具轨迹没有读取该包正文，初始输入不含正文。记录两组实际输入及缓存计数。
- **显式执行命令**。勾选包含命令的 Skill 及至少一项其他 Skill，以相同参数执行 `/command`。预期按需组的发出请求直接携带命令所属 Skill 的一份正文，参数正确展开，其他选中项只列入清单。对比命令结果、正文加载次数和用量。
- **使用 Skill 后连续追问**。首次请求提出需要该 Skill 的任务，随后保持勾选，连续发至少两条相关追问，并追加一条无关问题。预期首次相关请求读取当前正文。后续可在上下文仍保留当前正文时复用，Dext 的按需请求仍只发清单。按轮核对结果和工具轨迹。
- **Ask 只读读取**。在 Codex、Claude、Pi 和 DeepSeek Harness 的可用配置中，用已勾选的项目 Skill 发只读任务。用 `.dext` 相对路径验证读取，并核对未启用额外写权限。切换到适用的全局 Skill 时，再验证目录解析出的绝对路径。若无法读取，记录后端、模型/预设、cwd、权限、工具名、路径类别和原始原因。若有宿主回退，确认它只在经验证的缺口启用，且只读取此会话已选项。
- **恢复、压缩或版本变化**。恢复已勾选项的旧会话，确认「每轮应用」，显式切换后重新打开确认策略与勾选均保留。按需会话先读取带可识别指令的 Skill，再触发提供方压缩或退出恢复，在可确认正文已失去时追问相关任务。另以可辨别的正文更新或切换 Agent 专用版本复验。预期需要时重新读取当前路径或版本，结果反映实际正文。
