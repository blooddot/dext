## Responsibility

- **Names**: MCP contracts → `src/features/mcp/contracts/mcp.ts`（`McpServerConfig`、`McpToolConfig`、`McpDiscoveredTool`、`McpCredentialKind`）。
- 这一职责只拥有 MCP 的**数据形状**：一个服务器如何声明自己（`transport: "stdio"` 或 `"http"`）、它的工具白名单条目长什么样、以及运行时从服务器反查回来的工具描述。它不含任何解析、校验或调用代码。
- 凭据只以**声明**的形式存在于这里：`auth?: { type: "token", env }` 指明要注入的子进程环境变量名，`auth?: { type: "bearer" }` 与 `HttpQueryAuth` 指明令牌该走请求头还是查询参数；令牌值本身从不属于这些类型。

## Design

- `McpServerConfig` 是按 `transport` 判别（discriminated）的联合：stdio 分支才有 `command`/`args`，http 分支才有 `url`，因此消费方 `switch (server.transport)` 之后不需要可选字段断言，也不会写出“http 服务器却带 args”这种非法状态。
- `scope?: "project" | "global"` 上标注了它由加载器写入、清单写入器不持久化——作用域是加载时得到的归属信息，不是磁盘格式的一部分，这样同名服务器按项目优先解析时不需要第二个并行字段。
- `McpToolConfig` 把 `kind` 做成可选且默认 `"mcp"`：`"rest"` 条目复用同一个工具表，由 Dext 的通用适配器执行，所以 `method`/`url`/`docsUrl` 都是可选的旁支字段，而不是第二套工具类型。
- `inputSchema`/`outputSchema` 保持 `Record<string, unknown>`：JSON Schema 的裁剪与字段提取属于清单解析（`domain/mcpManifest.ts`），契约层只负责原样携带，避免把 schema 语义固化在类型里。
- `McpDiscoveredTool` 与 `McpToolConfig` 分开：一个是服务器报告的候选，一个是清单里被显式接受的条目，两者字段相近但来源与信任级别不同，合一会让“是否已在白名单中”无法区分。
- 它是本 feature 的唯一契约主题文件（不是 `contracts.ts` 或 `contracts/index.ts`），纯类型、无运行时值、不导入 `vscode` 或 Node 模块，因此 domain、host、app 与 `platform/webviewProtocol.ts` 都能以 `import type` 引用而不引入环境依赖。

## Boundary

- Allowed: 纯类型与接口声明；被 `domain/mcpManifest.ts`、`host/mcpRegistry.ts`、`host/mcpSecrets.ts`、`app/application.ts`、`platform/webviewProtocol.ts` 以类型方式引用；describe 凭据的种类与注入位置（种类名、环境变量名、查询参数名）。
- Forbidden: 读写清单文件或 SecretStorage；URL 校验与脱敏（属 `domain/mcpConfig.ts`、`host/mcpRegistry.ts`）；JSON Schema 到 Dext 字段的转换（属 `domain/mcpManifest.ts`）；发起 MCP/REST 调用；导入 `vscode`、`node:*` 或任何 host 实现；保存或比较令牌值。