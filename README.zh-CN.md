# Dext

[English](README.md) | 简体中文

Dext 是一款支持 AI 对话与类型化工作流的 Visual Studio Code 插件。你可以提问、委托代码修改、制定和执行计划，也可以通过 API、Skills 和 MCP 工具将重复任务变成可复用的工作流。

![Dext 在 VS Code 侧栏中解释选中的 Playground 代码](docs/images/dext-overview-sidebar.png)

<details>
<summary>查看全屏布局</summary>

![Dext 展开后的全屏布局](docs/images/dext-overview-fullscreen.png)

</details>

## 能做什么

| 模式 | 用途 | 输入 |
| --- | --- | --- |
| **Ask** | 理解代码、分析问题，不修改文件 | 自然语言 |
| **Agent** | 实现功能、修复问题、运行检查 | 自然语言 |
| **Plan** | 创建和修订计划，再点击 **Build** 实施 | 自然语言 |
| **Code** | 组合 API 调用，编写类型化工作流 | 工作流代码 |

执行 Plan 时，Dext 会在每轮回答后检查任务状态，自动继续未完成且未受阻的工作。任务全部报告完成后，还会单独请求最终验收，验收通过才显示 `Completed`。进度保存在会话历史中，不修改计划文件；暂停后再次点击 **Build** 会恢复同一计划中未变更任务的进度。

用户停止显示 `Stopped`，所有剩余任务都有明确外部阻塞时显示 `Blocked`；连续三轮没有新增完成项或新工具活动，或达到单次 64 轮上限时显示 `Incomplete` 并保留计划。普通回答结束不再等于计划完成。最终验收依赖 Agent 检查代码与测试并报告结果，宿主不能仅凭任务勾选独立证明实现正确。

你可以将文件和代码选区加入上下文，在 History 中继续对话，并从对话生成起始工作流。Code 模式提供 API 补全、参数提示、诊断和类型化结果字段。

从 VS Code 文件资源管理器拖动文件时，按住 **Shift**，在 Dext 输入框高亮后松开鼠标，即可在落点插入文件引用（ref）。支持多选文件一起拖入。

支持 **Codex CLI、Claude CLI 和 DeepSeek Harness**，也可以单独配置用于源代码行内补全的模型。

## 安装

需要 **VS Code 1.105 或更新版本**。执行 AI 任务前，请安装并登录其中一个受支持的 Agent CLI，Dext 使用该 CLI 的登录凭据。

### 从插件商店安装

1. 在 VS Code 中打开扩展视图。
2. 搜索 `blooddot.dext`，选择发布者为 **blooddot** 的 **Dext**。
3. 点击 **安装**。

