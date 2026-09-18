# MCP 配置

[English](mcp.md) | 简体中文

[返回 README](../README.zh-CN.md)

将 MCP 工具注册为带参数提示和结果字段补全的 API。本文说明清单格式、传输方式和凭据配置。

## MCP API

MCP 清单位于 `<workspace>/.dext/mcp/*.jsonc` 或 Dext 全局存储中。每个文件声明一个服务器和显式工具白名单。启用的工具会成为 `mcp.<server>.<tool>(...)` API，支持补全、参数提示、必填参数校验和结构化结果字段补全。

悬浮在 MCP 方法、参数或结构化结果字段上可查看签名、类型和说明，支持 `teambition-user` 等带连字符的名称。在 `.dx` 编辑器中按住 Ctrl 点击方法（macOS 使用 Cmd），或按 F12，可打开由已加载清单生成的只读虚拟定义，查看参数和返回字段；清单重载后再次跳转会打开最新定义。

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

**Dext: Clear MCP Access Token** 删除所选凭据；**Dext: Verify MCP Server** 对任意已配置的服务器（HTTP 或 stdio）执行带认证的初始化检查。编辑、新建或删除清单后，对应 API 会自动重新加载。

## 查询参数认证

部分托管网关只接受把凭据放在 URL 查询参数里，例如钉钉的 `https://mcp-gw.dingtalk.com/server/<实例ID>?key=<key>`。清单仍然保持 URL 不含凭据、不含查询字符串：只声明参数名，再用 **Dext: Set MCP Access Token** 保存令牌。

```jsonc
// .dext/mcp/dingtalk_doc.jsonc
{
  "name": "dingtalk_doc",
  "transport": "http",
  "url": "https://mcp-gw.dingtalk.com/server/<实例ID>",
  "auth": { "type": "query", "name": "key" },
  "tools": []
}
```

请求时 Dext 从 SecretStorage 读取令牌，拼接为 `?key=<已编码的令牌>`；清单里的 `url` 始终不含凭据。所有输出路径（日志、诊断、选择列表）只显示脱敏后的 URL（`?key=***`），令牌只存在于请求链路上。必须使用 HTTPS；由于 URL 比请求头更容易被代理或访问日志记录，请只对可信端点使用。服务器支持 Authorization 请求头时应优先使用 `auth: {"type":"bearer"}`。执行 **Dext: Set MCP Access Token** 时选择 **HTTP · Query parameter**，查询参数凭据会使用独立的存储键，已有的 bearer 令牌不受影响。

