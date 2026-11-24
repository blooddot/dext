# Design

## Context

`TurnExecutionCoordinator` 在用户回合开始时收集会话的 Agent、Skill 策略、勾选项和命令，并在每次 Plan 跟进时重新取得当前后端会话 ID。`DextRuntime.executeConversation` 在第一次异步读取前调用 `outputLanguageInstruction`，再将语言、`conversationSkillInstruction`、命令、用户内容和适用的 Plan 协议拼进 `AgentConversationRequest.input`。现有快照覆盖单次 Runtime 调用。自动 Plan 跟进是同一用户回合的多次 Runtime 调用，需要在宿主回合边界复用快照。资源草稿、MCP 配置生成和 Skill 导入分析也有直接调用 Runtime Ask 的入口，普通对话需要显式标识。

当前工作树的 Lazy 清单是紧凑 JSON，条目包括 `name`、`path`、`revision`、`description`，名称与 ID 不同才带 `id`。有效清单已承担当轮范围声明，可能继承历史范围的会话在无有效条目时会收到抑制历史 Skill 的说明。主规格中“没有 Skill 清单”的场景由增量明确为没有非空清单，并允许明确的空范围。继承语义使用当前工作树作为基线。

脚本 API 经 `DextRuntime.execute` 分派到适配器的结构化 `run` 路径。`agentPayload` 将显式 Skill、规则、语言及模板约束放在本次调用的 `instruction` 字段中。适配器另外组装 Dext 自带的载荷读取和结果提交通用说明。Codex 和 Claude Code 每次执行结构化 CLI 调用，Pi 和 DeepSeek Harness 在结构化入口清除普通对话的会话绑定后派发。

## Goals / Non-Goals

**Goals:**

- 让普通对话的宿主回合快照、后端指令来源和用户消息分别可在正常入口的测试中验证。
- 以已安装版本和明确的后端会话路径启用原生交付，保留会话身份、已有提示和权限。
- 按脚本 API 调用或后端执行环境隔离固定说明及显式规则和 Skill，保留现有结构化结果边界。

**Non-Goals:**

- 会话历史改写、用户提示文件迁移、新增 Skill 读取权限、改变脚本 API 的输入输出契约或迁移资源生成协议、预先承诺 token 或费用降幅。

## Decisions

### 在普通对话边界形成两部分请求

- 宿主在一个用户回合开始时捕获已经解析的语言偏好，并让同一回合的 Plan 执行与验证跟进共用。用显式状态区分“宿主未提供快照”和“该回合未解析到语言”。直接调用普通 Runtime 入口时保留第一次异步前的回合快照。由宿主将普通对话标识传入 Runtime，避免只凭 `ask` 模式将资源草稿或 Skill 导入分析迁入会话路径。
- 在内部 `AgentConversationRequest` 单独传递普通对话的固定规则及语言快照。拆出 `outputLanguageInstruction` 的固定格式保护、语言优先级约定及解析后的语言值，复用格式渲染。保留脚本、显式结构化调用及资源入口当前的语言渲染和输出约束。
- `input` 继续携带当轮 JSON 范围、显式正文、命令展开、用户内容、适用的 Plan 指令与输出协议。保持当前拼接顺序和既有 JSON 字符转义。系统或开发者层只接收 Dext 的固定规则及枚举化的语言值。清单的名称、描述、路径和 revision 属于数据。对当前路径和 revision 均匹配且正文完整的相关 Skill 才允许复用。仍需使用后端提供的授权文件工具，按当前清单路径读取，引用文件以该 `SKILL.md` 所在目录为基准。
- 继续按实际执行 Agent 解析选择。部分取消后仅传有效项。全部取消、全不可用，或从 Lazy 切换到 Always 时，凡会话可见历史中可能存在旧 Lazy 范围，显式将本轮 Lazy 范围置空。Always 继续提供本轮选定正文，直属命令 Skill 仍在本轮直接载入一次，其他条目保持 Lazy。保留不可用原因、Ask 只读、工作区信任检查和 Plan 跟进的命令展开行为。

