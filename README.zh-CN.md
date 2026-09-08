# Dext

[English](README.md) | 简体中文

Dext 是 Visual Studio Code 中的 AI 对话与类型化工作流编辑器。你可以提问、委托代码修改、制定和执行计划，也可以通过 API、Skills 和 MCP 工具编写可复用的工作流。

工作流使用 Python 的一小部分语法，由 Dext 自行解析和校验，**不需要 Python 解释器**。

没有配置 Agent 时，Dext 可以校验工作流结构、解析不可变的代码引用，并生成类型化的确定性结果预览。选择 Codex 或 Claude CLI 配置后，Dext 会把相同的类型化 API 契约交给对应 CLI 执行，并在展示前校验其结构化输出。

## 功能

- **四种输入模式**：Agent 执行任务，Ask 只读问答，Plan 管理实施计划，Code 编写类型化工作流。
- **Agent 选择**：支持 Codex CLI 和 Claude CLI，并提供各后端支持的模型选项。
- **类型化编辑**：API 补全、参数提示、悬停说明、诊断信息和结构化结果。
- **可复用资源**：项目级和全局 API、Skills、规则与 MCP 工具。
- **工作区上下文与历史**：文件和选区引用、附件、对话标签页、收藏，以及从历史记录生成工作流。
- **可选行内补全**：为源代码文件单独配置补全模型。

## 安装

需要 **VS Code 1.105 或更新版本**。要执行 AI 任务，请先安装并登录准备使用的 Agent CLI。Dext 不附带这些应用，也不管理它们的登录凭据。

