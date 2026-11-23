# Dext 通用 UI 组件目录

组件属性、默认值、合法部件、渲染介质和公开范围见下表。当前注册入口、承载页面和回归夹具见[界面覆盖索引](./ui-foundation-coverage.zh-CN.md)。

## 模块与宿主

| 职责 | 源码入口 |
| --- | --- |
| 介质无关构建 | [UiRenderAdapter 和 MarkupAdapter](../src/shared/lib/ui/renderAdapter.ts) |
| HTML 渲染 | [htmlUiAdapter](../src/shared/lib/ui/htmlUiAdapter.ts)，供宿主和历史回放使用 |
| DOM 渲染 | [domUiAdapter](../src/platform/browser/domUiAdapter.ts)，由页面注入所属文档 |
| 内容、Trace 与原生披露 | [contentComponents.ts](../src/shared/lib/ui/content/contentComponents.ts)、[traceComponents.ts](../src/shared/lib/ui/content/traceComponents.ts) 和 [disclosure.ts](../src/shared/lib/ui/content/disclosure.ts) |
| 条目状态、提示、反馈与空态 | [feedbackComponents.ts](../src/shared/lib/ui/feedback/feedbackComponents.ts) |
| 堆叠、行内布局与分段 | [layoutComponents.ts](../src/shared/lib/ui/layout/layoutComponents.ts) |
| 原生按钮、单选、复选与标签 | [nativeControls.ts](../src/shared/lib/ui/input/nativeControls.ts) |
| 表单与对话框结构 | [formComponents.ts](../src/shared/lib/ui/input/formComponents.ts) 和 [dialog.ts](../src/shared/lib/ui/overlay/dialog.ts)，由 [InteractionForm](../src/features/conversations/browser/interactionForm.ts) 和 [InteractionDialog](../src/features/conversations/browser/interactionDialog.ts) 接入 |
| 标签与 Composer 菜单组合 | [conversationTabs.ts](../src/features/conversations/browser/conversationTabs.ts) 和 [composerMenu.ts](../src/features/conversations/browser/composerMenu.ts) |
| 导航状态、菜单键盘与焦点绑定 | [navigationBindings.ts](../src/platform/browser/navigationBindings.ts) |
| 脚本只读树与应答数据 | [uiView.ts](../src/shared/contracts/uiView.ts) 和 [uiForm.ts](../src/shared/contracts/uiForm.ts) |
| 组件样式与主题默认值 | [ui.css](../media/ui.css) 读取 VS Code 颜色。侧栏和媒体标注经 `main.css` 打包，History 经 `styles.css` 加载，Resources 与草稿预览经 `editorTabs.css` 加载 |

基础组件可以依赖共享契约，并通过适配器生成标记。功能层传入内容与状态，平台层提供所属文档、键盘绑定和原生 API。请求信封、选定会话、目录查询、历史分页和媒体时间轴由各功能持有。运行 `node scripts/checkModuleBoundaries.mjs` 可以检查基础层与宿主之间的依赖方向。

下表记录迁移采用的契约。消费者和当前实现可从上表及覆盖索引定位。

## 组件目录与渲染约定

“H/D” 表示共享定义适配 HTML 和 DOM，“D” 表示需要活的 DOM 才能操作。HTML 可以输出初始化结构。交互部件的程序状态先由宿主传入，连接后使用原生属性同步。公开字段和内部宿主选项经不同类型暴露，公开树无法传入 CSS、任意 DOM 属性与回调。

