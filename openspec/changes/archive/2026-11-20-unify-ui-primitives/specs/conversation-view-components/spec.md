# Spec Delta

## Purpose

让正在进行的回合与历史回放用同一套部件表达计划、过程和输出，并通过原生语义保留可访问性。表单、菜单和标签在 Webview 中共享基础构建能力，同时保持当前交互流程。

## ADDED Requirements

### Requirement: Plan 与过程共用 Trace 部件

Plan Todo 与 agent trace SHALL 共用 Trace 的容器、折叠、触发、内容、行、图标、标题和描述部件。列表 SHALL 具有列表语义，折叠标题 SHALL 具备原生可访问名称和键盘操作，装饰图标 SHALL 隐藏于辅助技术。任务状态 MUST 保持 `pending`、`in_progress`、`completed`。

#### Scenario: 分组任务与过程详情可由相同部件构成

- **WHEN** 同一回合包含带子任务、`verify:` 和验收项的 Plan，以及带详情、引用和 JSON 的 agent trace
- **THEN** 两处由同一组 Trace 部件组合，计数进入 TraceDescription，嵌套通过子节点表达
- **AND** Markdown、状态文案、计数、展开策略以及既有标签、类名和顺序保持兼容

### Requirement: 实时渲染与静态回放结构等价

双介质部件 SHALL 在相同输入与宿主选项下输出等价的标签、类名、属性和层级。静态可变控件 SHALL 保留显示值与标签关联，使用原生禁用属性并禁用状态更新。历史交互应答 SHALL 维持文本或答案摘要。

#### Scenario: 验收状态可回放

- **WHEN** 实时 Plan 的验收复选框被勾选并写入会话状态，随后打开历史
- **THEN** 历史显示相同计数和勾选值，原生复选框带 `disabled`，标签仍关联控件
- **AND** 实时版仍通过现有委托与宿主确认改变状态，并把焦点还给触发项

#### Scenario: 原样复制 JSON

- **WHEN** 内部回合或历史以 JSON 披露区展示完整结果
- **THEN** 显示使用现有缩进格式，外层回合提供的复制动作仍取得原始字符串

### Requirement: 表单控件与对话框保留原生交互

Dialog、Form 与字段 SHALL 保留可访问名称、所属组、错误反馈、失焦与焦点恢复、草稿、验证和文件拖放。Select SHALL 保留 listbox/option 关系、展开和选中状态及现有按键。

#### Scenario: 全屏先退出再取消

- **WHEN** 用户在全屏模态对话框连续两次按 Escape
- **THEN** 第一次退出全屏但保留表单，第二次走现有取消路径并在关闭时恢复焦点

#### Scenario: 弹层 Escape 优先关闭 Select

- **WHEN** 模态表单中的 Select 已展开，用户按 Escape
- **THEN** Select 关闭、`aria-expanded` 更新且焦点回到触发器，表单保留

#### Scenario: 校验就地更新

- **WHEN** 用户编辑字段或拖入文件引用，使动作由不可提交变成可提交
- **THEN** 现有动作按钮就地更新 `disabled`，草稿和校验按原时序进行
- **AND** 校验失败时错误区域通过 `role="alert"` 报告

### Requirement: Tab 与菜单行为兼容

对话标签与资源分段控件 SHALL 保留 `tablist`、`tab`、可访问名称与 `aria-selected`。Composer 菜单 SHALL 保留可访问的菜单项角色、选中状态、键盘导航、关闭和焦点恢复，以及模型子菜单的容器内定位。

#### Scenario: 切换、固定和重排

- **WHEN** 用户切换标签、固定或拖动对话标签，或切换资源分段
- **THEN** 所选状态、动作禁用状态、现有滚动、草稿归属和重排结果保持兼容

#### Scenario: 模型子菜单受实际可用空间约束

- **WHEN** 用户在宽视口、受限的居中列或窄视口打开模型的子菜单
- **THEN** 子菜单优先显示在右侧，其次左侧，再在上方显示并限制高度
- **AND** 键盘进入、返回、关闭和选项提交保持当前行为
