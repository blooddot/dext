# Design

## Context

动机见 [proposal.md](proposal.md)。当前代码路径如下。

| 入口 | 已核对的现状 |
| --- | --- |
| 会话管理 | `ConversationController` 为每个标签保留 `AgentSelection`，恢复时优先使用当前会话缓存和 `DextConversationPreferences` 中的 `dext.conversationSelections`。后者由 `src/extension.ts` 接到 VS Code `workspaceState`。新标签从当前 Agent/模型设置起步，清除所选 Skill。已卸载的 ID 会从活动与已保存会话清理。 |
| 普通对话 | `TurnExecutionCoordinator.execute` 取得会话选中的 ID 和实际 profile。它把 `skills` 传入执行 metadata，随后经 `DextApplication.executeConversation` 进入 `Runtime.executeConversation`。当前 `conversationSkillInstruction` 对每个 ID 调用 `skillLoader`，把正文放在命令、语言和用户输入之前。Runtime 把合成后的字符串交给 `DefaultAgentRunner.runConversation` 及相应 Runner。 |
| 文件与版本 | `DextApplication` 将宿主加载回调接至 `SkillCatalog.load`。目录扫描按 `<workspace>/.dext/skills`、`<workspace>/.dext/third-party`、配置的工作区 Skill 根、`globalStorageUri/skills` 顺序登记，较早同名项优先。项目与全局的 `skill-packs` 清单可登记实际版本文件。对于有变体的 Skill，`list(provider)` 与 `load(..., provider)` 都优先匹配专用版本，然后查找 `shared`。当前扫描在发现和登记时读文件以解析名称、描述，全文注入路径另在每次 `load` 时读取。 |
| 命令与 Plan | 协调器只在 Ask、Plan、Agent 的普通回合解析开头的 `/command`。目录按当前 provider 解析命令，检查所属 ID 已勾选，再替换 `$ARGUMENTS` 或追加参数。协调器记录命令 ID 和所属 Skill，一次性展开模板并把指令用于同一用户回合中的 Plan 跟进请求。Plan 生成和修订仍走计划规则、语言指令、`PLAN_RESPONSE_FORMAT_INSTRUCTION` 与保存流程。 |
| 权限与其他入口 | Ask 固定只读。Pi 和 DeepSeek Harness 的普通 Plan 生成也只读，Codex 和 Claude 的 Plan 生成仍沿用当前选择权限及受信任工作区检查。Plan 执行与 Agent 沿用现有写权限。Code 普通输入和资源草稿在协调器处排除会话勾选和命令解析。脚本 `ask`、`plan`、`agent`、`template` 走 `Runtime.execute`，由调用参数显式加载 Skill，再处理有序规则、语言及适用输出约束。单独的 `skill()` 也直接加载；其写入仍由 `apply` 控制。 |

现有回归集中在 `test/runtime.test.ts` 的 Skill、规则、Plan 与信任契约，`test/turnExecutionCoordinator.test.ts` 的命令分派和 Code/资源隔离，`test/skillCatalog.test.ts` 的实际变体及根优先级，以及 `test/conversationPreferences.test.ts`、`test/sidebarAgentSelection.test.ts` 的选择恢复与卸载清理。既有 `conversation-view-components`、`plan-acceptance`、`plan-document-persistence`、`agent-result-boundary` 与 `pi-host-compatibility` 的相关契约可继续满足，Skill 加载由独立能力定义。

## Goals / Non-Goals

**Goals**

- 元数据模式复用目录、会话与文本请求协议，权限仍由 Runtime 和 Runner 决定。
- 将可重复验证的请求组装与依赖真实 Agent 的读取、上下文和用量行为分别验证。

**Non-Goals**

- 新的 Provider 请求字段、原生 Skill 安装或发现协议、会话正文缓存、Plan 输出格式调整。

## Decisions

### 会话加载策略显式持久化

