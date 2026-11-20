# Design

## Context

`turnComponents.ts` 已让回合内容共用 `TurnRenderAdapter`。`agentTodoPresentation.ts` 的行在实时 `AgentTodoView` 中经 `innerHTML` 注入，在 `historyRender.ts` 中直接拼入 HTML。Todo 和 Acceptance 的外壳由实时与历史分别构建。实时 trace 外壳与工具分组由 `AgentTraceView` 构建，结构化消息的详情和引用已走 `renderTurnMessage`，历史命令组有自己的披露标记。表单和 Composer 的状态、事件及定位需要真实 DOM。

`plan-acceptance` 定义用户勾选、焦点恢复、计数和执行完成规则。`agent-result-boundary` 定义 Agent 信封。显示型结果由新确定性方法生成，其方法和结果 kind 均独立。

## Goals / Non-Goals

保留四条路径当前的可观察行为，让实时、自带历史和脚本输出共用 Trace 部件及受限节点语义。组件源码归仓库，沿用 VS Code CSS 变量、现有运行时与类型生成。显示入口的范围限于当轮 Output。导航、主题 API、交互回传和 Tier 2 渲染器均在本次范围之外。

## Decisions

### 1. 重复统计

按源码构建点计数。循环、条件与多次渲染只计一个构建点，表内项目可能重叠。目标数字表示共享实现数量，调用点继续存在。实施后用同一口径复核。

| 结构 | 当前来源与数量 | 目标 |
| --- | --- | --- |
| Todo 外壳、独立验收组 | 各 2 处，`agentTodoView.ts` 构造函数与 `agentTodoPresentation.ts` 的 `renderAgentTodos` | 各 1 个共享组合 |
| 开发任务、验收复选框行 | `agentTodoRows`、`agentAcceptanceRows` 各有 2 个生产调用点。`todoRow`、`phaseRow` 与复选框各有 1 个构建点 | 各保留 1 个构建点，取得 DOM 输出能力 |
| 折叠壳与标题槽 | 11 处。`turnComponents.ts` 的 `renderTurnSection`、`renderTurnJson`、`renderTurnMessage.disclosure` 共 3 处，后者供引用和消息分节复用。`agentTodoPresentation.ts` 的 `phaseRow`、`renderAgentTodos` 共 2 处，`agentTodoView.ts` 构造函数 1 处，`agentTraceView.ts` 的 `createToolGroup`、`createToolCommand` 共 2 处，`historyRender.ts` 的 `commandRow`、`process` 共 2 处，`webview/main.ts` 的步骤错误与 `disclosureSummary` 共 1 处 | 共用 1 组折叠、触发和内容部件。历史会话、记录和交互应答外壳有独立语义，继续就地组合 |
| 状态、计数 | 状态行 3 处为 `phaseRow`、`todoRow`、`agentAcceptanceRows`。计数容器 5 处为两份 Todo 外壳各自的两组计数和 `phaseRow`，过程详情也消费描述槽 | 各用 1 个 TraceLine 和 TraceDescription 实现。任务状态文字由 Badge 承载，计数由 Description 承载 |
| 块级代码与加载图标 | `renderTurnJson`、`AgentTraceView.createToolCommand`、`main.ts` 的代码块、历史 `commandRow` 共 4 处。Spinner 有 Todo 状态与标签活动 2 处生产场景 | CodeBlock、Spinner 各 1 个。回合分隔视觉目前只有 `.turn-output` 边框，继续就地使用，Separator 供脚本使用 |
| 菜单项、分类行、空态 | `main.ts` 的 `renderSkillsMenu`、`renderComposerMenu`、`renderModelMenu`、`appendPluginCategory`、`renderPluginChoices`、`appendHarnessPresetManagementMenu`、`renderHarnessPresetChoices`、`renderHarnessPresetManagement`、`renderModelChoices` 共 10 个选项构建点，其中分类行有 3 个。Empty 有 6 个构建点 | 基础项 10 → 1，分类行 3 → 1，Empty 6 → 1。业务分支和唯一的子菜单标题就地组合 |
| 标签选中态 | `conversationTabs.ts` 的 `renderConversationTabs`、`main.ts` 的 `selectConversation`、宿主切换消息分支、`renderResourceSource` 共 4 个写入点。两个 tablist 在 `sidebarProvider.ts` 声明 | 四处调用同一状态写入函数，静态容器在各自页面初始化 |

