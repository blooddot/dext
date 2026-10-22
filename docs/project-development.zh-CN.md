# 项目知识与编辑器标签

Project 设置位于 **Project > Overview** 的一个可折叠区域，包括初始化选项、工作区 Plan 目录，以及项目相对的 API、Skill 和 MCP 目录。资源目录输入框直接显示当前的 `.dext/api`、`.dext/skills` 和 `.dext/mcp`，多个工作区相对目录用逗号分隔。证据读取的 Standard、Deep、Whole 三档也合并在这里；展开 **Advanced reading settings** 可配置文件数量、字符预算和工作区相对路径范围。改动会自动写入 `.dext/project.json`，并应用于新的对话、Plan 文件、资源重载、项目初始化和生成图。项目尚未保存对应值时，旧的 VS Code 设置仍作为兼容回退。Whole 仍有 1000 个文件上限，证据数字字段留空则跟随所选档位。

[English](project-development.md) | 简体中文

[返回 README](../README.zh-CN.md)

**项目知识**长期存在、属于仓库；对话历史独立保存，清理会话不会删除项目知识。

[项目文件](#项目文件) · [知识维度](#知识维度) ·
[编辑器标签](#编辑器标签) · [主动初始化](#主动初始化) · [系统图与-archify](#系统图与-archify) · [校验](#校验)

## 项目文件

项目数据位于工作区的 `.dext/` 下：

| 路径 | 内容 |
| --- | --- |
| `.dext/project.json` | schema 版本、乐观锁 `version`、项目路径（`planDirectory`、`apiDirs`、`skillDirs`、`mcpDirs`）、知识设置和 AI CLI 选择 |
| `.dext/project-intent.json` | 初始化时 AI 生成的项目简介和语义知识 |
| `.dext/objects/<id>.json` | 每个文件一个已确认的长期对象 |
| `.dext/architecture.json` | 人工声明的设计决策与架构规则；规则针对其指定的已保存图求值，不依赖源码扫描 |
| `.dext/diagrams/<id>.json` | 与渲染器无关的 AI 架构图 IR，每张图一个文件 |

`ProjectStore` 通过一个极小的文件宿主机读写这些文件，因此同一套逻辑可运行在扩展、worker 或内存测试替身中。每次写入都携带期望的 `version`；并发修改返回 `{ status: "conflict" }` 而不会覆盖。`project.json` 缺失或损坏时回退默认值，绝不阻塞开发。

`ProjectObjectReference` 保存稳定的 `objectId`。重命名对象会保留 id 并把旧名记入别名，引用、链接与测试因此不会因改名而失效。

显式 `evidence` 决定读取预算和范围，优先于旧配置；尚未保存它的项目，在构建或更新 Overview 索引前会提示先配置。页面引导用户设置读取深度与范围，也可点击 **Save reading settings** 保存显示的默认值。显式 `include: []` 表示使用内置文件范围，属于有效配置。旧 `scan.roots` 不再影响读取范围。旧 `scan` 和未知扩展字段兼容保留，但不自动生成。当前仓库已有 `evidence.include: ["src/**"]`，因此删除冗余 `scan` 不改变读取范围。Whole 仅提高预算，不取消范围限制。

Review 预设已移除，新建配置及原本不含 `preset` 的配置保存时都不会生成该字段。旧文件中的 `preset` 仅作为无效遗留字段保留。项目路径和证据预算通过 Project 设置保存到 `.dext/project.json`。已废弃的 VS Code 目录及证据设置不再读取；项目缺失的路径使用内置默认值，缺少 `evidence` 时必须先显式保存再构建索引。`knowledge`、AI 选择、版本号和写入时间继续保留。

## 知识维度

项目对象携带四个彼此独立的维度，绝不合并成单一状态。

- **来源**（`source`）：`code`、`ai`、`user`。
- **确认**（`confirmation`）：`draft`、`accepted`、`rejected`——用户决定。
- **有效性**（`validity`）：`current`、`needs_verification`、`stale`、`conflicted`——与代码再核对的结果。
- **归属**（`ownership`）：`owned`、`shared`、`candidate`、`unassigned`。

接受 AI 建议会设置 `confirmation: "accepted"`，但 `validity` 仍为 `"needs_verification"`：接受建议不等于已对当前代码核实。`validateProjectObjects` 会报告重复 id、重复名称/别名以及悬空的 `relatedIds`。

旧字段 `status` 仍可解析。`normalizeProjectObject` 负责迁移：`accepted`、`stale`、`conflicted` 都映射为 `confirmation: "accepted"`，并补齐其余维度。新代码只写四个维度。

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

**Overview > Build project model / Update project model** 先构建 JS/TS、Rust、Python 本地结构索引，再根据完整文件结构信息分批整理职责模块，最后生成项目简介和有证据支持的 C4 边界；详细模块流程仍按需生成。Knowledge 中选择模块只读取已保存内容；点击 **Analyze this module / Update module analysis** 才分析当前模块，同时生成说明与 Archify 图。

模块正文使用同一张图的 `metadata.topicSummary` 和节点 `description`；`topicId`、`topicAnalysis=1`、`topicBasis` 记录归属及项目模型依据。说明、节点证据和图通过一次 `writeDiagram` 一起保存，更新复用原图 ID，不堆积副本。刷新项目模型不删除模块分析；对应职责或入口证据变化时显示待更新，旧内容继续可读。失败或取消保留原结果，不覆盖其他模块。手动编辑正文和开发对话自动引用尚未实现。

## 主动初始化

打开、恢复、切换或刷新项目标签只读取已经保存在 `.dext` 中的数据。Dext 不会在后台枚举源码、运行解析器、调用 AI 或写入 `.dext`。只有在用户主动选择 **Build project model**、**Update project model**、**Check evidence** 或生成图时，才会读取受限的文档或源码。

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

项目层单元测试可运行：`npx vitest run test/project*.test.ts test/editorTab*.test.ts`。

## 第一轮模块迁移

`app` 负责启动装配，`platform` 收纳实际跨功能复用的基础设施，`features` 按产品职责聚合实现。选择 `features` 是本项目的语义约定，不代表行业使用率排名。不并列建立 `modules` 根目录，也不建立占位目录。宿主实现负责 Node/VS Code，浏览器实现负责 DOM 交互，契约和纯展示逻辑不加载环境专属实现。Knowledge 和 Diagrams 仍属于同一个 Project 功能。

扩展命令、消息类型、CSP/nonce、`dist/extension.js`、`dist/webview/main.js`、`dist/webview/project.js`、`dext.agentProfiles`、`dext.agentSelection`、编辑器标签身份及 Project 持久化格式保持兼容。装配入口负责服务释放，Provider 在关闭时退订并取消所属请求。已有 `.dext` 数据保持原状；生成验收使用临时副本。

兼容入口只显式转发导出，不保留第二份实现。范围外消费者可暂时使用旧入口，最后一个消费者迁移后删除该入口；新功能内部直接引用新路径。

| Previous path | Implementation |
| --- | --- |
| `src/core/projectIntent.ts` | `src/features/project/contracts/projectIntent.ts` |
| `src/core/projectKnowledge.ts` | `src/features/project/contracts/projectKnowledge.ts` |
| `src/core/projectDiagram.ts` | `src/features/project/contracts/projectDiagram.ts` |
| `src/core/projectDiagramAdapter.ts` | `src/features/project/contracts/projectDiagramAdapter.ts` |
| `src/core/projectEvidenceSettings.ts` | `src/features/project/contracts/projectEvidenceSettings.ts` |
| `src/core/projectSettings.ts` | `src/features/project/contracts/projectSettings.ts` |
| `src/webview/projectArchitectureTypes.ts` | `src/features/project/contracts/projectArchitectureTypes.ts` |
| `src/core/projectContext.ts` | `src/features/project/knowledge/projectContext.ts` |
| `src/core/projectReference.ts` | `src/features/project/knowledge/projectReference.ts` |
| `src/core/projectTopics.ts` | `src/features/project/knowledge/projectTopics.ts` |
| `src/core/projectIndexEvolution.ts` | `src/features/project/knowledge/projectModelEvolution.ts` |
| `src/core/projectArchitecture.ts` | `src/features/project/knowledge/projectArchitecture.ts` |
| `src/core/projectDiagramHistory.ts` | `src/features/project/knowledge/projectDiagramHistory.ts` |
| `src/core/projectC4.ts` | `src/features/project/presentation/projectC4.ts` |
| `src/core/projectDiagramPresentation.ts` | `src/features/project/presentation/projectDiagramPresentation.ts` |
| `src/core/projectMermaid.ts` | `src/features/project/presentation/projectMermaid.ts` |
| `src/core/projectStructure.ts` | `src/features/project/host/indexing/projectStructure.ts` |
| `src/core/projectStructureKnowledge.ts` | `src/features/project/host/indexing/projectStructureKnowledge.ts` |
| `src/projectStructureHost.ts` | `src/features/project/host/indexing/projectStructureHost.ts` |
| `src/core/projectAiGeneration.ts` | `src/features/project/host/generation/projectAiGeneration.ts` |
| `src/core/projectIndexQuality.ts` | `src/features/project/host/generation/projectModelQuality.ts` |
| `src/projectService.ts` | `src/features/project/host/projectService.ts` |
| `src/projectStore.ts` | `src/features/project/host/persistence/projectStore.ts` |
| `src/vscodeProjectHost.ts` | `src/features/project/host/projectPanelDataSource.ts` |
| `src/projectEditorProvider.ts` | `src/features/project/host/projectEditorProvider.ts` |
| `src/projectDiagramViewer.ts` | `src/features/project/host/diagrams/projectDiagramViewer.ts` |
| `src/core/projectDiagramRegistry.ts` | `src/features/project/host/diagrams/projectDiagramRegistry.ts` |
| `src/core/projectDiagramProcess.ts` | `src/features/project/host/diagrams/projectDiagramProcess.ts` |
| `src/core/archifyAdapter.ts` | `src/features/project/host/diagrams/archifyAdapter.ts` |
| `src/webview/projectPanel.ts` | `src/features/project/presentation/projectPanel.ts` |
| `src/webview/projectSettingsView.ts` | `src/features/project/presentation/projectSettingsView.ts` |
| `src/webview/projectTopicsView.ts` | `src/features/project/presentation/projectTopicsView.ts` |
| `src/webview/projectArchitectureNotes.ts` | `src/features/project/presentation/projectArchitectureNotes.ts` |
| `src/webview/projectReader.ts` | `src/features/project/browser/projectReader.ts` |
| `src/webview/projectReaderArchify.ts` | `src/features/project/browser/projectReaderArchify.ts` |
| `src/webview/archifyBridge.ts` | `src/features/project/browser/archifyBridge.ts` |
| `src/editorTabTypes.ts` | `src/platform/editor-tabs/editorTabTypes.ts` |
| `src/editorTabState.ts` | `src/platform/editor-tabs/editorTabState.ts` |
| `src/editorTabSerializer.ts` | `src/platform/editor-tabs/editorTabSerializer.ts` |
| `src/editorTabManager.ts` | `src/platform/editor-tabs/editorTabManager.ts` |
| `src/editorTabHtml.ts` | `src/platform/editor-tabs/editorTabHtml.ts` |
| `src/resourceSession.ts` | `src/features/resources/contracts/resourceSession.ts` |
| `src/resourceIcons.ts` | `src/features/resources/presentation/resourceIcons.ts` |
| `src/resourceBrowserProvider.ts` | `src/features/resources/host/resourceBrowserProvider.ts` |
| `src/apiEditorProvider.ts` | `src/features/resources/host/apiEditorProvider.ts` |
| `src/globalResourcesEditorProvider.ts` | `src/features/resources/host/globalResourcesEditorProvider.ts` |
| `src/webview/apiPanel.ts` | `src/features/resources/presentation/apiPanel.ts` |
| `src/webview/globalResourcesPanel.ts` | `src/features/resources/presentation/globalResourcesPanel.ts` |
| `src/agentProfiles.ts` | `src/features/agents/host/agentProfiles.ts` |
| `src/agentSelectionDefaults.ts` | `src/features/agents/presentation/agentSelectionDefaults.ts` |
| `src/core/toml.ts` | `src/features/agents/host/toml.ts` |
| `src/core/fileSearch.ts` | `src/features/workspace/domain/fileSearch.ts` |
| `src/webview/outputLink.ts` | `src/features/workspace/browser/outputLink.ts` |
| `src/webview/fileSearchClient.ts` | `src/features/workspace/browser/fileSearchClient.ts` |

Additional verification file: `test/sidebarLayout.test.ts` — source-location assertions follow extracted implementations; layout and behavior expectations remain enforced. / 额外验证文件：源码断言改为读取迁移后的实现，保留布局和行为约束。

Additional verification file: `scripts/checkProjectDiagramsUi.mjs` — use the new browser startup entry, retaining the same rendered diagram assertions. / 图表浏览器检查改用新启动入口，保留原渲染断言。

### 行为与释放约定

- Project 浏览器入口为 `features/project/browser/entry.ts`，从 `window.__dextApi` 获取宿主 API；`esbuild.mjs` 继续输出 `dist/webview/project.js`。页面选择、图表请求、进度和结果沿用现有消息类型；`projectPage` 可携带可选主题 ID，旧消息仍有效。
- 文件搜索契约为 `searchFiles { requestId, query }` 和 `searchFilesResult { requestId, files }`。索引仍使用 20,000 文件上限、15 秒缓存、40 条建议及原排除规则；请求身份和释放标记阻止旧响应覆盖新查询。
- 标签恢复版本仍为 1，键仍使用 `dext.editor:<kind>[@scope][#resource]`。视图类型仍为 `dext.project`、`dext.api`、`dext.globalResources`、`dext.history`，不以显示标题作为身份。
- `app/projectSetup.ts` 注册 Project 编辑器、序列化恢复和图表注册表，并把释放对象交给扩展上下文。页面关闭取消本页任务；数据源订阅随 Provider 释放。AI 桥接仅接收执行方法、Profile 与 Selection 回调，不接收整个应用实例。
- Agent 存储键、Project Schema 版本和 `.dext` 文件路径不变。初始化以保存成功作为完成条件；取消和失败不覆盖最后一次有效结果。

### 模块边界与已收敛例外

`node scripts/checkModuleBoundaries.mjs` 已加入 `npm run check`。检查区分类型导入和运行时导入，追踪浏览器与纯模块的传递依赖、运行时循环、根目录白名单、`shared` 纯度、`platform`/feature 环境方向、`contracts/` 目录规则、功能到应用装配层的反向依赖，以及全部已移除路径。浏览器构建清单另外检查宿主实现和 Node/VS Code 依赖。跨功能接口调用允许保留，不提供目录级豁免。

`migrationExceptions` 已为空。纯层引用实现模块类型的 6 条现有边登记在 `declaredTypeEdges`；跨 feature 的 4 条 host 耦合登记在 `crossFeatureHostCouplings`。新增或过期条目都会失败，且都不能跳过环境隔离和无循环检查。

### 索引质量流程

唯一非类型消费者只触发职责复核。AI 对每条线索返回 `retained`、`reassigned` 或 `unresolved`，附具体理由与已提供的文件事实；缺失、重复、越界证据和非法文件归属均拒绝。Overview 和 Knowledge 分开展示架构问题、待复核归属，以及折叠的已解释决定。旧数据缺少复核字段时仍保持待复核，不默认为通过。

运行证据从实际构建入口与依赖发现，不执行构建脚本。预算先覆盖各入口的 API 注入、发送和接收，再覆盖部署、宿主分发及传输；重复接口声明不作为实际发送证据，动态入口与预算遗漏明确记录。孤立 C4 单元最多触发一次关系复核，只能补充已读片段支持的关系，不删除节点；失败、超时或无证据时保留模型和提示，取消仍按取消处理。

源码搬迁可能改变主题身份。历史图表保持可读；只凭主题同名不复用 ID。边界变化及无法关联的分析明确显示过期提示。

### 验证与下一轮准入

2026-10-20 第一轮验收记录：

- `npm run check` 通过：154 个测试文件通过，1504 个测试通过；保留原有 3 个文件、13 个测试的跳过状态。默认并发配置未改动，边界、lint、类型、构建、声明和五种 WASM 语法加载检查均通过。
- `npm run check:ui`、编辑器标签检查、`--saved-project` 阅读器检查和 `npm run test:host` 通过。浏览器覆盖暗色、浅色、高对比度、窄屏、全屏、播放、导出及消息导航；VS Code 宿主验证激活、输入框和 Project/API/资源标签生命周期。
- 临时源码副本使用真实 Codex Provider 生成索引：229 个源码文件全部唯一归属，另有 3 个说明/配置文件；生成 50 个职责模块和 2 个架构阅读主题。Workspace 搜索契约与 Agent 选择展示两条归属线索均保留原职责并附理由；没有未解决的归属或孤立 C4 提示。Project 阅读器交互引用实际发送、接收和宿主处理片段，MCP 保留 HTTP/stdio，Archify 归为内部子进程。
- 随后对 Project 阅读器模块真实生成解释和图表（10 个节点、8 条关系）。第一次输出被校验拒绝，自动修正后通过；实际产物经浏览器原生 Archify 渲染及全屏检查。实际图表截图位于 `.tmp-tb/project-reader-ui/generated-module-analysis.png`，验收日志位于 `.tmp-tb/final-live.log` 和 `.tmp-tb/final-ai-reader.log`。
- 以上是一次真实结果的验收，不是固定模块数量或 AI 语义完全正确的承诺。模块说明仍明确标注未读实现与截断证据；完整生成包含多次串行 AI 调用，耗时未在本轮优化。
- 计划文件和当前工作区的 `.dext/evidence.json`、`.dext/project-intent.json`、`.dext/project.json` 与实施前哈希一致；生成数据只写入临时副本。

固定夹具测试、浏览器检查、扩展宿主检查与真实 AI 生成分别验收。可用 `node scripts/checkProjectReaderUi.mjs --saved-project --workspace <临时副本>` 浏览实际生成的数据；省略 `--workspace` 时只读当前工作区。任何生成验证不得回写当前仓库的 `.dext`。

第三轮已完成 `src/core/` 的解散：共享契约与纯工具进入 `src/shared/`（`contracts/`、`protocol/`、`lib/`），VS Code 适配器进入 `src/platform/vscode/`，组合根进入 `src/app/`，剩余浏览器组件进入各自 feature 的 `browser/`。`src/` 根目录只剩 `extension.ts`；`src/core`、`src/common`、`src/base`、`src/modules`、`src/utils` 由边界检查禁止恢复。会话浏览器拆分已完成：标签身份/缓存、草稿、标签条、滚动、回合行、实时 Process/trace、Plan 工具栏与补丁审核均位于 `src/features/conversations/browser/`。

下一轮以本轮完整检查为准入条件，并保持 `declaredTypeEdges`、`crossFeatureHostCouplings` 与已移除路径清单准确。优先级：

1. 将 `sidebarProvider.ts` 中的资源/MCP/附件以及 `webview/main.ts` 中的历史补载、滚动编排作为行为工作拆分。
2. 按所有者拆分 `shared/contracts/types.ts`，缩小共享契约面。
3. 通过 `app` 注入端口消除 4 条跨 feature host 耦合，使 `crossFeatureHostCouplings` 归零。
4. 把 6 条 `declaredTypeEdges` 收敛为纯类型契约。
5. 工作流内核、Agent 执行器、MCP 与补全的独立行为轮次仍按原计划推进。

本轮不预建空模块，不将剩余内容搬入新的大文件。

### 兼容入口消费者（仅历史，均已删除）

第二轮已把上面列出的 36 个转发入口与全部消费者一起更新，然后删除；`scripts/checkModuleBoundaries.mjs` 会对恢复的文件、静态或仅类型导入、字面量动态加载、mock 说明符以及内嵌构建入口字符串报错。上表与下文表格是第一批迁移的历史记录；当前导入直接使用目标路径，本轮新增的会话模块记录在 `docs/conversation-development.zh-CN.md`。

`src/features/conversations/` 下的会话模块及其唯一装配点 `src/app/conversationSetup.ts` 取代了会话、执行、计划与补丁状态。会话浏览器拆分已完成：标签身份/缓存、输入框草稿、标签条、输出滚动、回合 transcript、实时 Process/trace、Plan 工具栏与补丁审核均位于 `src/features/conversations/browser/`；`src/webview/main.ts` 只负责连接协议与范围外界面。

以下表格中的每个路径都已删除，仅用于记录历史，**不是当前导入指引**。

| Compatibility entry | Remaining consumers |
| --- | --- |
| `src/resourceDocuments.ts` | `test/apiReference.test.ts`, `test/apiSource.test.ts` |
| `src/core/projectIntent.ts` | `test/projectIntegration.test.ts`, `test/projectIndex.test.ts`, `test/projectContext.test.ts` |
| `src/core/projectKnowledge.ts` | `test/projectStore.test.ts`, `test/projectKnowledge.test.ts`, `test/projectIntegration.test.ts`, `test/projectContext.test.ts` |
| `src/core/projectDiagram.ts` | `test/archifyLayoutBudget.test.ts`, `test/archifyAdapter.test.ts`, `test/projectStore.test.ts`, `test/projectMermaid.test.ts`, `test/projectIntegration.test.ts`, `test/projectIndex.test.ts`, `test/projectDiagramRegistry.test.ts`, `test/projectDiagramPresentation.test.ts`, `test/projectDiagramAdapter.test.ts`, `test/projectDiagram.test.ts`, `test/projectArchitecture.test.ts` |
| `src/core/projectDiagramAdapter.ts` | `test/archifyAdapter.test.ts`, `test/projectIntegration.test.ts`, `test/projectDiagramRegistry.test.ts`, `test/projectDiagramAdapter.test.ts`, `test/projectDiagram.test.ts` |
| `src/core/projectEvidenceSettings.ts` | `test/projectEvidenceSettings.test.ts` |
| `src/core/projectSettings.ts` | `test/projectWorkspaceSettings.test.ts` |
| `src/core/projectContext.ts` | `test/projectContext.test.ts` |
| `src/core/projectReference.ts` | `src/webview/projectReferenceClient.ts`, `test/projectReference.test.ts`, `src/core/fileReference.ts` |
| `src/core/projectTopics.ts` | `test/projectIndex.test.ts` |
| `src/core/projectArchitecture.ts` | `test/projectArchitecture.test.ts` |
| `src/core/projectDiagramHistory.ts` | `test/projectDiagram.test.ts` |
| `src/core/projectDiagramPresentation.ts` | `test/projectDiagramPresentation.test.ts` |
| `src/core/projectMermaid.ts` | `test/projectMermaid.test.ts` |
| `src/core/projectAiGeneration.ts` | `test/archifyAdapter.test.ts`, `test/projectIntegration.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectIndex.test.ts` |
| `src/projectService.ts` | `test/projectIntegration.test.ts` |
| `src/projectStore.ts` | `test/projectStore.test.ts`, `test/projectIntegration.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectEvidenceSettings.test.ts` |
| `src/vscodeProjectHost.ts` | `test/projectTopicsHost.test.ts`, `test/projectInitializationOutput.test.ts`, `test/projectEvidenceSettings.test.ts`, `test/projectEvidenceSelection.test.ts` |
| `src/projectDiagramViewer.ts` | `test/projectDiagramViewer.test.ts` |
| `src/core/projectDiagramRegistry.ts` | `test/projectIntegration.test.ts`, `test/projectDiagramRegistry.test.ts` |
| `src/core/archifyAdapter.ts` | `scripts/checkProjectDiagramsUi.mjs`, `test/archifyLayoutBudget.test.ts`, `test/archifyAdapter.test.ts` |
| `src/webview/projectPanel.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/webview/archifyBridge.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/editorTabTypes.ts` | `test/editorTabState.test.ts` |
| `src/editorTabState.ts` | `test/editorTabState.test.ts` |
| `src/editorTabSerializer.ts` | `test/apiReference.test.ts` |
| `src/editorTabManager.ts` | `test/apiReference.test.ts`, `test/projectEvidenceSelection.test.ts`, `test/projectAiGeneration.test.ts` |
| `src/editorTabHtml.ts` | `scripts/checkProjectDiagramsUi.mjs` |
| `src/resourceSession.ts` | `src/features/conversations/host/historyStore.ts`, `test/resourceConversation.test.ts` |
| `src/apiEditorProvider.ts` | `test/apiReference.test.ts` |
| `src/webview/apiPanel.ts` | `test/apiSource.test.ts` |
| `src/webview/globalResourcesPanel.ts` | `test/apiSource.test.ts` |
| `src/agentProfiles.ts` | `test/agentRunner.test.ts`, `test/builtinCli.test.ts`, `test/harnessPresetSelection.test.ts`, `test/harnessPresets.integration.test.ts`, `src/core/agentRunner.ts`, `src/conversationPreferences.ts`, `src/core/builtinCli.ts`, `src/core/harnessPresets.ts`, `src/core/types.ts`, `src/core/deepseekHarnessRunner.ts`, `src/core/deepseekHarnessPolicy.ts`, `src/core/runtime.ts` |
| `src/core/toml.ts` | `test/toml.test.ts` |
| `src/webview/outputLink.ts` | `test/openImageReference.test.ts` |
| `src/webview/fileSearchClient.ts` | `src/webview/codeEditor.ts` |

Removed unused entries / 已移除无消费者入口：`src/webview/projectArchitectureTypes.ts`, `src/core/projectIndexEvolution.ts`, `src/core/projectC4.ts`, `src/core/projectStructure.ts`, `src/core/projectStructureKnowledge.ts`, `src/projectStructureHost.ts`, `src/core/projectIndexQuality.ts`, `src/projectEditorProvider.ts`, `src/core/projectDiagramProcess.ts`, `src/webview/projectSettingsView.ts`, `src/webview/projectTopicsView.ts`, `src/webview/projectArchitectureNotes.ts`, `src/webview/projectReader.ts`, `src/webview/projectReaderArchify.ts`, `src/resourceIcons.ts`, `src/resourceBrowserProvider.ts`, `src/globalResourcesEditorProvider.ts`, `src/agentSelectionDefaults.ts`, `src/core/fileSearch.ts`。
