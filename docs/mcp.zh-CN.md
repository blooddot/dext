# MCP 配置

[English](mcp.md) | 简体中文

[返回 README](../README.zh-CN.md)

将 MCP 工具注册为带参数提示和结果字段补全的 API。本文说明清单格式、传输方式和凭据配置。

## MCP API

MCP 清单位于 `<workspace>/.dext/mcp/*.jsonc` 或 Dext 全局存储中。每个文件声明一个服务器和显式工具白名单。启用的工具会成为 `mcp.<server>.<tool>(...)` API，支持补全、参数提示、必填参数校验和结构化结果字段补全。

同名时项目清单优先。`inputSchema` 必填；`outputSchema` 可选，用于为 MCP 的 `structuredContent` 提供类型信息。下面的命令名是示例，需要替换为实际安装的 MCP 服务器命令：

```jsonc
// .dext/mcp/docs.jsonc
{
  "name": "docs",
  "transport": "stdio",
  "command": "my-docs-mcp",
  "args": ["--stdio"],
  "tools": [{
    "name": "read",
    "description": "读取文档",
    "inputSchema": {
      "type": "object",
      "properties": { "uri": { "type": "string" } },
      "required": ["uri"]
    },
    "outputSchema": {
      "type": "object",
      "properties": { "content": { "type": "string" } },
      "required": ["content"]
    }
  }]
}
```

```python
document = mcp.docs.read(uri="README.md")
print(text=document.content)
```

如果 stdio MCP 从环境变量读取凭据，只需在清单中声明变量名，不要写入密钥：

```jsonc
{
  "name": "example-user-mcp",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "example-mcp"],
  "auth": { "type": "token", "env": "EXAMPLE_MCP_TOKEN" },
  "tools": []
}
```

MCP 调用需要受信任的本地工作区，支持本地 `stdio` 和 Streamable HTTP。HTTP 端点必须使用 HTTPS；本地开发可使用回环地址上的 HTTP。不接受 URL 中的用户信息、查询字符串、片段，以及清单中的内联请求头或凭据。

通过 **Dext: Set MCP Access Token** 保存令牌。HTTP 服务器使用 bearer 令牌；stdio 服务器声明 `auth: {"type":"token","env":"ENV_NAME"}` 后，Dext 会将 SecretStorage 中的令牌注入子进程对应的环境变量。令牌按服务器和清单范围区分：项目令牌属于当前工作区，全局令牌使用全局范围。不要把凭据放进清单或 stdio 参数。

**Dext: Clear MCP Access Token** 删除所选凭据；**Dext: Verify MCP Server** 执行带认证的 HTTP 初始化检查。编辑、新建或删除清单后，对应 API 会自动重新加载。
