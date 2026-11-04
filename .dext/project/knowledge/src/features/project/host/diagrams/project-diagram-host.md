## Responsibility

- **Names**: Project diagram host → `src/features/project/host/diagrams/projectStructureMap.ts`（`buildStructureMap`）、`projectClassMap.ts`（`buildClassMap`）、`projectDiagramRegistry.ts`（`ProjectDiagramAdapterRegistry`、`ProjectDiagramHistoryPersistence`）、`projectDiagramViewer.ts`（`DiagramTaskRegistry`、`isDiagramExportPayload`、`isAllowedEvidencePath`）；同目录 `projectDiagramProcess.ts` 的子进程原语已归 “Project diagram adapter”。知识页把两张图叫 Structure map 与 Type map，代码名仍是这两种派生图与其注册表。
- 拥有“索引 → 语义图”的编译：把 `StructureSummary` 变成一棵物理层级树（project → module → 代表文件 → 代表声明）和一张显式类型图（类型、声明成员、仅 `extends`/`implements` 的关系），每个节点都带 `path`/`contentHash`/行号/符号名，`topic.basis` 记 `summary.hash`，因此任何一张图都能对回某一次索引结果。
- 拥有宿主侧唯一的渲染枢纽：只允许注册一个 Archify 引擎，按稳定 `diagram.id` 取消陈旧渲染，复核适配器文档与产物的身份、版本、格式、MIME、体积，校验通过才写入 last-good，失败只记 `recordFailure`，并把“每图最新一版”经端口落盘以便跨 reload 回退。
- 拥有查看与导出前的验收谓词：`DiagramTaskRegistry` 以 key 取消进行中任务、`isDiagramExportPayload` 要求导出字节属于当前显示版本（HTML 必须是独立文档、SVG 不得含 `script`）、`isAllowedEvidencePath` 只放行索引允许的证据路径。
- 不拥有：`ProjectDiagram` IR 的形状与校验（`contracts/projectDiagram.ts`）、快照准入与差异比较（`knowledge/projectDiagramHistory.ts`）、沙箱 iframe 会话与交互（`browser/projectReaderArchify.ts`）、子进程执行原语（`projectDiagramProcess.ts`），以及“哪张图当前可见”的路由（由 `host/projectPanelDataSource.ts` 与组合根决定）。

## Design

- **索引是唯一真相，派生不重新扫盘。** 两张图都只消费 `StructureSummary` 与 `buildStructureGraphFromSummary` 的排名，从不读取文件内容、不推断调用关系；这让“读取、Plan 与查询永不触发初始化”这一全局约束在图表路径上也成立：没有结构缓存时 `projectPanelDataSource` 只是不产出派生主题。
- **有界优先于完整。** `STRUCTURE_MAP_MAX_NODES = 180`、每模块 6 个文件、每入口文件 2 个符号；`CLASS_MAP_MAX_TYPES = 60`、每类 12 个成员、总成员 240。超预算的部分不静默丢弃，而是变成 `qualityWarnings`（`shows X of Y`）、一个 “N more modules” 节点和 `confidence: 0.8`，读者能看出这是一张有预算的图而不是全量事实。
- **排序即取舍，集中一处。** 结构图按 `entryPoints → consumers → rank → path` 选代表文件，类图按成员数、是否有显式继承、graph rank、path、行号选类型；渲染层不再做第二次裁剪，因此“为什么这个类在图上”有单一可读答案。
- **只画可证的边。** 类图只在目标名于已选类型中唯一时建边；未解析、多义、以及被标记法禁止的组合（`inheritance` 指向 interface、`realization` 指向非 interface）各自计数进 warnings，而不是降级成一条猜测的边。语言限制（Python `self.x`、Rust `impl Trait for Type`）同样写成显式告警。
- **单一引擎、无回退。** 第二次 `register` 直接抛错，`render` 依次复核 `documentIssues`、`artifactIssues`（能力声明里的格式、MIME、16 MiB 上限）与 `validate`，任何一步失败都走 `failure()` 返回同图的 last-good 快照并标注 `displayedVersion`——页面显示的版本永远等于 `artifact` 的版本。
- **取消按稳定 id，而不是按时序。** `operationId` 默认 `${diagram.id}:${diagram.version}`，新渲染 abort 旧的；`unregister` 取消全部在飞任务，因为 operationId 不按适配器作用域；`hydrate()` 刻意放在注册之后才 await，所以“刚切图就取消”仍能命中。
- **持久化是端口，不是职责。** registry 不知道 `.dext/diagram-history.json`（路径属 `host/persistence/projectStore.ts`），只声明 `load`/`save`；落盘时每图只留最新一版、按 8 MiB 预算从新到旧裁剪，写入串行且吞掉异常——渲染成功不能因存储失败而失败，损坏的文件也不能抹掉会话内历史。
- **边界画在“产物”上。** 这里负责产出与验证可保存的制品，不负责把它画出来：`projectDiagramViewer.ts` 只提供取消器与纯谓词，sandbox 桥接脚本从 `browser/archifyBridge.js` 重导出而不复制一份。这条缝是两次评审的争议点——注册表与“查看”字面上属于呈现层——本节点据此只主张渲染与产物所有权，绘制与交互会话仍归 `browser/` 与 `presentation/`。

## Boundary

- Allowed: 读取 `host/indexing/projectStructure.ts` 的 `StructureSummary`/`StructureSymbol` 与 `projectStructureGraph.ts` 的排名；依赖 `contracts/projectDiagram.js` 的类型、`validateProjectDiagram` 与 `validationStatus`；经 `projectDiagramProcess.ts` 的 `runDiagramProcess`/`withDiagramFiles` 触达 Node 子进程与临时文件；通过 `ProjectDiagramHistoryPersistence` 端口读写 last-good；被 `host/projectPanelDataSource.ts`（构造两张派生图、持有 `DiagramTaskRegistry`）与 `src/app/projectSetup.ts`（构造 registry、注入持久化、注册 Archify）使用。
- Forbidden: 不定义或扩展 `ProjectDiagram`/`ProjectDiagramKind`，不新增第二种渲染引擎或跨引擎回退；不创建 iframe、不发 webview 消息、不注入沙箱脚本；不直接读写 `.dext/**` 或决定存储位置；不决定哪张图可见、不做主题排序；不把 `DiagramAdapterDocument` 或 archify 的本地 id 当作 Project 事实写入模型；派生时不重新读取源码、不补全未解析的继承/实现关系；不承担快照版本准入与差异比较（`knowledge/projectDiagramHistory.ts`）；不把 `MAX_*` 预算或布局参数下推给渲染器。