### 2. 适配器和绑定

选择 (b)。保留 `element(tag, attributes, children)`，先构建再调用 `bindXxx(element, actions)`。绑定读取宿主手里的 DOM 引用和数据，沿用 `AgentTodoView` 的事件委托和 B 群局部监听。第二套适配器会让共享部件依赖输出介质的事件能力。

A 群的 `interactive` 控制组件数据操作。历史和实时的验收控件都有原生 checkbox，历史加 `disabled`。脚本树不安装监听，复制按钮原生禁用。回合外壳提供的原生披露、既有引用和原始输出复制由各宿主管理。B 群用原生状态和宿主绑定。Button/Label/Checkbox 的共享标记供 A 群使用时，禁用选项由 A 群组合持有。

### 3. 平台原语覆盖度

`turnDomAdapter` 跳过布尔 `false`，以空属性设置 `true`。这对初始构建的 `disabled`、`checked`、`open`、`hidden`、`inert` 正确。字符串 `"false"` 会让 HTML 布尔属性成立，ARIA 则应使用字符串 `"true"`/`"false"`。已连接控件的值和 checked/disabled 由宿主属性更新。补齐 HTML 适配器对 void 元素的输出，并测试解析后结构与 DOM 等价。

`InteractionDialog` 已采用 `showModal()`。平台提供顶层、cancel 事件、背景 inert 和模态焦点范围，代码未另设背景 `inert`。应用负责名称、业务取消、全屏优先的 Escape 顺序和返回此前焦点。Select 的 `popover="manual"` 提供顶层与显隐，点外关闭目前通过失焦，Escape 和焦点回退由代码处理。菜单当前用 `hidden` 和文档点击委托。方向键、停用项跳过、选中状态、子菜单层级、定位和 typeahead 仍各有宿主责任，见第 14 项。[HTML Dialog](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-dialog-element) · [HTML Popover](https://html.spec.whatwg.org/multipage/popover.html)

### 4. 组件与容器职责

| 控件 | 构建与本地绑定 | 容器 |
| --- | --- | --- |
| Form 与字段 | 字段、错误行、动作壳，原生控件值与局部变化通知。在既有按钮上写入状态 | `InteractionForm.refresh` 时序、`validateUiAnswers`、草稿、提交锁、`InteractionFileHost`、引用字段、secret 清除及发送。`AgentInputView` 决定 inline/Dialog |
| Dialog 与 Select | `showModal/close`、名称、焦点和 cancel 绑定。Select 保留定位、按键、选中映射与回退 | 请求归属、草稿与答复协议。全屏切换仍供 inline 卡复用 |
| Menu | 菜单标记、焦点、可见性、选项状态、子菜单按键 | Composer 保有 CLI、模型、技能、分类、权限、锁定、提交、溢出和点外关闭的协调 |
| Tabs | 共享 tab 状态写入、标签及本地选择绑定 | `conversationTabDrag.ts` 的重排与 Escape 取消，`main.ts` 的滚动、会话切换、草稿、已有 tablist 和资源场景 |

### 5. Menu 与 Tabs 的收益

值得迁移共享标记与状态，收益见第 1 项。约 500 行的 Composer 业务规则保留原归属。技能的第三层命令目前是 skill 行内的 `small` 文本。模型子菜单才有独立弹层、几何和 ←→ 行为。特征测试分别锁定这两种结构。若共享构建无法覆盖现有输入，保留仍在用的路径并报告该分支。

### 6. Todo 影响面与断言

全仓搜索得到 `agentTodoRows` 的 2 个生产调用点（`agentTodoView.ts:68`、`agentTodoPresentation.ts:98`），`agentAcceptanceRows` 的 2 处（`agentTodoView.ts:96`、`agentTodoPresentation.ts:96`），`renderAgentTodos` 的 1 处（`historyRender.ts:360`）。实时层使用 DOM 构建，静态层使用 HTML。现有字符串函数保留为同一构建的薄入口，测试仍能直接读 HTML。

`test/agentTodos.test.ts:103–150` 有 8 个 `agentTodoRows` 调用表达式与 23 个相关 HTML `expect`（运行时 31 次，Markdown 循环每轮 8 条）。`renderAgentTodos` 有 4 个调用表达式，验收和无验收分支有 12 个独立 `expect`，另共享该循环。`test/historyRender.test.ts:754–760` 有 6 条直接验证验收历史的断言，`agentTodos.test.ts` 的中断历史 fixture 另有 6 条 HTML 断言。计划改动这些行为断言 0 条，新增双介质与实时委托覆盖。实施时逐条记录必须替换的源码断言。

### 7. 既有测试与缺口

- Menu 有 `sidebarLayout.test.ts:935–953` 的结构、CSS 和定位源码断言，`checkComposerLayoutUi.mjs` 检查布局，`checkResourceUi.mjs` 有技能 pack 的三态场景。迁移前补模型右/左/上、夹取、缩放、Escape、方向键、选中回调和空态的特征检查。
- Tabs 有 `sidebarLayout.test.ts` 的 tablist 和行结构、`checkConversationTabsUi.mjs` 的活动状态与草稿、`conversationTabOrder.test.ts` 的重排、`checkResourceUi.mjs` 的资源分段选中值。迁移前补实时焦点、活动/disabled、固定和关闭、拖拽取消与提交、分段联动的特征检查。
- Interaction 有 `checkInteractionUi.mjs` 验证键盘、bounds、全屏与焦点、草稿、重复提交、拖放、IME 等行为，也有 `uiForm.test.ts`、`uiInteractionPresentation.test.ts` 和 `conversationInteractionController.test.ts` 验证数据契约。补充模态背景范围、焦点边界、就地刷新保留同一按钮对象。

### 8. 稳定 id

公共树的行无需 id，展示使用顺序和层级。未来可引入可选标识或独立交互节点，现有只读树仍可使用。Todo/验收 id、trace 事件 id、DOM `for/id`、ARIA 关系与复制槽分别保留既有用途。重复结果同页出现时，宿主生成的内部 id 需限制作用域。

### 9. 结果落点

确定性处理器返回内部 `{ kind: "view", nodes }`。在 `renderTurnResult` 和 `resultCopyText` 显式分派，`DextResult`、共享解析、history hydrate/export、结果记录及 replay 复用树的校验。外层需要摘要时只取可见文本，节点原样留作重放。

`src/runner/dextRuntime.mjs:148–199` 每次调用发一条 `step`，既有 `quiet` 由 `echo` 决定。`dextHost.ts:298–311` 按条追加。`main.ts` 的 `renderResult` 先清空旧输出，再遍历完整的 `response.steps` 逐项 append，`historyRender.ts` 的 `output` 同样遍历。因此顺序调用两次可在同一回合上下显示，结果没有按 kind 覆盖。保留现有完成后绘制时机。

### 10. 入口和 schema

在现有 `ui` 命名空间新增 `ui.render({ nodes }): Promise<void>`。`ui.render` 负责只读显示，`ui.form`、`ui.confirm` 等现有方法继续等待用户应答。`ui.render` 经 `invoke` 发起校验和记录，结果走内部 `view` kind，复用既有 `step` 与 replay 并默认显示。Promise 完成表示结果已记录，无需用户确认。

`nodes` 是按显示顺序排列的顶层 `UiNode[]`，类型目录名称为 `ui.Node`。节点是纯 JSON 对象，`type` 按以下部件名判别，容器通过 `children` 嵌套。开放 `Trace`、`TraceLine`、`TraceIcon`、`TraceTitle`、`TraceDescription`、`Text`、`Markdown`、`Code`、`CodeBlock`、`Separator`、`Badge`、带名称的静态 `Spinner`、`Alert`。折叠部件、B 群控件、宿主动作与业务 id 留在内部。`Trace` 接收可选 `ordered` 和仅含 `TraceLine` 的 `children`，行接受可选 `status`、`tone` 和组合子节点。`status` 沿用 `pending`、`in_progress`、`completed`，图标仅允许宿主列出的名称。内容叶子只接受表中对应的字符串及允许的枚举，`Separator` 只需要 `type`。Markdown 沿用 `dextMarkdown`，脚本变体输出链接的文字并禁用 URL 及主动加载资源，Text/Code 显示标记字面量。脚本节点禁止定义 HTML、class、style、ARIA、data 属性、任意标签和处理器。

```ts
import { ui } from "dext";

await ui.render({
  nodes: [
    { type: "Markdown", source: "**检查结果**" },
    {
      type: "Trace",
      children: [
        {
          type: "TraceLine",
          status: "completed",
          children: [
            { type: "TraceTitle", text: "类型检查" },
            { type: "TraceDescription", text: "已通过" },
          ],
        },
      ],
    },
  ],
});
```

复用 `builtins.ts`、`builtinTypeDefinitions.ts`、`dextApiTypes.ts` 的 `shapeType`、判别字段和具名类型闭包。`ui.Field` 为判别生成的先例，公共节点递归采用具名引用，避免无限展开 FieldDefinition。复用 `renderUiGroup` 在现有 `ui` 声明中生成 `render`，分别描述公开的 `Promise<void>` 和内部结果 schema。初始上限选用 32 层、1,000 个节点、256 KiB UTF-8。通过有界预检查后运行递归校验，失败包含节点路径且无部分输出。验证实际导出、递归声明与 API Reference 同步。

### 11. 八个 Trace 部件的组合验证

两处可以共用。Trigger 可直接承载 TraceLine 的槽位，Content 可直出既有子元素，使 `summary.agent-todo-item` 和引用披露保留直接子级。可信宿主选择既有标签与类。原生 `ul/ol` 保有列表语义，需要保留现有非列表标签时在合法父子位置采用 `role=list/listitem`。嵌套通过 children，计数、`verify:` 和过程元信息经 Description。保留现有 summary 动作，检查点击动作不会同时误切折叠。

```text
Plan
TraceCollapsible
  TraceCollapsibleTrigger[TraceLine → TraceIcon, TraceTitle, TraceDescription(count)]
  TraceCollapsibleContent[
    Trace[
      TraceCollapsible → TraceCollapsibleTrigger[TraceLine → TraceIcon, TraceTitle(Markdown), TraceDescription(count)]
        → TraceCollapsibleContent[Trace[TraceLine(status) → TraceIcon, TraceTitle(Markdown + TraceDescription(verify)), Badge]]
    ],
    Trace[TraceLine → Checkbox, Label(Markdown)]
  ]

agent trace
Trace[
  TraceCollapsible
    TraceCollapsibleTrigger[TraceLine → TraceIcon, TraceTitle, TraceDescription(meta)]
    TraceCollapsibleContent[Trace[
      TraceLine(tone) → TraceDescription(meta), Text,
      TraceCollapsible → TraceCollapsibleTrigger[TraceLine → TraceIcon, TraceTitle, TraceDescription(ref)]
        → TraceCollapsibleContent[Text(path), CodeBlock],
      TraceCollapsible → TraceCollapsibleTrigger[TraceLine → TraceIcon, TraceTitle(JSON)]
        → TraceCollapsibleContent[CodeBlock]
    ]]
]
```

部件命名、children 和两种组合来自 shadcn 的模式。[shadcn Trace](https://ui.shadcn.com/docs/components/base/trace) · [shadcn Plan](https://ui.shadcn.com/docs/ai-elements/base/plan) · [shadcn Task](https://ui.shadcn.com/docs/ai-elements/base/task)

### 12. Tier 1 接口和落点

将八个 Trace 部件组织在 `presentation/` 的同一文件，内容与反馈同层按职责组织。`presentation/` 当前 7 个文件，`browser/` 有 28 个文件，维持现有目录边界。DOM 专用构建和绑定优先扩展 `browser/` 现有模块。公共 schema 进入 `shared/contracts/`，类型目录归 `workflow/domain/`。下表含内部步骤所需字段，公共字段以第 10 项白名单为准。

| 部件 | 群 | 字段 | 子节点 | a11y 契约、绑定 | 现有对应物 |
| --- | --- | --- | --- | --- | --- |
| Trace | A | 列表类型、内部容器 | TraceLine、TraceCollapsible | ul/ol 或合法列表角色，无绑定 | agent-todo-list、turn-section-body、agent-result-section |
| TraceCollapsible | A | open | Trigger 后接 Content | details 原生展开态，无业务绑定 | renderTurnSection、phaseRow、json-disclosure |
| TraceCollapsibleTrigger | A | 标题槽、内部动作槽 | TraceLine 槽 | 第一子节点 summary 有可访问名，Enter/Space 原生，附属动作宿主绑定 | summary |
| TraceCollapsibleContent | A | 内部容器或直出 | Trace、TraceLine、内容 | 折叠时由 details 隐藏，无绑定 | 分组及披露体 |
| TraceLine | A，B 复用内容 | status、tone | Icon、Title、Description、内容、子 Trace | 保留列表关系和文字状态，菜单点击由 B 群处理 | todoRow、验收行、result detail、menu item 内容 |
| TraceIcon | A+B | 允许的 icon 名 | 无 | 装饰图标 aria-hidden，无绑定 | codicon、chevron |
| TraceTitle | A | text、内部内容槽 | Text、Markdown、Code、内部 Description | 可见标题可作触发器名称，无绑定 | agent-todo-text、trace summary label |
| TraceDescription | A | text、tone、内部 live | Text、Code | 可读计数与元信息，实时总计沿用 aria-live="polite"，无绑定 | turn-section-meta、agent-result-meta、verify |
| Text | A+B | text、tone | 无 | 文本节点，语义随容器，无绑定 | 标题、detail |
| Markdown | A+B | source | 无 | 保留标题、列表、代码，脚本链接和外部资源惰性，内部链接按宿主行为 | todoMarkdown、dextMarkdown |
| Code | A+B | text | 无 | 原生 code，无绑定 | 行内代码 |
| CodeBlock | A | code、内部 copy 槽 | Code、内部复制按钮 | pre/code，复制按钮具名且只读原生禁用，内部宿主绑定复制 | renderTurnJson、trace code、reference |
| Separator | A | 无 | 无 | 独立内容使用 hr，无绑定 | turn-output 用边框表达分隔 |
| Badge | A+B | text、status | 无 | 可见状态文字及 data-status，无绑定 | agent-todo-status |
| Spinner | A+B | label、是否装饰 | 无 | 装饰态 aria-hidden，独立状态具名且避免重复播报，无绑定 | todo active、conversation-tab-activity |
| Alert | A+B 共享标记 | text、tone | Text | 动态宿主错误 role=alert，静态脚本提示只贡献提示文字，无绑定 | interaction-error |
| Empty | B | text | Text | 可读空态且不进入方向键选项，无绑定 | composer-menu-empty |
| Button | B，A 复制复用标记 | kind、disabled、label、title | Text、图标 | 原生按钮，图标按钮具名，宿主绑定动作 | 关闭、全屏、表单动作、tab close/pin |
| Label | B，A 验收复用标记 | for、text | Text、Markdown | 与唯一控件 id 对应，无独立绑定 | agent-acceptance-text、选择表单 |
| Field | B | label、description、required | Label/legend、控件、描述 | fieldset/legend 和可读必填提示，控件具名并关联描述，无独立绑定 | interaction-field |
| Input | B | value、placeholder、secret、disabled、label | 无 | 具名原生 input、密码和禁用语义，宿主绑定输入与拖放 | InteractionForm、InteractionReferenceField |
| Textarea | B | value、placeholder、disabled、label | 无 | 具名原生 textarea 与换行编辑，宿主绑定输入与拖放 | InteractionForm 多行 |
| Checkbox | B，A 验收复用标记 | checked、disabled、id、group、custom | Label，B 群自定义输入 | 原生 checkbox 与唯一 for/id，Space 操作。只读禁用保留值，宿主注入状态更新 | selectionGroupField、agentAcceptanceRows |
| Radio | B | name、checked、disabled、custom | Label、自定义输入 | 原生同名组及 legend，方向键/Space 原生，宿主绑定自定义项 | selectionGroupField |
| Select | B | options、multiple、selected、expanded、label | trigger、listbox、option | 触发器具名，aria-controls/expanded、role=option/aria-selected，宿主绑定焦点与键盘 | selectField |
| Form | B | title、description、action、error、提交态 | Field、Button、Alert | 字段标签、错误播报、动作禁用，由容器注入请求绑定 | interactionForm |
| Dialog | B | label、fullscreen、open | Form、关闭和全屏 Button | 原生 modal、背景 inert、Escape 与焦点恢复由宿主配合 | interactionDialog |
| Menu | B | label、expanded、role、checked、disabled | trigger、项、分类头、子菜单、Empty | 具名、菜单角色、aria-expanded/checked，绑定第 14 项键盘流程 | Composer、模型子菜单 |
| Tabs | B | selected、running、pinned、disabled、label | tablist/tab、按钮、Spinner | 保留角色、名称、aria-selected 与键盘可激活动作，宿主注入切换和固定 | conversationTabs、resource-source-toggle |

### Tier 2

Table、Progress、Tooltip、Popover、Drawer、Toast、Breadcrumb、Slider、Switch、Avatar、Skeleton、Kbd 均为「无消费者，待需求」。内部 schema 目录记录这 12 个保留的 `type` 名称和待需求状态。Table 保留名字，排序与选择需另立交互协议。可调用的公共联合、渲染分派和 API Reference 只列已支持项。

### 13. CSS Anchor Positioning

VS Code 1.105.0 固定 Electron 37.6.0，Chromium 138.0.7204.251。现有 `engines.vscode` 为 `^1.106.0`，1.106.0 固定 Electron 37.7.0，Chromium 同版本。Chromium 125 有 `anchor-name`、`position-anchor`，128 支持现名 `position-try-fallbacks`。两版都支持。[VS Code 1.105.0](https://raw.githubusercontent.com/microsoft/vscode/1.105.0/.npmrc) · [Electron 37.6.0](https://releases.electronjs.org/release/v37.6.0) · [VS Code 1.106.0](https://raw.githubusercontent.com/microsoft/vscode/1.106.0/.npmrc) · [Electron 37.7.0](https://releases.electronjs.org/release/v37.7.0) · [Chrome 锚点语法](https://developer.chrome.com/blog/anchor-syntax-changes)

模型子菜单采用纯 CSS 方向。用现有选择器建立锚点及受 `.app-shell` 约束的定位空间，定义右、左、上 fallback。锁定现有 216px 上限、4px 间距、8px 边界和 24px 宽度余量，并验证居中列裁切、紧凑 Composer、滚动和 resize。几何检查通过后移除 `positionModelSubmenu` 和所属样式写入。CSS 例外仅用于现有模型选择器设置锚点、包含块及 fallback，预计新增 class 0 个。若包含块的等价行为失败，保留手写实现并记录实测场景。依赖保持当前清单。[Chrome CSS Anchor Positioning](https://developer.chrome.com/docs/css-ui/anchor-positioning-api)

### 14. 键盘契约与剩余工作量

| 控件 | 平台已给 | 已有手写行为 | 现状缺口 |
| --- | --- | --- | --- |
| Menu | Button 的 Enter/Space、原生 Tab 顺序 | ↑↓ 循环、Home/End、跳过 disabled、→ 进模型子菜单、← 回主菜单首项、Esc 关闭并回触发器 | 无 typeahead，Tab 无统一关闭，子菜单 Esc 当前关闭整组 |
| Select | Button 激活、manual popover 顶层、原生 Tab 顺序 | 触发器 ↑↓ 打开，列表 ↑↓ 和 Home/End，Esc 先于 Dialog 且回焦，Tab 与失焦关闭 | 无 typeahead，无 Tab 循环，←→ 不适用纵向列表 |
| Tabs | Label button 的 Enter/Space、原生 Tab 和按钮 disabled | 指针即时选中、键盘按钮点击、资源分段点击、拖拽 Escape 取消 | 无 roving tabindex、←→、Home/End。横向标签无需 ↑↓、typeahead 和 Tab 循环 |
| Dialog | showModal 的模态 Tab/Shift+Tab、Esc cancel、背景 inert | Escape 全屏优先，关闭后恢复此前焦点 | 方向键与 Home/End 归字段本身，Dialog 无全局 typeahead |

等价迁移约 75–110 行现有键盘/焦点逻辑（Menu 40–55，Select 20–30，Tabs 0–10，Dialog 15），新键盘行为预计 0 行。共享输出把技能 `aria-checked` 的 checked/unchecked 值映射为 true/false，mixed 照旧，保留内部态并逐项记录 ARIA 属性差异。`toggleComposerMenu` 当前用 `aria-checked="true"` 找初始焦点，技能归一后需显式保留首个可用项的焦点策略。APG 的额外按键与焦点功能属独立行为变更。[WAI-ARIA Menu](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) · [WAI-ARIA Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) · [WAI-ARIA Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) · [WAI-ARIA Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

## Risks / Trade-offs

- 多余包装会破坏 CSS 直接子级、列表或 summary 行为。比对解析后标签、class、属性、层级及控件当前值，逐项记录合法的可访问性补充与禁用语义差值。
- `sidebarLayout.test.ts:941–946` 中已有 5 条位置实现断言，分别覆盖两条旧 CSS、方向决策函数、居中列裁切以及排除错误视口基准。CSS 等价成立时用可测量的边界与回退顺序代替它们，保留其他约束。
- 历史有文件路径链接化，实时有富文本增强。脚本结果区排除这些处理，避免惰性文本变成操作入口。现有历史数据可直接回放。

## Migration Plan

按 tasks 的 1–9 阶段推进。A 群先做结构比对，再迁移 turn、Todo、历史和计数承载。B 群先锁定结构与行为再迁移，表单、标签、菜单分别检查。脚本入口最后接入结果链和生成器。阶段无法证明等价时保留仍在用的路径，并报告具体失败场景和契约。Menu 的标记构建和 CSS 定位可独立核验和回退。

## Acceptance

以下操作由用户在真实 VS Code Webview 完成。

- [ ] 在浅色、深色和高对比度主题分别打开含分组 Todo、verify、验收、工具 trace、引用和 JSON 的会话，再重开历史。比较层级、字距、图标、分隔线和折叠后的内容，预期与当前界面一致，历史验收保留勾选值且禁用。
- [ ] 用 Tab 打开表单、展开 Select 并按 Escape，之后切全屏并按两次 Escape。预期依次关闭 Select 并回焦、退出全屏、取消并返回触发元素，焦点始终可见。
- [ ] 使用键盘激活会话标签与资源分段，验证关闭/固定按钮、拖动取消和重排。预期显示的标签、面板、草稿和焦点按现有流程切换。
- [ ] 在窄侧栏、宽编辑器和居中列裁切场景打开模型子菜单并调整宽度。预期右侧优先、空间不足时向左或向上，子菜单可滚动且完整显示，方向键和 Escape 的回退顺序保持一致。
- [ ] 在脚本回合连续显示两棵树并重新打开历史。预期两项按顺序显示，显示内容、层级与禁用状态一致。
