# script-view-output Specification

## Purpose

允许用户脚本在当前回合提交只读结构化内容，使同一份数据可在对话输出中顺序展示，并在历史重放时保留其可访问语义与原有内容。

## Requirements

### Requirement: 显示 API 只接收受约束的 JSON 树

`ui.render({ nodes })` SHALL 接收按显示顺序排列的 `UiNode[]` 作为顶层节点。每个节点 MUST 是纯 JSON 对象，使用 `type` 指定部件，容器通过 `children` 表达嵌套。公开的 `type` 值为 `Trace`、`TraceLine`、`TraceIcon`、`TraceTitle`、`TraceDescription`、`Text`、`Markdown`、`Code`、`CodeBlock`、`Separator`、`Badge`、`Spinner`、`Alert`，其中 `Spinner` MUST 为带名称的静态指示。`Trace` 的 `children` MUST 仅包含 `TraceLine`。

宿主 SHALL 校验节点类型、字段和允许的子节点，限制树的深度、节点数和序列化大小。宿主 MUST 拒绝任意标签、HTML 字段、class、style、事件、handler id、交互节点及保留节点。

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
