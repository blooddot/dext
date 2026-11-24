# Proposal

## Why

Dext 已提供带写入提示的「重新执行」，会用原轮次的输入和模式从头运行。当前仍注册 Code Continue 命令并接受对应 Webview 消息，失败轮次的内存回放可能给第二次执行返回旧的 API 响应，且中英文工作流仍把 Continue 描述为失败轮次的可见操作。

## What Changes

- **BREAKING** 移除 `dext.history.continueTurn`、`continueTurn` 消息及失败轮次的 Dext API 调用回放。使用这些入口的调用方改用现有「重新执行」流程，保留用户确认。
- Code 轮次通过「重新执行」从头开始。用户确认后，原输入和原模式用于启动新轮次，每个 API 调用执行并使用当次响应，写文件、保存计划和调用外部服务等副作用可能再次发生。原失败轮次及已记录输出仍可查看。
- 保留 History 的 `dext.history.continueConversation`（Continue in Dext）、既有输出与已回答交互的展示、Agent 会话恢复，以及 Plan 进度与验收状态。
- 更新中英文工作流、开发文档、源码注释和验证命令。归档变更继续作为历史记录保留。

## Capabilities

### New Capabilities

### Modified Capabilities

- `plan-document-persistence`：保留 `planPath` 的 Host/Kernel 边界契约和 `plan()` 的保存行为，移除回放复用已保存路径和禁止重复保存的要求。
- `script-view-output`：保留 `ui.render` 的输出顺序、失败轮次已产生的可见输出和 History 中的交互摘要，移除与继续执行旧 API 调用绑定的场景，明确确认重跑时使用本轮调用结果。

## Impact

- VS Code 命令注册、Webview 请求协议、Sidebar 和对话宿主执行接线。
- `DextApplication`、`DextKernelHost`、Kernel IPC 与 `dextRuntime.mjs`；移除回放专用缓存和类型，保留请求分发、结果序列化、步骤输出和取消隔离。
- History 存储和已保存的 Plan 文档继续沿用现有格式。回放缓存位于当前扩展进程内，无需数据迁移。
- 对话、Plan、源代码 Kernel 与构建版 Kernel 回归测试，以及 `docs/workflows*.md`、`docs/development*.md`。
