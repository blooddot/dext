# Proposal

## Why

普通对话每次发送请求都会把所有已勾选 Skill 的完整 `SKILL.md` 拼入输入。整包勾选或多轮追问时，无关 Skill 也会消耗上下文，同一份正文会反复进入续聊请求。

## What Changes

- 新会话默认按需加载，勾选表示当前会话可以使用该 Skill。Ask、Plan 和 Agent 通过现有文本输入提供名称、短描述和实际版本的路径，Agent 在任务相关且上下文缺少当前正文时读取。
- 在 Skills 菜单提供会话级「按需加载」和「每轮应用」选项。旧会话保留每轮应用语义，用户明确切换后将新选择保存到该会话。
- `/command` 仍由 Dext 解析并展开参数。在按需模式中，Dext 直接加载命令所属 Skill，其余可用选中项进入简短清单。脚本 API 显式指定的 Skill 继续按既有顺序加载全文。
- 优先使用 Agent 自带的文件读取工具。仅在实测确认全局 Skill 或后端沙箱存在读取缺口时，复用宿主 MCP 接入按 Skill ID 读取，并保持 Ask 只读及现有信任边界。

## Capabilities

### New Capabilities

- `conversation-skill-loading`：会话 Skill 加载策略、当前版本的文本清单、显式调用及读取失败反馈。

### Modified Capabilities

## Impact

- Composer 与会话偏好负责展示和保存加载策略，回合协调器和 SkillCatalog 负责选中项、命令及版本，Runtime 负责拼装现有文本输入。
- 普通 Plan 的文档格式、保存与执行跟进沿用既有流程。Code 普通输入、资源草稿、脚本 API 的参数及输出契约保持兼容。
- 各 Agent Runner 的文件读取差异通过现有配置和真实 Agent 验收核对。宿主 MCP 扩展由可复现的读取失败触发。
