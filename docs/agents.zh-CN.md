# Agent 配置

[English](agents.md) | 简体中文

[返回 README](../README.zh-CN.md)

支持 Codex CLI、Claude CLI 和 DeepSeek Harness。先安装并登录所选 CLI，再通过 Dext 输入区域选择 Agent 和模型；需要修改命令路径时运行 **Dext: Configure Agent**。

[通用配置](#通用配置) · [DeepSeek Harness](#deepseek-harness)

## 通用配置

Agent 配置保存在 VS Code 扩展全局存储中。输入区域根据后端能力提供 Agent、Model、Reasoning 和 Speed 选项。Codex 配置优先读取本地模型缓存中的模型、推理级别和速度选项；Claude Code 使用 `opus` / `sonnet` 别名及已配置的推理级别。

`.dx` 文件可以通过 `@api(agent="codex", model="...")` 覆盖 Agent 和模型，否则使用输入区域的选择。**Dext: Configure Agent** 用于编辑可执行命令和自定义模型名称，不处理登录凭据。

内置的 `agent`、`ask`、`plan`、`skill`、`create` 还支持单次调用的 `cli` 和 `model` 参数：

- `cli` 为 `"codex"`、`"claude"` 或 `"deepseek-harness"`；Harness 的模型对象见下方说明。
- Claude 的 `model` 为 `"sonnet"` 或 `"opus"`。
- Codex 的 `model` 为字典，必填字段 `model` 使用已配置列表中的模型 ID；可选字段 `reasoning` 支持 `"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"`、`"ultra"`，`speed` 支持 `"standard"`、`"fast"`。实际选择必须受该模型支持。本地模型列表不可用时，模型 ID 按字符串接收，待列表可用后再进行目录校验。

```python
ask(input="解释这段代码", cli="claude", model="sonnet")
agent(input="实现这次修改", cli="codex")
```

参数继承规则如下，覆盖仅对当前调用生效：

| 参数 | 行为 |
| --- | --- |
| 都不提供 | 使用当前输入选择，已有 `.dx` 装饰器覆盖仍然生效。 |
| 只提供 `cli` | 使用该 CLI 的默认配置，不继承输入区域或装饰器的模型、推理和速度设置。 |
| 同时提供 `cli` 和 `model` | 使用显式模型选项，未填写的推理或速度选项由 CLI 默认值决定。 |
| 只提供 `model` | 使用输入区域选择的 CLI；模型未变时继承未指定选项，模型改变时使用 CLI 默认值。 |

`dext.agentCli` 控制输入区域显示哪些内置 Agent，默认是 `codex`、`claude` 和 `deepseek-harness`。可以编辑列表，选择显示其中哪些配置。

内置 API 始终可用。Code 输入区支持直接使用自定义 API 的完整名称，也支持显式导入；`.dx` 文件中的自定义 API 通过 `import` 或 `from ... import ...` 进入作用域。补全、悬停、参数提示和编译都支持导入后的名称。

## DeepSeek Harness

### 安装与模型

运行 `npm install -g @deepseek-ai/dsh@0.1.2-rc.1` 安装已验证版本，在 Harness 中配置模型凭据，再在 Dext 选择 **DeepSeek Harness**。**Dext: Configure Agent** 可配置可执行文件路径并通过 ACP 发现模型和推理选项；首次选择也会发现模型。模型留空时使用 Harness 默认值。Dext 在扩展启动时读取一次 `$DSH_HOME/settings.yaml` 中的 `llm-pi-ai.providers` 和 `agent-default-model` 路由；首次选择 Harness 或运行配置命令时刷新，并把缓存结果用于临时 ACP 覆盖层；不会复制或修改用户的 profile 文件或 `.credentials.yaml`。安装和凭据由 Harness 管理。

发布包 `0.1.2-rc.1` 使用 ACP SDK `1.4.0`，Dext 固定使用同一 SDK 版本。已核对实际发布包的握手、创建/恢复/关闭会话、模型配置、执行及取消接口；入口为[官方 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) 的 `dsh --profile acp`。新安装默认显示三个后端，可通过 `dext.agentCli` 限定列表。

### 预设与自定义

模型菜单中的 **Agent preset**：标准、PTC、极简和创造模式直接读取已安装 Harness 的预设。第一条消息发送前选择，已有会话保持原预设；**ACP default** 保留原有 ACP 配置。Dext 通过 ACP 会话工厂适配器挂载预设，不修改 Harness 安装文件。

自定义只需选择 **Let Agent create a preset**，开启创造模式会话并填入草稿；也可以使用 **Copy and open configuration** 复制预设，在 VS Code 编辑 `agent.cordis.yml`。副本保存在 `$DSH_HOME/.agent-presets`（通常为 `~/.dsh/.agent-presets`），与 Harness 网页创建的预设共用目录。修改后点击 **Refresh presets**，配置问题会自动显示。标准和 PTC 支持 Dext 的受限权限；极简、创造和自定义插件可能绕过宿主沙箱，因此需要 **Full access**，选择预设不会自动提升权限。

### Code 调用

Code 模式支持 `ask(input="解释项目", cli="deepseek-harness")`；可选模型对象包含 `model`（ACP 返回的不透明选项值）和 `reasoning`。界面展示可读模型名称，不展示速度或服务等级。类型化调用要求最终消息为 JSON 对象，由 Dext 校验；格式错误会报告失败，不自动重跑可能已经修改文件的任务。

### 会话与权限

每个活动对话使用独立 ACP 进程并复用会话，原生会话 ID 连同工作区、权限和启动配置绑定保存在通用历史字段中。关闭后释放进程，持久化会话可恢复。切换权限或分叉时创建新会话并注入 Dext 已记录的上下文；ACP 不提供原生分叉，内部工具状态不会复制。恢复失败会明确报错。

Ask、预览调用和计划生成使用只读权限；Agent 和明确的计划执行使用所选写入范围。Dext 最后应用的配置将全部权限预设固定在该范围内，用户保存的默认预设不会放宽范围。受限模式拒绝升级请求，因为 ACP 未提供可验证的升级范围；完全访问模式下已知工具的请求使用 Dext 确认。[Windows ACL 约束是部分约束](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)，存在 Everyone 可写对象、硬链接等边界，不能视为严格隔离。工作区写入模式还允许 Harness 使用平台临时目录。

### 高级配置与兼容性

受信任工作区的 `dext.agentCliArgs.deepseek-harness` 接受重复的 `--patch <path>` 参数对；Dext 管理 ACP profile 并最后附加权限配置。插件属于受信任代码，自定义配置必须保留官方沙箱实现，stdout 必须仅输出 JSON-RPC。配置更改需建立新连接。单轮超时使用 `dext.agent.timeoutMs`。过程按已提交消息和工具事件更新，不保证逐 token 展示，也不把上下文占用当作计费 token 消耗。

AIOA/CDP 接入已移除，不提供旧 AIOA 对话兼容或迁移。