| 分类／组件 | 目录结论与消费者 | 属性、默认值与合法内容 | 介质、a11y 与宿主 | 公开 |
| --- | --- | --- | --- | --- |
| 布局 · Stack | 补齐；回合块、History、资源详情、脚本报告 | `gap: "sm" / "md" / "lg"`，默认 `"md"`；纵向，接普通块或内置页面槽 | H/D；文档顺序，按容器宽度收缩，无绑定 | `UiStack` |
| 布局 · Inline | 补齐；资源元信息、回合状态、脚本摘要 | `gap` 默认 `"sm"`，`wrap` 默认 `true`；接普通内容，复杂块仍保序 | H/D；窄栏换行，以 DOM 顺序朗读，显式不换行时容器允许横向滚动，无绑定 | `UiInline` |
| 布局 · Section | 补齐；回合片段、资源文档、API 示例、报告 | 必填非空 `title`，可选纯文本 `description`，随后为内容；内部入口可明确指定标题级别 | H/D；原生 section 和 heading，公开报告第一层 h3，嵌套逐级递增至 h6，Stack/Inline 不增加级别 | `UiSection` |
| 布局 · Toolbar | 合并；Composer、History、资源、媒体工具栏 | `label`、`children`；沿用宿主当前顺序和换行，接按钮、菜单触发器、搜索等 | H/D；具名区域，已有工具栏角色和按键按宿主合同保留，无统一焦点接管 | 内部 |
| 导航 · Tabs | 补齐；会话标签、资源分段、编辑器页导览 | `label`、`selected`、`disabled=false`；TabList、Tab、可选 Panel，关闭/固定动作为 Tab 同级 | H/D 标记、D 绑定；维护 role、可访问名和 aria-selected，关联实际受控区域。真实链接保留导航语义；业务决定选中和拖拽 | 内部 |
| 导航 · Menu | 合并；Composer 的模式、模型、技能、权限、预设和更多菜单 | 触发器默认收起；项含 label、checked、disabled、可选分组/子菜单；Empty 只显示说明 | H/D 标记、D 绑定；现有 ↑↓、Home/End、左右层级、Escape、选中和回焦；宿主保有裁切容器及动作 | 内部 |
| 输入 · Form | 合并；现有工作流、Agent 表单和 MCP 助手 | `title`、可选 description、Field／组、Error、Actions；表单语义一次提交，沿用隐式动作与默认必填规则 | H/D 标记、D 交互；共享名称、提示、错误和动作状态；宿主验证、收集并提交结果 | `ui.form` 的参数与答案 |
| 输入 · Field、Label、Description、FieldError | 补齐；交互表单、MCP 配置、标注备注、验收标签 | 字段 label 必填，单字段一个控件或一组同契约选项；可选 description、error；`required` 在公开表单默认 true | H/D 标记；单控件用 for/id 或既有具名机制，组用 fieldset/legend。说明和错误保持可读关联，实时错误沿用既有播报 | `UiField` 数据 |
| 输入 · Input、Textarea | 合并；Form、History 与资源搜索、MCP、图像／视频备注 | `value` 默认空字符串、可选 placeholder/disabled；Input 选择 text/search/password，Textarea 保留多行；均为叶 | H/D 标记、D 可编辑；原生 label、焦点与选择。草稿、验证、secret、引用、拖放由各入口处理 | `ui.input` 和表单 input 字段 |
| 输入 · Select | 复用并上移；交互表单，MCP 原生 scope 使用同语义的原生变体 | `options`、`selected`、`multiple=false`、label、placeholder；Trigger 加 listbox/Option，原生变体用 select/option | D 行为；具名、`aria-expanded`、`aria-selected`，保留 manual popover 及失焦/Escape 顺序；宿主验证所选值 | `ui.select` 和表单 select 字段 |
| 输入 · Radio、Checkbox | 复用；表单选择组、Plan 验收、资源三态按钮按既有角色呈现 | `checked=false`、`disabled=false`、id、组名与 Label；历史显示值随状态，资源三态由页面给出 | H/D 标记、D 操作；原生 Radio 组、Checkbox Space 与 label 点击；宿主保存并回焦 | `ui.radio`、`ui.checkbox` 和表单字段 |
| 输入 · Button | 复用；全部页面工具栏、菜单、标签和表单 | `type="button"`、`disabled=false`、label/具名图标，内部变体可作提交；接文本和图标 | H/D；禁用用原生属性，图标须有名称，宿主注入动作 | 表单动作数据，显示树内无动作 |
| 覆盖层 · Dialog | 合并；工作流 Dialog、旧权限提示、MCP Assistant | `open=false`、必需可访问标题。可选 Description、关闭/全屏动作、内容、页脚；可放一个 Form | H/D 壳、D 原生 `showModal`；背景 inert、模态焦点范围、分层 Escape 与焦点恢复，业务取消由宿主映射 | 由现有 `presentation` 调用 |
| 覆盖层 · Tooltip、Popover、Drawer | 延期新增组件；Composer 的描述 tooltip、Select 的原生 popover 都有当前宿主 | 延用 title 与 Select/Menu 既有锚点、开闭和默认值。Drawer 暂无迁移消费者 | D；说明或弹层行为按对应现有入口维护 | 保留名称 |

### 内容展示与反馈

