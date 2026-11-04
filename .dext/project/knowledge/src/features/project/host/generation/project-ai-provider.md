## Responsibility

**Names**: Project AI → `createProjectAiProvider`（公开类型 `ProjectAiProvider`，实现 `ProjectAiBridge`，见 `src/features/project/host/generation/projectAiProvider.ts`）

- 拥有 Project 模型生成请求到“当前选中的 Agent CLI”的适配层。对外只是一个很小的契约：`ProjectAiProvider`（`id: "selected-agent"` 加 `generate(request, signal)`），由 `createProjectAiProvider` 组装；`src/app/application.ts` 注入 runtime、`listProfiles`、`profiles`、`selection` 与 `language` 回调，因此桥接层拿不到整个应用实例。
- 它把 `ProjectAiRequest`（prompt、`responseSchema`、可选 agent/model/reasoningEffort/speed，以及 `onEvent`）变成一次**只读的 Ask 调用**，并把结果收敛成 `ProjectAiResponse.text`；Profile、Model 的显式覆盖也在这里落到运行时选项上。
- 它不拥有流水线本身：批次归属与证据校验属于 `projectAiGeneration.ts`，阶段保存属于 `projectModelCheckpoint.ts`，质量信号属于 `projectModelQuality.ts`。`projectBootstrap.ts` 只把它当成一个可替换的 provider 使用。

## Design

- **窄接口＋工厂**：`ProjectAiGeneration` 只需要“问一次、拿文本”，所以真实 CLI 与测试假 provider 可以互换；CLI 选择、传输差异与降级都留在宿主侧，不污染生成逻辑。
- **自己补语言指令**：Project 生成绕过对话回合，若不在 `generate` 内追加 `outputLanguageInstruction(...)`，正文语言就随模型自行决定；追加时会明确要求标题与正文跟随交互语言，代码、路径、标识符保持不变。
- **结构化通道优先**：当 profile 属于 Codex 或 Claude 时先走 `executeStructuredJson`，Schema 由提供方在服务端约束，答案无法漂移成散文、信封或围栏代码；Profile 取的是 runtime 解析的同一份集合（`profiles()` 而非另一处读配置），所以路由不会与对话传输选到不同后端。
- **有边界的回退**：结构化通道失败——CLI 拒绝 schema 或起不来——时发一条 status 事件说明原因，再回退到 `executeConversation("ask", ...)`；DeepSeek Harness 的 ACP 本就没有 schema 字段，因此始终走对话通道。取消（`signal.aborted`）永远原样抛出，不算降级。
- **thinking 重放的特殊处理**：部分 Anthropic 兼容网关会对“空 thinking 回放”报 400，这是历史问题而非提示词问题；Project 调用是无状态只读提问，所以识别到该错误后去掉 thinking 重试一次（`ask("off")`）并留下可见说明，而不是让一次本该成功的初始化失败。
- **事件投影**：`onEvent` 只转发 `status`、`message`、`tool` 三类 `AgentStreamEvent` 为 `ProjectAiActivityEvent`，provider 的私有阶段不外泄。依赖都用函数形式读取，选择变化不需要重建 provider。

## Boundary

- Allowed: 通过 `WorkflowRuntime` 执行 `ask` 与结构化 JSON 调用；读取注入的 profile 列表、当前 selection 与交互语言；在降级时发出 Project 活动事件；向上抛出取消与提供方错误。
- Forbidden: 写 `.dext` 模型、检查点、图或任何 Project 文件；修改 composer 输入或对话历史；做证据路径、归属或质量校验；决定批次划分、重试次数与阶段顺序；启用写入工具或 MCP。