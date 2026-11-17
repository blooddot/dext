# Proposal

## Why

Pi 1.5.x 把两类可恢复的用户状态问题变成了不可读的 CLI 失败：会话记录的工作区被改名或删除后，RPC 模式下 Pi 启动即退出，Dext 只透传一条 `Pi CLI exited before completing the request (1).`（外加 Pi 的 stderr 原文）；用户此前存下的 provider/modelId 被移除后，`set_model` 失败同样只剩一句 `Pi set_model failed: ...`。两种情况下用户都看不出原因，也没有下一步动作可做。

同时 Dext 的 Pi 文档基线仍停在 1.4.0，未记录 1.5.0–1.5.2 中三项会影响用户的行为变化（模型目录换到 models.dev v2、工具参数统一 coercion、`cacheWarming` 默认 `"idle"` 的计费影响），升级后的用户只能靠猜。

## What Changes

- **恢复路径的可读失败**：在 `--session` 恢复之前读取会话文件首行的 `cwd`，目录不存在时**不启动 Pi**，直接返回说明「会话记录的工作区已移动或删除」的错误与下一步动作。预检对会话文件缺失、首行非 JSON、缺 `cwd`（旧会话可能是空字符串）全部放行，交回 Pi 原有路径。不引入 `--fork`。
- **`set_model` 失败的可操作提示**：仅在 `set_model` 请求失败时（两处调用点）在错误文案后追加一句「模型可能已下架，请在 Configure Agent 中刷新模型目录」。其它 RPC 命令的错误透传与自动选模型的既有行为不变。
- **固定 coercion 现状**：用最小断言覆盖「可选属性的显式 `null` 会被 Pi 丢弃」与「单值被包成单元素数组」两点，并在 `docs/agents.md` 的 Pi 段落补一句说明。不改输出契约、不删 `nullable`、不在 Dext 侧补一次 `null` 归一化。
- **文档收敛**：`docs/agents.md` 与 `docs/agents.zh-CN.md` 的 Pi 段落把「Pi 1.4.0 或兼容的更新 CLI」改为「1.4.0 起，当前验证到 1.5.2」，并列三条升级注意：刷新模型目录、工具参数 coercion、`cacheWarming` 默认 `"idle"` 的计费影响及关闭方式（不改 Dext 代码）。

## Capabilities

### New Capabilities

- `pi-host-compatibility`: Dext 宿主与所关联 Pi CLI 版本之间的兼容行为边界——恢复会话前的前置校验与可读失败、模型选择失败的可操作提示，以及 Pi 侧工具参数规整（coercion）在 Dext 工具边界上的既定语义。

### Modified Capabilities

（无。`pi-result-submission` 已覆盖 strict schema 改写下的可选 `null` 丢弃，本次不改动其需求；新增的断言只是固定现状。）

## Impact

- 代码：`src/features/agents/host/piCommand.ts`、`src/features/agents/host/piAgentRunner.ts`，必要时在同一目录新增一个小的会话 header 读取助手（不新建模块目录）。
- 测试：`test/piAgentRunner.test.ts`、`test/piCommand.test.ts`，以及固定 coercion 现状时触碰的既有扩展测试（`test/piExtension.test.ts`）。
- 文档：`docs/agents.md`、`docs/agents.zh-CN.md`。
- 用户可见行为：工作区丢失后的恢复从 CLI 退出错误变为说明原因与下一步的可读错误；模型不可用时多一句刷新提示；Pi 版本基线与三条升级注意进入文档。
- 明确不做：不改 `PiRpcTransport` 协议层（请求/响应匹配、退出清理、`taskkill`）；不改 `media/pi-extension.mjs` 的工具注册与 `agent_before_settle` 提醒；不改结果解析与 `failAgentResult`；不做 provider 原生结构化输出或第三方 structured-output 插件；不加开关、配置项、抽象层或新模块。