1. 在 [GitHub Releases](https://github.com/blooddot/dext/releases) 中选择版本，下载附件 `dext-<版本号>.vsix`。
2. 打开 VS Code 命令面板，执行 **Extensions: Install from VSIX...**（扩展：从 VSIX 安装）。
3. 选择下载的文件；如果出现提示，重新加载 VS Code。

如果尚无可下载的安装包，可以按照[开发](#开发)部分在本地构建。更新时，下载并安装新版本的 VSIX 即可。安装方式也可参考 [VS Code 官方文档](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix)。

## 快速上手

1. 在 VS Code 中打开项目文件夹，点击活动栏中的 Dext，或执行 **Dext: Focus Input**。
2. 在输入区域选择 Agent 和模型。如果需要修改可执行文件路径或模型名称，执行 **Dext: Configure Agent**。
3. 选择 **Ask**，输入“解释这个项目的结构”等问题，点击 **Send**。需要具体上下文时，将文件或代码选区加入输入。
4. 需要修改代码时选择 **Agent**；需要制定并推进实施计划时选择 **Plan**。这两种模式提供 **Workspace write**（工作区写入）和 **Full access**（完全访问）范围选项。
5. 需要组合 API 调用时，选择 **Code**，输入工作流并点击 **Run**：

```python
answer = ask(input="解释这个项目的结构")
print(text=answer.text)
```

Agent、Ask 和 Plan 模式可以直接输入自然语言；Code 模式需要使用工作流语法。执行 **Dext: Open History** 可以查看历史对话，右键历史条目可将其记录为可复用工作流。

## 工作流语言

在 Code 模式中，自然语言需要写在 API 的字符串参数中，直接输入普通文本会产生编译错误。

```python
analysis = ask(input="解释这段实现，并提出重构要求：")

preview = agent(
    input="实现所需的重构",
    apply=False,
)

if preview.patch:
    applied = apply(result=preview)
```

输入工作流支持以下语法：

- 赋值、仅使用关键字参数的 API 调用、字符串（包括三引号字符串）、数字、布尔值、同类型元素列表、结果字段访问和注释。
- `if` / `else` 分支，以及 `==`、`!=` 比较。
- `for name in list:` 顺序循环；列表元素必须类型一致，循环变量仅在循环体中有效。
- `[call(...) for name in list]` 列表推导式；这是支持并发执行的结构，各分支互不可见，并发上限由 `dext.workflow.maxConcurrency` 控制，结果保持输入顺序。仅支持一个 `for` 子句，不支持 `if` 过滤。
- `try` / `except` 和可选的 `finally`；某一步失败后可以进入处理分支并继续工作流。`except Exception as name:` 将错误消息绑定为仅在处理分支内可见的字符串。不支持按具体异常类型区分处理，用户停止执行也不会被捕获。

`.dx` API 文件还支持带类型声明的 `main()` 入口、同文件内带类型声明的辅助函数和显式导入。辅助函数仅在当前文件可见；不支持嵌套定义或递归调用。输入工作流不支持自定义函数或类、`while`、重复赋值、`eval`、`exec` 或任意系统、文件、网络 API；相关操作需通过 Dext 提供的 API 完成。除列表推导式外，执行按顺序进行；未选中的步骤及因上游失败未执行的后续步骤会标记为 `skipped`。

`ask` 和 `agent` 接受普通字符串。文件选区和附件会以可读的 `@workspace/path#Lstart,end-Lend,end` 标记插入；编辑器、Output 和 History 将其显示为引用块，复制和执行时保留可读标记。Dext 不把文件内容直接展开进提示词。

## 内置 API

- `create(type="api"|"mcp"|"rule"|"skill", input, scope="project"|"global") -> ChatResult`：根据描述或 URL 创建资源，在 Code 模式中使用。
- `ask(input, skills?, rules?, workspace?) -> ChatResult`：只读解释和分析。
- `plan(input, skills?, rules?, workspace?) -> ChatResult`：创建、维护和执行实施计划。
- `agent(input, apply=true, skills?, rules?, workspace?) -> AgentResult`：执行持续性任务。
- `apply(result) -> ApplyResult`：应用 `AgentResult` 中存在的补丁。
- `terminal(command, cwd=".", timeout_ms=120000) -> TerminalResult`：运行经确认的终端命令。
- `skill(skill, input, workspace?) -> ChatResult`：使用指定 Skill 执行任务。
- `mcp.<server>.<tool>(...)`：由 MCP 清单生成的类型化工具 API。
- `print(text, label?) -> PrintResult`：在 Dext 中展示结果。
- `ui.choose(...)`、`ui.confirm(...)`、`ui.input(...) -> UiResult`：请求用户选择、确认或输入。

上面的 `?` 表示可选参数，是文档记法。

项目 API 以 `.dx` 文件存放在 `.dext/api/` 中，目录会成为命名空间。例如 `.dext/api/workflow/feature.dx` 注册为 `workflow.feature`。全局 API 存放在 Dext 全局存储中，可供所有工作区使用；同名项目 API 优先。

项目 API 可以直接组合类型化 MCP、`agent` 和 UI 调用。例如，功能开发工作流可以先读取上下文、制定计划，经 `ui.confirm` 确认后实现，再确认并验证。通过声明可选的 `mcp_tool`、`mcp_input` 参数，也可以在首个 Agent 阶段前调用已注册的文本 MCP 工具。规则存放在 `.dext/rules/`，由各 Agent 阶段显式指定使用顺序。

UI API 返回结果后会继续执行工作流，不需要注册单独的回调。后续步骤需要结果时，先赋值：

```python
confirmation = ui.confirm(message="应用这次修改吗？")
if confirmation.confirmed == True:
    print(text="继续执行")
```

交互完成后，所选值、确认状态或输入文本也会出现在 Output 和 History 中。

所有 API 输出都实现统一的 `Result` 契约。Agent CLI 接收的前序结果是带版本号的 `dext-result` JSON 数据，而不是直接插入字符串。`agent_result: AgentResult`、`agent_result.patch: PatchResult` 等结果变量和字段支持补全及悬停说明。

`ask` 始终只读。`agent` 和 `plan` 使用输入区域选择的写入范围；在受信任的本地工作区中，`Workspace write` 将编辑限制在所选工作区。Dext 可以在自身管理的全局存储中保存计划文档。两者的 `workspace` 都默认为当前项目根目录。

```python
answer = ask(input="解释这段代码：")
result = agent(input="实现所需的修改")
```

`terminal` 仅适用于受信任的本地 `file` 工作区。`cwd` 必须位于工作区内，每条命令都需要 VS Code 弹窗确认，超时上限为 10 分钟，捕获的输出大小也有限制。返回状态为 `"succeeded"`、`"failed"` 或 `"timed_out"`；非零退出码会返回类型化的失败结果，拒绝确认则取消该工作流步骤并跳过后续步骤。

`print` 只在 Dext Output 中展示内容，不会写入集成终端。字符串和基本类型显示为文本，列表、字典及 API 结果显示为 JSON。

可用的上下文引用包括：

- `ref.selection`：当前编辑器选区。
- `ref.active_file`：当前活动编辑器的完整文件。
- `ref.file("path")`：工作区文件，也可以指定行列范围。
- `ref.dir("path")`：工作区内的目录引用，不读取或展开目录内容。
- `ref.symbol("name")`：通过 VS Code 工作区符号提供器查找声明及源码范围。

复制 VS Code 选区或选择文件、文件夹时，会在普通字符串中插入可读的 `@path` 引用。引用块可以整体删除，并支持撤销和重做。加载旧数据时，原有的标记、f-string 和嵌套引号引用形式会迁移为此形式。

选中工作区代码并短暂停顿后，活动光标附近会出现 **Add to Dext** 悬浮入口。浮层覆盖在编辑器上，不插入额外行、不挤动代码，也不会抢走键盘焦点；点击即可把该段代码的位置引用加入 Input。浮层的样式和位置由 VS Code 控制，可能与符号提示共用同一个浮层。在设置中切换 `dext.selectionActions.enabled` 可立即显示或隐藏该入口。正文、文件列表和文件标签的右键入口统一为 **Add to Dext**，不受选区入口开关影响。

在资源管理器、“打开的编辑器”列表、文件标签或没有文字选区的文件正文中按 Ctrl+C（macOS 为 Cmd+C），再到 Dext Input 按 Ctrl+V，即可插入原文件路径的引用。支持多文件和图片文件，不会生成附件。Ctrl+Shift+V 按原文粘贴路径。将 `dext.copyFilePathOnCopy` 设为 `false`，可恢复资源管理器原生的文件复制和编辑器的整行复制快捷键。

编辑器使用 CodeMirror 的 Python 语法能力提供高亮、缩进和括号匹配，Dext 在此基础上提供 API、关键字参数及结果字段补全、参数提示、悬停文档和编译诊断。

## 自定义 API 与 Skills

自定义 API 位于 `.dext/api/**/*.dx`，目录片段构成命名空间，每个文件通过 `main()` 导出一个 API：

```python
# .dext/api/team/analyze.dx -> team.analyze
from common import ask

def main(input: str) -> ChatResult:
    return ask(input=input)
```

`from playground import verify` 导入的是 `.dext/api/playground/verify.dx` 的 `main()` 入口，随后通过 `verify()` 调用。也支持 `from playground import verify as check` 这样的别名。被导入的 API 必须存在并成功加载。

较长的 API 可以拆成同文件内带类型声明的辅助函数：

```python
# .dext/api/playground/develop.dx
from playground import verify

def report(checked: TerminalResult) -> PrintResult:
    if checked.status != "succeeded":
        return print(text=checked.stderr, label="检查失败")
    return print(text=checked.stdout, label="检查通过")

def main() -> PrintResult:
    checked = verify()
    return report(checked=checked)
```

辅助函数可以放在 `main()` 前后，也可以调用其他辅助函数或已导入的 API。每次调用都有独立的参数和局部变量。参数必须声明类型，通过命名参数传入；有字面量默认值的参数可以省略。每个函数都要声明并返回 Dext 结果，例如 `ChatResult`、`AgentResult`、`TerminalResult` 或 `PrintResult`；目前不支持直接返回字符串、布尔值或列表，可通过 `return print(text=value)` 返回摘要或集合。

`if`、`try`、`except` 中均可提前 `return`；除取消执行外，返回前会先执行 `finally`。实际执行到函数末尾却没有返回时，会报告运行错误。只有 `main()` 对外导出，辅助函数不能被其他文件导入；递归调用、与 API 或导入名称冲突的辅助函数会被拒绝。`.dx` 编辑器提供辅助函数调用、参数及结果字段补全，以及签名和悬浮提示。

右键 Dext History 条目并选择 **Record Conversation as Dext Workflow**，可以从已有对话生成起始工作流：成功的轮次会转成步骤，重复提示词会成为 `main()` 参数，确认操作会转成 `ui.confirm`，Code 模式的轮次会保留为注释。文件写入 `.dext/api` 后自动打开，需要继续检查和调整。

Dext History 按 VS Code 工作区隔离。对话、收藏、名称和已打开的对话标签页会在重启后恢复，不会在不同项目之间共享。

History 子对话的悬浮操作栏和右键菜单依次提供重命名、分叉、复制 Markdown、从 Dext 删除四项操作。当前 CONVERSATION 的操作栏在这四项前面增加编辑输入和重试。History 父对话的悬浮按钮依次为继续、重命名、分叉、复制、收藏、归档、删除。共有操作的图标和相对顺序保持一致，删除始终在最后。子标题单独保存，不改变原始输入；清空名称可恢复默认标题。

删除一轮只移除 Dext 保存的输入与输出记录，不会删除 CLI 消息，也不会撤销文件修改；续接原 CLI 会话时，它仍可能使用已从 Dext 删除的内容。Dext 会保留 CLI 会话 ID，包括最后一轮被删除后留下的空对话，重启后仍可请求续接同一会话；能否成功续接取决于该会话是否仍可用。重试会在该对话中追加一次执行，可能再次执行写入操作。

`.dx` 使用显式导入：通过 `common` 导入内置 API，自定义导入则引用 `.dext/api` 文件。只有工作区被 VS Code 标记为受信任后，才会读取外部文件。

嵌套的 `agent(...)`、`ask(...)`、`plan(...)` 可以指定 `skills=["name"]` 和 `rules=["path.md"]`。规则路径仅在 `<workspace>/.dext/rules` 下解析。Dext 先加载所选 Skills，再按顺序加载规则，将内容注入 Agent 指令；这些参数也会出现在签名和补全中。

Skill 按以下顺序查找，同名时靠前的位置优先：

1. `<workspace>/.dext/skills`。
2. Dext 全局存储。
3. 用户配置的 `dext.skillDirs`。

`create` 可以在项目或全局范围创建 Skill。`skill` 的 `workspace` 默认为当前项目，并将所选 `SKILL.md` 注入当前 Agent 任务。`ui.*` 等待用户回答后继续同一个工作流。

类型化结果使用 Python 标准的 `TypedDict`、`Literal` 和 `NotRequired` 注解。`kind` 必须声明为单个 `Literal` 字符串，字段会转成 API 输出的 JSON Schema 和成员补全。目前不支持 TypedDict 继承、`Protocol` 或复杂泛型。

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```

## MCP API

MCP 清单位于 `<workspace>/.dext/mcp/*.jsonc` 或 Dext 全局存储中。每个文件声明一个服务器和显式工具白名单。启用的工具会成为 `mcp.<server>.<tool>(...)` API，支持补全、参数提示、必填参数校验和结构化结果字段补全。

同名时项目清单优先。`inputSchema` 必填；`outputSchema` 可选，用于为 MCP 的 `structuredContent` 提供类型信息。下面的命令名是示例，需要替换为实际安装的 MCP 服务器命令：

```jsonc
// .dext/mcp/docs.jsonc
{
  "name": "docs",
  "transport": "stdio",
  "command": "my-docs-mcp",
  "args": ["--stdio"],
  "tools": [{
    "name": "read",
    "description": "读取文档",
    "inputSchema": {
      "type": "object",
      "properties": { "uri": { "type": "string" } },
      "required": ["uri"]
    },
    "outputSchema": {
      "type": "object",
      "properties": { "content": { "type": "string" } },
      "required": ["content"]
    }
  }]
}
```

```python
document = mcp.docs.read(uri="README.md")
print(text=document.content)
```

如果 stdio MCP 从环境变量读取凭据，只需在清单中声明变量名，不要写入密钥：

```jsonc
{
  "name": "example-user-mcp",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "example-mcp"],
  "auth": { "type": "token", "env": "EXAMPLE_MCP_TOKEN" },
  "tools": []
}
```

MCP 调用需要受信任的本地工作区，支持本地 `stdio` 和 Streamable HTTP。HTTP 端点必须使用 HTTPS；本地开发可使用回环地址上的 HTTP。不接受 URL 中的用户信息、查询字符串、片段，以及清单中的内联请求头或凭据。

通过 **Dext: Set MCP Access Token** 保存令牌。HTTP 服务器使用 bearer 令牌；stdio 服务器声明 `auth: {"type":"token","env":"ENV_NAME"}` 后，Dext 会将 SecretStorage 中的令牌注入子进程对应的环境变量。令牌按服务器和清单范围区分：项目令牌属于当前工作区，全局令牌使用全局范围。不要把凭据放进清单或 stdio 参数。

**Dext: Clear MCP Access Token** 删除所选凭据；**Dext: Verify MCP Server** 执行带认证的 HTTP 初始化检查。编辑、新建或删除清单后，对应 API 会自动重新加载。

## Agent 配置

Agent 配置保存在 VS Code 扩展全局存储中。输入区域根据后端能力提供 Agent、Model、Reasoning 和 Speed 选项。Codex 配置优先读取本地模型缓存中的模型、推理级别和速度选项；Claude Code 使用 `opus` / `sonnet` 别名及已配置的推理级别。

`.dx` 文件可以通过 `@api(agent="codex", model="...")` 覆盖 Agent 和模型，否则使用输入区域的选择。**Dext: Configure Agent** 用于编辑可执行命令和自定义模型名称，不处理登录凭据。

内置的 `agent`、`ask`、`plan`、`skill`、`create` 还支持单次调用的 `cli` 和 `model` 参数：

- `cli` 为 `"codex"` 或 `"claude"`。
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

`dext.agentCli` 控制输入区域显示哪些内置 Agent，默认是 `codex` 和 `claude`。可以编辑列表，选择显示其中哪些配置。

内置 API 始终可用。自定义 API 通过显式 `import` 或 `from ... import ...` 进入作用域，补全、悬停、参数提示和编译使用相同的导入范围。

## 行内补全

行内补全使用独立于 Agent 的后端。点击 Dext 状态栏项目，或执行 **Dext: Configure Completion Model**，依次配置 API 格式、基础 URL、模型 ID 和密钥，并可发送一次真实请求验证连接。

API 密钥保存在 VS Code 的加密 SecretStorage 中，不会写入设置；其余选项保存到用户设置的 `dext.completion`，配置一次即可在不同项目使用。

支持四种请求格式，需要与服务端接口匹配：

| 格式 | 请求方式 |
| --- | --- |
| `openai` | 向兼容的 `/completions` 端点发送 `prompt` 和 `suffix`，需要模型及端点支持中间填充（FIM）。 |
| `openai-chat` | 向 `/chat/completions` 发送包含光标前后代码的聊天提示词。 |
| `anthropic` | 向 `/messages` 发送聊天式补全请求。 |
| `ollama` | 通过 `/api/generate` 调用本地 Ollama，使用其 FIM 字段，无需密钥。 |

延迟和质量取决于模型及端点。Dext 会移除聊天响应中的代码围栏。格式不匹配时，服务端可能返回 HTTP 200 却没有可用的补全文本；Dext 会在连接测试和补全请求中报告可识别的格式错误。

只有端点和模型都配置后，补全才会启用。新请求会经过防抖；后续输入与正在生成的内容一致时，可以复用同一次生成。上下文按光标前后的字符数截取，避免单条长代码行耗尽预算。

补全通过流式响应提供内容，并在确定补全已经结束时提前停止请求。在行中间或注释等不适合插入多行的位置，会要求模型在换行处停止。用户输入与已有建议前缀一致时，可从缓存继续提供剩余内容；输入发生偏离时才放弃原生成。

前缀窗口按一定粒度调整并对齐到行边界，以保持相邻输入间的提示词前缀稳定，便于支持提示词缓存的后端复用。

遇到 HTTP 429 时，Dext 会自动增加请求间隔；限流持续时继续退避，恢复后逐步缩短间隔，并优先遵守服务端的 `Retry-After`。如果需要减少首次触发限流的概率，可以调高 `dext.completion.debounceMs`。

建议被截断时，可以增大 `dext.completion.maxTokens`，但可能增加延迟。默认跳过 `.gitignore` 排除的文件，工作区根目录的 `.dextignore` 会追加规则，也可以重新包含被排除的路径。`.dx` 文件使用类型化 API 补全。状态栏开关仅关闭当前窗口的行内补全，不修改持久设置，便于与其他补全扩展一起使用。

## 架构

- `src/core/workflow.ts`：遍历 Lezer Python 语法树，限制语法、检查类型并生成诊断。
- `src/core/workflowRuntime.ts`：顺序执行、结果组合和分支状态管理。
- `src/core/languageService.ts`：Dext 补全、悬停、参数提示和诊断。
- `src/core/contextResolver.ts`：不可变上下文快照。
- `src/core/axAdapter.ts`：Ax / Zod / JSON Schema 契约适配。
- `src/core/runtime.ts`：确定性执行器白名单。
- `src/core/customApi.ts`：`.dx` API 加载、导入、签名和自定义计划。
- `src/core/agentRunner.ts`：Codex / Claude CLI 的结构化执行适配。
- `src/core/completionProvider.ts`：FIM 补全后端、缓存和密钥管理。
- `src/core/workflowRecorder.ts`：从对话生成 `.dx` 工作流骨架。
- `src/webview/codeEditor.ts`：基于 CodeMirror 的 Python 语法编辑器。

## 开发

使用 `package.json` 中 `volta` 固定的 Node.js 版本（目前为 **22.23.2**）以及 VS Code 1.105 或更新版本。

```bash
git clone https://github.com/blooddot/dext.git
cd dext
npm ci
npm run check
```

执行 `npm run test:host` 运行 VS Code 扩展激活和侧栏冒烟测试。VS Code 安装路径非标准时，可设置 `VSCODE_EXECUTABLE_PATH`；设置 `DEXT_TEST_DOWNLOAD=1` 则使用单独下载的测试版本。

在 VS Code 中按 **F5**，选择 **Run Dext Extension**，即可启动扩展开发宿主。修改打包代码时，可以运行 `npm run watch` 持续构建。

## 打包与发布

```bash
npm run package
```

此命令先执行 lint、类型检查、单元测试、构建和 Webview 资源检查，再生成 `release/dext-<版本号>.vsix`。版本号来自 `package.json`。

`release/` 会自动创建，已被 Git 忽略，也不会包含在 VSIX 中。不同版本的安装包会保留；重新打包同一版本会覆盖对应文件。例如 `0.1.0` 的输出为 `release/dext-0.1.0.vsix`。

发布到 GitHub 的步骤：

1. 更新 `package.json`、`package-lock.json` 中的版本，并在 [CHANGELOG.md](CHANGELOG.md) 中填写版本说明。
2. 运行 `npm run package`，安装生成的 VSIX，检查主要使用流程。
3. 提交源码修改，创建与版本对应的 Git 标签，例如 `v0.1.0`。
4. 推送提交和标签，为该标签创建 GitHub Release，并上传 `release/` 中对应的 VSIX 作为附件。

每个已发布安装包保存在对应的 Release 中，方便查找历史版本。`npm run package` 只生成本地安装包，不会自动上传或发布。

## 反馈与许可证

通过 [GitHub Issues](https://github.com/blooddot/dext/issues) 反馈问题或提出功能建议。请提供 Dext 和 VS Code 版本、复现步骤，以及移除凭据后的相关日志。

Dext 采用 [PolyForm Perimeter License 1.0.1](LICENSE)，并可另行协商商业授权。在遵守许可证的前提下，允许日常使用，包括企业内部使用。利用 Dext 向他人提供竞争性产品或服务，需要另行授权，即使该产品或服务免费提供。

授权范围与申请方式见[商业授权说明](COMMERCIAL-LICENSING.md)。本项目属于源码可见软件，不采用 OSI 认可的开源许可证。第三方组件继续遵循各自许可证。版本记录见 [CHANGELOG.md](CHANGELOG.md)。