在现有会话选择上记录加载策略，例如 `on-demand` 与 `every-turn`。在正常新建、清空后的新会话、空工作区首次会话及历史分支的新会话入口显式设置按需模式，并沿用新会话初始无勾选项的规则。恢复已有会话且缺少策略时解析为每轮应用，包括完全缺少保存选择的旧会话。恢复时用会话实际来源区分旧会话与首次创建的会话，避免由有无勾选推断。历史分支在交给恢复入口之前保存新策略。旧会话可以继续使用原有路径，直到用户主动切换。

在现有 Skills 菜单展示彼此互斥的「按需加载」与「每轮应用」，并保留包级勾选、单项勾选和不可用状态。需要选中项在每轮持续生效时，可将该会话设为「每轮应用」并勾选对应项。切换保存到当前会话，保留勾选，当前 Agent、模型或其他标签的状态各自按既有规则更新。Webview 消息只在显式修改时更新策略，旧客户端消息省略字段时保留会话值。沿用当前运行中拒绝修改的规则，让回合读取一次策略及勾选快照。

### 目录负责解析当前版本，Runtime 生成文本

从 `SkillCatalog` 提取 `list` 与 `load` 已有的版本选择规则，让普通按需路径从同一解析入口取得实际 ID、名称、描述和路径。常规请求使用目录元数据及文件存在性检查，无需逐项读正文。使用目录登记的名称和描述，压成单行并限制长度（描述最多 300 字符，缺失时用简短提示），以结构化转义避免路径或描述改变文本清单结构。项目内文件路径以 Runner 的工作区根为基准，保留真实变体子目录并使用可读的工作区相对路径。全局文件使用目录实际解析出的绝对路径。路径格式化前确认真实文件属于登记的项目、配置目录或全局安装根，按 Windows 与 POSIX 路径规则检查，防止同前缀路径或链接误判。

Runtime 继续用当前的受信任工作区检查。普通按需项在派发前可判定文件缺失、版本不可用或越界时，通过现有状态事件标明对应 ID 和原因，清单省略该项并保留其余请求。无可用项时不生成空清单。派发后若发生文件变更、原生读取失败或工具不可用，文本指令要求 Agent 对相关 Skill 说明原因和受影响的工作，可独立完成的部分继续。显式加载及每轮应用沿用现有加载失败行为。

清单指示 Agent 只对当前任务匹配的项读取，若当前上下文能确认已拥有该路径的当前正文则可复用，来源或版本不确定时重新读取。每轮重新解析实际 provider 和目录结果。安装、更新或卸载沿用资源重载，正文就地编辑可用轻量文件变更检查刷新对应目录元数据和当轮重读提示。路径变更、检测到文件修订、恢复或压缩后不能确认正文时均触发相关任务重读。主机只记目录或文件变更以刷新提示，模型是否仍拥有正文由当轮上下文决定。此前读入的正文可能仍在提供方历史中，当前指令只授权当前勾选和当前版本。

### 显式调用复用全文加载

让协调器把已解析的命令所属 ID 与展开指令一并传给普通对话 Runtime。按需时只对所属 ID 调用既有全文加载器，并从同一请求的简短清单排除该 ID；每轮应用继续按原勾选顺序加载。两种路径都保持 Skill 内容先于命令、Plan 指令和用户输入。Plan 跟进请求复用同一用户回合的选中策略及已展开的命令，照常提供任务状态、验证与文档协议。下一条用户消息重新解析。

脚本 API 的 `Runtime.execute` 路径仍由已解析调用参数驱动，保留选择实际 provider、有序 Skill、规则、语言和模板约束，以及单独 `skill()`、结构化输出、上下文工作目录和写权限的原契约。普通对话 metadata 中的加载策略不参与脚本参数校验。资源草稿与 Code 普通输入仍走协调器已有隔离。

### 以真实读取结果决定宿主接入

普通对话使用工作区根 `cwd`。在本轮当前工作区，用 PowerShell 只读打开 `.dext/skills/openspec-propose/SKILL.md` 成功，证实文件存在且宿主进程可读。以下表格基于 Dext 当前 Runner 源码及相应测试的配置断言。真实工具能否读取项目与全局路径，仍需在对应安装、沙箱和模型中验收。当前实测记录中没有已确认的后端读取缺口。