### 适配器在实际派发前确定生效来源

适配器在解析实际 CLI、版本、会话键和新建／恢复／分叉路径后，为固定格式、Lazy 规则和语言默认值分别选择原生、精简内联，或原生规则加单个语言覆盖。语义相同的内联正文与原生正文不得同时启用。进程启动方式、原生会话身份和当前指令版本分别判断。已知原生基线按后端及会话 ID 关联规则版本与语言，沿用现有会话持久化边界，仅记录判断所需的版本和枚举。缺少元数据的旧会话走兼容分支。分叉只在已验证的继承路径采用父会话基线，之后各分支独立更新。

固定规则约定当前回合的 Dext 范围有效。原生块主动委托语言默认值的当轮覆盖，并在本轮明确启用内联基线时让位。这样后端仍回放历史 Dext 块时，历史块也不会成为第二份生效来源。覆盖只包含新的解析语言，或者“撤销 Dext 的语言偏好，由当前用户消息决定”的显式状态。只有可证明旧偏好已被替换或清除后才省略覆盖。若原生层欠缺可靠的更新能力，复用已验证仍生效的固定基线，逐轮提供需要的简短覆盖。用户明确指定语言或翻译的请求优先，格式保护仍生效。能力不明时使用精简内联并声明当轮来源。仅在提交用户消息前且能确认原生设置失败时回退，同一用户任务不因结果不确定而重复提交。

### 按后端选择原生入口

| 后端和当前入口 | 原生接入 | 恢复、分叉及配置更新 | 兼容范围与回退 |
| --- | --- | --- | --- |
| Codex App Server。普通界面有 `requestAgentInput` 时，`CliAgentRunner` 进入 `runCodexConversation`。现有实现每次打开 App Server 连接，随后调用 `turn/start` | 在验证配置优先级后用 `thread/start.developerInstructions`，保留现有模型基线、工具说明和用户 developer 配置；如无法无损合并用户原有的附加指令，沿用内联。 | 已安装 `0.169.1` 的协议类型在 start、resume、fork 都声明该字段。resume 可能冷加载或重新加入已加载线程，fork 复制历史到新线程 ID。上游实际模型请求显示，冷恢复／分叉首轮可能保留父基线并忽略新值，已运行线程也可忽略覆盖。可验证路径重用或重传同一基线，语言改动或清空先用当轮覆盖，直至确认替换。压缩后也检查生效来源。 | 用模型请求验证受支持的版本及具体路径。无基线的旧会话、无法确认继承的分叉、无法保留用户配置或字段不受支持时使用精简内联。无交互回调走 `codex exec` 的普通对话兼容路径，以内联为默认。 |
| Claude Code。`claudeConversationArguments` 和 `claudeControlArguments` 都使用 `-p`。控制入口每次调用启动一个新进程并用 stream-json 发送用户消息 | 两条调用链共用原生 `--append-system-prompt` 组合。维持用户既有文本与文件参数的语义和顺序，保留默认提示及工具说明。无法可靠合并已有的同类参数时使用内联。 | `--resume <id>` 使用同一会话，`--resume <source-id> --fork-session` 才能从指定父会话创建新 ID。当前两处派发参数在只有 `forkFromId` 时设置了 fork 标志但没有交来源 ID，接入时将来源同时传给这两条路径。官方文档说明快照可在恢复后复用首轮系统提示，压缩后重新构建，且不同版本有例外。 | 本机 `2.1.251` 的帮助确认 append、resume 和 fork 参数，早于文档列出的 `--system-prompt-snapshot off` 起点 `2.1.257`。新建使用经过验证的 append。按版本与启动方式验证续聊的快照及覆盖行为，只有可靠的同版本路径才重传或替换原生基线。已知保留旧基线时先用语言覆盖，旧会话及快照行为不明时回退。 |
| Pi。`PiAgentRunner.open` 通过 `piArguments` 启动 RPC，按绑定复用进程，重启后用已验证路径的 `--session` 恢复 | 优先加一个 `--append-system-prompt`，保留用户显式追加参数。已安装 `1.5.2` 的 `DefaultResourceLoader` 有显式追加时跳过自动发现。在无显式追加时，只有能按现有项目受信任优先、用户目录其次的顺序保留自动选中的 `APPEND_SYSTEM.md`，才构建等价启动参数。 | 复用活进程时沿用其启动基线。重启时重传参数，并在现有绑定允许时打开同一 `--session`。应用固定规则或语言变更时将进程配置与历史恢复绑定分开，避免仅因 Dext 指令版本变化丢失旧会话。复用进程时可用短覆盖，重启后按验证结果采用新原生设置。Dext 当前遇到分叉时走新 RPC 会话和已有的历史摘要引导。 | 基于安装版本的多次追加和恢复测试启用。该版本的 `AgentSession` 比较现有提示章节并仅追加变化的 system patch，实际模型上下文仍需观察。不能保留自动发现、当前版本或恢复路径行为不明确时使用内联。 |
| DeepSeek Harness。`DeepSeekHarnessRunner` 已用 `--profile acp` 叠加 preset 与 Dext 临时 policy patch | 安装的 `0.2.1-rc.2` 中 `dsh-system-prompt` 接受 `personaSuffix` 并将其作为提示章节，ACP profile 通过 `system-prompt` 配置身份。沿用现有覆盖层，以追加的方式合并有效 `personaSuffix`，或者使用现有 preset 的会话级合成保持同样语义，保留用户所选 preset、原后缀、工具限制与默认提示。 | Dext 的 `media/harness-presets.mjs` 包装 registry 的 `agents.create` 和 `agents.resume`，对两者重新选择 preset。验证最终合成结果在选择之后仍含固定块，包括无显式 preset 的路径。复用进程时检查实际启动基线。重建 overlay 可重用符合原绑定的 `resumeSession`，恢复被拒或分叉沿用现有新会话加宿主历史引导。 | 已确认安装包有字段、Dext 有叠加入口，尚未证实每种 preset 最终请求中的保留。按版本、preset 组合及路径启用。有效后缀无法无损取得、选 preset 后覆盖 Dext 片段、或恢复结果没有可靠证据时继续精简内联。 |

