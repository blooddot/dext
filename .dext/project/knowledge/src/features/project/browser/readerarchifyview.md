## Responsibility

- **Names**: Knowledge / Project 阅读器里的交互图 → `ReaderArchifyView` / `renderReaderArchify`（`src/features/project/browser/projectReaderArchify.ts`），注入沙箱的桥接脚本 `archifyViewerBridgeScript`（`src/features/project/browser/archifyBridge.ts`），页面引导 `src/features/project/browser/entry.ts`（调用 `startProjectReader`），往返契约 `ProjectReaderRenderRequest`／`ProjectReaderExportRequest`／`ProjectReaderEvidenceRequest`（`src/features/project/contracts/reader.ts`）。界面把这一页叫 Knowledge（旧 `architecture` 键打开同一阅读器），代码里这次显示的公开类型是 `ReaderArchifyView`，标题沿用代码名。
- 它只拥有一张已保存的 Project 图在沙箱里“被显示、被操作的那一次会话”：建 iframe、向宿主请求渲染、注入桥接脚本、把 Archify 本地 id 译回 Project 稳定 id、校验双向消息、关闭时切断迟到消息。图怎么生成、正文怎么解释、模型怎么写入都不归它。
- 一次显示的身份由 `session` 与 `requestId`（各由 `crypto.randomUUID()` 生成）确定；对外只暴露 `ready`、`command`、`dispose`。`ready` 在收到 `dext-diagram-ready` 且 `archify === true` 时兑现，30 秒无响应即拒绝。

## Design

- **沙箱决定了形态。** 图表 iframe 只有 `sandbox="allow-scripts"` 与 `allow="fullscreen"`，拿不到 VS Code API，页面也只能经注入的 `postMessage` 与宿主通信；因此桥接不能 import 共享模块，只能以自包含字符串 `archifyViewerBridgeScript(session, theme, forwardEscape)` 注入 `<head>`，并给注入的 `<script>` 补上页面 nonce。
- **桥脚本跟着会话走，不单独成职责。** 宿主或 `ReaderArchifyView` 都不使用它，只有创建这次会话的代码会注入它，它也没有自己的消息入口；把它拆成独立边界会得到一个只被这一处调用、且必须与 `session` 同生共死的模块，所以它与会话合为同一个职责。
- **一次快照一个 iframe。** `renderReaderArchify` 每次 append 一个 iframe，`dispose` 移除监听、移除 iframe 并让 `ready` 失败；监听器在 `disposed` 或 `canvas.isConnected` 为假时直接返回，所以异步渲染与退出动画都无法覆盖后来选择的图或主题。宿主回包还要 `requestId`、`diagramId`、`updatedAt` 三者同时匹配才被接受。
- **信任按来源分区。** `isTrustedViewerMessage` 要求 source window 等于 iframe 窗口且 `__dext` 等于本次 `session`；`isTrustedHostMessage` 反过来拒绝来自 iframe 的消息，并拒绝携带 `__dext` 的消息；命令面由 `VIEWER_COMMANDS` 白名单加 `isViewerCommand` 收口，未命中的命令在桥内抛错而不是宽松执行。
- **稳定 id 只存在于宿主侧。** 桥先接收 `map` 命令（`nodes`／`ids`／`relations`，来自渲染回包的 `mapping`），之后把 `[data-node-id]`、`data-edge-id`／`data-composition-edge-id` 译回 Project id 再经 `inspect(id, kind)` 回传；点击与路径演示都走同一条路，Archify 的布局 id 从不被当成身份。
- **导出必须取回源码文本。** Archify 用 blob URL 加带 `download` 的锚点导出，桥因此改写 `URL.createObjectURL` 与 `HTMLAnchorElement.prototype.click`，把 SVG 原文作为 `dext-diagram-export` 发出，再由 `renderReaderArchify` 以 `projectReaderExport` 附上 `diagramId`／`updatedAt` 交宿主核对后保存。
- **交互留在沙箱内。** 主题由 `matchMedia` 桩值与 `Archify.theme` 同步；Ctrl/Cmd 滚轮围绕指针缩放，并把触控板小增量累积到一步；全屏走 `Archify.presentation`，进入前记住原状态，Escape 经 `dext-diagram-escape` 交回页面。
- **入口只做引导。** `entry.ts` 读取 `window.__dextApi`、启动阅读器、折叠目录，并单独处理 `projectQualityCopy` 回执（按钮禁用加 10 秒超时）；渲染会话语义不在这里。

## Boundary

- Allowed: 创建与销毁图表 iframe；生成并注入带 nonce 的桥接脚本；校验 `dext-diagram-*` 消息的来源与 `session`；把 Archify 本地 id 映射为 Project id；转发节点／关系点击、Escape、SVG 导出与 `command(...)`；读取 `ProjectDiagram` 的 `id`、`updatedAt`、`title` 以绑定快照；通过注入的 `postMessage` 发起 `projectReaderRender` 与 `projectReaderExport`；`entry.ts` 引导 `startProjectReader` 并回执复制结果。
- Forbidden: 直接调用 VS Code 或 Node API，读写 `.dext` 或任何持久化状态；生成图表 HTML、布局或渲染器（宿主 `src/features/project/host/diagrams/archifyAdapter.ts` 负责）；把 Archify DOM id 当成 Project id，或把 iframe 内 DOM 当语义来源；接受缺少 `session` 的 viewer 消息，或接受来自沙箱的宿主消息；在 `dispose` 之后继续处理消息或保留未兑现的 `ready`；解释证据、改写正文、拥有主题／图库／播放的页面状态（属于 `startProjectReader`），或在渲染失败时切换到第二套布局引擎。