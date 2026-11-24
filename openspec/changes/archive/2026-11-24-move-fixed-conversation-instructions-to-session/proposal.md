# Proposal

## Why

普通对话已用紧凑 JSON 传递 Lazy Skill 清单，但 Dext 仍在每轮用户消息中拼接语言与格式说明以及 Lazy 通用规则。使用后端支持的会话指令入口，可以减少当轮用户消息中的固定正文，并避免续聊时反复把它写入对话历史。

脚本 API 的结构化请求也携带 Dext 内建的载荷读取说明和通用输出格式保护。将这部分固定说明与调用方提供的内容拆分，可以减少相应 API 用户消息中的固定正文，同时保留每次调用所选规则、Skill 及结果契约。

## What Changes

- 将 Dext 内建的语言与格式保护、Lazy 范围和读取规则交给经过验证的原生入口。保留后端默认工具说明和用户已配置的附加提示。
- 继续随请求解析和传递当轮 Skill 范围、实际执行 Agent 的路径与 revision，以及用于清除历史范围的空清单标记。保留相关 Skill 的授权读取与精确版本复用。
- 保持回合语言快照和用户明确语言要求的优先级。设置变更从下一轮生效，涵盖切换语言与恢复由用户消息决定语言。根据后端和会话路径选择更新原生指令、简短当轮覆盖或精简内联回退。
- 覆盖新建、续聊、分叉、进程重启、后端切换和历史会话。分别核对 Dext 用户消息大小、后端上下文中的重复副本和模型请求的输入及缓存用量。
- 对脚本 API 的 `ask`、`plan`、`agent` 和 `template`，在结构化输出兼容性经过验证时，将 Dext 固定说明经原生入口交付给本次独立调用。其余路径使用精简内联。每次调用继续加载显式 `rules` 和 `skills` 的全文，并携带本次输出 schema 与模板约束。

## Capabilities

### New Capabilities

### Modified Capabilities

- `conversation-skill-loading` 的普通 Lazy 对话以当轮清单决定 Skill 范围，固定规则和语言偏好采用适合当前会话路径的指令来源。脚本 API 按调用隔离固定说明与显式规则和 Skill。

## Impact

- 涉及 `DextRuntime.executeConversation`、普通对话语言快照、`AgentConversationRequest`、会话路由与 Codex、Claude Code、Pi、DeepSeek Harness 适配器。脚本 API 涉及 `DextRuntime.execute`、`AgentExecutionRequest` 及结构化派发。
- Ask、Plan 和 Agent 沿用原有信任与权限、Plan 输出协议、Always 和 `/command` 语义。脚本 API 沿用显式 `rules`、`skills`、语言及模板的处理顺序和结构化结果契约。`skill()`、普通 Code 输入和资源草稿沿用各自的入口契约。
- 仓库与用户目录中的 `AGENTS.md`、`CLAUDE.md`、`APPEND_SYSTEM.md` 和已安装 Skill 文件保持原样。实际上下文、token 和费用变化以真实后端请求为准。

