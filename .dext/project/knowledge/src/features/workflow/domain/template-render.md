## Responsibility

- **Names**: Render Template → `src/features/workflow/domain/templateRender.ts`（`parseTemplate`、`TemplateSpec`、`renderTemplateText`）
- 拥有模板的解析与校验：`parseTemplate` 读取源文件开头的 YAML front matter，在 `dext-template` 下解析字段声明（`string` / `lines` / `enum`、`optional`、`values`、`separator`）与保留选项 `format`，并逐行检查 body 中的 `{{name}}` 占位符——未声明的占位符、声明却未使用、同一行放入多个 `lines` 字段都直接报错。
- 拥有渲染：`renderTemplateText` 以模板正文为骨架回填字段值；markdown 额外承担结构规则（可选字段为空时连标题整段删除、连续空行折叠、行尾空白裁剪），其他格式逐字渲染后交给 `templateFormatError` 解析校验。
- 拥有模型侧契约：`templateOutputSchema` 由字段声明生成 zod schema，`templateInstruction` 生成“结构来自模板、你只给字段值”的指令，`templatePreset` / `templateValues` 让 Dext 自己提供的值剔除出模型契约并最终覆盖模型输出。
- 形状如此，是因为一个责任要同时保证两件事：模型只产出字段值、模板决定骨架，prompt 规则无法保证标题层级与章节顺序；而 `format` 必填使“渲染后不合法”成为可被一次性修复重试的校验失败，而不是无人察觉的坏文件。契约对象刻意不是 strict，provider 回显 preset 字段不应让一次完整渲染失败。

## Design

- 纯函数、无副作用：模块只 import `smol-toml`、`yaml`、`zod`，不读文件、不写文件、不调用模型；取模板源码、跑模型、写出结果由 `src/features/workflow/host/runtime.ts` 的 `templateRender` handler 负责，该 handler 在未配置 Agent profile 时直接抛错。
- `format` 是模板选项而非字段，因此是保留名：隐藏 `format` 的模板会让 Dext 无法判断渲染结果必须解析成什么。
- 解析型 format 用 `superRefine` 把“渲染后能否解析”并入 schema，`z.toJSONSchema` 会忽略该 refinement，provider 收到的仍是普通字段 schema。
- `lines` 字段在线上是“一行一项”：只有 markdown 模板自带列表符号，故只在 markdown 剥离模型多写的 `-`/`*`/`+`；其他格式里多出的符号属于值本身，会变成格式错误。`separator` 让 JSON/TOML 数组自带逗号，避免最后一项多一个尾逗号。
- 围栏代码块内的行按内容处理：其中的 `#` 注释不算标题，其空行不被折叠。

## Boundary

- Allowed: `smol-toml`、`yaml`、`zod`，以及本目录内的纯函数复用。
- Forbidden: 文件系统与工作区访问（含路径解析、ignore 规则）、Agent profile / 配置解析、模型或 CLI 调用、UI 交互、渲染结果的写盘，以及导入 `features/*/host` 或 `features/*/browser` 层模块。