## Responsibility

**Names**: apiPanel → src/features/resources/presentation/apiPanel.ts（renderApiList、renderApiDetail）

- 拥有 API 页与 Global Resources 页的渲染变体：`renderApiList` 给 `ResourcePanelOptions` 补上 `apiTree: true` 后交给 `renderResourceList`，`renderApiDetail` 委托 `renderResourceDefinition`；`renderGlobalResources` 按 `RESOURCE_LABELS` 重排分组、补 `title` / `createKinds` / `categoryTree` 后再委托。这三个函数就是 `ResourceEditorProviderOptions.renderList` / `renderDetail` 的覆盖值，分别由 `ResourceBrowserProvider`、`GlobalResourcesEditorProvider` 注入。
- 拥有 API 详情页的 Execution flow 图壳：`renderApiFlow` 产出 `<figure data-api-flow>`（状态行、preview 容器、`severity === "error"` 的规则问题、Mermaid 源码 details、函数清单），`renderApiFlowMermaid` 生成 `flowchart TB` / `flowchart LR` 源码。
- 拥有资源页工具栏图标：`resourceIcon` 提供 file、trash、collapse-all、expand-all、refresh、folder-opened、upgrade 的内联 SVG。
- 命名对应：页面对外标签是 `RESOURCE_LABELS` 的 "API" 与 "Global Resources"，contracts 注释称它们为 "the migrated API and Global Resources pages"；本责任仍以代码名 apiPanel 记录。

## Design

- 变体即选项，不是子类：共享渲染器 `renderResourceList` / `renderResourceDefinition`（同目录 resourceDocuments.ts）把全部差异收进 `ResourcePanelOptions`（`apiTree`、`categoryTree`、`createKinds`、`title`、`collapsed`、`commandPrefix` 等），因此新增页面只需一层薄封装，宿主以 `renderList` / `renderDetail` 注入而不用覆写方法；contracts 已写明 "Page renderers. The migrated API and Global Resources pages override these."。
- 纯函数、无宿主依赖：只接收已构建好的 `ResourceListDocument` / `ResourceDefinitionDocument`，返回 HTML 字符串；不读文件、不碰 `vscode`、不保存状态，所以同一输入可重复渲染，整页替换与测试都无需模拟面板。
- 图只是壳：宿主从不执行 Mermaid。`renderApiFlow` 只输出 `data-api-flow-state="loading"` 的占位与状态提示，由 webview 侧的 `browser/apiFlow.ts` 渲染 SVG 并更新状态；同时保留 Mermaid 源码与函数列表，渲染失败时仍可读，只有 error 级问题进入 `role="alert"` 区块。
- 源码稳定：Mermaid 节点 id 由索引生成（`n0`、`n1`…），边按函数顺序与调用顺序输出并按 `from/to` 去重，所以结果与函数名无关、跨次运行 diff 稳定；入口节点统一用 `classDef entry stroke-width:2px` 加重，与调用图保持同一约定。
- 两处转义各有理由：DOM 文本走 `escapeHtml`（shared/lib/html.ts），Mermaid 标签另用 `mermaidText`，因为 strict 模式会把 `#quot;` 还原成字面 `&quot;`，故双引号改写为单引号，同时仍做实体转义，用户文本不会变成标记。
- 图标内联（Codicons，MIT）而非引用资源文件，工具栏无需额外请求或图标字体依赖。
- 形态承接被移除的侧边栏对话框：搜索、命名空间分组、详情、引用插入与源码跳转都保留，Global Resources 的每个分类再按自身命名空间嵌套，与 API 页一致。

## Boundary

- Allowed: 依赖 `../contracts/resourceDocuments.js`、`../contracts/resourceSession.js`、`../../workflow/contracts/apiFlow.js`、`../../../shared/lib/html.js`，以及同目录共享渲染器 `./resourceDocuments.js`；由 host provider 调用，输出 HTML 字符串与 Mermaid 源码文本。
- Forbidden: 不读资源、不访问文件系统或 `vscode` API（数据来源与 `buildResourceList` / `buildResourceDefinition` 归 host 与共享渲染器）；不定义 tab、命令与面板状态（归 `ResourceBrowserProvider` / `ResourceEditorProvider`）；不执行 Mermaid、不生成 SVG（归 webview 的 `browser/apiFlow.ts`）；不创建或编辑资源；共享页面渲染器 `resourceDocuments.ts` 与 `apiFlow` 类型不在本节点内。