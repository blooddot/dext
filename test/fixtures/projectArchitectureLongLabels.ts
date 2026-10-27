import type { ProjectDiagram } from "../../src/features/project/contracts/projectDiagram.js";

/** C4 fan-out with the full relationship descriptions that overlapped in Project. */
export const architectureLongLabels: ProjectDiagram = {
  schemaVersion: 1, id: "architecture-long-labels", title: "Runtime units", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [
    ["host", "VS Code 扩展宿主 [container]"],
    ["sidebar", "侧边栏聊天 Webview [container]"],
    ["tabs", "编辑器标签 Webview 页面 [container]"],
    ["kernel", "Code 模式 Node 内核 [container]"],
    ["archify", "Archify 图表渲染进程 [container]"],
    ["agent", "外部 Agent CLI 后端 [system · external]"],
    ["mcp", "外部 MCP 服务器 [system · external]"]
  ].map(([id, label]) => ({ id: id!, label: label!, role: "component", semanticIds: [], evidence: [] })),
  relations: [
    ["sidebar", "扩展宿主与侧边栏 Webview 通过 postMessage 交换状态与客户端请求。 · VS Code Webview postMessage"],
    ["tabs", "宿主创建、恢复并路由编辑器标签 Webview，页面通过消息处理器提交操作。 · VS Code WebviewPanel、postMessage"],
    ["kernel", "宿主启动长驻 Node 子进程，并以内置 loader 运行 Code 模式工作流。 · Node.js 子进程、ESM"],
    ["archify", "宿主为 Project 图表处理启动随扩展分发的 Archify 子进程。 · Node.js 子进程、Archify CLI"],
    ["agent", "扩展宿主调用用户安装并认证的外部 Agent CLI 后端执行 Agent 或对话轮次。 · 外部 CLI 进程"],
    ["mcp", "Dext 依据服务器配置选择 stdio 或 HTTP 传输，调用 MCP 工具并发现工具能力。 · MCP stdio JSON-RPC / HTTP"]
  ].map(([to, label]) => ({ id: `host-${to!}`, from: "host", to: to!, kind: "calls", label: label!, evidence: [] })),
  semantics: { boundaries: [{ id: "dext", label: "Dext", nodeIds: ["host", "sidebar", "tabs", "kernel", "archify"], evidence: [] }] }
};
