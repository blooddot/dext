## Responsibility

- **Names**: App Setup → `createConversationServices`（`src/app/conversationSetup.ts`，同文件导出 `ConversationSetupDependencies`、`ConversationServices`）与 `setupProject`（`src/app/projectSetup.ts`，同文件导出 `ProjectSetupOptions`）；本职责没有第三个名字，这两个入口符号就是它的全部对外面。
- 它拥有「扩展只在激活期装配一次」这件事：会话侧一次调用内按固定顺序构造 `ConversationController`、`AgentEventStream`、`InteractionController`、`PlanController`、`TurnExecutionCoordinator`，交出这五个对象与一个 `dispose()`；项目侧构造 `ProjectDiagramAdapterRegistry`（并注册 `ArchifyAdapter`）、`createProjectPanelDataSource`、`ProjectEditorProvider`，注册编辑器标签序列化器，并把释放挂到 `context.subscriptions`。
- 它拥有「宽宿主收窄成窄端口」：`ConversationSetupDependencies` 只有具名函数（`post` / `postWhenReady`、`currentSelection` / `setAgentSelection`、`executeConversation` / `executeInput` / `draftResource`、`readPlan` / `knownPlan`、`isTrustedLocalWorkspace`、`activeSessionId`、`flushAttachmentDeletes`、`runningChanged` 等），没有被注入的侧栏实例，也没有整份应用对象；`ProjectSetupOptions` 只交出 `ProjectStore`、`EditorTabManager`、`EditorTabRestorer`、`renderEditorHtml`、`ProjectAiProvider`、`AgentProfile` 列表与三个回调。
- 它拥有可选能力的存在性判定：`startPlanProject`、`finishPlanProject`、`preparePlanBuild`、`resolveSkillCommand`、`maxEventTextLength` 只在侧栏提供时才以条件展开方式传入，缺省策略（`DEFAULT_HISTORY_LIMITS.maxOutputLength`）也在这一处兜底。
- 它拥有组件之间的连接边与释放顺序：`PlanController.startTurn` 接到 `coordinator.execute`（透传 `planPath` 与 `executePlan`），`AgentEventStream` 的 `observe` 接到 `interactions.observeEvent`，`running` 回落链指向 `executionRef.coordinator`；`dispose()` 按 `abortAll` → `events` → `interactions` → `controller` 收尾。项目侧先注册图表适配器，再随上下文统一释放。
- 它不拥有任何业务判断：不执行回合、不裁剪证据、不生成索引、不渲染 HTML、不定义持久化格式。

## Design

- **形状由依赖方向决定。** 会话状态与项目知识各有唯一所有者（controller 管会话映射、coordinator 管执行与中止、events 管事件缓冲、interactions 管问答、plans 管 Plan 文本），它们互相需要却都不能 import 对方；`features/*` 又不得反向 import 组合根，于是「谁拿到谁」只能写在这一层。`docs/development.zh-CN.md` 把 `src/app/` 定为唯一可依赖任意层的组合根，`docs/project-development.zh-CN.md` 规定 AI 桥接只接收执行方法、Profile 与 Selection 回调，不接收整个应用实例。
- **依赖是窄函数，不是回调对象。** 正因为如此，`conversationSetup.ts` 不接触任何 VS Code 全局，一个回合可以在 `test/conversationSetup.test.ts` 里跑通，不必 mock 整个侧栏。
- **先建被引用的端口，后填协调器。** `executionRef` 让 controller、events、interactions、plans 在 coordinator 尚未构造时就能读到 `running()` / `turnOf()`（`?? false`），注释写明装配期间无人调用，装配末尾再赋值；循环只存在于这一处，且是代码里可见的。
- **装配与重连刻意分开。** 本函数由侧栏构造期调用一次，Webview 重载、标签切换与 `ready` 处理只能重放状态，不能再建第二份实例、第二条订阅或第二个计时器。
- **线协议的翻译放在同一处闭环。** `notifier` 把 coordinator 的生命周期回调翻成 `executing`（起止）、`execution`、`executionFailed`，并在开始与结束两侧调用 `runningChanged()` 同步 `dext.running` 上下文键。
- **项目侧证据输入按调用读取。** `projectEvidenceInput()` 每次重新 `readDefinition()` 再解析预算，因此设置改动对下一次初始化或生成图立即生效，不必重新装配；缺 `definition.evidence` 时直接报错，对应「必须先显式保存」的约定。
- **索引缓存只有一份路径。** `structureCachePath` 落在 `storageUri ?? globalStorageUri`，由 `readProjectEvidence`、`readStructureIndex` 与 `readStructure` 共用，索引算一次、后续复用。
- **图表只搬运不裁决。** 最后可用快照交给 `ProjectDiagramAdapterRegistry` 做校验与体积预算，`ArchifyAdapter` 的仓库根由 `discoverArchifyRepository(folder.uri)` 惰性发现。
- **旧标签没有状态是正常输入。** `restoreEditorTabState` 失败时回退 `createEditorTabState(provider.key, { page: "overview" })`，`adoptRestored` 用 `invalid` / `opened` 区分占用，`isProjectPanelPage` 兜底未知页面，既不重复打开同一标签，也不留空白页。
- **证据跳转先校验再打开。** `isProjectEvidencePath`、`isExcludedProjectEvidencePath` 与 `workspace.getWorkspaceFolder` 三重判定在前，稳定 ID 的证据跳转因此不会越界。
- **`aiCli` 只做形状摊平。** 把 `AgentProfile.modelOptions` 转成面板选择器所需形状，group、推理档、速度档、服务档逐项做可选字段过滤，不产生 `undefined` 键。

## Boundary

- Allowed: 在 `src/app/` 组合根依赖任意 feature 的 `host/` 与纯层、`src/platform/`（含 `editor-tabs`）、`src/shared/`、`src/runner/` 的类型；以窄函数与窄接口注入宿主能力；建立组件之间的单向连接；按固定顺序统一释放。
- Allowed: 只在这里转接 VS Code 适配（`context.extensionUri` / `storageUri`、`workspace.findFiles`、`openTextDocument`、剪贴板、`commands.executeCommand`、`registerWebviewPanelSerializer`），并按当前 definition 解析读取预算与 `aiCli` 选项。
- Allowed: 新增宿主能力时以可选依赖声明并条件展开传入，由侧栏决定是否提供；缺省策略在此处兜底。
- Forbidden: 在 Webview 重载或激活事件里再次调用 `createConversationServices`，再注册第二个图表注册表或第二个序列化器，或在此处订阅事件、启动定时器。
- Forbidden: 把会话业务状态、执行调度、Plan 判定、证据裁剪、结构索引、AI 生成、HTML 渲染与持久化格式搬进装配点（分别归各 controller 与 coordinator、`PlanController`、`projectAiGeneration`、`projectStructureHost`、`projectPanelDataSource`、注入的 `renderEditorHtml` 与 `ProjectStore`）。
- Forbidden: 让 feature 模块反向 import `src/app/`；在路径未校验时打开证据文件，或让证据跳转落到工作区之外；让图表历史绕过 registry 的准入直接成为预览；把凭据与 `isSecret` 答案带出到装配参数以外的状态里。