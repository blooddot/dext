## Responsibility

- **Names**: ProjectStore persistence → `src/features/project/host/persistence/projectStore.ts`（同一切片：`projectHash.ts`、`projectModelStore.ts`、`projectMigration.ts`、`projectNorms.ts`）；公开入口符号是 `ProjectStore`、`ProjectModelStore`、`projectContentHash`、`commitProjectMigration`、`listProjectNorms` / `writeProjectNorm`，文件宿主接口 `ProjectFileHost` 也定义在这里，但它的 VS Code 实现属于另一职责 `VscodeProjectFileHost`。
- 它拥有 `.dext/` 下的长期项目文件及其字节级写入：定义与设置 `project.json`（`PROJECT_DEFINITION_PATH`，含 `version`）、旧版规范 `project-intent.json`、`architecture.json`、`diagrams/<id>.json`、`diagram-history.json`、证据诊断 `evidence.json`，以及迁移前的 `.dext/objects/<id>.json`；每个路径常量与 `projectDiagramPath()` 只在这里定义一次。
- 它拥有“两份规范谁说话”：原生模型 `ProjectModelStore` 一旦存在即成唯一权威，`readLegacySnapshot`、`writeLegacyChecked`、`deleteLegacyChecked`、`writeIntent`、`writeArchitecture` 全部直接报错；旧文档只在迁移前可写，并负责把模型节点反向投影回 `ProjectObject` / `ProjectIntent` / `ProjectArchitectureDocument` 给既有消费者。
- 它拥有冲突判定与提交顺序：`writeDefinition` / `writeArchitecture` 以 `version` 加“写前再读一次原始文本”判 `{ status: "conflict", current }`；`ProjectModelStore.update` 以 `revision` 守卫，把知识文档写盘夹在 `model.json` 提交之前，并在 `.dext/project/migrations/update-<hash>.json` 里逐份留回执，最后才落 `model.json`。
- 它拥有迁移的确定性与可重试性：`migrateProjectModel` 从 `ProjectLegacySnapshot` 一次性构造节点、关系与 `aliases` 映射，ID 冲突才追加哈希后缀；`commitProjectMigration` 在切换格式前把原文备份写到 `migration.backup`，逐文件复核哈希与文件集未变，已有模型则原样返回，因此重试写的是同一份备份。
- 它拥有规范正文的编辑语义：`writeProjectNorm` 把未改动的正文记成 `accepted`、改动过的记成 `edited` + `needs_verification`，用 `structureFingerprint` 把确认绑定到成员/父子结构而不是措辞，文档型正文与它的 `contentHash` 走同一次 `updateProject` 事务。
- 形状如此，是因为项目知识必须比对话活得久、又会被多个窗口同时改写：字节文件与 `ProjectFileHost` 端口隔开环境，哈希把“内容没变”和“被外部改过”变成同一个可计算事实，原生模型用一次带修订号的提交替代无数条“尽力而为”的写。

## Design

- **两层写入，各有守卫。** 旧层按字节读写并逐个走 zod（`projectDefinitionSchema`、`projectArchitectureSchema`、`projectIntentSchema` + `validateProjectIntent`、`normalizeProjectObject`、`validateProjectDiagram`）；原生层管模型，内部 `queue` 把并发 `update` 串成一次 `commit`，失败的 promise 不阻塞下一次。
- **一个哈希服务三处。** `projectContentHash`（sha256）同时用于冲突检测、知识文档归属校验（每个 `body.kind === "document"` 的路径必须恰好被一个节点拥有且哈希相符）与恢复日志命名，重复路径在写任何文件前就被拒绝。
- **写文档前先算清“能不能写”。** `ProjectDocumentUpdate` 携带 `beforeHash`，每次落盘前重读；既不是旧哈希也不是目标哈希即报冲突，而 `model.json` 的原文本再次被比对，防止提交期间被另一窗口改写——此时保留 journal 而不是回滚掉证据。
- **strict 与宽松读分档。** `readStrict` / `listStrict` 在宿主提供严格方法时区分“不存在”与“读不到”，让 Plan 能报 `absent` 与 `unavailable`；`readDefinition`、`readEvidenceSummary`、`readDiagramHistoryState` 则容忍缺失与损坏，回落到默认值或 `undefined`。
- **损坏按文件降级。** 定义文件解析失败回默认定义、单张图校验失败被跳过、历史与证据文件解析失败返回 `undefined`；证据记录被明确标成诊断而非知识，因此一个坏文件不会阻塞初始化或生成。定义 schema 用 `passthrough` 保留旧字段与未知字段，但不主动生成它们。
- **架构规则针对真实端点求值。** `readLegacySnapshot` 只接受显式 `diagramId` 或唯一一张 architecture 图，并校验每条 `allow`/`deny`/`no_cycles` 规则的 `from`/`to` 确实存在于该图（`*` 仅用于 `no_cycles`），因此不会按标题猜端点。
- **初始化状态从数据推导。** `readInitialization` 组合定义标记、有效 intent 与图数量，旧的 `initialized` 布尔或残留扫描数据本身不算成功。
- **迁移是纯函数加一次提交。** 节点 `origin`/`review`/`freshness` 由旧字段推导（`source === "user"` → `declared`），关系方向与 owner 一起记录，C4 与流程步骤用 `legacyScope` 保留来源；导入结果交给 `ProjectModelStore` 走正常提交路径，不为迁移另开写口。

## Boundary

- Allowed: 通过 `ProjectFileHost`（`readFile`、`writeFile`、`listDirectory`，可选 strict 与 `deleteFile`）读写 `.dext/` 内的相对路径；用 `contracts/` 的 schema 与 `knowledge/projectModel`、`projectDiagramHistory` 的纯函数校验与转换；计算并复用 `projectContentHash`；把原生模型提交与回执委派给 `ProjectModelStore`；为 Plan、面板与测试产出 legacy 快照、对象、架构与规范视图。
- Allowed: 定义并导出 `ProjectFileHost` 端口、路径常量与文件格式的 zod schema，让扩展宿主、worker 与内存测试替身（`test/planProjectIntegration.test.ts` 一类）共用同一份读写语义。
- Forbidden: 直接依赖 `vscode` 或 `vscode.workspace.fs`、把相对路径解析成真实路径或做 `realpath` 越界校验（属 `vscodeProjectFileHost.ts`）；递归遍历目录树、应用忽略规则或做证据预算（属 `indexing/`）；持有 `.dext/project-initialization.checkpoint.json` 的格式与生命周期（属 `projectInitializationCheckpointStore` 与 `generation/projectModelCheckpoint`）。
- Forbidden: 调用 AI、索引或生成流水线，也不决定“该生成什么”；渲染或操作界面、依赖 webview/DOM；读写对话历史、会话快照或会话目录。
- Forbidden: 静默接受损坏输入、自动修复数据或在冲突时覆盖；在原生模型存在后继续双写旧规范；绕过 `ProjectFileHost` 写工作区内的任意路径或工作区之外的路径。