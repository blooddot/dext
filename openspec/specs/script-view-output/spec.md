# script-view-output Specification

## Purpose

允许用户脚本在当前回合提交只读结构化内容，使同一份数据可在对话输出中顺序展示，并在历史重放时保留其可访问语义与原有内容。

## Requirements

### Requirement: 显示 API 只接收受约束的 JSON 树

`ui.render({ nodes })` SHALL 接收按显示顺序排列的 `UiNode[]`。每个节点 MUST 是以 `type` 区分的纯 JSON 对象。公开类型包含 `Stack`、`Inline`、`Section`、`Empty` 及既有 `Trace`、`TraceLine`、`TraceIcon`、`TraceTitle`、`TraceDescription`、`Text`、`Markdown`、`Code`、`CodeBlock`、`Separator`、`Badge`、`Spinner`、`Alert`。容器通过 `children` 表达顺序。布局容器内允许布局、普通内容、反馈与完整 Trace。`Trace` 只包含 `TraceLine`，`Spinner` MUST 有可见名称。宿主 SHALL 校验合法字段和子节点，沿用 32 层、1,000 节点和 256 KiB 上限，并拒绝任意标签、HTML 字段、class、style、事件、handler id、交互节点及保留节点。

#### Scenario: 顶层节点和嵌套 Trace 按顺序显示

- **WHEN** 脚本调用 `ui.render`，`nodes` 依次包含 `Markdown` 和带有一条 `TraceLine` 的 `Trace`，行内包含标题和描述
- **THEN** 当前回合生成一项输出，先显示 Markdown，再显示包含该行标题和描述的 Trace

#### Scenario: 非法子节点使整次调用失败

- **WHEN** 脚本在深层子节点传入任意标记字段、未知类型、交互控件或超限树
- **THEN** 宿主给出含节点位置的校验错误，该调用没有部分输出

#### Scenario: Markdown 作为安全内容展示

- **WHEN** 允许的 Markdown 节点包含原始 HTML、链接语法或 `javascript:` 目标
- **THEN** 原始标记保持惰性，脚本树中的链接文字仍可阅读，链接目标不会成为可操作链接

#### Scenario: 保留名称不产生输出

- **WHEN** 脚本提交 Table、Tooltip 或其他 Tier 2 名称
- **THEN** 节点被拒绝，保留名称只出现在 schema 目录中

#### Scenario: 旧根节点与新布局的嵌套规则兼容

- **WHEN** 旧脚本仍提交独立的根 `TraceLine`，新脚本在 `Section.children` 直接提交 `TraceLine`
- **THEN** 旧调用仍在列表中显示该行，新调用报告位于 `nodes[0].children[0]` 的子节点错误
- **AND** 新脚本可以在 `Section` 内放置完整 `Trace` 以显示同一过程

### Requirement: 连续显示调用逐项追加

`ui.render({ nodes })` SHALL 从现有 `ui` 命名空间导出并返回 `Promise<void>`，解析和记录完成即可继续脚本执行。调用 MUST 无需面板确认。每次成功调用 SHALL 在当前回合添加一份可见输出，记录其调用顺序。

#### Scenario: 两份树与日志保持顺序

- **WHEN** 脚本依次等待两次显示调用，并在它们之间写入日志
- **THEN** 本轮 Output 中两棵树各出现一次，日志位于两者之间
- **AND** 调用方得到 `undefined`，无需设置 `echo`

### Requirement: 只读显示结果可在历史恢复

显示结果 SHALL 保存经验证的树数据，在实时回合和历史中使用等价的组件结构。宿主 SHALL 禁用脚本树的状态修改和复制控件。已有回合与交互应答 SHALL 继续走既有重放路径。

#### Scenario: 重放显示结果

- **WHEN** 用户恢复会话、打开历史，或脚本运行继续时重放已记录的两次显示调用
- **THEN** 两个输出仍按记录顺序各出现一次，结构和文本一致
- **AND** 脚本树的 CodeBlock 复制按钮保持原生禁用，且不会产生任何脚本回调

### Requirement: 通用报告可嵌套布局并阅读状态

`Stack`、`Inline` 和 `Section` SHALL 支持嵌套的普通内容、状态和反馈，保留声明顺序。`Section` MUST 有非空标题，可提供说明，并在嵌套时保持标题层级。`Inline` 默认换行，`Stack` 默认纵向排列。两者 SHALL 接受 `"sm"`、`"md"` 或 `"lg"` 间距，分别默认 `"sm"` 与 `"md"`。`Badge` SHALL 支持独立于既有任务 `status` 的可见反馈色调。静态提示 SHALL 可阅读，`Empty` SHALL 以可见文字表示显式空态。

#### Scenario: 显示多区块检查报告

- **WHEN** 脚本以 `Stack` 包含摘要、详情和说明三个 `Section`，在摘要中用 `Inline` 排列 `Text` 和 `Badge`，在详情中使用 `CodeBlock` 或 `Empty`，在说明中使用 `Alert`
- **THEN** 同一回合中出现一份完整报告，区块按脚本顺序显示，窄视口中的状态行换行且阅读顺序稳定
- **AND** 历史回放保留区块标题、顺序、状态和空态语义，静态提示保持惰性

### Requirement: 类型与 API Reference 描述同一套公开组件

每个公开节点 SHALL 提供可直接用于 TypeScript 的具名类型，并在内置 API Reference 中记录属性、默认值、合法子节点与组合示例。类型和运行时校验 MUST 接受同一合法节点形状。运行时超限或非法字段 SHALL 给出位置与原因。

#### Scenario: 通过公开文档和编辑器编写报告

- **WHEN** 作者只通过内置 API Reference 和 `dext` 声明编写报告，并在 `children` 输入字面量
- **THEN** 编辑器根据所在容器补全合法类型和属性，错误的子节点无法通过类型检查
- **AND** 合法示例能通过工作流正常入口运行，绕过类型检查传入同类错误时收到节点路径和原因

### Requirement: 报告后的交互通过已有 UI 方法返回

脚本 SHALL 能先等待只读报告完成记录，再使用现有 `ui.form`、`ui.confirm` 或快捷交互方法取得结果。现有参数、返回值、默认挂载位置、取消和中止语义 MUST 保持兼容。已回答交互 SHALL 按现有摘要和重放规则呈现。

#### Scenario: 脚本消费用户提交

- **WHEN** 检查报告已追加，脚本等待 `ui.form`，用户选择修复范围并按下确认动作
- **THEN** 脚本收到 `status: "submitted"`、按字段 ID 索引的 `answers` 和所按的 `action`，并可按结果决定后续步骤
- **AND** 报告保持只读，回放时同一次应答以静态摘要显示

#### Scenario: 取消和重放按既有路径处理

- **WHEN** 用户关闭表单、取消确认、停止回合，或打开此前已完成的历史
- **THEN** 表单按既有设置返回取消结果或中止，确认在返回模式下得到 `confirmed: false`，停止按既有中止路径处理
- **AND** 历史打开不会重新请求应答，继续执行已记录步骤时沿用现有去重和重放规则
