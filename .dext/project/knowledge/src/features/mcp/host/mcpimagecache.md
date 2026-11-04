## Responsibility

- **Names**: mcpImageCache → `src/features/mcp/host/mcpImageCache.ts`、`src/features/mcp/host/mcpSecrets.ts`。两处公开符号是 `McpImageCache` 与 `McpAccessTokenStore`，本职责的标题取自前者所在的模块名，两者共同承担「MCP 载荷换成宿主侧句柄」这件事。
- 它拥有 MCP 结果里那部分**不能直接进对话正文的字节**：`McpImageCache.store(blocks, label)` 把 `tools/call` 返回的 base64 图片块写成磁盘文件，回传 `McpCachedImage`（`mimeType`、`url`、`byteLength`）与 `diagnostics`，并负责这些文件的回收。
- 它拥有 MCP 凭据**不能落进 manifest 的那一半**：`McpAccessTokenStore.get / store / delete` 按 server、`McpCredentialKind`、`McpCredentialScope` 读写 VS Code `SecretStorage`，空令牌直接拒绝。
- 它不拥有工具调用、结果形状与注册表准入：`McpToolRegistry` 调用完成后把 `result.images` 交给 `store()`，再用注入的 `accessTokenProvider` 向 `McpAccessTokenStore` 取令牌；缓存或密钥失败只变成 `imageError`／诊断文本，从不改写工具调用本身的成败。

## Design

- **两种载荷，同一个动作：用不透明句柄替代原值。** 图片文件名是 `randomUUID()` 加扩展名，服务器自带的文件名永不采用；密钥键是 `createHash("sha256")` 的摘要加 `dext.mcp.<kind>.` 前缀。句柄既不泄露内容，也不依赖服务器提供的可选字段，因此 Webview 拿到的 URL 与存储里留下的键都不携带秘密。
- **图片从不进入 Webview 自己的 realm。** 文件由宿主写一次，`toUrl` 由 `application.ts` 注入成 `asWebviewUri`，返回非 `https://` 时立刻删文件并抛错——令牌因而没有机会跟 URL 一起旅行。
- **刻意不在写入时套用 TTL。** 一次 MCP 调用可能挂在确认卡片上远超任何年龄阈值，所以 TTL 与总量裁剪只回收**早前会话**留下的文件；本会话文件按写入顺序从新到旧保护，但最多只保护总预算的一半，避免单次长会话把缓存撑到无上限（默认 100 MB 总量、7 天、单图 10 MB）。
- **先量后解码。** 超过 10 MB 的 base64 长度在 `Buffer.from` 之前就被拒绝，不为一枚越界图片多开一份内存副本；不支持的 `mimeType`、空数据、非法 base64 都只影响当前块。
- **失败是诊断，不是异常。** 单块失败进 `diagnostics`，`store()` 前后各跑一次 `prune()`，`McpToolRegistry` 用 `try/catch` 兜住整段图片处理，因为图片支持不该让工具调用失败。
- **两个文件都不 import `vscode`。** `McpImageCache` 只依赖 Node 内置模块与注入的 `toUrl`，`McpAccessTokenStore` 只依赖 `SecretStorageLike` 与 `workspaceScope()`，因此键的派生（workspace 用 `workspace\u0000serverName`，global 用 `serverName` 且带 `.global.` 段）可以用假实现直接断言。
- **这条边界仍是草稿。** 候选范围两次评审被否：图片落盘回收与密钥读写共享的只是「换句柄」这一抽象，而不是同一份数据生命周期。保留为单一职责是为了先记录事实，最终归属待人工复核。

## Boundary

- Allowed: 在 `globalStorageUri` 下的 `mcp-media` 目录写入随机 UUID 图片文件，按 mtime 与总量回收早前会话文件；通过注入的 `toUrl` 换取 Webview 可加载的 https URL；经 `SecretStorageLike` 读取、写入、删除 MCP 令牌；按 `McpCredentialScope`／`McpCredentialKind` 派生 `SecretStorage` 键。
- Allowed: 向 `McpToolRegistry` 暴露 `setImageCache` / `setAccessTokenProvider` 两个注入点，并只通过返回值（`images`、`diagnostics`）与异常文本影响调用方。
- Forbidden: 发起 MCP 请求、解析 `tools/call` 响应或决定某个服务器/工具是否可用（属 `McpToolRegistry`）；解析 `.dext/mcp/*.jsonc` 或产出 manifest 诊断（属 `mcpManifest`）；重写 `McpServerConfig` 等声明形状（属 `contracts/mcp.ts`）。
- Forbidden: 把令牌写进图片文件、诊断、日志或 Webview 状态；把图片字节放进对话正文或 `.dext` 持久化；直接 import `vscode`、把 `SecretStorage` 实例传进缓存类，或让 `McpImageCache` 依赖工作区路径与服务器名。
- Forbidden: 在 `store()` 里对本会话刚写的文件套用 TTL 裁剪，或用服务器提供的文件名作为磁盘名——前者会让挂在确认卡片上的调用丢图，后者把外部输入变成路径。