Codex 协议与行为来源见 [start 类型](https://raw.githubusercontent.com/openai/codex/rust-v0.169.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts)、[resume 类型](https://raw.githubusercontent.com/openai/codex/rust-v0.169.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts)、[fork 类型](https://raw.githubusercontent.com/openai/codex/rust-v0.169.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadForkParams.ts)、[已加载线程覆盖处理](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/thread_processor.rs)和 [上游首轮模型请求复测](https://github.com/openai/codex/issues/61046)。Claude 行为来源见 [CLI 参数及恢复快照](https://code.claude.com/docs/en/cli-reference#system-prompt-flags-in-resumed-conversations)和 [会话恢复与分叉](https://code.claude.com/docs/en/how-claude-code-works#resume-or-fork-sessions)。Pi 证据来自本机 `1.5.2` 的 `dist/cli/args.js`、`dist/core/resource-loader.js` 和 `dist/core/agent-session.js`。DeepSeek 证据来自本机安装包 `app.asar` 下的 `dsh-system-prompt/lib/index.js`、`dsh-acp-app/cordis.patch.yml` 和 `dsh-acp/lib/index.js`。这些资料用于确定设计和兼容门槛，真实后端测试见 [tasks.md](tasks.md)。

### 在脚本 API 派发时拆分固定说明与单次调用内容

- 范围是 `ask`、`plan`、`agent`、`template` 的结构化执行路径。沿用普通对话的来源选择原则，独立判断实际 API 派发路径是否支持原生追加。固定块仅包括 Dext 自带的通用载荷读取和输出格式保护。用原生入口时只应用到该次调用的独立执行环境，并从该次用户消息移除对应固定正文。保留用户附加提示和后端默认工具说明。
- Dext 宿主每次按实际执行 Agent 解析并完整读取显式 `skills` 和 `rules`，沿用现有资源定位、路径校验、工作区信任、权限和读取失败行为。`agentPayload` 保留本次传入的指令与数据，现有调用说明、Skill 正文、规则正文、语言说明及模板约束的顺序保持一致。实际 schema、模板字段约束和任务数据继续随调用处理。调用结束后清除调用范围，普通对话的勾选项和会话 ID 不参与派发。
- 分别核对 Codex `exec --output-schema`、Claude Code `-p --json-schema`、Pi 的 `dext_submit_result` 及 DeepSeek Harness 的结果工具和 JSON 结果通道。普通对话路径的能力验证只适用于该路径。API 路径须验证原生追加能与既有结构化输出、校验和结果恢复行为共存，且适用于当前权限及配置。缺少证据或无法无损合并用户提示时，按调用使用精简内联并保留必要的 schema 与结果协议。一段固定说明仅有一个生效来源。仅在提交任务前确认原生配置失败时回退，避免重复执行写入。

### 用三个测量面判断实际效果

1. **Dext 当轮用户消息**。以同一用户输入和 Skill 选择，对比适配器实际送入用户角色的消息，记录字节数、固定段出现次数和当轮清单。
2. **后端上下文**。用可识别的固定段和当轮标记观察后端保存记录及后续模型请求，并检查叠加、恢复、分叉、压缩前后是覆盖还是新增。启动参数重新传递本身不计为对话历史中的新正文。
3. **模型用量和费用**。沿用后端用量事件与 Dext 的 `inputTokens`、`cachedInputTokens` 归一化，记录缓存写入及统计口径（后端提供时）。按同后端、同模型和可比的任务序列记录真实请求。若只有回合汇总，标注其粒度。费用依实际用量和对应计费规则评估，缺少字段或账单时记录不可用，保留仍参与模型输入的正文用量。

脚本 API 单独计量。先对照使用同一组请求参数的调用，记录发给后端的结构化载荷与完整用户消息各自的字节数，再比较模型实际输入及缓存用量。使用前后不同的规则和 Skill，以及省略选择的调用检查隔离。独立 API 调用的载荷变化与普通续聊的历史累积分别统计。

## Risks / Trade-offs

- 接口接收字段但模型仍收到旧基线 → 以首个模型请求和恢复后续请求判定相应路径，未知路径使用精简内联。兼容逻辑不依赖一次 RPC 成功。
- 移动说明后旧正文或用户附加提示被覆盖 → 通过测试验证来源和拼接优先级，并对原有会话格式、配置、权限和历史做兼容回归。
- 正文在压缩、切换 Agent 或取消勾选后继续生效 → 使用当轮范围和路径、revision 双匹配，检查空范围及正文缺失时的重读。
- 原生提示变更影响提示缓存或占用 → 记录后端提示、后端上下文和真实用量。覆盖分支使用短标记，正常续聊稳定复用固定规则。
- API 原生配置与结构化输出通道或用户附加提示冲突 → 按实际派发组合验证，保留原 schema 和模板渲染。无法同时满足时使用精简内联。

## Migration Plan

1. 先以现有精简内联路径兼容所有会话，加入内部请求拆分、回合快照及既有契约回归。
2. 按表验证并启用适配器路径。既有会话缺少指令版本时继续使用原有会话 ID、权限和上下文引导。新建或恢复会话时按经验证的能力更新指令来源。
3. 某个原生路径需要回退时，恢复该路径的精简内联发送，通过当轮来源标记处理历史里的 Dext 基线，保留后端会话 ID。
4. 脚本 API 先在独立调用中拆分固定说明与载荷，逐条验证该入口的原生追加与当前结构化输出组合。验证通过的路径启用原生追加，其他路径保留精简内联。
