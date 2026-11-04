## Responsibility

- **Names**: Agent Domain Model → `src/features/agents/contracts/agent.ts`、`contracts/pi.ts` 与 `src/features/agents/domain` 的公开符号（`AgentProfile`/`AgentSelection`、`PiRecord`/`PiState`/`PiBridgeConfig`、`agentTimeout`、`trackCliToolActivity`、`cliCompletion`、`ClaudeTodoTracker`、`AxAdapter`、`PiEvents`、`PiModel`/`encodePiSession`、`HARNESS_RESULT_TOOL`/`harnessPresetOrDefault`、`elicitationFormQuestions`、`resolveOutputLanguage` 与 `presentAgentSelection`）。
- 它拥有 Agent 切片里“与宿主无关”的那一半：`contracts/` 说清一次调用可以被声明成什么（档案、选择、权限、模型选项、preset、注入的 MCP server），`domain/` 说清各 provider 的线路数据可以被读成什么（模型 ID、流事件、用量、工具起止、待办快照、结束信号、错误文案、提问表单、Harness 结果通道、结构化结果校验、输出语言、选择默认值）。
- 它拥有“未完成的快照不许覆盖已完成的计划”这类判定权：拒绝不合法的输入、丢弃不认识的 id、只接受能被无损往返的表单，而不是把脏数据交给上层去猜。
- 它不拥有进程、套接字、文件、`Memento`、DOM，也不拥有回合队列与权限执行：这些分别属于 `host/` 的 runner/transport/bridge 与 `src/app/` 的组合根，因此本层所有模块都可以只喂一段原始 JSON 或一个 `unknown` 就完成验证。

## Design

- **契约与策略并置、环境为零**：`architecture` 层由 `scripts/checkModuleBoundaries.mjs` 机械禁止纯层引用 `vscode`、Node 内置模块与 DOM，所以这里统一只 `import type` 自 `src/shared/contracts`，把“provider 说出这句话是什么意思”留在可单测的纯函数里，把“谁来 spawn、谁来超时”留在 `host/`。
- **线路优先的形状**：`PiRecord` 只有 `type` 加索引签名，`PiState`/`PiModel` 只镜像 `get_state` 的字段，`piObject`/`piText` 是永不抛异常的全函数取值器——CLI 输出是不可信且会随版本漂移的，因此解析在能宽容处宽容（缺字段就是缺字段），只在无法容忍处抛一条固定文案（`parsePiModelId` 要求 `provider/modelId`；`decodePiSession` 解码失败只报“重新开始对话”且不回显存储内容）。
- **不对称是数据，不是散落的 if**：`isClaudeTodoTool` 给出 Claude 的 task 工具集合，`CODEX_TOOL_TYPES` 给出 Codex 的 item 类型集合，`cliCompletion` 只认各家的终止事件（`turn.completed`/`turn.failed` 与 `result` 的错误标志），`Codex exec` 没有计划工具所以待办分支里根本没有 Codex——新增 provider 时读的是同一批原语，而不是复制一份事件解析。
- **超时是三层问题，被拆成三个可组合原语**：`AgentTimeout` 只暴露 `activity`/`toolStarted`/`toolFinished`/`dispose` 四个回调，计时器的所有权留给调用的 runner；策略本身（总时长、空闲、单个静默工具三个上限，进展即 `refresh`，`completedTools` 只留最近 256 个 id 以吞掉迟到的重复 `toolStarted`）因此无需进程即可断言。`trackCliToolActivity` 刻意在展示过滤之前读事件，因为被 UI 折叠的空结果与被合并的多工具消息仍然是真实生命周期。
- **迟到与重复是常态**：流事件一律 `replace: true` 表示“这是当前完整快照”，`PiEvents` 用文本块累加并对结束帧做整块替换，`ClaudeTodoTracker` 按 tool-use id 对账（而非按创建次数计数）、跳过 `parent_tool_use_id` 以免子代理的任务顶替本会话计划，遇到不完整快照宁可返回 `undefined` 也不删除既有任务。
- **结构化结果由契约裁决，而不是由 ax 裁决**：`AxAdapter` 把 `CallableDefinition` 编成 zod 输入/输出 schema 与 ax signature，`inspectOutput`/`validateOutput` 是唯一裁决点；修复用的 `repairSignature()` 故意把输出声明为不透明字段，因为让 ax 走查输出契约会把本就合法的答案判错。
- **Harness 缺的通道自己补，但补两条而不是一条**：ACP 的 `PromptRequest` 没有输出 schema 字段，于是 `harnessResultTool` 提供“工具即契约”的主通道（根类型不是 `object` 的 `ui` 契约不发布工具），`harnessResultEnvelope` 提供提示词兜底；`harnessPresetOrDefault` 与 `DEFAULT_HARNESS_PRESET` 让“空选择”永远读成 Harness 默认 preset，而不是裸 ACP 组合。
- **投影宁可失败也不半读**：`elicitationFormQuestions` 只映射能无损往返的 schema，布尔渲染成 Yes/No 再映射回 `true`/`false`，枚举按用户读到的标签回填 wire 值，无法往返时返回 `undefined`（并由 `decline`/`cancel` 区分“没答”与“拒答”），这样模型拿到的是明确失败而不是一个 schema 从未允许的答案。
- **默认值只呈现、不落盘**：`presentAgentSelection` 只填 `options`/`model`/`modelLabel`/`reasoningEffort`/`speed`，`defaults.*` 从不写回 `AgentSelection`，界面因此不会产生隐式的 CLI 覆盖。

## Boundary

- Allowed: 只依赖 `src/shared/contracts`、`src/shared/protocol` 的类型与同切片 `contracts/`，导出纯函数、常量与每回合显式建/弃的小对象（`PiEvents`、`ClaudeTodoTracker`、`AxAdapter`）。
- Allowed: 对不合法的持久化值或外部输入抛出单条自撰错误、丢弃非法或重复的 id、把无法往返的 schema 判为不可渲染，并在事件层面用整块替换表达快照语义。
- Allowed: 声明权限等级与可写范围、声明 provider 之间的能力差异（缺能力时明确报错而非静默降级），并把计时策略定义成可被 `host/` 驱动的回调集合。
- Forbidden: 引用 `vscode`、`node:*`、DOM 全局、`src/app/`、`src/webview/` 或任何其他特性的 `host/` 实现；把本层变成第二个组合根。
- Forbidden: spawn CLI、建立 socket、读写工作区文件或 `Memento`、渲染表单与消息（只产出事件、schema、问题卡片数据与字符串指令）。
- Forbidden: 执行或拦截权限、决定 provider 路由与回合排队、持有执行预算的计时器生命周期、决定对话持久化键——这些分别属于 runner、`DefaultAgentRunner`、`host/` 与偏好存储。
- Forbidden: 在本层复制第二份默认值链（模型、档位、preset、工具白名单），或把工具活动的判定挪到展示过滤之后。