也可以打开 [Dext 商店页面](https://marketplace.visualstudio.com/items?itemName=blooddot.dext)。后续可在扩展视图中管理更新。

### 从 VSIX 安装

1. 从 [GitHub Releases](https://github.com/blooddot/dext/releases) 下载 `dext-<版本号>.vsix`。
2. 打开 VS Code 命令面板，执行 **Extensions: Install from VSIX...**（扩展：从 VSIX 安装）。
3. 选择下载的文件；如果出现提示，重新加载 VS Code。

手动安装的版本可通过安装新版 VSIX 更新。从源码构建见[开发指南](docs/development.zh-CN.md)。

## 快速上手

1. 在 VS Code 中打开项目文件夹，点击活动栏中的 Dext，或执行 **Dext: Focus Input**。
2. 在输入区域选择 Agent 和模型；如果选项未显示，展开 **More options（更多选项）**。需要修改可执行文件路径时，执行 **Dext: Configure Agent**。
3. 选择 **Ask**，输入“解释这个项目的结构”，点击 **Send**。需要分析具体代码时，在编辑器中选中代码，再点击 **Add to Dext**。
4. 需要修改代码时，选择 **Agent**。项目内修改使用 **Workspace write**；**Full access** 允许更广泛的访问。

较大的任务可以先选择 **Plan**，创建和修订实施计划。选中最终计划后，在同一模式点击 **Build** 执行。

![选中代码，加入 Dext，再通过 Ask 获取解释](docs/images/dext-ask-demo.gif)

*Ask 操作演示：选中代码 → Add to Dext → 输入“Explain the selected code.”。*

## 编写工作流

选择 **Code**，输入以下代码并点击 **Run**：

```python
answer = ask(input="解释这个项目的结构")
print(text=answer.text)
```

工作流使用 Python 的一小部分语法，由 Dext 自行解析和校验，**不需要 Python 解释器**。API 参数和结果字段都支持补全与类型检查。

可复用的 API 以 `.dx` 文件保存在 `.dext/api/` 中。例如，创建 `.dext/api/team/analyze.dx`：

```python
from common import ask

def main(input: str) -> AskResult:
    return ask(input=input)
```

在 Code 模式中，可以直接调用 `team.analyze(input="...")`，也可以导入后使用简短名称：

```python
from team import analyze

answer = analyze(input="解释任务筛选逻辑和相关测试")
print(text=answer.text)
```

项目 API 需要受信任的工作区。你也可以右键 History 条目，选择 **Record Conversation as Dext Workflow**，生成起始文件后继续编辑。组合调用、Skills、规则和交互确认见[工作流与 API 参考](docs/workflows.zh-CN.md)。

![Code 模式调用 Playground API 后，输入 checked. 时显示 TerminalResult 字段补全](docs/images/dext-workflow-completion.png)

*输入 `checked.` 时的字段补全。图中的 `playground.*` API 来自 Dext Playground。*

## 跟着 Playground 练习

[Dext Playground](https://github.com/blooddot/dext-playground) 是配套的 Todo 应用和实作教程。先运行应用，让 Dext 解释代码，再完成一次看得见的修改；之后按需练习计划、功能开发、测试、可复用 API 和 MCP 工具。

[开始首次体验](https://github.com/blooddot/dext-playground/blob/master/docs/getting-started.md)。

![通过 Agent 完成搜索练习后的 Playground，展示匹配任务、全局统计和修改摘要](docs/images/playground-search-result.png)

*完成搜索练习后的效果：列表按关键词展示匹配任务，全局统计保持不变。*

## 详细文档

| 文档 | 内容 |
| --- | --- |
| [工作流与 API](docs/workflows.zh-CN.md) | 语法、内置与自定义 API、上下文、Skills、规则和 History |
| [Agent 配置](docs/agents.zh-CN.md) | CLI 配置、模型覆盖、DeepSeek Harness 预设与权限 |
| [MCP 配置](docs/mcp.zh-CN.md) | 工具清单、类型化结果、传输方式和凭据 |
| [行内补全](docs/completion.zh-CN.md) | 模型配置、接口格式和调优 |
| [开发与发布](docs/development.zh-CN.md) | 本地开发、检查、打包、发布和架构 |

## 补全：API 模型、上下文与项目经验

Tab 补全仅支持 API Key 模型及本地 Ollama，已移除 ChatGPT 登录补全；侧栏 Codex 对话不受影响。未发布预览的配置已在本机一次性清理，扩展不再包含 ChatGPT Tab 配置迁移代码。可通过 **Dext: Configure Completion Model** 配置 API 模型。Codex CLI 仍自行管理登录。补全现在结合有界的光标上下文、后台定义查询、近期编辑和相关示例。自动请求不会等待后台查询；忽略规则确认后，冷缓存使用基础文本窗口。所有源码片段遵守工作区边界、`.dextignore` 和配置控制的 `.gitignore`。候选支持同一行标识符替换及有界的多行插入。

`dext.completion.adaptation` 提供 `off`、`session`（初始默认）和 `workspace` 模式。补全菜单可切换模式、查看记忆摘要和清除当前项目记忆。`workspace` 只持久化本地弱反馈统计及有效示例引用，不保存原始代码副本、不上传训练日志。`off` 停止读取和学习；切换到 `session` 清除当前工作区各根目录的持久化经验。接受后观察 30 秒，仅可关联的撤销、修改或已保存保留参与统计；至少 20 个有效样本后才调整长期策略，幅度不超过 ±20%，旧样本衰减，30 天未使用的记录过期。真实未见任务质量与延迟验收尚未完成，因此暂不默认启用跨会话记忆。

项目记忆位于扩展宿主的 `workspaceState`，远程开发时可能位于远程主机。每根使用八个固定存储槽，每槽最多 16 个统计分组、三个引用和 16 KiB，每窗口最多八个活动根目录。写入按 30 秒合并。随机清除代次另存于 `<扩展全局存储>/completion-memory-generations`，不含源码或账号信息，旧窗口覆盖整份 `workspaceState` 也不能回退这些代次。窗口观察到代次变化后失效快照；代次不可验证时暂停使用持久化记忆。清除操作立即使本地记忆和候选失效，再执行磁盘操作；清除失败时暂停使用该项目记忆，直到重试成功。临时写入失败会在后续批次重试。VS Code 没有跨窗口事务，槽位碰撞及并发写入仍可能丢失近期统计，退出刷新仅尽力完成。集成测试已验证两个真实 VS Code 进程（独立 profile）间共享清除代次、重写旧 Memento 不恢复旧经验，以及同一 peer profile 重启后的持久化恢复。

当前 VS Code Profile 中已有的 HTTP 配置无需重新填写。运行 **Dext: Evaluate Completion Quality and Latency**（也可从补全菜单进入），选择三轮质量对照、三种适应模式或 100 次延迟采样。入口按当前文档读取有效配置，并在扩展进程内从 SecretStorage 获取已有密钥；不把密钥传到命令行、日志或临时文件。即使自动补全关闭，也能显式评测；评测不会修改该开关、切换后端或污染实际项目记忆。任务可取消，认证失效、限流或后端不可用时停止剩余批次。输出只含样例指标、计数和延迟，真实模型文本不写入编辑器诊断日志。安装了旧版扩展的窗口需要加载新构建后才能使用此入口，无需再次授权。

无需账号的离线验证：

```sh
node scripts/probeCompletionApi.mjs --offline --cases test/fixtures/completionQuality.json
node scripts/probeCompletionApi.mjs --offline --adaptation --cases test/fixtures/completionAdaptation.json
node scripts/probeCompletionApi.mjs --offline --performance --repeat 200
node scripts/probeCompletionApi.mjs --offline --performance --repeat 200 --baseline-revision 53ccfd28e6213ca967b12023c7d6d7fac06a1048
```

独立 CLI 真实 HTTP 评测使用 `--backend http --endpoint <地址> --models <模型> --api <生效协议> --quality --repeat 3`，凭据通过环境变量 `DEXT_PROBE_KEY` 传入。CLI 不会自动读取当前 Profile 或 SecretStorage；已有配置应优先使用上述编辑器入口，不能因终端缺少环境变量就判定插件未配置。`--api` 保留现有四种协议，不能仅凭模型名称改为 chat；`--suffix` 检查配对后缀证据。CLI 质量评测会输出样例模型文本和候选，分享前需检查。当前 34 个完整编辑样例和八组反馈序列复用生产上下文、候选及示例引用校验；两组项目写法任务检查保留示例与重启恢复。固定响应和预置弱反馈仅证明处理行为，不能证明真实模型变聪明；核心耗时也不能冒充编辑器灰字显示耗时。真实持续适应收益尚未验收。

`--baseline-revision <完整提交 SHA>` 从 Git 在内存加载旧版 HTTP provider，交替运行旧版与新版，不修改工作区；也可与 `--quality` 配合。

### 补全验证记录

2026-09-09 Windows 验证记录：三轮共 96 个固定响应样例，基线提交 `53ccfd28e6213ca967b12023c7d6d7fac06a1048` 为 75 个有效、9 个错误、12 个留空；当前处理链路为 84、0、12。这是候选处理结果，不代表真实模型学习收益。真实 VS Code provider 对照每类执行 200 次、交替运行旧版和新版，HTTP 返回固定响应：

| 场景 | 旧版 p95 | 新版 p95 | 模型调用数：旧版/新版 |
| --- | --- | --- | --- |
| 热候选缓存 | 0.047 ms | 0.442 ms | 1 / 1 |
| 未缓存位置 | 16.444 ms | 16.841 ms | 200 / 200 |
| 重叠 provider 调用 | 16.448 ms | 16.382 ms | 400 / 200 |
| 大文件 | 16.200 ms | 16.212 ms | 200 / 200 |
| 文件切换 | 16.072 ms | 16.482 ms | 200 / 200 |

PowerShell 中运行 `$env:DEXT_COMPLETION_PERFORMANCE='1'; npm run test:host` 可复测编辑器基准，需要上述 Git 提交，测试会创建临时样例与 profile。它包括真实文档读取和调度，不包括网络、模型学习或屏幕显示；之后清除该环境变量可恢复普通宿主检查。诊断已关联 provider/编辑时间与实际 HTTP 发送时间，并单列后端准备耗时。

显式调用 `dext.evaluateCompletion` 可以传入 `quality`、`adaptation` 或 `performance`，仍使用生效 Profile 配置及固定请求上限，只返回脱敏汇总。缺少密钥时，诊断分别报告存储是否可读、全局／当前旧密钥是否存在及其他旧补全密钥数量，不返回密钥值或存储键名。2026-09-09 在 Cocos Profile 的开发窗口中确认模型、协议、endpoint 已配置，但可读的 SecretStorage 没有全局或旧版补全密钥，102 个质量样例请求实际发送 0 个；这不计为模型质量失败。其他 Provider 或 Agent 的凭据不会被自动替代使用。

## 反馈与许可证

通过 [GitHub Issues](https://github.com/blooddot/dext/issues) 反馈问题或提出功能建议。请提供 Dext 和 VS Code 版本、复现步骤，以及移除凭据后的相关日志。

Dext 采用 [PolyForm Perimeter License 1.0.1](LICENSE)，并可另行协商商业授权。在遵守许可证的前提下，允许日常使用，包括企业内部使用。利用 Dext 向他人提供竞争性产品或服务，需要另行授权，即使该产品或服务免费提供。

授权范围与申请方式见[商业授权说明](COMMERCIAL-LICENSING.md)。本项目属于源码可见软件，不采用 OSI 认可的开源许可证。第三方组件继续遵循各自许可证。版本记录见 [CHANGELOG.md](CHANGELOG.md)。