| 后端 | 已核对的 Dext 接入 | 待实测的读取范围 |
| --- | --- | --- |
| Codex | `CliAgentRunner` 有 app-server 和 CLI 路径。app-server 的线程配置使用 `request.cwd`、`sandbox: "read-only"` 和 `approvalPolicy: "never"` 处理 Ask，`turn/start` 继续传文本。CLI 路径传 `--sandbox read-only`，请求进程仍以工作区为 cwd。 | 通过实际路径允许的读取操作，分别验证 .dext 相对路径和全局绝对路径；需要时覆盖 CLI 后备路径。 |
| Claude | `CliAgentRunner` 的 print 和控制模式都把只读权限映射到 `--permission-mode plan`，使用实际工作区 cwd。 | 用 `Read` 验证项目路径和工作区外全局路径，记录实际权限或工具配置拒绝原因。 |
| Pi | `piTools` 的只读列表保留 `read`，进程使用工作区 cwd，Dext 关闭 Pi 自己的原生 Skill 注入。只读调用保留 Dext 自有 MCP 工具入口，继续限制写入工具。 | 用 `read` 验证 .dext 和全局文件，记录额外工具配置影响。 |
| DeepSeek Harness | `DeepSeekHarnessRunner` 用 ACP 打开或恢复会话，传工作区 cwd 和 Dext 宿主 MCP 声明。 `harnessPolicyPatch` 以该 cwd 为 sandbox 的 `workspaceRoot`，为只读请求固定只读策略。 | 核对实际 preset 暴露的读取工具、项目隐藏目录访问及 workspace 外全局路径策略，记录触发拒绝的具体配置。 |

后续对有代表性的 Agent 以相同身份、cwd 和权限试读项目与全局 Skill，区分工具实际被禁用、文件或路径错误、沙箱拒绝和模型没有发起读取。只有可复现的项目/全局读取缺口来自全局位置或后端沙箱时，才实现、注册和宣传宿主读取入口，覆盖受影响的请求。沿用 `DextApplication.configureVideoFrames`、`Runtime.setHostMcpServers` 与各 Runner 已有宿主传递机制，保留其他宿主工具。宿主接收 Skill ID，由绑定当前会话、回合及实际 provider 的宿主上下文校验工作区信任和勾选快照，并通过目录解析当前版本。绑定由宿主生成并管理，使用持久 Runner 时仍以当前活动回合授权，结束、取消、会话或权限变化后撤销旧授权。工具只读登记根内的 `SKILL.md`，对规范化后的实际路径做边界检查；任意路径、未选项及过期调用均返回错误。正文直接交给当前 Agent，状态事件只记录 ID、来源与诊断。

实施核对中，Codex 和 Claude 的子进程夹具收到原样的按需文本，Pi 夹具验证了只读工具清单保留 `read`，DeepSeek Harness 的 ACP 夹具验证了工作区 cwd、文本块和已有宿主工具声明。当前记录未发现可复现的原生读取缺口，因此 3.2 的宿主读取接入条件不适用。真实 Agent 对项目及全局路径的读取仍在 `## Acceptance` 中核对。

## Risks / Trade-offs

- 大包的描述也会占用上下文 → 复用现有勾选数量上限，单行截断描述，清单以外维持既有提示顺序。
- 同一文件就地更新或提供方压缩后，历史仍可能保留旧摘要 → 对当前解析结果、变化和正文来源给出重读指令，真实验收同时检查读取轨迹与任务结果。
- 各 Runner 的全局读取、续聊及用量上报不同 → 把工具读取轨迹与原生输入或缓存计数分别记录。Harness 当前 ACP `usage_update` 是上下文占用，其用量缺项记为不可用。

## Migration Plan

1. 先接入显式会话策略和兼容读取，覆盖首次、新建、清空、分支、旧会话恢复与切换再持久化。
2. 在普通回合启用新的文本组装和状态反馈，复用现有全文路径支撑每轮应用及显式调用。
3. 真实读取探测用于确认是否需要宿主工具。需要时以当前权限复验对应项目或全局文件，并保留每轮应用作为用户可选择的兼容行为。