| 分类／组件 | 目录结论与消费者 | 属性、默认值与合法内容 | 介质、a11y 与宿主 | 公开 |
| --- | --- | --- | --- | --- |
| 内容 · Text / Markdown | 拆出复用；回合、资源说明、报告 | `Text.text`、可选 tone，默认 normal；`Markdown.source` 必填，内部宿主可选择受信链接与现有复制策略。两个均无 children | H/D；文本转义，段落、标题等保留语义。脚本 Markdown 仅保留可读文字和安全标记，文件/链接/图表由对应宿主处理 | `UiText`、`UiMarkdown` |
| 内容 · Code / CodeBlock / Separator | 拆出复用；回合 JSON、Agent 命令、资源源码与 API 示例、报告 | `Code.text`、`CodeBlock.code` 必填；Separator 无字段。内置 CodeBlock 可以接受受信高亮并由宿主提供复制区 | H/D；code、pre/code、hr。脚本 CodeBlock 的既有原生复制按钮保持禁用。内置输出可复制原文 | `UiCode`、`UiCodeBlock`、`UiSeparator` |
| 内容 · Disclosure | 合并；History、资源分组、回合、MCP Process | `open=false`，各场景保留所传初始状态。具名 Trigger 后接 Content；允许内部合法摘要动作 | H/D；原生 details/summary 和键盘披露，宿主控制历史懒载、树展开、权限与滚动 | 内部 |
| 内容 · Trace / TraceLine | 复用；Todo、验收、Agent Trace、部分资源树、脚本过程 | `ordered=false`；Trace 的公开子项仅 TraceLine，行可接既有内容和嵌套 Trace。行 `status` 缺省无状态，`tone` 缺省 normal | H/D；保留列表语义和状态文字，内置可结合 Disclosure、Checkbox 和绑定 | `UiTrace`、`UiTraceLine` |
| 内容 · TraceIcon / TraceTitle / TraceDescription | 复用；过程行、Todo 和历史；通用图标从现有 Codicon 标记提取 | `icon` 必需且使用现有白名单；标题和描述的 `text` 必需，描述的 `tone` 默认 normal；公开为叶 | H/D；装饰图标隐于辅助技术；标题可为披露具名；实时计数由宿主声明 polite | `UiTraceIcon`、`UiTraceTitle`、`UiTraceDescription` |
| 内容 · TraceCollapsible / Trigger / Content | 合并共用 Disclosure 的结构；Plan 分组、命令和资源树既有兼容组合 | 可选 open，默认 false；Trigger 首位，Content 可包含行和子列表，兼容现有是否包壳 | H/D；原生展开语义，由宿主接增量、懒载和状态更新 | 内部 |
| 反馈 · Badge | 拆出复用；Todo、资源 Draft、API 标记、附件/帧序号、脚本摘要 | `text` 必需；可选现有任务 `status` 和通用 `tone`，无 children。未传 tone 延用现有状态默认视觉 | H/D；有可读文字；显式 tone 改变视觉，保留原 status 标识；无交互 | `UiBadge` |
| 反馈 · Spinner | 拆出复用；运行标签、Todo、视频进度、报告 | 脚本 `label` 为非空可见名且静态；内部允许装饰、运行态与调用方状态文本 | H/D；装饰 aria-hidden，内置实时状态由宿主统筹播报；无交互 | `UiSpinner` |
| 反馈 · Alert | 复用；表单、输入错误、资源错误、媒体、报告 | `text` 必需，可选 `tone`，脚本默认 info；内部可选动态报错模式；公开为叶 | H/D；动态角色 `alert` 按现用场景启用，静态说明只贡献可读文字。宿主决定清除或隐藏 | `UiAlert` |
| 反馈 · Empty | 补齐；菜单、History、资源筛选、媒体列表和脚本报告 | 非空 `text`，无 children。仅调用方确认无结果时展示，空容器不会隐式生成文案 | H/D；可读，菜单中不成为可操作项，无自动播报 | `UiEmpty` |
| 其它保留名称 | 延期；已有进度、提示、分组与列表优先迁移至目录内部件 | Table、Progress、Toast、Breadcrumb、Slider、Switch、Avatar、Skeleton、Kbd 继续保留。Markdown 表格和媒体专用进度沿用现入口 | 由现有内容或专用宿主提供，媒体进度由播放和导出状态控制 | 保留名称 |

状态约定从现有行为提取。禁用使用 `disabled` 和 native 属性，非原生支持的角色只在阻止激活时设置 `aria-disabled`。加载用 `busy`、实际更新区域的 `aria-busy` 和必要的可读 Spinner 文案。错误用 `invalid`、`aria-invalid` 和说明关联，避免一份错误在多个 live region 重复播报。选中由既有角色分别写入 `aria-selected`、`aria-checked` 或原生属性。任务实体保持 `pending`、`in_progress`、`completed`，展示色调 `normal`、`muted`、`info`、`warning`、`error` 独立。空态由页面条件显式传入。可关闭内容、滚动和业务状态依旧由页面协调。

