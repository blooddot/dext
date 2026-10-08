# 工作流与 API 参考

[English](workflows.md) | 简体中文

[返回 README](../README.zh-CN.md)

在 Code 模式中组合调用，再将重复流程保存为项目 API。本文包含 Code 轮次运行的 TypeScript 模块、内置 API、代码引用、自定义 API、Skills 和对话历史的详细说明。

[工作流语言](#工作流语言) · [内置 API](#内置-api) · [模板](#模板) · [文件与选区引用](#文件与选区引用) · [自定义 API 与 Skills](#自定义-api-与-skills) · [对话历史与工作流录制](#对话历史与工作流录制) · [导入、Skills 与规则](#导入skills-与规则) · [自定义结果类型](#自定义结果类型) · [执行与预览](#执行与预览)

## 工作流语言

Input 使用 Monaco，Code 模式入口和底部工具栏保持原位。Code 中 Enter 换行，Ctrl/Cmd+Enter 执行；聊天模式沿用发送设置，Shift+Enter 换行。补全列表打开时 Enter 接受建议。

补全、悬浮说明、参数提示和诊断由 Monaco 的 TypeScript 服务提供，且**只在 Code 模式**生效:Agent、Chat、Plan 模式编辑的是纯文本,输入提示词不会出现任何 TypeScript 符号建议。在 Code 模式下,输入调用触发字符可显示参数提示,Esc 关闭提示,Ctrl/Cmd+Shift+Space 手动唤起。F12 或 Ctrl/Cmd+点击跳转到生成的 `dext` 声明。输入区按当前 VS Code 主题着色——颜色和斜体/粗体都照搬,标识符与括号标点同样着色;对话里 Code 轮次的源码也由同一套语法与主题着色,因此记录看起来就和当初输入的一致。Agent、Chat、Plan 的提示词在对话里同样保持纯文本。

文件与图片标签可整体选择、删除及撤销，复制、保存草稿和执行时保留完整 `@path`。标签过长会缩短显示，可悬浮查看完整路径；光标在标签旁时 Alt+Enter 打开引用，Ctrl/Cmd+Shift+V 粘贴原文。引用是整体对象，修改路径时删除后重新插入；原生查找针对普通编辑文本，不搜索标签内隐藏的完整路径。

在 Code 模式中，自然语言需要写在 API 的字符串参数中；无法通过 TypeScript 编译的普通文本会产生编译错误。

```ts
import { agent, apply, ask } from "dext";

const analysis = await ask({ input: "解释这段实现，并提出重构要求：" });

const preview = await agent({
  input: "实现所需的重构",
  apply: false,
});

// 只以文本汇报结论，不产出补丁。
const summary = await agent({
  input: "总结重构方案",
  apply: false,
  patch: false,
});

if (preview.patch) {
  const applied = await apply({ result: preview });
}
```

一个 Code 轮次就是普通的 ES 模块。完整 TypeScript 语言都可用：变量、函数、类、`if`/`for`/`while`、`try`/`catch`、`async`/`await`、标准库，以及工作区能解析的任意 Node 内置模块或 npm 包。入口文件按 ESM 导入，因此顶层 `await` 可用。

Dext 把文件放在每个工作区一个长期存活的 Node 子进程中运行；在 VS Code 内该进程由 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 启动。每次运行都会用新的 generation 重新注册模块加载器，因此工作区模块都会重新求值，模块级状态不会在运行之间泄漏。取消轮次会终止内核，下次运行会启动新的内核；用户代码崩溃不会影响扩展宿主。一次运行可以并发调用 Dext API（例如使用 `Promise.all`），`dext.workflow.maxConcurrency`（默认 4，最大 16）限制同时在途的调用数，超出的调用排队等待。

不再有独立的工作流语言，也没有需要学习的解释器。旧 Python 风格 `.dx` 语言的文件不会被读取：可用 `node scripts/migrateDxToTs.mjs <file.dx>` 迁移，它会改写能确定的部分，并报告需要人工完成的部分。

一次运行只要还在等待 Dext API 就不算结束。没有写 `await` 的调用（`commit()` 而不是 `await commit()`）同样会让轮次保持开启，直到它返回；它失败则整次运行失败——这样调用启动的 agent 不会在面板已经停止更新之后还在后台继续跑。运行不会为此报告任何东西：没有 await 的调用就是普通 TypeScript，类型上本来就写着它返回的是 promise。需要读取结果就写 `await`。

### 文本与取值表达式

表达式就是普通 TypeScript。Dext 不参与求值：整个模块由内核执行，因此任何 JavaScript 表达式的行为都和在 Node 中完全一致。

| 形式 | 示例 | 说明 |
| --- | --- | --- |
| 模板字符串 | `` `${answer.text} (${checked.exit_code})` `` | 可插入任意表达式 |
| 字符串拼接与数值运算 | `"Review: " + text`、`2 + 3 * 4`、`7 / 2`、`2 ** 8` | `7 / 2` 为 `3.5`；整除请用 `Math.floor(7 / 2)` |
| 数组与对象 | `["a", "b"]`、`{ id, label }` | 字面量、展开和解构都正常可用 |
| 索引与切片 | `text[0]`、`text.slice(1, 4)`、`[...text].reverse()` | `slice` 的结束下标不包含在内；字符串不可变 |
| 成员判断与查找 | `text.includes("done")`、`list.indexOf(value)`、`"key" in record` | 按值自身支持的方法使用 |
| 相等比较 | `a === b`、`a !== b` | 严格相等；`==` 会做类型转换 |
| 大小与逻辑运算 | `a < b`、`a && b`、`a \|\| b`、`!a`、`a ?? b` | 操作数遵循 JavaScript 常规规则 |
| 可选链 | `result.patch?.title ?? ""` | 值存在时才读取字段 |

`Math`、`JSON`、`Number`、`String`、`Array`、`Object`、`Date` 都是标准内置对象，Dext 不再维护自己的字符串方法或纯函数清单。旧语言的部分写法没有直接对应：f-string 和 `%` 格式化改用模板字符串，`//` 改用 `Math.floor`，元组改用数组，`int(value)` / `float(value)` 改用 `Number(value)`。

普通赋值不是工作流步骤。Output 中每次 Dext API 调用对应一个步骤；`console.log`、`console.error` 会额外产生进程输出步骤，只携带文本，没有调用信息，也没有耗时。

旧解释器的资源上限（`while` 迭代次数、`range` 大小、折叠元素数量、导入深度）随解释器一起移除，改用 Node 和 TypeScript 自身的限制。

## 内置 API

- 点击侧栏的 **Create resource**，打开复用 Conversation 和 Input 布局的专用 Tab。底部选择 **API / MCP / Rule / Skill** 和 **Project / Global**（菜单显示保存目录）。可以选择 **New resource** 新建，或选择已有资源描述修改；预览草稿或差异后保存。保存后保留 Tab，方便继续修改；更改已有资源的保存位置表示另存一份。资源目标、草稿和对话会随历史记录恢复。
- `ask({ input, workspace?, cli?, model? }) -> AskResult`：只读解释和分析。
- `plan({ input, workspace?, cli?, model? }) -> PlanResult`：创建、维护和执行实施计划。
- `agent({ input, apply=true, patch=true, workspace?, cli?, model? }) -> AgentResult`：执行持续性任务；`patch=false` 时只以 text 汇报结论，不产出补丁。
- `template({ input, source, values={}, workspace?, cli?, model? }) -> TemplateResult`：按模板文件渲染文本（见[模板](#模板)）。
- `apply({ result }) -> ApplyResult`：应用 `AgentResult` 中存在的补丁。
- `terminal({ command, cwd=".", env={}, timeout_ms=120000 }) -> TerminalResult`：在平台 Shell 中运行任意终端命令；`env` 可传入仅对此命令有效的字符串环境变量。
- `skill({ skill, input, workspace?, cli?, model? }) -> SkillResult`：使用指定 Skill 执行任务。
- `mcp.<server>.<tool>({...})`：调用已配置的 MCP 工具。
- `ui.select | ui.radio | ui.checkbox | ui.input | ui.confirm | ui.alert | ui.form`：见 [UI 交互与表单](#ui-交互与表单)。

它们都是 `dext` 模块的导出：

```ts
import { ask, agent, ui } from "dext";
```

每次调用只接收一个命名参数对象，返回可 JSON 序列化的 Promise 值。`cli`、`model`、`reasoning`、`speed` 仍可逐次覆盖：

```ts
const answer = await ask({ input: "解释这段代码", cli: "claude", model: "sonnet" });
```

Node 内置模块和工作区依赖可以直接使用，因为代码运行在真正的 Node 进程中：`import fs from "node:fs/promises"`、`import path from "node:path"` 与在任何其他 Node 程序里完全一致。没有能力闸门，也没有 `node.*` 或 `js.*` 命名空间：内核中由模型编写的代码拥有用户的完整权限。`terminal` 和 `apply` 不再有确认弹窗；现有的工作区信任检查仍然存在，但已不再是安全边界。

**Dext: View APIs** 在可调用 API 之外，还列出只读的 **node** 与 **js** 参考：每个 Node 内置模块一条（`node:fs/promises`、`node:path`、`node:url`…），Node 或 ECMAScript 提供的每个全局量一条（`process`、`Buffer`、`fetch`、`setTimeout`、`JSON`、`Array`、`Intl`…）。这份参考直接由声明文件生成——`@types/node` 与 TypeScript 自带的 `lib.es*.d.ts`——因此每个签名都是编辑器与内核真正解析到的那个签名，每段说明都是声明里原本的 JSDoc，没有任何说明是手写的。打开条目会列出它的全部成员及其签名、参数、返回值和文档，模块名一行的 **Copy** 按钮会复制精确的模块标识符。这些条目说明的是代码可以 `import` 或作为全局量读取的内容；它们不是 Dext API，因此没有 Insert reference 操作，也不能以 `node.*` 或 `js.*` 的形式调用。

`print` 已移除。`console.log(...)`、`console.error(...)` 会被捕获为进程输出步骤并转发到真实输出流，但它们不是 Dext 结果：没有调用信息，也没有耗时。需要类型化结果时请返回值或调用 API。

跨 Dext API 边界的值必须可 JSON 序列化，因为内核与扩展宿主之间通过 JSON 通信。函数、Symbol、`Map`、`Set`、`Buffer`、类型化数组、类实例（除非实现了 `toJSON()`）和循环引用都无法传递，`Date` 会转换为 ISO 字符串。报错会指出具体路径和替代写法：`{ createdAt: new Date() }` 会变成 ISO 字符串，而 `{ cache: new Map() }` 会在 `cache` 处报错。用户代码内部可以使用任意值——只有交给 Dext API 的值、以及 API 模块返回的值会被检查。

### 模板

rules 只能"请求"模型遵守模板，模型一旦漂移，输出结构就跟着变。`template` 消除了这一点：模型只填模板声明的字段，标题层级、章节顺序和列表符号都由 Dext 依据模板文件渲染。模型因此无法新增、改名、重排或删除章节。

模板是带 YAML front matter 的文本文件：必须声明 `format`，再逐字段声明，正文用 `{{字段}}` 占位。字段可以只写一句说明，也可以写成映射：

```markdown
---
dext-template:
  format: markdown
  number: 四位数字编号，例如 "0081"
  title: 简短标题，体现决策内容
  status:
    type: enum
    values: [accepted, rejected, deprecated]
    description: 决策状态
  positive:
    type: lines
    description: 正面后果，每条一行
  sources:
    type: lines
    optional: true
    description: 外部来源；纯项目决策留空
---

# ADR-{{number}}: {{title}}

## 状态

{{status}}

## 后果

### 正面

- {{positive}}

## 参考资料

- {{sources}}
```

- `format` 必填，取 `markdown`、`text`、`json`、`toml` 或 `yaml`，属于模板而不是调用参数。它在读取模板时就被解析，所以写错或漏写会在这里直接报错，而不是靠文件名去猜。markdown 才启用下面那套章节规则，其余格式按字面渲染。`json`、`toml`、`yaml` 会在渲染后再解析一次，因此渲染结果不是合法文档的答案会被拒绝，并带着解析器自己的报错再问一次。`format` 是保留名，字段不能占用。
- `type` 取 `string`（默认）、`lines` 或 `enum`。`enum` 必须给出 `values`，取值按此校验。
- `lines` 字段是换行分隔的列表。每个条目重复占位符所在的那一行，所以模板里的 `- ` 前缀就是列表符号；模型多加的列表符号只在 markdown 模板里会被去掉，其他格式里它属于值本身。`separator` 插在这些重复行**之间**，缩进仍由占位符所在行自带，所以 JSON 数组写 `separator: ",\n"`，行末不要再写逗号。
- `optional: true` 允许字段为空：占位符所在行消失；若该章节因此没有内容（markdown 模板），标题也一并消失——上面 `sources` 就是这样在纯项目决策里整节不出现。
- 声明的字段必须都在正文出现，正文的占位符也必须都已声明，不一致会在读取模板时直接报错。
- `values` 固定由 Dext 掌握字段：这些字段不会出现在模型契约里，且始终覆盖模型返回值，因此编号、模块名这类事实不会交给模型决定。取值同样按模板校验。
- 调用只返回 `text`，不写任何文件。要不要落盘、落到哪里，由调用方决定：`fs.writeFile(path, created.text)`。如果文件名要跟着某个字段走，那个字段就是调用方自己的值——用 `values` 传进去，并在路径里复用同一个变量，这样文件名和正文不可能不一致。

同一套模板契约也能渲染任意文本格式，所以 JSON 产物同样是模板：

```markdown
---
dext-template:
  format: json
  name: 包名，kebab-case
  version: 版本号，例如 0.1.0
  keywords:
    type: lines
    separator: ",\n"
    description: 每行一个关键词，每个写成带双引号的 JSON 字符串
---

{
  "name": "{{name}}",
  "version": "{{version}}",
  "keywords": [
    {{keywords}}
  ]
}
```

字段值是**原样**插到占位符位置上的，所以某个位置需要什么引号、什么标点，由该字段的 `description` 说明；而周围的骨架（包括数组元素之间的逗号）来自模板。声明了解析格式后，渲染本身就成了模型契约的一部分：渲染结果解析失败即校验失败，走同一次自动修复，诊断就是解析器的报错；而 `z.toJSONSchema` 仍然只把普通字段 schema 发给 Codex 和 Claude。`format` 是保留的选项而非字段，永远不会作为字段交给模型。

调用只返回渲染出的文本，所以怎么用它由工作流决定——下面 `number`、`slug` 来自工作流自己的作用域，经 `values` 进入模板，并让文件名和正文里的编号保持一致：

```ts
import { template } from "dext";
import fs from "node:fs/promises";

const number = "0081";
const slug = "medoid-selection";

const created = await template({
  input: "记录我们刚确定的 medoid 选择决策。",
  source: ".agents/skills/adr/references/adr-template.md",
  values: { module: "optimize", number, slug },
});
await fs.writeFile(`docs/decisions/${number}-${slug}.md`, created.text);
```

该调用是只读的：它不会改动工作区，因此输出不符合模板（包括渲染结果不是合法的 json/toml/yaml）时总能走一次自动修复；它也从不决定落盘位置，所以同一个模板可以渲染到任意路径——需要跟着字段走的文件名，由调用方用它自己传入的值拼出来。Codex 和 Claude 会直接拿到模板字段作为原生结构化输出 schema；DeepSeek Harness 的 ACP 协议没有 schema 字段，其输出改由 Dext 按同一契约校验。模板内容会进入 Agent 指令，因此必须位于受信任工作区内。

上面的 `?` 表示可选参数，是文档记法。

项目 API 以 TypeScript 模块存放在 `.dext/api/` 中。模块按其在 `.dext/api` 下的路径导入，例如 `.dext/api/workflow/feature.ts` 对应 `import { main } from "dext/api/workflow/feature"`。全局 API 存放在 Dext 全局存储中，可供所有工作区使用；同名项目 API 优先。`dext.apiDirs` 可以增加更多 API 目录，`.dext/api` 始终最先查找。

项目 API 可以直接组合类型化 MCP、`agent` 和 UI 调用，不需要导入中间阶段 API。例如，功能开发工作流可以先读取上下文、制定计划，经 `ui.confirm` 确认后实现，再确认并验证。规则存放在 `.dext/rules/`，由各 Agent 阶段显式指定使用顺序；代码生成、提交这类需要确认的操作仍然是显式的 UI 闸门。

UI API 返回结果后会继续执行工作流，不需要注册单独的回调。后续步骤需要结果时，先赋值：

```ts
import { ui } from "dext";

const confirmation = await ui.confirm({ message: "应用这次修改吗？" });
if (confirmation.confirmed) {
  console.log("继续执行");
}
```

交互完成后，所选值、确认状态或输入文本也会出现在 Output 和 History 中。

所有 API 输出都实现统一的 `Result` 契约。结果类型恰好九种——`ask`、`plan`、`agent`、`template`、`apply`、`terminal`、`skill`、`ui` 和 `mcpRaw`——外加结构化 MCP 工具生成的 `mcp.<server>.<tool>`。`ask`、`skill`、`template` 是同一种 `{ kind, text }` 形状的三个名字；`PatchResult` 不是结果类型，而是 `AgentResult.patch` 的形状。结果变量和字段（如 `AgentResult.patch`）由生成的声明提供类型，因此补全和悬停说明在输入区与 `.dext/api/*.ts` 中都能工作。Agent CLI 接收的前序结果是带版本号的 `dext-result` JSON 数据，而不是直接插入字符串。

`ask` 始终只读。`agent` 和 `plan` 使用输入区域选择的写入范围；在受信任的本地工作区中，`Workspace write` 将编辑限制在所选工作区。Code 模式没有权限选择器，因此其中的 `agent({ apply: true })` 调用默认使用 `Full access`。Dext 可以在自身管理的全局存储中保存计划文档。两者的 `workspace` 都默认为当前项目根目录。

```ts
const answer = await ask({ input: "解释这段代码：" });
const result = await agent({ input: "实现所需的修改" });
```

`terminal` 仅适用于受信任的本地 `file` 工作区。`cwd` 必须位于工作区内，超时上限为 10 分钟，捕获的输出大小也有限制。它不会弹出确认，因此由工作流决定哪些命令可以安全运行。返回状态为 `"succeeded"`、`"failed"` 或 `"timed_out"`；非零退出码会返回类型化的失败结果。

`console.log` 和 `console.error` 会在 Dext Output 中展示内容，并转发到进程输出流，但不会写入集成终端。字符串和基本类型显示为文本；对象或数组按缩进 JSON 渲染，且**不限深度**，所以带嵌套的载荷会完整到达，而不是变成 `util.inspect` 的 `[Object]`；JSON 装不下的值（`Map`、循环引用）退回 `util.inspect` 全深度渲染。格式化占位符与空格拼接仍由 Node 负责，因此 `console.log("标签", payload)` 仍是"标签 + 值"的读法。

## 文件与选区引用

上下文通过 API 字符串参数中的可读 `@path` 标记附加：

- 复制 VS Code 选区，或选择文件、文件夹时，会插入 `@workspace/path` 标记；选区还会带上 `#Lstart,startChar-Lend,endChar` 范围。
- 目录标记以斜杠结尾，只引用目录，不读取或展开目录内容。
- 标记会渲染为整体引用块，可整体删除，并支持撤销和重做。加载旧数据时，原有的标记、f-string 和嵌套引号引用形式会迁移为此形式。

选中工作区代码并短暂停顿后，活动光标附近会出现 **Add to Dext** 悬浮入口。浮层覆盖在编辑器上，不插入额外行、不挤动代码，也不会抢走键盘焦点；点击即可把该段代码的位置引用加入 Input。浮层的样式和位置由 VS Code 控制，可能与符号提示共用同一个浮层。在设置中切换 `dext.selectionActions.enabled` 可立即显示或隐藏该入口。正文、文件列表和文件标签的右键入口统一为 **Add to Dext**，不受选区入口开关影响。

在资源管理器、“打开的编辑器”列表、文件标签或没有文字选区的文件正文中按 Ctrl+C（macOS 为 Cmd+C），再到 Dext Input 按 Ctrl+V，即可插入原文件路径的引用。支持多文件和图片文件，不会生成附件。编辑器悬浮提示显示时，Ctrl+C 保留 VS Code 原本的内容复制行为。Ctrl+Shift+V 粘贴纯文本而不是引用。凡是 VS Code 自己有复制行为的地方都保持原样：资源管理器里复制后仍可把文件本身粘贴到资源管理器——同一窗口或另一个窗口都行，文件正文没有选区时仍复制整行；只有“打开的编辑器”和编辑区标签这类本身没有复制快捷键的位置才只写入路径文本。将 `dext.copyFilePathOnCopy` 设为 `false`，可停止复制时暂存文件路径。

选中终端输出后按 Ctrl+Shift+C（macOS 为 Cmd+C）会复制并把这段输出附加到 Dext Input；Ctrl+C 仍交给 shell，因此仍能中断正在运行的命令。

标记在提交的输入中保持可读文本，Dext 不会把文件内容展开进提示词，由 Agent 自行读取引用的文件。`ask`、`agent`、`plan`、`template` 的 `input` 都接受这些标记。

输入区使用 Monaco 的 TypeScript 编辑器，高亮、缩进、括号匹配和原生编辑行为都来自 TypeScript 语法。Code 模式就是普通 TypeScript，不多做别的事：Dext 会把生成的 `dext` 声明和工作区自己的 `.dext/api` 模块作为 extra lib 注入，并沿用生成工程给 VS Code 的那套 `dext/api/*` 映射；此后补全、自动导入、参数提示、悬浮文档、转到定义和诊断都由编辑器自身的 TypeScript 服务提供。因此 `import { main } from "dext/api/git/commit"` 在输入区能解析、能类型检查，模块说明符和具名导出也像其他模块一样补全。还没导入的导出会连同绑定它的 import 一起补全——输入 `ask` 会给出 `ask` 和 `import { ask } from "dext";`，输入 `commi` 会给出工作区 API 自己的 `commit` 和 `import { commit } from "dext/api/git/commit";`；在 `import { … } from "…"` 里面则只给该模块的导出、不带额外编辑。这些名字都是从声明和 API 源码里读出来的，绝不按名字形状猜：`git` 是目录而不是导出，所以输入它没有任何提示，旧 `.dx` 那种限定调用也不会被翻译。运行里仍然用了这些名字却没有导入时，报错会直接给出该写的导入：`git is not defined` 后面跟着 `use: import { main as commit } from "dext/api/git/commit";`。

## 自定义 API 与 Skills

自定义 API 位于 `.dext/api/**/*.ts`。目录片段构成命名空间，每个文件都是普通的 ES 模块：

```ts
// .dext/api/team/analyze.ts -> "dext/api/team/analyze"
import { ask, type AskResult } from "dext";

export async function main(input: string): Promise<AskResult> {
  return await ask({ input });
}
```

按 `.dext/api` 下的路径导入：

```ts
import { main as analyze } from "dext/api/team/analyze";

const answer = await analyze("解释任务筛选逻辑和相关测试");
console.log(answer.text);
```

导出 `main` 只是当模块本身作为运行入口时 Dext 会查找的约定；由导入方决定如何调用。除此之外导出没有特殊含义——模块导出的任何内容导入方都可以使用。

较长的 API 可以用普通函数拆分：

```ts
// .dext/api/playground/develop.ts
import type { TerminalResult } from "dext";
import { main as verify } from "dext/api/playground/verify";

function report(checked: TerminalResult): void {
  if (checked.status !== "succeeded") console.error(checked.stderr);
  else console.log(checked.stdout);
}

export async function main(): Promise<void> {
  report(await verify());
}
```

辅助函数就是普通函数：一个模块可以导出任意多个值，其他模块可以导入其中任意一个；递归、类、泛型和 npm 包都能使用。没有强制的返回类型——`main` 可以返回 Dext 结果、普通值，也可以不返回。`.dext/api/*.ts` 中的补全、参数提示和悬浮说明由 VS Code 的 TypeScript 服务依据生成的声明提供。

### 生成的类型

Dext 为工作区生成一套编辑器用的 `dext` 工程，这个工程由项目提交。每次 API 重新加载都会写入，而且文件里所有路径都是相对路径——同一套文件换到别的机器和 CI 上都能用：

- `.dext/api/dext.d.ts`——`dext` 模块：全部内置 API、`ui` 分组、`mcp` 分组、所有结果接口、JSON 边界规则，以及本项目自己的 `.dext/mcp/*.jsonc` 清单所声明的 MCP 工具。**打开内置 API 定义** 与 F12 打开的就是这个文件。
- `.dext/tsconfig.json`——严格的 `nodenext` 工程，把 `dext` 映射到 `./api/dext.d.ts`、把 `dext/api/<id>` 映射到 API 模块本身（`dext/api/team/analyze` 对应 `api/team/analyze.ts`，与内核 loader 的查找顺序一致，项目通过 `apiDirs` 增加的目录同样在内），并包含 `api/**/*.ts`。它设置 `erasableSyntaxOnly: true`，因此 Node 类型擦除无法处理的语法——`enum`、`namespace`、参数属性和装饰器——在编辑器中就是错误；内核会以 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` 拒绝它。
- `.dext/package.json`——把该目录标记为 ESM，使 TypeScript 服务按内核的加载方式对待 `.dext/api/*.ts`，包括顶层 `await`；同时声明这些文件编译时依赖的 `@types/node`。Dext 只在文件不存在时创建默认内容；之后由项目维护依赖、脚本及其他字段。请保留 `"type": "module"`，使工作流工程按 ESM 加载。

类型声明和 tsconfig 会在重新加载时生成；`package.json` 只在缺失时初始化。`npm run check` 里的 `--workspace . --check` 检查生成文件是否与 registry 一致，以及 package 文件是否存在，不比较或改写项目依赖。完全不写 API 模块的工作区一个文件都不会生成。另有两类 API 源因为提交的文件无法指向它们而保持无类型：`dext.apiDirs` 设置与 Dext 全局存储里的 API 都是本机相关的；全局 MCP 清单同样不会进入声明（见 [MCP 配置](mcp.zh-CN.md)）。

Node 内置模块就是普通 import——自定义 API 读写文件用的 `import fs from "node:fs/promises"`——要让编辑器认它需要两步。先在 `.dext` 里执行一次 `npm install`，装上清单声明的类型定义。工程还设置了 `types: []`，以免工作区里无关的 `@types/*` 把全局量泄漏进这些文件；这也让 `@types/node` 的 ambient 模块在文件主动引用之前不进入程序，所以在 `api/` 下写一处 `/// <reference types="node" />` 就够了——它带进来的类型属于整个 program——完全不 import Node 内置模块的工程则既不需要这一行，也不需要那次安装。工作流自己的依赖直接声明在 `.dext/package.json`，在 `.dext` 中安装，并随工作流提交清单和锁文件。

构建时还会写出 `dist/dext.d.ts`——同一份声明，但不含任何项目的 MCP 工具。它**不在运行时读取**：`npm run check` 用它跑 `generate:dext-types --check`，证明内置 API 表面仍与 registry 一致，同时它随 VSIX 发布，便于直接从安装包里查看 API 表面。

随后由 VS Code 自身的 TypeScript 服务在 `.dext/api/*.ts` 中提供补全、悬停、F12 和诊断；输入区则由 Monaco 直接使用同一份内存声明。不再有独立的 API 检查器：**Dext: Reload APIs** 会刷新声明并重新加载注册表。

## 对话历史与工作流录制

右键 Dext History 条目并选择 **Record Conversation as Dext Workflow**，可以从已有对话生成起始工作流：成功的轮次会转成步骤，重复提示词会成为 `main()` 参数，确认操作会转成 `ui.confirm`，Code 模式的轮次会保留为注释。文件写入 `.dext/api` 后自动打开；它是需要继续修改的 TypeScript 骨架，而不是完成品。

Dext History 按 VS Code 工作区隔离。对话、收藏、名称和已打开的对话标签页会在重启后恢复，不会在不同项目之间共享。

History 子对话的悬浮操作栏和右键菜单依次提供重命名、分叉、复制 Markdown、从 Dext 删除四项操作。当前 CONVERSATION 的操作栏在这四项前面增加编辑输入和重试。History 父对话的悬浮按钮依次为继续、重命名、分叉、复制、收藏、归档、删除。共有操作的图标和相对顺序保持一致，删除始终在最后。子标题单独保存，不改变原始输入；清空名称可恢复默认标题。

删除一轮只移除 Dext 保存的输入与输出记录，不会删除 CLI 消息，也不会撤销文件修改；续接原 CLI 会话时，它仍可能使用已从 Dext 删除的内容。Dext 会保留 CLI 会话 ID，包括最后一轮被删除后留下的空对话，重启后仍可请求续接同一会话；能否成功续接取决于该会话是否仍可用。重试会在该对话中追加一次执行，可能再次执行写入操作。

## 轮次 Review 与 Build Review

每次开发轮次结束后，Output 末尾会显示可折叠的 **Review**：列出本轮实际改动的文件并区分新增、修改和删除，每一项都可以跳转到文件引用。Review 绑定 `sessionId + turnId + runId`，因此重试、分叉或后续 Build 都不会继承上一次的接受状态。

Review 只展示本轮确实记录到的内容：脚本事实及其覆盖范围、语义建议，以及提供者明确暴露了 Hook 身份与结果时的 Hook 结果。普通终端输出和 Agent 文字不会被重新标记为 Hook，工具成功退出也不等于业务验收成功；协议没有暴露 Hook 信息时不显示 Hook 区域。

两种预设只改变呈现重点，不改变操作模式：

- **工程审查**突出设计决策、模块边界、代码差异和依赖变化。
- **体验验收**突出功能行为、人工操作场景、用户反馈和待验收项。

项目默认预设写在 `.dext/project.json`，单次会话的覆盖优先于它。发送时会固定当次生效的预设，之后再改项目默认值不会改写已有轮次。Ask 在任何预设下都保持只读且不生成验收卡片；没有开发变更的轮次同样不生成。

接受 Review 与采用 Knowledge 建议是两个独立动作：**Accept review** 只记录你对本轮代码的决定，不写入项目知识；每条待处理的知识草稿有独立的 **Adopt** 操作，写入一条长期对象并在 Project 中定位到它。同一基础版本被拒绝过的草稿不会再次出现。

Plan 执行复用同一组件并额外绑定计划内容版本与本次 Build 运行 ID：中间轮次累计到同一份 Review，不会打断继续执行；能证明归属的变更按任务 ID 分组，被多个任务共用的变更单列为 **Shared across tasks**，没有可靠归属的内容进入 **Unattributed changes**，不会依据 AI 的任务勾选强行分配。最终验收等待你的决定而不是让 Agent 空转；后续反馈会进入新的执行记录。

仅编写 Plan 不算实现，因此编写 Plan 的轮次不会产生实现 Review。

## 导入、Skills 与规则

内置 API 从 `dext` 模块导入，始终可用；`import` 就是普通 ESM，因此也可以引入 Node 内置模块、工作区文件、以 `dext/api/<id>` 导入的自定义 API 和 npm 包。只有工作区被 VS Code 标记为受信任后，才会读取外部文件。

Skill 是显式的包。`skill({ skill: "name", input })` 加载指定的 `SKILL.md` 并注入当前 Agent 任务。查找顺序为 `<workspace>/.dext/skills`、**Project > Overview > Project configuration** 中的项目 Skill 目录、Dext 全局存储；项目尚未保存 Skill 目录时回退到旧的 `dext.skillDirs`，同名时靠前的位置优先。`create` 可以在项目或全局范围创建 Skill。

规则是 `.dext/rules/` 下的有序策略文件，规则路径只会在该目录下解析。`.dext/rules/plan.md` 会替换 Plan 模式默认的计划文档指令。`agent`、`ask`、`plan`、`template` 也可以为单次调用指定 `skills` 和 `rules`——`await agent({ input: "…", rules: ["review.md"] })`。它们是 `internal`，因为从不作为控制字段转发给提供方；而生成的声明恰好会在这四个 API 上列出它们，因为这是调用方自己写的选项。Dext 先加载所选 Skills，再按顺序加载规则，因此调用的窄规则会约束通用的 Skill 流程；这些内容注入 Agent 指令。`ui.*` 等待用户回答后继续同一个工作流。

## 自定义结果类型

Dext API 返回的每个值都是已声明的结果类型之一：`AskResult`、`PlanResult`、`AgentResult`、`TemplateResult`、`ApplyResult`、`TerminalResult`、`SkillResult`、`Ui*Result` 各变体以及 `McpRawResult`。自定义 API 像返回普通值一样返回其中之一，不需要编写按文件声明。`ask`、`skill`、`template` 共用 `{ kind, text }` 形状，`PatchResult` 是 `AgentResult.patch` 的类型，而不是独立的结果类型。

模块内部使用的值可以自由声明接口和类型——它们就是普通 TypeScript。只有跨 Dext API 边界的值必须保持可 JSON 序列化，也只有已声明的结果类型可以交给 `apply`：

```ts
import type { AgentResult } from "dext";

interface ReviewSummary {
  title: string;
  files: string[];
}

function summarize(result: AgentResult): ReviewSummary {
  return {
    title: result.summary ?? result.text,
    files: (result.files ?? []).map((file) => file.uri),
  };
}
```

## 执行与预览

Code 运行会在 Node 内核中立即执行。每次 Dext API 调用都会派发到扩展宿主，无论是否选择 Agent 配置，都应用相同的类型化契约和结果校验。`terminal`、`apply`、`ui.*` 始终由 Dext 自身处理。

没有配置 Agent 时，`ask`、`plan` 和 `agent` 返回输入的确定性回显，不改动工作区；`skill` 和 `template` 会报告需要配置 Agent。预览不代表 AI 已执行任务。选择 Agent 配置后，调用会交给对应 CLI，其结构化输出会在展示前校验。

## 继续失败的 Code 运行

失败的 Code 轮次会提供 **继续（Continue）**。Dext 记录了失败那次尝试发出的每一次 Dext API 调用——顺序、参数与响应；继续时按同样的顺序重放：仍然匹配的调用直接返回之前记录的结果，因此已经成功的工作不会重复，运行从第一个新调用继续。`console.log`/`console.error` 的输出不是被记录的调用，也不会影响对齐。

重放要么完全一致，要么立即停止。Dext 会比较调用序号、方法与参数，第一处差异意味着代码或某个记录看不到的值（`Date.now()`、`Math.random()`、环境变量，或 Dext 调用之外的直接文件读取）让第二次尝试走上了另一条路径。此时 Dext 不会把旧响应套用到别的调用上，而是明确报出「记录的调用已不再对应」并允许从头重试。被停止（Stop）的轮次不作为继续点：停止即结束。

旧版本 `.dx` 的 checkpoint 不会被读取，也无法继续；Code 文件与其轮次都从头开始。

## UI 交互与表单

所有 UI API 都等待用户回答，每次调用只记录一个工作流步骤。`presentation: "inline"` 在所属对话的 Process 上方展示卡片，`"dialog"` 使用弹窗。等待只暂停所属工作流，停止任务会中断等待并跳过后续步骤。

```ts
ui.select(options: { label: string; options: string[]; multiple?: boolean; placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiSelectResult>
ui.radio(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiRadioResult>
ui.checkbox(options: { label: string; options: string[]; allow_custom?: boolean; custom_placeholder?: string; presentation?: "inline" | "dialog" }): Promise<UiCheckboxResult>
ui.input(options: { label: string; placeholder?: string; multiline?: boolean; presentation?: "inline" | "dialog" }): Promise<UiInputResult>
ui.confirm(options: { message: string; confirm_label?: string; cancel_label?: string; presentation?: "inline" | "dialog" }): Promise<UiConfirmResult>
ui.alert(options: { message: string; acknowledge_label?: string; presentation?: "inline" | "dialog" }): Promise<UiAlertResult>
ui.form(options: { title: string; fields: UiField[]; description?: string; submit_label?: string; cancel_label?: string; show_cancel?: boolean; presentation?: "inline" | "dialog" }): Promise<UiFormResult>
```

| API / 字段 | 控件 | 返回内容 |
| --- | --- | --- |
| `ui.select` / `select` | 折叠式单选或多选下拉框 | `type: "select"`、`selected` 数组 |
| `ui.radio` / `radio` | 展开的互斥单选组 | `type: "radio"`、`selected` 和可选 `custom` |
| `ui.checkbox` / `checkbox` | 展开的独立复选框组 | `type: "checkbox"`、`selected` 和可选 `custom` |
| `ui.input` / `input` | 单行或多行文本 | `type: "input"`、字符串 `value` |
| `ui.confirm` | 确认、取消按钮 | `type: "confirm"`、布尔值 `confirmed` |
| `ui.alert` | 阅读信息后关闭 | `type: "alert"`、`status: "acknowledged"` 或 `"dismissed"` |
| `ui.form` | 整组字段统一提交 | `type: "form"`、`status: "submitted"` 或 `"cancelled"`、按字段 ID 保存的 `answers` |

API 结果带有 `kind: "ui"`。`answers` 中的字段答案只包含 `type` 及对应值。字段描述仅为数据，可以保存到变量复用；不要在 `fields` 中调用交互 API。

```ts
import { ui, type UiField } from "dext";

const fields: UiField[] = [
  { id: "environment", type: "select", label: "Environment", options: [
    { value: "dev", label: "Development", description: "Local environment" },
    { value: "test", label: "Testing" }
  ] },
  { id: "approach", type: "radio", label: "Approach", options: ["inspect", "change"], allow_custom: true },
  { id: "checks", type: "checkbox", label: "Checks", options: ["types", "tests", "build"], required: false },
  { id: "details", type: "input", label: "Details", multiline: true, required: false },
  { id: "run_tests", type: "radio", label: "Run tests?", options: [
    { value: "yes", label: "Yes" }, { value: "no", label: "No" }
  ] }
];
const reply = await ui.form({ title: "Settings", fields, submit_label: "Apply settings" });
if (reply.status === "submitted") {
  if (reply.answers["run_tests"]?.selected?.[0] === "yes") {
    console.log("Run the selected checks");
  }
}
```

表单级 `description` 在内联和弹窗中均按 Markdown 渲染，支持标题、列表、代码、表格和 HTTPS 图片（`![说明](https://...)`）。图片自适应宽度，点击可打开原图；加载失败时显示备用链接提示（带签名的附件地址可能过期）。原始 HTML 按文本显示。标题、字段标签和字段说明仍为纯文本。任务备注可直接传入 `description`，无需增加图片字段。

字段具有唯一 `id`、`label`、可选 `description`、`required`（默认 `true`）和 `default`。表单未配置默认值时不预选。选择字段的默认值为选项值数组，输入默认值为字符串，均须通过字段校验。选项使用非空字符串列表或 `{value, label, description?}` 对象，稳定值是唯一字符串；字符串选项的值等于自身。

只有 `select` 支持 `multiple`，`radio`、`checkbox` 不接受该参数。下拉不支持自定义文本；单选的自定义答案与预设选项互斥，复选框允许两者同时提交。必填选择字段至少有一个选择或有效自定义答案。输入按裁剪后的文本判断是否为空，提交时保留原文。可选且为空的字段不进入答案映射。

是／否问题使用普通 radio，`["no"]` 是正常提交的答案，不等于取消，也不自动转换为布尔值；后续分支应显式比较字符串。

选择快捷 API 接受字符串选项列表：`ui.radio` 默认选中首项，`ui.checkbox` 默认不选且允许空提交，`ui.select` 初始显示占位提示且提交前必须选择。对象选项、默认值、必填配置使用 `ui.form`。`ui.input` 提交空字符串时保留 `value: ""`，取消时省略 `value`。选择快捷入口取消时返回对应类型和 `selected: []`，不返回自定义草稿；需要区分取消与主动空提交时使用 `ui.form`。

取消或关闭表单返回 `status: "cancelled", answers: {}`；空字段表单提交返回 `status: "submitted", answers: {}`。`fields: []` 可表达纯确认或告知。`show_cancel: false` 只隐藏取消按钮，仍可关闭交互或停止任务。确认关闭返回 `confirmed: false`；告知主按钮返回已读，关闭按钮或 Esc 返回已关闭，点击遮罩不会关闭告知。已读不代表授权后续操作。

Esc 先关闭下拉弹层，再关闭外层容器。单选支持方向键，复选框支持 Space，弹窗关闭后恢复焦点。宿主执行仍存活时，切换对话或重建 Webview 可恢复请求及非秘密草稿。完成后的交互显示只读摘要，宿主重启后的历史请求显示为已关闭。

工作流与 Agent 共用控件。Agent 仍按每题一个答案回传，保留异步回答、跳过及秘密输入语义；秘密输入提交后清空，不写入草稿或历史。公共字段不开放密码输入。

限制为每张表单 32 个字段、每字段 200 个选项、标签和选项值最多 2,000 字符、文本最多 20,000 字符，表单和答案各最多 200,000 UTF-8 字节。不支持的类型或属性、重复 ID、重复选项值、重复选择、与原始请求不符的答案均被拒绝。未知历史结果通过有大小限制、转义后的文本或 JSON 只读展示，不能恢复执行。搜索、远程选项、自由创建、虚拟列表、条件字段和嵌套分组不在本版范围；普通输出使用 `console.log`，进度使用 Process/Todo。
