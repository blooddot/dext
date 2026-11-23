# conversation-skill-loading Specification

## Purpose

让 Dext 普通对话能按任务读取已勾选 Skill 的当前版本，减少续聊请求中重复的正文，同时保留会话级持续应用、命令和脚本显式调用的行为。

## Requirements

### Requirement: 会话选择决定 Skill 加载策略

Dext SHALL 在普通对话的 Skills 菜单中显示「Lazy」和「Always」及勾选状态，并按会话保存用户的显式切换。新会话 SHALL 默认按需加载，并在「Lazy」的悬停提示中说明此默认设置。既有会话缺少策略字段时 SHALL 按每轮应用恢复，并按既有规则恢复勾选状态。

#### Scenario: 新建普通对话

- **WHEN** 用户从采用每轮应用且已有勾选项的会话新建普通对话
- **THEN** 新会话选中「Lazy」，初始未勾选 Skill
- **AND** 勾选项表示该 Skill 可用于此会话

#### Scenario: 旧会话恢复后明确切换

- **WHEN** 用户恢复未保存策略字段的旧会话，并将它切换到「Lazy」后重新打开
- **THEN** 首次恢复选中「Always」且所选全文按原流程进入请求
- **AND** 再次打开选中「Lazy」并保留原勾选项，其他会话的设置不受影响

#### Scenario: 需要持续应用所勾选的 Skill

- **WHEN** 用户勾选需要持续应用的 Skill，并将会话切换到「Always」
- **THEN** 每轮请求都直接加载该会话所勾选的有效 Skill 全文
- **AND** 取消勾选后，该 Skill 不再由 Dext 注入后续请求

### Requirement: 普通按需请求提供当前版本的简短清单

按需模式中的 Ask、Plan 和 Agent SHALL 通过现有文本输入提供可用勾选项的名称、短描述和实际 `SKILL.md` 路径，并说明在任务匹配且当前上下文缺少当前版本正文时先用文件工具读取。清单 MUST NOT 包含正文或未勾选项。项目内路径 SHALL 优先相对于工作区根目录表示。

#### Scenario: 勾选整包后发送普通请求

- **WHEN** 用户勾选包含多项 Skill 的包并发送无关的普通问题
- **THEN** Dext 只在文本中提供有效勾选项的名称、短描述和实际路径，完整正文不会随该请求发送
- **AND** 指令要求仅在相关任务需要当前正文时读取

#### Scenario: 未勾选任何 Skill

- **WHEN** 用户在按需会话中取消勾选全部 Skill 后发送普通请求
- **THEN** 该请求没有 Skill 清单或由勾选引入的 Skill 正文

#### Scenario: 实际执行 Agent 选择对应版本

- **WHEN** 勾选的同一 Skill 有 Agent 专用版和共享版，且执行 Agent 发生变化
- **THEN** 清单优先使用实际执行 Agent 的专用版，否则使用共享版，并提供该版本的实际描述与路径
- **AND** 两种版本均不可用时反馈该 Skill 的版本缺失

### Requirement: 当前版本允许按上下文重新读取

每次按需请求 SHALL 提供当前解析结果，并允许 Agent 复用上下文中已拥有的当前正文。已读记录 MUST NOT 成为跳过当前正文读取的依据。

#### Scenario: 连续追问后上下文失去正文

- **WHEN** Agent 已读 Skill，随后用户连续追问并在会话恢复或压缩后继续相关任务
- **THEN** Agent 可在正文仍可用时复用，正文缺失时从清单路径重新读取

#### Scenario: 更新正文或切换 Agent

- **WHEN** Skill 更新或实际执行 Agent 切换，且上下文中仍有旧正文
- **THEN** 请求提供新解析结果并要求在版本变化或无法确认上下文中版本时重新读取

### Requirement: 命令保留显式展开和直属 Skill 加载

Dext SHALL 按实际执行 Agent 解析 `/command` 所属的已勾选 Skill，并按现有规则展开参数。在按需模式下，命令所属 Skill SHALL 直接加载全文一次，其余可用勾选项 SHALL 以简短清单提供。Plan 跟进请求 SHALL 继续携带当前用户回合已展开的命令与其适用的 Skill 指令，并保留原有 Plan 协议。

#### Scenario: 已勾选多项 Skill 后运行命令

- **WHEN** 按需会话勾选 A 与 B 后输入属于 A 的 `/command` 和参数
- **THEN** 命令参数按原规则展开，A 的正文在展开命令前直接发送一次，B 只进入清单
- **AND** 用户的下一条普通请求恢复按需语义

#### Scenario: 运行未选中的命令或命令所属 Skill 缺失

- **WHEN** 命令所属 Skill 未被勾选、没有当前可用版本或其正文不可读
- **THEN** Dext 反馈原因并使该显式调用失败

#### Scenario: 一次 Plan 执行产生后续请求

- **WHEN** 带显式命令的 Plan 执行因进度或验证进入同一用户回合的后续请求
- **THEN** 已展开的命令继续可用，命令所属 Skill 按该回合既定策略直接加载，任务状态、验证与结束条件按原有协议处理

### Requirement: 其他入口保留各自的 Skill 契约

脚本 API 的 `ask`、`plan`、`agent` 和 `template` 显式指定 `skills` 时 SHALL 按原顺序直接加载全文，规则及语言和适用的输出约束仍按既有顺序处理。`skill()` SHALL 保持直接调用语义。Code 普通输入和资源草稿 MUST NOT 使用会话勾选项生成清单或注入正文。

#### Scenario: 脚本调用与对话勾选不同

- **WHEN** 会话勾选 A，用户通过 Code 调用 `template` 且显式传入 B、C 和有序规则
- **THEN** B、C 正文先于规则，模板输出约束保留原位置，A 不因会话勾选被注入

#### Scenario: Code 普通输入与资源草稿

- **WHEN** 用户在勾选 Skill 的会话发送普通 Code 输入，或从对应资源入口生成草稿
- **THEN** 请求继续遵循各自的生成或执行流程，且不携带会话勾选产生的 Skill 清单、正文或斜线命令展开

### Requirement: 按需读取保持现有权限并反馈不可用

按需读取 SHALL 优先使用当前后端已有的文件工具，并维持工作区信任与 Ask 的只读权限。可选宿主读取入口仅在确认原生读取缺口时提供，且 MUST 限于当前受信任会话已勾选 Skill 的当前版本及其 `SKILL.md`。系统 SHALL 反馈缺失、不可用或读取失败的原因。

#### Scenario: Ask 在受信任工作区读取项目 Skill

- **WHEN** Ask 中的任务需要某个已勾选的项目 Skill 且当前上下文缺少正文
- **THEN** 可用的原生文件工具读取清单路径，Ask 保持只读

#### Scenario: 普通按需项没有可用文件

- **WHEN** 某个所选 Skill 的文件缺失或版本不可用可在派发前确定
- **THEN** Dext 提示该 Skill 的 ID 和原因，其他可用勾选项和普通请求继续可用

#### Scenario: 派发后读取失败或工具不可用

- **WHEN** Agent 尝试读取相关 Skill，读取失败、工具不可用，且没有已授权的读取途径
- **THEN** 回复说明相关 Skill 和失败原因，不声称已按该正文执行，可独立完成的部分仍可继续

#### Scenario: 宿主读取工具拒绝越权或过期请求

- **WHEN** 已启用的宿主工具收到未勾选的 ID、过期回合、其他会话或不受信任工作区的读取请求
- **THEN** 工具拒绝读取且不返回文件正文
