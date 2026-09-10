# 工作流与 API 参考

[English](workflows.md) | 简体中文

[返回 README](../README.zh-CN.md)

在 Code 模式中组合调用，再将重复流程保存为项目 API。本文包含语法、内置 API、代码引用、自定义 API、Skills 和对话历史的详细说明。

[工作流语言](#工作流语言) · [内置 API](#内置-api) · [文件与选区引用](#文件与选区引用) · [自定义 API 与 Skills](#自定义-api-与-skills) · [对话历史与工作流录制](#对话历史与工作流录制) · [导入、Skills 与规则](#导入skills-与规则) · [自定义结果类型](#自定义结果类型) · [执行与预览](#执行与预览)

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
- `while` 顺序重试循环；最多执行 100 次。循环中新建变量不会泄漏到外部，已有变量可在保持相同类型的前提下更新。
- `[call(...) for name in list]` 列表推导式；这是支持并发执行的结构，各分支互不可见，并发上限由 `dext.workflow.maxConcurrency` 控制，结果保持输入顺序。仅支持一个 `for` 子句，不支持 `if` 过滤。
- `try` / `except` 和可选的 `finally`；某一步失败后可以进入处理分支并继续工作流。`except Exception as name:` 将错误消息绑定为仅在处理分支内可见的字符串。不支持按具体异常类型区分处理，用户停止执行也不会被捕获。

`.dx` API 文件还支持带类型声明的 `main()` 入口、同文件内带类型声明的辅助函数、显式导入和有上限的 `while` 重试循环。辅助函数仅在当前文件可见；不支持嵌套定义或递归调用。输入工作流不支持自定义函数或类、无限制的重复赋值、`eval`、`exec` 或任意系统、文件、网络 API；相关操作需通过 Dext 提供的 API 完成。循环仅可更新同类型的已有变量。除列表推导式外，执行按顺序进行；未选中的步骤及因上游失败未执行的后续步骤会标记为 `skipped`。

`ask` 和 `agent` 接受普通字符串。文件选区和附件会以可读的 `@workspace/path#Lstart,end-Lend,end` 标记插入；编辑器、Output 和 History 将其显示为引用块，复制和执行时保留可读标记。Dext 不把文件内容直接展开进提示词。

## 内置 API

- 通过侧栏的“Create resource”按钮创建 API、MCP 配置、规则和 Skill；它会保持专用创建对话、预览生成文件，并在确认后写入。
- `ask(input, skills?, rules?, workspace?) -> AskResult`：只读解释和分析。
- `plan(input, skills?, rules?, workspace?) -> PlanResult`：创建、维护和执行实施计划。
- `agent(input, apply=true, skills?, rules?, workspace?) -> AgentResult`：执行持续性任务。
- `apply(result) -> ApplyResult`：应用 `AgentResult` 中存在的补丁。
- `terminal(command, cwd=".", env={}, timeout_ms=120000) -> TerminalResult`：在平台 Shell 中运行任意终端命令；`env` 可传入仅对此命令有效的字符串环境变量。
- `skill(skill, input, workspace?) -> SkillResult`：使用指定 Skill 执行任务。
- `mcp.<server>.<tool>(...)`：由 MCP 清单生成的类型化工具 API。
- `print(text, label?) -> PrintResult`：在 Dext 中展示结果。

顶级内置 API 仅限上述列表。交互能力位于 `ui.*`；确认框或表单可传
`on_cancel="abort"`，在用户取消时终止当前自定义 API，无需额外的
`workflow.*` 控制 API。Node 标准库能力仅通过白名单 `node.*` 提供：
`node.url`、`node.path`、`node.querystring`、可安全映射的 `node.util`、
受工作区边界限制的 `node.fs` 与 `node.http.request`。函数名保持 Node
原生 camelCase。文件和 HTTP 调用需要受信任工作区；命令仍使用 `terminal`。

`node:crypto`、`node:zlib`、`node:timers/promises` 与包含环境信息的
`node:os` 仅作为后续候选模块记录，当前不能调用。原始进程、socket、流、
worker、VM、模块加载和 HTTP 服务监听能力不向 `.dx` 开放。
- UI 交互：`ui.select`、`ui.radio`、`ui.checkbox`、`ui.input`、`ui.confirm`、`ui.alert`、`ui.form`。

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

## 文件与选区引用

可用的上下文引用包括：

- `ref.selection`：当前编辑器选区。
- `ref.active_file`：当前活动编辑器的完整文件。
- `ref.file("path")`：工作区文件，也可以指定行列范围。
- `ref.dir("path")`：工作区内的目录引用，不读取或展开目录内容。
- `ref.symbol("name")`：通过 VS Code 工作区符号提供器查找声明及源码范围。

复制 VS Code 选区或选择文件、文件夹时，会在普通字符串中插入可读的 `@path` 引用。引用块可以整体删除，并支持撤销和重做。加载旧数据时，原有的标记、f-string 和嵌套引号引用形式会迁移为此形式。

选中工作区代码并短暂停顿后，活动光标附近会出现 **Add to Dext** 悬浮入口。浮层覆盖在编辑器上，不插入额外行、不挤动代码，也不会抢走键盘焦点；点击即可把该段代码的位置引用加入 Input。浮层的样式和位置由 VS Code 控制，可能与符号提示共用同一个浮层。在设置中切换 `dext.selectionActions.enabled` 可立即显示或隐藏该入口。正文、文件列表和文件标签的右键入口统一为 **Add to Dext**，不受选区入口开关影响。

在资源管理器、“打开的编辑器”列表、文件标签或没有文字选区的文件正文中按 Ctrl+C（macOS 为 Cmd+C），再到 Dext Input 按 Ctrl+V，即可插入原文件路径的引用。支持多文件和图片文件，不会生成附件。编辑器悬浮提示显示时，Ctrl+C 保留 VS Code 原本的内容复制行为。Ctrl+Shift+V 按原文粘贴路径。将 `dext.copyFilePathOnCopy` 设为 `false`，可恢复资源管理器原生的文件复制和编辑器的整行复制快捷键。

编辑器使用 CodeMirror 的 Python 语法能力提供高亮、缩进和括号匹配，Dext 在此基础上提供 API、关键字参数及结果字段补全、参数提示、悬停文档和编译诊断。

## 自定义 API 与 Skills

自定义 API 位于 `.dext/api/**/*.dx`，目录片段构成命名空间，每个文件通过 `main()` 导出一个 API。Code 输入区可以直接调用 `playground.verify()`，也可以导入后调用 `verify()`；`.dx` 文件中的自定义 API 调用需要显式导入。两种调用形式都支持补全、参数提示和悬停说明。

例如：

```python
# .dext/api/team/analyze.dx -> team.analyze
from common import ask

def main(input: str) -> AskResult:
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

辅助函数可以放在 `main()` 前后，也可以调用其他辅助函数或已导入的 API。每次调用都有独立的参数和局部变量。参数必须声明类型，通过命名参数传入；有字面量默认值的参数可以省略。每个函数都要声明并返回 Dext 结果，例如 `AskResult`、`PlanResult`、`SkillResult`、`AgentResult`、`TerminalResult` 或 `PrintResult`；目前不支持直接返回字符串、布尔值或列表，可通过 `return print(text=value)` 返回摘要或集合。

`if`、`try`、`except` 中均可提前 `return`；除取消执行外，返回前会先执行 `finally`。实际执行到函数末尾却没有返回时，会报告运行错误。只有 `main()` 对外导出，辅助函数不能被其他文件导入；递归调用、与 API 或导入名称冲突的辅助函数会被拒绝。`.dx` 编辑器提供辅助函数调用、参数及结果字段补全，以及签名和悬浮提示。

## 对话历史与工作流录制

右键 Dext History 条目并选择 **Record Conversation as Dext Workflow**，可以从已有对话生成起始工作流：成功的轮次会转成步骤，重复提示词会成为 `main()` 参数，确认操作会转成 `ui.confirm`，Code 模式的轮次会保留为注释。文件写入 `.dext/api` 后自动打开，需要继续检查和调整。

Dext History 按 VS Code 工作区隔离。对话、收藏、名称和已打开的对话标签页会在重启后恢复，不会在不同项目之间共享。

History 子对话的悬浮操作栏和右键菜单依次提供重命名、分叉、复制 Markdown、从 Dext 删除四项操作。当前 CONVERSATION 的操作栏在这四项前面增加编辑输入和重试。History 父对话的悬浮按钮依次为继续、重命名、分叉、复制、收藏、归档、删除。共有操作的图标和相对顺序保持一致，删除始终在最后。子标题单独保存，不改变原始输入；清空名称可恢复默认标题。

删除一轮只移除 Dext 保存的输入与输出记录，不会删除 CLI 消息，也不会撤销文件修改；续接原 CLI 会话时，它仍可能使用已从 Dext 删除的内容。Dext 会保留 CLI 会话 ID，包括最后一轮被删除后留下的空对话，重启后仍可请求续接同一会话；能否成功续接取决于该会话是否仍可用。重试会在该对话中追加一次执行，可能再次执行写入操作。

## 导入、Skills 与规则

`.dx` 使用显式导入：通过 `common` 导入内置 API，自定义导入则引用 `.dext/api` 文件。只有工作区被 VS Code 标记为受信任后，才会读取外部文件。

嵌套的 `agent(...)`、`ask(...)`、`plan(...)` 可以指定 `skills=["name"]` 和 `rules=["path.md"]`。规则路径仅在 `<workspace>/.dext/rules` 下解析。Dext 先加载所选 Skills，再按顺序加载规则，将内容注入 Agent 指令；这些参数也会出现在签名和补全中。

Skill 按以下顺序查找，同名时靠前的位置优先：

1. `<workspace>/.dext/skills`。
2. Dext 全局存储。
3. 用户配置的 `dext.skillDirs`。

`create` 可以在项目或全局范围创建 Skill。`skill` 的 `workspace` 默认为当前项目，并将所选 `SKILL.md` 注入当前 Agent 任务。`ui.*` 等待用户回答后继续同一个工作流。

## 自定义结果类型

类型化结果使用 Python 标准的 `TypedDict`、`Literal` 和 `NotRequired` 注解。`kind` 必须声明为单个 `Literal` 字符串，字段会转成 API 输出的 JSON Schema 和成员补全。目前不支持 TypedDict 继承、`Protocol` 或复杂泛型。

```python
from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]
```

## 执行与预览

没有配置 Agent 时，Dext 可以校验工作流结构、解析不可变的代码引用，并生成类型化的确定性结果预览。选择 Agent 配置后，相同的类型化 API 契约会交给对应 CLI 执行，其结构化输出会在展示前校验。预览不代表 AI 已执行任务。

## UI 交互与表单

所有 UI API 都等待用户回答，每次调用只记录一个工作流步骤。`presentation="inline"` 在所属对话的 Process 上方展示卡片，`"dialog"` 使用弹窗。等待只暂停所属工作流，停止任务会中断等待并跳过后续步骤。

```text
ui.select(label, options, multiple=False, placeholder="Select…", presentation="dialog")
ui.radio(label, options, allow_custom=False, custom_placeholder="", presentation="dialog")
ui.checkbox(label, options, allow_custom=False, custom_placeholder="", presentation="dialog")
ui.input(label, placeholder="", multiline=False, presentation="dialog")
ui.confirm(message, confirm_label="Continue", cancel_label="Cancel", presentation="dialog")
ui.alert(message, acknowledge_label="OK", presentation="dialog")
ui.form(title, fields, description="", submit_label="Submit", cancel_label="Cancel", show_cancel=True, presentation="inline")
```

| API / 字段 | 控件 | 返回内容 |
| --- | --- | --- |
| `ui.select` / `select` | 折叠式单选或多选下拉框 | `type="select"`、`selected` 数组 |
| `ui.radio` / `radio` | 展开的互斥单选组 | `type="radio"`、`selected` 和可选 `custom` |
| `ui.checkbox` / `checkbox` | 展开的独立复选框组 | `type="checkbox"`、`selected` 和可选 `custom` |
| `ui.input` / `input` | 单行或多行文本 | `type="input"`、字符串 `value` |
| `ui.confirm` | 确认、取消按钮 | `type="confirm"`、布尔值 `confirmed` |
| `ui.alert` | 阅读信息后关闭 | `type="alert"`、`status="acknowledged"` 或 `"dismissed"` |
| `ui.form` | 整组字段统一提交 | `type="form"`、`status="submitted"` 或 `"cancelled"`、按字段 ID 保存的 `answers` |

API 结果带有 `kind="ui"`。`answers` 中的字段答案只包含 `type` 及对应值。字段描述仅为数据，可以保存到变量复用；不要在 `fields` 中调用交互 API。

```python
fields = [
    {"id": "environment", "type": "select", "label": "Environment", "options": [
        {"value": "dev", "label": "Development", "description": "Local environment"},
        {"value": "test", "label": "Testing"}
    ]},
    {"id": "approach", "type": "radio", "label": "Approach", "options": ["inspect", "change"], "allow_custom": True},
    {"id": "checks", "type": "checkbox", "label": "Checks", "options": ["types", "tests", "build"], "required": False},
    {"id": "details", "type": "input", "label": "Details", "multiline": True, "required": False},
    {"id": "run_tests", "type": "radio", "label": "Run tests?", "options": [
        {"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}
    ]}
]
reply = ui.form(title="Settings", fields=fields, submit_label="Apply settings")
if reply.status == "submitted":
    if reply.answers["run_tests"].selected[0] == "yes":
        print(text="Run the selected checks")
```

字段具有唯一 `id`、`label`、可选 `description`、`required`（默认 `True`）和 `default`。表单未配置默认值时不预选。选择字段的默认值为选项值数组，输入默认值为字符串，均须通过字段校验。选项使用非空字符串列表或 `{value, label, description?}` 对象，稳定值是唯一字符串；字符串选项的值等于自身。

只有 `select` 支持 `multiple`，`radio`、`checkbox` 不接受该参数。下拉不支持自定义文本；单选的自定义答案与预设选项互斥，复选框允许两者同时提交。必填选择字段至少有一个选择或有效自定义答案。输入按裁剪后的文本判断是否为空，提交时保留原文。可选且为空的字段不进入答案映射。

是／否问题使用普通 radio，`selected=["no"]` 是正常提交的答案，不等于取消，也不自动转换为布尔值；后续分支应显式比较字符串。

选择快捷 API 接受字符串选项列表：`ui.radio` 默认选中首项，`ui.checkbox` 默认不选且允许空提交，`ui.select` 初始显示占位提示且提交前必须选择。对象选项、默认值、必填配置使用 `ui.form`。`ui.input` 提交空字符串时保留 `value=""`，取消时省略 `value`。选择快捷入口取消时返回对应类型和 `selected=[]`，不返回自定义草稿；需要区分取消与主动空提交时使用 `ui.form`。

取消或关闭表单返回 `status="cancelled", answers={}`；空字段表单提交返回 `status="submitted", answers={}`。`fields=[]` 可表达纯确认或告知。`show_cancel=False` 只隐藏取消按钮，仍可关闭交互或停止任务。确认关闭返回 `confirmed=False`；告知主按钮返回已读，关闭按钮或 Esc 返回已关闭，点击遮罩不会关闭告知。已读不代表授权后续操作。

Esc 先关闭下拉弹层，再关闭外层容器。单选支持方向键，复选框支持 Space，弹窗关闭后恢复焦点。宿主执行仍存活时，切换对话或重建 Webview 可恢复请求及非秘密草稿。完成后的交互显示只读摘要，宿主重启后的历史请求显示为已关闭。

工作流与 Agent 共用控件。Agent 仍按每题一个答案回传，保留异步回答、跳过及秘密输入语义；秘密输入提交后清空，不写入草稿或历史。公共字段不开放密码输入。

限制为每张表单 32 个字段、每字段 200 个选项、标签和选项值最多 2,000 字符、文本最多 20,000 字符，表单和答案各最多 200,000 UTF-8 字节。不支持的类型或属性、重复 ID、重复选项值、重复选择、与原始请求不符的答案均被拒绝。未知历史结果通过有大小限制、转义后的文本或 JSON 只读展示，不能恢复执行。搜索、远程选项、自由创建、虚拟列表、条件字段和嵌套分组不在本版范围；普通输出使用 `print`，进度使用 Process/Todo。
