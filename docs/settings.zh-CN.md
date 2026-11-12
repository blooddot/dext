# 设置

[English](settings.md) | 简体中文

[返回 README](../README.zh-CN.md)

`dext.*` 设置决定轮次如何发送、保留多少历史、Dext 把文件写到哪里，以及 Agent 的写入范围有多大。

[发送与历史](#发送与历史) · [存储与附件](#存储与附件) · [权限与发现](#权限与发现) · [执行限制](#执行限制)

## 发送与历史

- `dext.submitOnEnter`（布尔值，默认 `true`）— Agent、Ask、Plan 模式下按 Enter 发送，Shift+Enter 换行。设为 `false` 时改为 Ctrl/Cmd+Enter 发送。Code 模式始终使用 Ctrl/Cmd+Enter 运行。轮次运行中按 Enter 排队下一条消息，而不是停止当前轮次；输入区上方的排队行可回填编辑或撤回，**Stop** 仍然立即停止，随后发出排队消息。
- `dext.history.maxTurns`（整数，默认 `0`，最小 `0`）— 所有对话合计保留的轮次数。`0` 表示全部保留；设为正数时超出部分先丢弃最旧的轮次，对话标签条中对应的项也一并消失。
- `dext.history.maxOutputLength`（整数，默认 `64000`，最小 `1000`）— 每条存储的输入、进程事件和序列化输出保留的字符数。超长时保留首尾两半；保存轮次时被截掉的文本写入该对话的 overflow 文件，轮次可以打开它。同一个值也限制流式输出时单条 Process 行的长度。
- `dext.captureSelectionOnCopy`（布尔值，默认 `true`）— 在任意工作区文本文件（含 Markdown、纯文本、日志和 CSV）中按 Ctrl+C（macOS 为 Cmd+C）复制选区时，把选区暂存为 Dext 文件引用；同样控制选中终端输出后按 Ctrl+Shift+C（macOS 为 Cmd+C）的复制。剪贴板仍收到精确的选中文本，多光标复制完全交给 VS Code。设为 `false` 时两种复制都交回 VS Code。由此生成的 Input 引用见 [文件与选区引用](workflows.zh-CN.md#文件与选区引用)；**Add to Dext** 悬浮入口与路径暂存分别由 `dext.selectionActions.enabled` 和 `dext.copyFilePathOnCopy` 控制。

## 存储与附件

- `dext.storage.location`（`"global"` 或 `"workspace"`，默认 `"global"`）— Dext 保存生成的计划与粘贴的图片附件的位置。`global` 使用 Dext 的 VS Code 全局存储；`workspace` 写入当前工作区的 `.dext` 目录。已存在的文件留在创建时的位置。
- `dext.planDirectory`（字符串，默认 `.dext/plans`）— `dext.storage.location` 为 `workspace` 时，保存的计划所在的工作区相对目录。
- `dext.attachments.maxFiles`（整数，默认 `200`，范围 1–1000）— 当前存储位置保留的粘贴图片附件数量上限。超出时 Dext 先删除最旧的附件。
- `dext.attachments.maxBytes`（整数，默认 `5242880`，范围 65536–52428800）— Dext 保存的粘贴图片、复制的终端输出或剪贴板上下文的字节上限。工作区 `@file` 引用不受此限制。

## 权限与发现

- `dext.agentPermission`（`"workspace-write"` 或 `"full-access"`，默认 `"workspace-write"`）— Agent 与 Plan 的起始写入范围。输入区的 Permission 控件只为当前对话覆盖它，Ask 始终只读。
- `dext.hiddenSkills`（skill id 数组，默认空）— 仍处于安装状态、但不显示在 Input 的 Skills 菜单中的 skill id，因此 API 或已保存的选择仍能加载它们。在 Resources 页面切换某个 Skill 的眼睛按钮时，Dext 以工作区范围写入这个键。
- `dext.mcpDirectories`（工作区相对目录数组，默认空）— 额外读取 MCP 清单的目录。`.dext/mcp` 和 Dext 的全局清单存储始终会被读取；清单本身见 [MCP 配置](mcp.zh-CN.md)。

## 执行限制

- `dext.terminal.defaultTimeoutMs`（整数，默认 `120000`，范围 1000–600000）— 未传 `timeout_ms` 的 `terminal()` 调用使用的超时。取值非法或大于 600000 时回退到默认值；600000 同时是显式 `timeout_ms` 的硬上限。
- `dext.workflow.maxConcurrency`（整数，默认 `4`，范围 1–16）— 一次 Code 运行中同时在途的 Dext API 调用数上限。超出的调用排队等待。

Agent、语言与目录发现相关的设置在各自主页说明：`dext.outputLanguage`、`dext.agentCli`、`dext.agentCliArgs`、`dext.agent.timeoutMs`、`dext.agent.idleTimeoutMs` 见 [Agent 配置](agents.zh-CN.md)；`dext.selectionActions.enabled`、`dext.copyFilePathOnCopy`、`dext.apiDirectories`、`dext.skillDirectories` 见 [工作流与 API](workflows.zh-CN.md)。