新页面先按目录选择部件和已存在的组合，再确定宿主。一处需求先由页面选择已有组合或内部兼容属性。第二处同类需求出现时，按共同 DOM、状态和 a11y 契约提炼部件。新增公开部件要同时列出内置消费者、节点 schema、契约文档和正常入口测试。角色或键盘约定的扩展需要对现有场景逐项比对，迁移阶段沿用已发布行为。

## 关键部件树

```text
Form (一个提交面；title 必需)
├── Description? (表单级说明)
├── Field* / FieldGroup* (字段可以为空)
│   ├── Label / Legend (必需，组用 legend)
│   ├── Input | Textarea | Select | RadioGroup | CheckboxGroup (恰一)
│   ├── Description?
│   └── FieldError?
├── Alert? (请求级错误)
└── Actions (至少一个提交动作，Cancel? 由现有表单参数决定)

Dialog
└── Surface (有且仅一个可访问 Title)
    ├── Header (Title、Description?、Close?、Fullscreen?)
    └── Form | Body + Footer? (无嵌套 form；工作流共用一个 Actions)
```

Field 负责关联标签和说明。Input 等持有原生控件和局部交互，Action 由表单组合协调。`InteractionForm` 与 `McpAssistantView` 分别注入提交与取消。Select 打开时 Escape 先关闭选择层，再按既有全屏和 Dialog 顺序处理。宿主保存请求、草稿与恢复焦点引用。

```text
Tabs
├── TabList (具名，至少一个 Tab)
│   └── Tab* (可含 Text/Icon/Spinner；Pin/Close 作为同级动作)
└── Panel? (有实际受控区域时和 Tab 对应)

Menu
├── Trigger (具名，expanded)
└── Content (role=menu)
    ├── Item | CheckedItem | SubmenuTrigger + Submenu
    ├── Group? (组名与菜单项)
    └── Empty? (说明，方向键跳过)

Trace (ul/ol；内部等价列表角色)
└── TraceLine* (li，或同等列表项；公开 Trace 的唯一直属类型)
    ├── TraceIcon? / TraceTitle? / TraceDescription?
    ├── Text / Markdown / Code / CodeBlock / Separator / Badge / Spinner / Alert* (原顺序)
    ├── Trace? (容纳嵌套过程；公开兼容既有同级多项)
    └── TraceCollapsible? (内部)
        ├── TraceCollapsibleTrigger (第一个 summary，需具名)
        └── TraceCollapsibleContent (可含子 Trace 和详情)
```

Tabs 维护单一选中状态和现有原生按钮操作，关闭/固定与 Tab 同级。Menu 的空态无选项角色，定位由调用方提供真实裁切容器。Trace 的标记沿用原生披露，等价结构必须保证列表层级合法。Trace 部件已有其他格式的内部调用时保留对应角色映射。通用布局可容纳普通内容，Trace 用于业务步骤或过程。


## 组合回归夹具

[组合测试](../test/uiFoundationCoverage.test.ts) 检查最小部件标记及其反例。各页面通过覆盖索引中的正常入口回归测试核对交互和宿主生命周期。

| 组合 | 合法结构 | 反例 |
| --- | --- | --- |
| Form | 具名表单含带标签的字段及提交动作，禁用态由原生属性表示 | 字段标签指向其他控件 |
| Dialog | 标题可解析，表面含一个 Form 或独立内容 | 标题引用不存在 |
| Tabs | 具名标签列表含唯一选中项，实际面板与其标签双向关联 | 面板标注了错误的所属标签 |
| Menu | 展开状态和菜单 ID 匹配，禁用项及空态说明退出键盘遍历 | 为说明赋予可操作项角色 |
| Trace | 列表子项保持层级，披露由首个具名 summary 控制 | 披露标题移到正文之后 |

## 正常入口

| 界面 | 共用部件 | 回归夹具 |
| --- | --- | --- |
| 侧栏 Plan Todo、命令和 JSON，随后打开 History | 共用 `Trace`、`Badge` 和 `CodeBlock`。实时与历史使用自己的复制、勾选和持久化绑定 | `scripts/checkStructuredOutputUi.mjs` |
| 在 Resources 切到 Dext，打开 `ui.render` | 兼容示例用 `Section` 和与回合相同的 `CodeBlock`。Resources 保有导航与 API 详情数据 | `test/apiPanel.test.ts`、`scripts/checkEditorTabsUi.mjs` |
| 运行检查报告，再按需打开修复确认 | 报告使用同一 `CodeBlock`、`Section`、`Badge` 和布局部件。表单走原有请求桥，脚本读取动作和字段值，History 回放静态摘要 | [检查报告示例](./workflows.zh-CN.md#检查报告示例)、`test/dextHost.test.ts`、`scripts/checkStructuredOutputUi.mjs` |
