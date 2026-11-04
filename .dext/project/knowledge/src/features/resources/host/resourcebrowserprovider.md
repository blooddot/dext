## Responsibility

- **Names**: Resource Browser Provider → src/features/resources/host/resourceBrowserProvider.ts，连同 resourceEditorProvider.ts、apiEditorProvider.ts、globalResourcesEditorProvider.ts、resourceActions.ts、githubArchive.ts、githubSkillSnapshot.ts、skillVariants.ts。
- 拥有“资源”功能在扩展宿主侧的整条实现链：`ResourceEditorProvider` 定义编辑器 Tab 的公共行为（`showList`/`showDetail`/`detailKey`/`handleMessage`、`listKinds`/`groupBy`/`primaryKind` 三个可覆写钩子），`ResourceBrowserProvider` 在其上叠加前进/后退/首页历史与每条的 `query`、`scrollTop`、`scope`、`collapsed` 视图状态，`ApiEditorProvider` 与 `GlobalResourcesEditorProvider` 只声明自己的页面种类，`ResourceBrowserProvider` 构造函数里传入的 `kind` 决定 Tab 归属。
- 拥有数据来源的适配：`createFileResourceDataSource` 按种类枚举磁盘上的 api/mcp/rule/skill 资源并把文件映射成 `ResourceEntry`，`createApiDataSource` 把可调用 API（`apiEntry`）与语言参考（`apiReferenceEntries`）合并进同一份列表。
- 拥有资源写操作与删除计划：`managedResourcePath`、`resourceRemovalPlan`、`removeManagedResource` 判断一个条目是否受管、删除会波及哪些文件，再由调用方确认执行。
- 拥有技能导入所需的远端获取：`fetchGithubArchive`、`resolveGithubRef`、`extractTarGz`、`fetchGithubSkillSnapshot`、`collectSkillVariants`。

## Design

- 三层继承而不是三份重复实现：`ResourceEditorProvider` 只做“打开同一个目标就复用一个页面、消息路由、列表/详情渲染委派”，`ResourceBrowserProvider` 只补“同一个 Tab 内的浏览历史”，两个具体类各自只答一个问题（`listKinds` 与 `groupBy`）。新增一个资源页面只需继承并回答这两个钩子，不必重写消息处理。
- 数据来源通过 `ResourceEditorDataSource` 注入，渲染函数通过 `renderList`/`renderDetail` 注入。因此本模块从不直接读文件、也不拼 HTML，测试可以替换 `dataSource` 与 `manager`，展示层（presentation/）也能脱离编辑器复用。
- `handleMessage` 只把消息转成“导航/刷新/命令”，真正的副作用留给 `options.onCommand`；`deleteResource` 与 `upgradeSkillPack` 成功或失败后都重新渲染当前页，是为了不把“命令是否成功”这一判断复制到宿主两侧。
- 远端部分刻意分成“索引”和“内容”两步：`fetchGithubSkillSnapshot` 先用 Git tree 拿到路径与 blob 哈希（`paths`、`fileHashes`），选定后再由 `loadFiles` 只下载被选中的字节，避免无关资产吃掉导入预算；`loadFiles` 先对整批做预检（存在性、类型、大小）再并发下载，因为半途失败会留下不完整快照。
- 所有网络路径共享 `DEFAULT_ARCHIVE_LIMITS` 与可注入的 `fetch`/`apiBase`/`codeloadBase`：压缩体积、展开体积、文件数、超时和重定向白名单都在同一处收紧，让一个恶意仓库不能撑爆扩展宿主，同时测试无需真实联网。

## Boundary

- Allowed:
  - 在 `src/features/resources/host/` 内新增编辑器提供者、数据来源、资源写操作与 GitHub 获取逻辑。
  - 复用 `src/features/resources/contracts/` 与 `domain/` 中的类型（`ResourceEditorProviderOptions`、`ResourceEntry`、`ResourceScope`、`GithubSource`）与 `platform/editor-tabs/` 的 Tab 工具。
  - 把渲染交给 `src/features/resources/presentation/`，把 AI 解析与导入判定交给技能导入流程。
- Forbidden:
  - 生成面板 HTML 或决定视觉结构（属于 presentation/）；本模块只传 `ResourcePanelOptions`。
  - 直接访问磁盘或 `globalThis.fetch`、自行放宽体积/超时限制：文件枚举由 `listFiles`/`readFile` 回调提供，网络必须走注入的 `fetch` 与 `DEFAULT_ARCHIVE_LIMITS`。
  - 在没有确认的情况下删除文件；删除只产出 `ResourceRemovalPlan`。
  - 承担技能内容的语义分析或导入结论（`skillImportAnalysis`/`skillImporter`），以及浏览器侧的页面状态管理。