# 项目知识与对话 Review

Project 设置位于 **Project > Overview** 的一个可折叠区域，包括初始化选项、默认 Review 预设、工作区 Plan 目录，以及项目相对的 API、Skill 和 MCP 目录。资源目录输入框直接显示当前的 `.dext/api`、`.dext/skills` 和 `.dext/mcp`，多个工作区相对目录用逗号分隔。证据读取的 Standard、Deep、Whole 三档也合并在这里；展开 **Advanced reading settings** 可配置文件数量、字符预算和工作区相对路径范围。改动会自动写入 `.dext/project.json`，并应用于新的对话、Plan 文件、资源重载、项目初始化和生成图。项目尚未保存对应值时，旧的 VS Code 设置仍作为兼容回退。Whole 仍有 1000 个文件上限，证据数字字段留空则跟随所选档位。

[English](project-development.md) | 简体中文

[返回 README](../README.zh-CN.md)

Dext 把两类理解严格分开：**项目知识**长期存在、属于仓库；**对话 Review**只描述某一次运行，永不写回项目。

[项目文件](#项目文件) · [知识维度](#知识维度) · [对话 Review](#对话-review) ·
[Review 预设](#review-预设) · [编辑器标签](#编辑器标签) · [主动初始化](#主动初始化) · [系统图与-archify](#系统图与-archify) · [校验](#校验)

## 项目文件

项目数据位于工作区的 `.dext/` 下：

| 路径 | 内容 |
| --- | --- |
| `.dext/project.json` | schema 版本、乐观锁 `version`、默认 Review 预设、项目路径（`planDirectory`、`apiDirs`、`skillDirs`、`mcpDirs`）、知识设置和 AI CLI 选择 |
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

项目标签保留 **Overview** 和 **Knowledge** 两个主入口。独立保存的图位于阅读目录的次级入口；旧的 `architecture` 页面键会打开同一阅读器中的图库，以兼容标签恢复。

## 按主题理解项目

**Knowledge** 使用“可搜索目录 + 当前主题正文”的布局。说明、交互图或结构图、源码引用和相关主题位于同一阅读路径；项目简介保留折叠的术语表、架构规则和决策。

正文与图共用已有语义 ID。流程图只采用明确保存的 `nextStepIds`，不把数组顺序推断成调用关系。点击节点或连接会定位相关说明并展示源码依据；点击正文步骤会选中对应节点。相关模块可继续进入其主题。旧数据无需迁移，后续生成可补充可选的步骤说明。独立保存的图仍可查看，没有明确主题关联的图会如实标明，不按标题猜测关联。

**Check sources** 主动比对主题及关联图引用的文件哈希。已变化或缺失时显示复核提示；没有哈希、无法读取和超预算仍为无法判断。最多读取 1000 个文件，单文件 256 KiB、总量 32 MB；结果只保留在当前会话，主题内容变化后失效。不调用 AI、不改写知识，打开页面也不自动检查。文件未变化不代表语义结论正确。

**Additional views > Generate a focused view** 在配置范围与预算内优先读取主题引用的源码，已保存主题只作为历史假设。流程图最多 8 个节点，边界图最多 10 个节点。新图留在当前主题，源代码支持时复用已有步骤或边界 ID。关系必须引用实际读到的文本片段，文件清单本身不足以证明调用或依赖。

**Overview > Build project index / Update project index** 先构建 JS/TS、Rust、Python 本地结构索引，再根据完整文件结构信息分批整理职责模块，最后生成项目简介和有证据支持的 C4 边界；详细模块流程仍按需生成。Knowledge 中选择模块只读取已保存内容；点击 **Analyze this module / Update module analysis** 才分析当前模块，同时生成说明与 Archify 图。

模块正文使用同一张图的 `metadata.topicSummary` 和节点 `description`；`topicId`、`topicAnalysis=1`、`topicBasis` 记录归属及索引依据。说明、节点证据和图通过一次 `writeDiagram` 一起保存，更新复用原图 ID，不堆积副本。索引刷新不删除模块分析；对应职责或入口证据变化时显示待更新，旧内容继续可读。失败或取消保留原结果，不覆盖其他模块。手动编辑正文和开发对话自动引用尚未实现。

## 主动初始化

打开、恢复、切换或刷新项目标签只读取已经保存在 `.dext` 中的数据。Dext 不会在后台枚举源码、运行解析器、调用 AI 或写入 `.dext`。只有在用户主动选择 **Build project index**、**Update project index**、**Check evidence** 或生成图时，才会读取受限的文档或源码。

本地索引取消候选文件数与 24 文件上限，遵守配置范围、排除规则和单文件大小限制。扩展随包携带 Tree-sitter WASM 语法；结构缓存保存在扩展的工作区存储中，以内容哈希复用未变化的解析结果，删除文件会移除，配置变化会重新解析依赖。不可读、语法异常及不支持的文件会显示为覆盖问题。包和目录分组仅作为物理索引信息。完整文件归属、符号签名和静态依赖用于构建候选分组；候选分组只组织分批阅读，AI 可以拆分目录内不同职责，也可以跨目录归并同一功能。限定源码范围时，索引仍会补充源码上级目录的 README 和项目配置作为背景，不扩大源码范围。

结构事实请求使用最多 120,000 证据字符（配置更小时遵守配置），每批最多 12 个候选组、60 个源码文件。过大的候选组按文件拆批，不通过丢弃文件或声明缩短输入；单个文件事实仍超预算时明确报错。每个文件必须且只能归属一个职责模块，漏文件、重复归属、虚构文件以及跨模块入口均会校验失败。随后分批归并同一功能的摘要，继续校验全部成员归属；对于无法继续缩减的大目录保留独立主题，不强制压成固定数量。C4 运行边界必须引用实际读取的文档、配置或针对性源码片段，不能从 import 关系推断调用。完整索引中的运行相关导入与入口声明用于选择源码片段，实际读取受证据字符预算约束，并保留原始行号和完整文件哈希。候选事实包含跨批次引用者，辅助辨别共享能力。运行源码片段在最终打包时保留边界优先级，单片段独立限制为 1,400 字符，不受深入读取预设影响。源码预算优先平衡部署路径、打包启动器、浏览器入口与替代传输方式，再补充重复的启动候选；同一文件可以提供进程、网络和协议分派的多个独立片段，未读取的片段间隔不能作为行号证据。即使只有一个源码批次，也会结合成员路径、声明摘要、逐文件依赖和跨批次引用者整理阅读主题；允许拆开初稿分组、重新分配文件，并继续校验完整且唯一的归属与入口。不能仅因格式、库或文件名相似而合并模块。待核实问题单独保存，不混入职责说明；只保留带有成员完整路径并以问号结尾的问题，过滤泛化验证声明。这些规则约束问题的具体程度，不代表问题本身已获得事实验证。最终概览还必须通过 capabilities 将每个职责模块归入且仅归入一个功能域，遗漏、重复和未知模块均会校验失败；Knowledge 按功能域分组，旧的平铺目录保持可读。模块深入分析优先读取保存的 `sourceFiles` 和直接依赖，排除同目录无关文件，仍最多读取 32 个文件、单文件摘录 12,000 字符、总证据 96,000 字符。Knowledge 可查看完整成员文件列表，Overview 区分目录分组和知识模块数量。新职责 ID 由排序后的成员路径生成；更新时，对无歧义且文件集合交并比至少 50% 的延续模块保留 ID，拆分或合并则保存前身引用。分析依据变化时标记过期，索引过程不改写已有图表。前身模块分析，以及保存过成员清单的失联分析，可作为需复核的历史视图继续访问，不会被当作新边界的已验证说明。旧模型仍可读取，主动更新索引后采用新的知识目录，已有图表继续保留。

Overview 还会读取上级目录的 esbuild/Vite/Webpack/Rollup 构建配置作为部署证据，不执行构建脚本，也不把它们作为应用知识模块。TypeScript 类型导入在索引中保留独立标记，不计入非类型引用者列表。对于唯一非类型引用者位于其他模块的小型辅助文件，增加一次受预算约束的 AI 定向复核，继续校验完整且唯一的文件归属。未消除的归属疑点、C4 孤立节点及内部运行单元缺失知识关联，会保存在 `qualityIssues`，并显示于 Overview 和相关 Knowledge 主题。这些是复核提示，不是归属错误的定论或语义正确性评分。系统级架构图将容器交互投影到所属系统，合并描述与证据并删除内部自连接；容器级关系保持原样。

当前依赖解析覆盖常见相对导入、当前 TS 配置中的路径映射、Python package/src 布局和 Rust module/use 路径。宏展开、条件编译、动态加载、继承的 TS 配置和跨语言运行通信尚未完整解析，保留未解析状态。缓存只保存结构事实，不保存完整源码。

初始化状态机分为三个阶段：

1. **准备证据** —— 本地解析配置范围内的源码并缓存完整文件结构事实，形成候选分组；另读取有界文档和配置摘录，作为架构证据。保留排除规则、路径校验、取消与脱敏处理。
2. **AI 生成** —— 所选项目 AI CLI 分批返回严格 JSON，将全部文件分配到职责模块，再跨批次整理知识目录；每一步验证完整且唯一的成员归属；最后生成项目简介和可选 C4 模型，此阶段不生成模块详细图。证据、稳定 ID 引用和各类图所需的语义结构都会先对照本次受限输入校验，再进入保存阶段。Codex 与 Claude 通过各自的原生结构化输出通道（`--output-schema` / `--json-schema`）接收响应 schema，答案由提供方约束，而不只是写在提示词里；若某个 CLI 拒绝该 schema 或无法启动，本次尝试会回退到对话通道并说明原因。信封与一次有界修复由共享的 ax 预测器负责：严格契约解析与证据校验作为它的校验步骤运行，被拒绝的回答会带着这些诊断重新提问，契约未声明的多余键会在校验前丢弃，而不是让本可验证的生成失败。DeepSeek Harness 的 ACP 没有 schema 字段，因此始终走对话通道。
3. **校验与保存** —— 先写入 Intent 和每张图；只有全部写入成功后才把 `.dext/project.json` 标记为 `initialized`。失败或取消的运行绝不显示成功，较早运行的迟到响应也不能覆盖新状态。

没有有效已存 Intent 的项目显示 **未初始化** 和主动初始化入口。旧 `initialized` 标记、旧扫描数据或引擎偏好文件都不算成功。
运行中、失败、取消及缺少图会分别显示；
重启后从有效 Intent、已存图和初始化记录恢复状态，只有图的项目仍可查看图，并单独提示知识尚未初始化。

## 图表渲染

Project Intent 和与渲染器无关的 `ProjectDiagram` IR 仍是数据来源。结构图、C4 视图、流程、时序、数据流和生命周期统一使用本地 Archify 2.17.0-dev.1。Mermaid 11.17.2（严格安全模式）保留为静态降级方案。两者共用稳定 Project ID、正文和源码链接，不依赖在线渲染服务。


五类图共享节点、关系和证据结构，并按类型增加可选的渲染器中性语义：

| 类型 | 可选语义结构 |
| --- | --- |
| 架构图 | 边界分组与依赖方向 |
| 工作流图 | 泳道、显式顺序、分支条件、异常路径、分组布局 |
| 时序图 | 有序参与者与调用／返回消息 |
| 数据流图 | 2–5 个阶段与节点 `stageId` |
| 状态机／生命周期图 | 初始／普通／终态、事件、条件与转换 |

Archify 在独立沙箱中渲染，保留原生动画、缩放和导出。节点选择与原生路径演示联动正文；阅读器还可按明确主路径或消息顺序逐步播放。分支流程没有主路径时不猜测执行顺序。交互渲染失败时从同一份模型降级为 Mermaid，并保留错误说明；已有图无需迁移。

可选的 `intent.c4` 记录系统、人员、外部系统和运行单元，以 `systemId` 指定当前系统，运行单元通过 `parentId` 归属系统、通过 `contextIds` 关联职责主题。每个元素和关系必须有已读取的源码／文档证据。阅读器派生“项目全貌（C1）→ 运行单元（C2）”，再链接职责与流程；不把目录当容器，不把不同层级混在同一张图。已有 C4 模型仍可读取；新的索引流程可以根据已读取文档、配置和关键入口源码生成 C4，不把目录推断成运行单元。类图／ER 图暂未新增独立数据类型。

阅读器提供缩放、适应宽度、展开、SVG 导出和折叠源码。渲染失败仍保留正文与 Mermaid 源码；异步渲染不能覆盖后来选择的主题。源码跳转和导出由宿主核对图 ID 与保存时间。没有稳定边 DOM ID 的状态连接可通过连接列表选择。

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

`deny` 命中确实存在的关系，`allow` 命中从 `from` 出发但目标不是 `to` 的关系，`no_cycles` 命中依赖环。宿主继续按稳定 Project ID 求值，**Project introduction > Architecture rules and decisions** 展示规则、违规和无法求值的说明，不猜测另一张图。

## 校验

```bash
npm run check      # tsc --noEmit、eslint 与生产构建
npm run test:host  # VS Code 激活冒烟测试
```

浏览器检查在本地 Chromium 或 Edge 中运行，并且刻意不并入 `npm run check`，以免标准门禁依赖本机浏览器：

```bash
npm run check:ui                        # 依次运行浏览器检查
node scripts/checkComposerLayoutUi.mjs  # 输入区附件向上生长、底栏对齐、窄视口
node scripts/checkStreamJumpUi.mjs      # 跳到底部控件不遮挡对话滚动条
node scripts/checkEditorTabsUi.mjs      # 编辑器外壳、Project 各页、CSP 与主题
node scripts/checkProjectReaderUi.mjs   # 混合渲染、C4、播放、图文源码关联、CSP、切换与窄屏
node scripts/checkProjectDiagramsUi.mjs # 保留的 Archify 适配器与桥接兼容检查
```

assertWebviewAssets.mjs 依据 esbuild 依赖清单证明运行包不含 TypeScript 编译器或旧扫描／引擎实现，确认适配器引用的 Archify 入口、五份 Schema 与五个渲染器存在，且 `vendor/project-diagrams/drawio` 未进入分发包；其余 vendor 内容随包分发由 `.vscodeignore` 未排除 `vendor/**` 保证。

项目层单元测试可运行：`npx vitest run test/project*.test.ts test/editorTab*.test.ts test/turnReview*.test.ts`。
