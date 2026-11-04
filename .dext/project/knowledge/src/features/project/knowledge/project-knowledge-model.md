## Responsibility

- **Names**: Project Knowledge Model → `src/features/project/knowledge/projectModel.ts`，连同 `projectKnowledge.ts`、`projectArchitecture.ts`、`projectModelEvolution.ts`、`projectTopics.ts`、`projectContext.ts`、`projectReference.ts`、`projectPlan.ts`、`projectQuery.ts`、`projectDiagramHistory.ts`；界面上的 Knowledge 页读取的就是这里派生出的阅读视图。
- 拥有原生 `ProjectModel` 的读侧语义：图级校验 `validateProjectModel`、统一解析入口 `parseProjectModel`、确认指纹 `structureFingerprint`，以及向扁平 `ProjectIntent` 的单向投影 `projectModelIntent`。
- 拥有规范正文的所有权规则：`knowledgeText` 取 `inline` / `document` 两种 body（document 侧带 `contentHash`），`replaceKnowledgeBody` 规定 AI 不得静默覆盖 accepted / edited 正文。
- 拥有模型演进与接续：`reconcileProjectModel`（旧扁平视图的跨分析接续）、`reconcileNativeProject`（新候选与已保存原生图合并）、`analysisSourceFiles`（只读旧图表里的成员快照）。
- 拥有阅读视图的派生：`buildProjectTopics`、`readingOrder`、`topicFingerprint`、`checkProjectTopics`、`topicDiagramRequirement`。
- 拥有架构规则求值：`architectureRuleReport` 与 `evaluateArchitectureRules`。
- 拥有图表快照史与差异：`ProjectDiagramHistory`、`createDiagramSnapshot`、`isUsableDiagramSnapshot`、`isArchifySnapshot`、`compareDiagramSnapshots`。
- 拥有稳定引用语法与选择器数据：`formatProjectReference`、`projectReferenceOccurrences`、`ProjectObjectReference`、`searchProjectReferences`。
- 拥有 Plan 语义解析：`planTaskNorms`、`parseProjectImpact`、`planSemanticContent`。
- 拥有只读查询：`projectQuerySchema`、`queryProject`、`runProjectQuery`。

## Design

- 两层表示、单一写入者。`contracts/projectModel.ts` 是节点与关系的图，`contracts/projectIntent.ts` 是 Knowledge / Plan 读的扁平视图；`projectModelIntent` 的注释写明它是 "Transitional read view for existing diagrams; the native model remains the sole writer"，所以投影只能单向派生，扁平视图不能反向成为第二条写路径。
- 校验做成图级不变量而不是字段修补：重复 node / relation、悬空关系、`*.plan.md` 不得成为规范节点、同一 document 路径只能有一个 owner、`contains` 必须无环，全部由 `parseProjectModel` 一次抛出；降级、提示与“不写坏数据”留给 host 侧的调用方。
- 确认与措辞分离。`structureFingerprint` 只摘要排序后的成员路径和 module / context 父节点，注释给出的理由就是改措辞不该让同一条规范的确认失效；因此 `reconcileNativeProject` 在指纹失配时只把节点回落为 `draft` / `needs_verification` 并删掉 `structureHash`，正文与已复核关系仍受保护，生成也覆盖不了 reviewed 正文。
- 正文只有一个所有者：`knowledgeBodySchema` 是 `inline` | `document` 的判别联合，`knowledgeDocumentPathSchema` 明确拒绝绝对路径、`plans/`、`node_modules/`、`.git` 与 `.plan.md`，避免同一份规范被两处编辑，也避免把一次改动计划当成长期规范。
- 接续宁可放弃也不猜：`reconcileProjectModel` 要求前后任双向唯一且成员交集占并集至少 0.5，然后把旧 id、既有 `previousContextIds` 与历史图表的 `metadata.topicId` 收进历史，并统一重映射 `dependsOn`、质量提示、能力、流程步骤、术语、约束 `scope` 和 C4 `contextIds`。
- 阅读视图是派生结果，不是第二份存储：`buildProjectTopics` 每次从 `ProjectIntent` 与已保存图表现算，`topicFingerprint` 配合 `metadata.topicBasis` 只用来判断一次分析是否过期（匹配为 `ready`，否则 `stale`），`readingOrder` 按依赖层级排序而不是目录顺序，`checkProjectTopics` 只比对文件快照，缺哈希或读不到一律 `unknown`。
- 图表史先验可用性，再谈历史：`isUsableDiagramSnapshot` 拒绝失败回执、工件与回执不匹配、语义不合法或空内容，`record` 再拒绝版本回退与“同版本改了语义”，`renderedLayout` 明确只作展示，不与手工布局或持久化事实混同。
- 架构规则绑定稳定节点 id：`architectureRuleReport` 只接受显式 `diagramId` 或唯一一张 architecture 图，模糊时返回 `note` 而不是挑一张图求值，因此 Archify id 或布局变化不会让规则失效，规则也不会被套用到错误的图上。
- 引用 token 以 id 为身份：`formatProjectReference` 编出 `#canonicalName[objectId]`，`projectReferenceOccurrences` 用前导字符检查排除 Markdown 标题、URL fragment、文件范围和 C# 名，损坏的百分号编码保留为普通文本，改名因此不会让旧对话失效。
- Plan 解析先掩码再识别：`maskCode` 把代码围栏与缩进块等长替换为空格，代码示例就不能变成协议消息或规范 id；`planSemanticContent` 再忽略勾选状态与 impact 摘要，只保留任务语义。
- 现存两处方向倒置属于待收敛的例外，不是设计目标：`projectTopics.ts` 运行时引入 `presentation/projectC4.ts` 取 C4 主题，`contracts/projectArchitectureTypes.ts` 反向从 `knowledge/projectArchitecture.ts` 只取类型；它们都还是纯函数或类型，不应被扩大成知识层对展示层、契约层的常规依赖。

## Boundary

- Allowed: 使用同特性 `contracts/` 的 schema 与类型，以及与 `knowledge/` 内兄弟模块互相引用；以纯函数和纯类型的方式被 `host/`（bootstrap、persistence、plan service、panel data source、MCP）、`presentation/`、`app/` 与 `webview/` 的调用方使用；返回校验结果、派生视图、差异与解析结果，由调用方决定降级、持久化与取消。
- Forbidden: 任何文件、网络或编辑器 IO 与 `.dext` 落盘（属 `host/persistence`）；发起 AI 生成、建立索引、选择模型或安装 CLI（属 `host/generation`、`host/indexing`）；依赖 `vscode`、Node 内建、DOM 或具体渲染器（Archify 在独立沙箱中运行）；渲染 Markdown 或组装图表 DOM；把扁平 `ProjectIntent`、Plan 文件、目录名、渲染几何或标题相似性当作规范事实；绕过 `parseProjectModel` / `reconcileNativeProject` 直接改写已保存模型或模型文档。