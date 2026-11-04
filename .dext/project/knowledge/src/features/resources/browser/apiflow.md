## Responsibility

- **Names**: apiFlow → `src/features/resources/browser/apiFlow.ts`（模块无公开导出，入口即文件末尾的顶层副作用；私有函数 `renderFlow` 是实际执行体）。
- 它只拥有“把宿主已经给出的 Mermaid 源码变成页面上的图”这一件事：在文档中找出所有 `[data-api-flow]` 根节点、从 `[data-api-flow-source]` 取出源码、调用共享渲染器，并把结果写成 `data-api-flow-state`（`ready`/`error`）以及失败时的状态文案与展开的源码详情。
- 它不拥有 API 详情页的 HTML、API 数据的取数顺序，也不拥有 Mermaid 源码的生成与校验。

## Design

- 宿主只投递 Mermaid 源码，浏览器侧才懒加载共享的 `mermaid.js` 包（`platform/browser/markdownDiagrams.js` 的 `renderMermaidSvg`）：API 页面只在真的存在流程图时付出渲染器成本，会话页复用 VSIX 里的同一份拷贝。
- 状态全部落在 DOM 上：每次渲染重新查询 preview/status/details/source，页面与脚本之间只通过 `data-*` 属性耦合，没有额外的数据模型或注册表，因此该入口没有已知的 import 消费者也可独立运行。
- 失败是可见状态而不是异常：preview 缺失或源码为空时写入错误文案、展开源码详情并置 `error`；渲染 Promise 被 `catch` 后走同一条路径；成功则写入 SVG、移除 status 并置 `ready`。
- `root.isConnected` 在 `await` 之后检查，避免页面已重绘时把 SVG 写进已脱离文档的节点；整趟遍历用 `void renderFlow(root)` 逐个触发，任一根节点失败或阻塞都不影响其他根节点与页面其余脚本。
- 与 presentation 层的 `apiFlowDiagram` 刻意是两条路径：那边负责生成源码文本，这边只负责源码到 SVG 的呈现，所以浏览器入口不必理解 API 调用流程的语义。

## Boundary

- Allowed: `platform/browser/markdownDiagrams.js` 的 `renderMermaidSvg`；页面上的 `data-api-flow*` 属性与标准 DOM API。
- Forbidden: 引入 `vscode`、Node 内置模块、任何 `host/` 或 `contracts/` 实现；自行生成、解析或改写 Mermaid 源码；拥有 API 详情页与资源标签页的 HTML/样式；跨根节点缓存已渲染的 SVG 或发起网络请求。