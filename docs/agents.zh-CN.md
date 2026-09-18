# Agent 配置

[English](agents.md) | 简体中文

[返回 README](../README.zh-CN.md)

支持 Codex CLI、Claude CLI 和 DeepSeek Harness。先安装并登录所选 CLI，再通过 Dext 输入区域选择 Agent 和模型；需要修改命令路径时运行 **Dext: Configure Agent**。

Codex 对话通过 CLI 的 App Server 将原生提问显示为 Process 上方的卡片。选择选项或输入自己的答案后点击提交；异步提问允许 Agent 在等待回答时继续工作。任务完成或中断会关闭未回答的卡片，历史记录保留只读问答。已有的纯文本问题不能补接成交互。对话沿用普通 Codex 登录与配置，独立于 Dext 的补全账号。交互对话支持 `dext.agentCliArgs` 中的 `--config`、`--enable` 和 `--disable` 参数，其他 CLI 参数会给出明确的配置错误；类型化 `.dx` API 仍使用 `codex exec`。

Claude 对话改用 CLI 的双向控制协议，它原本要问自己终端的问题与权限提示都会转成 Dext 卡片。详见 [Claude Code](#claude-code)。

[通用配置](#通用配置) · [Claude Code](#claude-code) · [DeepSeek Harness](#deepseek-harness)

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

### 单轮超时

Dext 默认使用 `dext.agent.timeoutMs: 0`（不限制总时长）和 `dext.agent.idleTimeoutMs: 600000`（没有已报告的活动工具时，连续十分钟没有进程输出）。stdout、stderr 的每次输出都会重新开始空闲计时。收到 Codex、Claude 或 ACP 工具开始事件后暂停空闲检测，所有未结束的工具完成或失败后重新计满十分钟。通过调用 ID 跟踪并发工具并去除重复事件，因此工具调用仍在执行时，不会把静默命令当作模型卡死。

工具执行保留提供方自身的时限。报告工具正在执行不代表进程一定正常：工具卡死或缺少结束事件可能让空闲检测持续暂停，仍可手动停止或设置整轮硬时限。提供方未报告带有调用 ID 的工具开始事件时，仍按普通空闲超时处理。

任一值设为 `0` 可关闭对应限制。已显式配置的正数 `dext.agent.timeoutMs` 仍是硬性总时限，不因输出而延长；要只按活动计时，请删除旧覆盖值或改为 `0`。设置对新一轮执行生效，仍可随时点击停止。提供方的网络超时和单个工具的超时独立生效。同一组限制也用于约束「结果修复」（某一轮的最终消息不是合法结果时，Dext 补跑的那次只读调用），它没有额外的内部固定上限。

## Claude Code

Claude 对话使用 CLI 的双向控制协议：`--input-format stream-json` 打开反向通道，`--permission-prompt-tool stdio` 把 CLI 原本要问自己终端的每个决定转交给 Dext。类型化 `.dx` 调用不变，仍使用 CLI 的一次性 print 模式加 `--json-schema`，因为类型化调用没有人在回路中。

### 提问与权限

`AskUserQuestion` 显示为与 Codex、Harness 相同的 Dext 卡片（位于 Process 上方），所选选项会返回给工具。Claude 以工具调用形式提问且不带题目 id，因此由 Dext 生成稳定 id；多选回答以逗号分隔返回，自定义输入以自由文本返回。其他需要决定的工具 —— 执行命令、写入文件、交接计划 —— 显示一张 Dext 确认卡片，标明工具名以及它涉及的命令或路径，关闭即拒绝该调用。CLI 主动撤回的请求会关闭对应卡片；MCP elicitation 也走同一张提问卡片。

只读的 Ask 与 Plan 轮次使用 Claude 的 `plan` 模式，Agent 轮次使用 `acceptEdits`，Full access 使用 `bypassPermissions`。`plan` 直接拒绝写入，`bypassPermissions` 不再询问，因此这两种档位下多数调用不会有卡片。对话用 `--resume` 恢复 provider 会话，分叉用 `--fork-session` 从源会话开始。没有 Dext 界面时，runner 保留 CLI 自身的 print 模式行为，而不是把每个调用都拒绝掉。

## DeepSeek Harness

### 安装与模型

使用仓库 `mise.toml` 运行 `mise install` 安装已验证版本（`@deepseek-ai/dsh@0.1.5-rc.1`），在 Harness 中配置模型凭据，再在 Dext 选择 **DeepSeek Harness**。**Dext: Configure Agent** 可配置可执行文件路径并通过 ACP 发现模型和推理选项；首次选择也会发现模型。模型留空时使用 Harness 默认值。Dext 在扩展启动时读取一次 `$DSH_HOME/settings.yaml` 中的 `llm-pi-ai.providers` 和 `agent-default-model` 路由；首次选择 Harness 或运行配置命令时刷新，并把缓存结果用于临时 ACP 覆盖层；不会复制或修改用户的 profile 文件或 `.credentials.yaml`。安装和凭据由 Harness 管理。

发布包 `0.1.5-rc.1` 使用 ACP SDK `1.4.0`，Dext 固定使用同一 SDK 版本。已核对实际发布包的握手、创建/恢复/关闭会话、模型配置、执行及取消接口；入口为[官方 CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md) 的 `dsh --profile acp`。新安装默认显示三个后端，可通过 `dext.agentCli` 限定列表。

### 预设与自定义

模型菜单中的 **Agent preset** 就是已安装 Harness 的预设目录本身：标准、PTC、极简和创造模式。新会话默认使用标准模式；要换预设请在第一条消息前选择，已有会话保持原预设。Dext 通过 ACP 会话工厂适配器挂载所选预设，不修改 Harness 安装文件，也不会用 profile 自带的 agent 组合代替预设。旧版本保存的、没有预设的会话按标准模式运行。

自定义只需选择 **Let Agent create a preset**，开启创造模式会话并填入草稿；也可以使用 **Copy and open configuration** 复制预设，在 VS Code 编辑 `agent.cordis.yml`。副本保存在 `$DSH_HOME/.agent-presets`（通常为 `~/.dsh/.agent-presets`），与 Harness 网页创建的预设共用目录。修改后点击 **Refresh presets**，配置问题会自动显示。标准和 PTC 支持 Dext 的受限权限；极简、创造和自定义插件可能绕过宿主沙箱，因此需要 **Full access**，选择预设不会自动提升权限。

### Code 调用

Code 模式支持 `ask(input="解释项目", cli="deepseek-harness")`；可选模型对象包含 `model`（ACP 返回的不透明选项值）和 `reasoning`。界面展示可读模型名称，不展示速度或服务等级。类型化调用要求最终消息为 JSON 对象，由 Dext 校验；格式错误会报告失败，不自动重跑可能已经修改文件的任务。

### 会话与权限

每个活动对话使用独立 ACP 进程并复用会话，原生会话 ID 连同工作区、权限和启动配置绑定保存在通用历史字段中。关闭后释放进程，持久化会话可恢复。切换权限或分叉时创建新会话并注入 Dext 已记录的上下文；ACP 不提供原生分叉，内部工具状态不会复制。恢复失败会明确报错。

Ask、预览调用和计划生成使用只读权限；Agent 和明确的计划执行使用所选写入范围。Dext 最后应用的配置将全部权限预设固定在该范围内，用户保存的默认预设不会放宽范围。受限模式拒绝升级请求，因为 ACP 未提供可验证的升级范围；完全访问模式下已知工具的请求使用 Dext 确认。[Windows ACL 约束是部分约束](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)，存在 Everyone 可写对象、硬链接等边界，不能视为严格隔离。工作区写入模式还允许 Harness 使用平台临时目录。

### 提问

Harness 的提问显示在与 Codex 相同的 Dext 卡片中（位于 Process 上方），回答会直接返回给工具。由于卡片位于 Process 时间线上方，而长时间运行的回合会把该时间线撑得远超视口，因此当回合处于等待状态时新出现的提问会自动滚动到视野内，并暂停自动跟随，直到回答完毕；**Jump to latest** 可回到最新输出。发布包的 `dsh-acp` 只桥接了 `approval/request`，没有为 `user-questions/request` 注册应答者，因此 `dsh --profile acp` 下 `ask_user_question` 会按失败关闭原则直接报错。协议自带的替代方案是 ACP elicitation：Dext 已声明 `elicitation.form` 能力并实现 `elicitation/create`，上游一旦把该接缝桥接到 elicitation，Dext 无需改动。在此之前 Dext 通过自己的预设覆盖层注册应答者，经一次性令牌命名的回环端点与扩展通信，且只对该 Harness 进程开放。当没有 Dext 卡片接管问题时，应答者会转交下一个监听者，保持原有失败关闭行为。

### 高级配置与兼容性

受信任工作区的 `dext.agentCliArgs.deepseek-harness` 接受重复的 `--patch <path>` 参数对；Dext 管理 ACP profile 并最后附加权限配置。插件属于受信任代码，自定义配置必须保留官方沙箱实现，stdout 必须仅输出 JSON-RPC。配置更改需建立新连接。单轮执行使用上文的总时限和空闲时限；ACP 初始化和模型配置请求保留各自的超时。过程按已提交消息和工具事件更新，不保证逐 token 展示，也不把上下文占用当作计费 token 消耗。

AIOA/CDP 接入已移除，不提供旧 AIOA 对话兼容或迁移。
