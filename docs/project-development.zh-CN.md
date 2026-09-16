# 项目知识与对话 Review

[English](project-development.md) | 简体中文

[返回 README](../README.zh-CN.md)

Dext 把两类理解严格分开：**项目知识**长期存在、属于仓库；**对话 Review**只描述某一次运行，永不写回项目。

[项目文件](#项目文件) · [知识维度](#知识维度) · [对话 Review](#对话-review) ·
[Review 预设](#review-预设) · [编辑器标签](#编辑器标签) · [主动初始化](#主动初始化) · [系统图与-archify](#系统图与-archify) · [校验](#校验)

## 项目文件

项目数据位于工作区的 `.dext/` 下：

| 路径 | 内容 |
| --- | --- |
| `.dext/project.json` | schema 版本、乐观锁 `version`、默认 Review 预设、知识开关 |
| `.dext/project-intent.json` | 初始化时 AI 生成的项目简介和语义知识 |
| `.dext/objects/<id>.json` | 每个文件一个已确认的长期对象 |
| `.dext/architecture.json` | 人工声明的设计决策与架构规则；规则针对其指定的已保存图求值，不依赖源码扫描 |
| `.dext/diagrams/<id>.json` | 与渲染器无关的 AI 架构图 IR，每张图一个文件 |

`ProjectStore` 通过一个极小的文件宿主机读写这些文件，因此同一套逻辑可运行在扩展、worker 或内存测试替身中。每次写入都携带期望的 `version`；并发修改返回 `{ status: "conflict" }` 而不会覆盖。`project.json` 缺失或损坏时回退默认值，绝不阻塞开发。

`ProjectObjectReference` 保存稳定的 `objectId`。重命名对象会保留 id 并把旧名记入别名，引用、链接与测试因此不会因改名而失效。

## 知识维度

项目对象携带四个彼此独立的维度，绝不合并成单一状态。

- **来源**（`source`）：`code`、`ai`、`user`。
- **确认**（`confirmation`）：`draft`、`accepted`、`rejected`——用户决定。
- **有效性**（`validity`）：`current`、`needs_verification`、`stale`、`conflicted`——与代码再核对的结果。
- **归属**（`ownership`）：`owned`、`shared`、`candidate`、`unassigned`。

接受 AI 建议会设置 `confirmation: "accepted"`，但 `validity` 仍为 `"needs_verification"`：接受建议不等于已对当前代码核实。`validateProjectObjects` 会报告重复 id、重复名称/别名以及悬空的 `relatedIds`。

旧字段 `status` 仍可解析。`normalizeProjectObject` 负责迁移：`accepted`、`stale`、`conflicted` 都映射为 `confirmation: "accepted"`，并补齐其余维度。新代码只写四个维度。

## 对话 Review

`TurnReview` 以 `sessionId + turnId + runId` 为键，反馈绝不会落到另一次运行、更早的尝试或别的 Plan Build 上。Review 还会记录产生时的 `projectVersion`、`planVersion`、`buildRunId`；`reviewRepresentsVersion` 会拒绝基于旧项目版本得出的结论。

`TurnReviewStore` 在内存中保存 Review，按最旧优先淘汰并有上限；`TurnReviewController` 提供宿主所需动作：`find`、`submitFeedback`（返回 `not_found`、`stale`、`accepted`、`rejected`）、`diffTargets`、`acceptanceCard`、`adoptKnowledgeSuggestion`。接受代码改动与采纳知识建议是两个独立决定，后者会拒绝过期的 `baseVersion`。

### 单轮 Review 视图

`renderTurnReview` 生成可折叠区域。纯 Ask 轮次，或没有开发改动、也没有待验收内容的轮次，不产生验收卡片。只有提供方明确报告过 Hook 结果时才展示；未知或失败的 Hook 绝不会渲染成通过。

### Plan Review

`buildPlanReview` 汇总同一个 Build 的每一轮。`associatePlanChanges` 只依据显式记录的任务关联来分组：被多个任务同时拥有的改动进入「共享改动」，没有任何关联的改动保持「未归属」。Dext 绝不根据 AI 的任务勾选推断文件归属。`finalizePlanReview` 记录 Build 级决定；中间任务 Review 从不阻塞续写，只有最终 Review 等待用户。

## Review 预设

两个预设改变 Review 的关注点，与 Ask/Agent/Plan/Code 相互独立：

- **engineering** 侧重设计决策、模块边界与改动理由。
- **experience** 侧重行为变化、反馈与手工验证。

`resolveReviewPreset` 依据项目默认值与可选的单次覆盖决定预设。Ask 模式下结果为只读，并记录捕获时间。

## 编辑器标签

项目、API、全局资源与历史都以编辑器标签打开，并共用同一层：

- `editorTabTypes` 定义标签种类、视图类型、标题、页面与稳定键格式。
- `editorTabState` 校验持久化状态；未知页面回退到该类型的默认页。
- `editorTabManager` 对每个键最多创建一个面板，支持 reveal/close，并使用注入的宿主机，便于脱离 VS Code 测试。
- `editorTabSerializer` 提供与 `WebviewPanelSerializer` 兼容的恢复路径，并带占用守卫，因此序列化恢复与主动恢复不会重复打开同一标签。

项目标签暴露 **概览**、**知识**、**系统图**三页，内部页面键仍为 architecture 以兼容标签恢复。不设 Hook、Review、扫描目录或渲染器偏好控件。

## 主动初始化

打开、恢复、切换或刷新项目标签只读取已经保存在 `.dext` 中的数据。Dext 不会在后台枚举源码、运行解析器、调用 AI 或写入 `.dext`。只有在用户主动选择 **初始化项目知识** 或生成图时，才会读取受限的 README、文档、清单和必要源码文本。

初始化状态机分为三个阶段：

1. **准备证据** —— 读取受预算约束的证据包：README／文档、清单与必要源码文本；同时应用文件数、单文件大小、总字符数、排除规则、路径校验和脱敏限制。不构造 AST、不提取导入关系、不运行语言解析器。
2. **AI 生成** —— 所选项目 AI CLI 返回一份严格 JSON，包含 Project Intent 和零到多张图。证据、稳定 ID 引用和各类图所需的语义结构都会先对照本次受限输入校验，再进入保存阶段。
3. **校验与保存** —— 先写入 Intent 和每张图；只有全部写入成功后才把 `.dext/project.json` 标记为 `initialized`。失败或取消的运行绝不显示成功，较早运行的迟到响应也不能覆盖新状态。

没有有效已存 Intent 的项目显示 **未初始化** 和主动初始化入口。旧 `initialized` 标记、旧扫描数据或引擎偏好文件都不算成功。
运行中、失败、取消及缺少图会分别显示；
重启后从有效 Intent、已存图和初始化记录恢复状态，只有图的项目仍可查看图，并单独提示知识尚未初始化。

## 系统图与 Archify

Project 的语义模型和 `ProjectDiagram` IR 是唯一事实来源，由唯一固定引擎 Archify `2.17.0-dev.1+d673e830` 渲染。运行时位于 `vendor/project-diagrams/archify`，由 `context.extensionUri` 定位（不再依赖 `process.cwd()`），无需安装 skill、Python 或在线渲染服务。

五类图共享节点、关系和证据结构，并按类型增加可选的渲染器中性语义：

| 类型 | 可选语义结构 |
| --- | --- |
| 架构图 | 边界分组与依赖方向 |
| 工作流图 | 泳道、显式顺序、分支条件、异常路径、分组布局 |
| 时序图 | 有序参与者与调用／返回消息 |
| 数据流图 | 2–5 个阶段与节点 `stageId` |
| 状态机／生命周期图 | 初始／普通／终态、事件、条件与转换 |

Archify 转换分别映射五份上游 Schema（含 `data_flow → dataflow` 与 workflow v2 的 0–5 列），维护 Project ID 与 Archify ID 双向映射，在上游 Schema 支持时传递源码证据，并对仅布局类诊断执行有上限的修复；语义错误保留可理解诊断。

**系统图** 页在沙箱 iframe 中嵌入完整 Archify HTML，保留原生视觉、搜索、缩放与探索能力。父页面持有 VS Code API；iframe 消息校验来源窗口与会话，操作以 `diagramId` 和语义版本定位。页面提供图选择、生成／更新、刷新、导出与全屏，校验、版本和证据覆盖详情放在折叠区域。

### 声明的架构规则

`.dext/architecture.json` 可以针对某一张已保存图的**稳定 Project 节点 id** 声明规则，因此 Archify id 或布局变化不会让规则失效：

```json
{
  "schemaVersion": 1, "version": 0, "updatedAt": 0,
  "decisions": [],
  "diagramId": "architecture",
  "rules": [
    { "id": "no-ui-db", "type": "deny", "from": "ui", "to": "db", "reason": "UI 只能经 API 写库" },
    { "id": "api-only", "type": "allow", "from": "api", "to": "db", "reason": "只有 API 可以访问数据库" },
    { "id": "acyclic", "type": "no_cycles", "from": "*" }
  ]
}
```

`deny` 命中确实存在的关系，`allow` 命中所有从 `from` 出发但目标不是 `to` 的关系，`no_cycles` 命中依赖环。系统图页会列出规则以及当前图违反的条目；当声明了规则却无法求值（未写 `diagramId` 但存在多张架构图、`diagramId` 指向不存在的图、或还没有架构图）时，页面会明确说明而不是猜一张图。规则写错会让整个文件不可用并回退默认值，不会被静默忽略。

正式导出仅 **HTML** 与 **SVG**，都读取当前显示的同一次成功渲染结果。HTML 可独立打开；SVG 通过桥接取得原生序列化结果（保留样式、字体和背景），由扩展宿主保存。新版本渲染失败时展示同图最近成功版本并标明实际版本，因此导出与所见一致；切图、关闭页面或启动更新会取消过期任务。


## 校验

```bash
npm run check      # tsc --noEmit、eslint 与生产构建
npm run test:host  # VS Code 激活冒烟测试
```

浏览器检查在本地 Chromium 或 Edge 中运行，并且刻意不并入 `npm run check`，以免标准门禁依赖本机浏览器：

```bash
npm run check:ui                        # 依次运行下面四项
node scripts/checkComposerLayoutUi.mjs  # 输入区附件向上生长、底栏对齐、窄视口
node scripts/checkStreamJumpUi.mjs      # 跳到底部控件不遮挡对话滚动条
node scripts/checkEditorTabsUi.mjs      # 编辑器外壳、Project 各页、CSP 与主题
node scripts/checkProjectDiagramsUi.mjs # 五种原生图表、未初始化／空状态、桥接与导出
```

assertWebviewAssets.mjs 依据 esbuild 依赖清单证明运行包不含 TypeScript 编译器或旧扫描／引擎实现，确认适配器引用的 Archify 入口、五份 Schema 与五个渲染器存在，且 `vendor/project-diagrams/drawio` 未进入分发包；其余 vendor 内容随包分发由 `.vscodeignore` 未排除 `vendor/**` 保证。

项目层单元测试可运行：`npx vitest run test/project*.test.ts test/editorTab*.test.ts test/turnReview*.test.ts`。
