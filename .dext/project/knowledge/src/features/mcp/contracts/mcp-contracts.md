## Responsibility

- **Names**: MCP contracts（结构中的界面名 mcp）→ `src/features/mcp/contracts/mcp.ts`，公开类型 `McpServerConfig`（`StdioMcpServerConfig` | `HttpMcpServerConfig`）、`McpToolConfig`、`McpDiscoveredTool`、`McpCredentialKind`。
- 拥有 MCP 配置与发现结果的唯一类型词汇：服务器（stdio/http）、清单里声明的工具（mcp/rest）、`tools/list` 实际发现到的工具，以及凭据种类。
- 只拥有形状，不拥有行为：文件里没有任何值导出，也没有校验、解析、传输或凭据读写；这些分别落在 `domain/mcpConfig.ts`、`domain/mcpManifest.ts`、`host/mcpRegistry.ts`、`host/mcpSecrets.ts`。
- 消费者：`domain/mcpManifest.ts`、`host/mcpRegistry.ts`、`host/mcpSecrets.ts`、`app/application.ts`、`platform/webviewProtocol.ts`。

## Design

- 整个文件只有 `interface`/`type`，没有任何运行时导出，因此导入它等于零成本：纯层与 `platform/webviewProtocol.ts` 都能安全引用，不会把 `vscode`、Node 内置模块或 DOM 全局拖进浏览器 bundle。
- 用 `transport` 判别联合约束字段合法性：`command`/`args` 只属于 stdio 变体，`url` 只属于 http 变体；host 侧靠 `server.transport !== "http"` 就能收窄，无需额外的运行时形状校验。
- 凭据只描述「种类与位置」，从不承载值：stdio 用 `auth: { type: "token"; env }` 指向子进程环境变量，http 用 `{ type: "bearer" }` 或 `{ type: "query"; name }` 指向查询参数名。真正的 token 存在 SecretStorage（`McpAccessTokenStore`），并按 `McpCredentialKind` 分键，所以 `mcpGenerated` 这类消息可以把 `McpServerConfig` 直接发到 webview 而不泄露密钥。
- `scope` 是加载期注解：Dext 读取项目/全局清单时写入，清单写出方不持久化它（注释已写明）；`timeoutMs` 可选，缺省由 host 的 `DEFAULT_TIMEOUT_MS` 兜底，避免把默认值散落到每份清单。
- 声明与发现分开建模：`McpToolConfig` 是清单里可声明 REST 适配的工具（`kind: "rest"` 配合 `method`/`url`/`docsUrl`），`McpDiscoveredTool` 只是 MCP `tools/list` 的原始返回形状，两者不合并。schema 保持 `Record<string, unknown>`，转成 Dext 的 `FieldDefinition` 由 domain 层完成，契约不绑定任何 JSON Schema 库。

## Boundary

- Allowed: 同特性纯层（`domain/`、`host/`、`presentation/`）、`app/` 组合根与 `platform/webviewProtocol.ts` 等跨环境消费者以 `import type` 引入；新增 MCP 数据类型时在这里扩展，而不是在消费者里另立同形类型。
- Forbidden: 引用 `vscode`、Node 内置模块、DOM 全局或任何运行时实现——本文件必须能被浏览器层与纯层直接导入；写入校验与 URL 诊断、清单解析（属 `domain/mcpConfig.ts`、`domain/mcpManifest.ts`）；接触 SecretStorage 或 token 值（属 `host/mcpSecrets.ts`）；发起 stdio/HTTP 传输或维护服务器与工具注册表（属 `host/mcpRegistry.ts`）；界面状态或 webview 消息形状（属 `platform/webviewProtocol.ts` 与浏览器层）。