## Responsibility

- **Names**: dext_project / dext_structure → src/features/project/host/indexing/projectModelMcp.ts（连同 projectStructureGraph.ts、projectStructureHost.ts、projectStructureKnowledge.ts、projectStructureMcp.ts、projectStructureQuery.ts、workspaceEvidence.ts）
- 拥有“索引事实 → 派生结构图 → 只读 MCP 工具”这一条链路：扫描工作区得到文件、符号与静态依赖的结构事实，由同一批事实派生内存图（枢纽、环、社区、邻接），再以 stdio MCP 把查询能力交给对话（`structure_query`、`project_query`）。
- 该职责同时持有事实的**读取预算**：MCP 侧只读缓存，宿主侧才做受预算约束的证据读取，两边都不改写模型。
- 边界仍未定论：候选边界两次评审被否，暂作临时职责保留并上报复核；`projectModelMcp.ts` 中的模型查询与 `projectStructureMcp.ts` 中的结构查询是否应拆成两条职责，属于待人工复核项，不作为既有结论。

## Design

- **索引与图分层，图不落盘。** `projectStructureGraph.ts` 的注释写明派生图 “never persisted”：`buildStructureGraph` / `buildStructureGraphFromSummary` 每次都从缓存事实重算，节点 id 是工作区相对路径。这样缓存 schema（`PROJECT_STRUCTURE_VERSION` 校验）与后加的图查询互不牵连，重建模型后无需迁移数据。
- **一个排序契约。** `rankStructureFiles` 的 PageRank 同时被结构摘要和图复用，避免图层出现第二套排序实现；`typeOnly` 边不参与社区划分、跨模块引用者计数和面向运行的遍历，因此“类型导入”不会被算成运行时依赖。
- **传输与查询分离。** `runStructureQuery` / `parseStructureQuery` / `isStructurePath` 是纯函数层；`projectStructureMcp.ts` 只处理 JSON-RPC 帧、参数校验和错误码，且每次 `tools/call` 重新读取缓存（无状态、只读），所以重建索引后不必重启服务；行解析失败只回错误，不触发额外操作。
- **模型查询自带读预算。** `readProjectQuery` 在读取前用 `stat` 与字节数双重限制（16 MB），超预算即报错，服务器名 `dext-project`，工具名 `project_query`，只读已维护的 Project 模型与显式关系。
- **注入由宿主负责。** `src/app/application.ts` 的 `conversationMcpServers` 用 `process.execPath` 加 `ELECTRON_RUN_AS_NODE` 按对话注入 `dext_project` 与 `dext_structure`，不需要用户 MCP manifest；结构服务仅在 `cachePath` 存在时注入，工作区未受信任时不注入任何服务。
- **证据面有界。** `structureGraphFacts` 只保留两端都在候选路径内、最多 200 条的紧凑边集，配合 `STRUCTURE_GRAPH_EDGE_LIMIT` / `CYCLE_LIMIT` / `COMMUNITY_LIMIT`，让提示词增长受证据窗口而非仓库规模约束；`workspaceEvidence.ts` 用固定排除与 glob 集合（`PROJECT_EVIDENCE_EXCLUDE`、`PROJECT_SOURCE_GLOB` 等）界定可读范围。
- **宿主侧复用同一批事实。** `projectStructureHost.ts` 的 `readCachedStructure` / `readCachedStructureGraph` / `indexedRelatedPaths` 只读缓存、不碰源码，供图表与证据装配复用同一份摘要和图；`projectStructureKnowledge.ts` 提供候选分组、运行证据窗口与归属/入口校验（`validateOwnership`、`validateEntryPoints`），保证“每个文件恰好归属一个职责”。

## Boundary

- Allowed:
  - 读取 `.dext` 下已保存的结构缓存与 Project 模型，以及在宿主侧按预算读取源码/文档摘录。
  - 由缓存事实重算结构图，并注册、响应 `structure_query` 与 `project_query`。
  - 返回工作区相对路径、`provenance`（`extracted` / `inferred` / `ambiguous`）与截断计数，说明结果不完整。
- Forbidden:
  - 改写源码、`.dext` 中的模型或知识正文；本职责只读。
  - 把 import 关系升级为运行时调用，或把图排序当作正确性评分。
  - 执行构建脚本，或把构建配置当作应用知识模块。
  - 调用 AI 生成职责归属与说明；候选分组只组织阅读，不替代 AI 判定。
  - 持久化派生图，或把摘要/图的结构写回缓存 schema。