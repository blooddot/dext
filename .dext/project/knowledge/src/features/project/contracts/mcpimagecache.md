## Responsibility
- **Names**: mcpImageCache → `src/features/mcp/host/mcpImageCache.ts`（导出 `McpImageCache` 类）。界面与文档没有单独的名称，代码名即标题。
- 它只拥有「MCP 图片内容块的本地留存」这一件事：把一次 `tools/call` 结果里的 `image` 块写到宿主磁盘，回传 Webview 可加载的 URL、字节数和跳过原因。MCP 协议解析、图片渲染、消息拼装都不在它这里。
- 写入与回收是同一职责的两半：本次会话写过的文件不能因为「太旧」被删——一次 MCP 调用可能停在确认卡上很久；可随时间回收的只有更早会话留下的文件。单张图片上限是 `MAX_MCP_IMAGE_BYTES = 10MB`。

## Design
- `store(blocks, label)` 先 `prune()` 再逐块 `write()`，单块失败只进 `diagnostics`（`<label> image skipped: …`）而不抛出，所以 `McpToolRegistry` 里图片链路失败不会让 tool call 本身失败。
- 写入把不可信输入挡在最前面：MIME 白名单只有 png/jpeg/gif/webp；base64 先判长度上界再解码，避免为超大载荷造第二份拷贝；文件名用 `randomUUID()` 配 `wx` 与 `0600`，服务器自带的文件名永不复用，目录里不符合 UUID 命名的文件不读也不删。
- URL 来自注入的 `toUrl`，只有 `https://` 才算成功，否则回滚删除已写文件——缓存本身不 import `vscode`，资源根的可用性由组合根负责。
- 回收策略刻意不对称：`protectedNames()` 按写入顺序倒序、只保护到总预算的一半，旧会话文件先按 `maxAgeMs`（默认 7 天）过期，再按 mtime 最旧优先删到 `maxTotalBytes`（默认 100MB）；`store()` 在写入前后各 prune 一次，因为新写入可能把旧会话推过预算。

## Boundary
- Allowed: 同 feature 的 host 消费者 `src/features/mcp/host/mcpRegistry.ts`（`setImageCache` 注入、`store` 调用）；组合根 `src/app/application.ts` 提供 `directory`/`toUrl`/`now`（目录为全局存储下的 `mcp-media`）；Node 内置 `node:crypto`、`node:fs/promises`、`node:path`；`test/mcpImageCache.test.ts`。
- Forbidden: 解析或执行 MCP 协议与传输（`mcpRegistry.ts` 及其 adapter）；决定 Webview 资源根与 URI 形状（`setMcpImageWebview`/`asWebviewUri` 在 `app`）；渲染图片或改写会话消息（`features/conversations/browser`）；导入 `vscode` 或 DOM；跨 feature 的 host 耦合以及依赖 `src/app`、`src/webview`；把图片字节写入对话历史、日志或 URL（token 不得随 URL 出行）。