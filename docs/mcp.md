# MCP configuration

English | [简体中文](mcp.zh-CN.md)

[Back to README](../README.md)

Register MCP tools as APIs with parameter hints and result-field completion. This guide covers manifests, transports, and credentials.

## MCP APIs

MCP manifests live in `<workspace>/.dext/mcp/*.jsonc` or Dext global storage:
one file declares one server and its explicit tool allowlist. Each enabled tool
becomes a typed API named `mcp.<server>.<tool>`, with completion, signature help,
required-argument validation, and structured result-field completion. Project
manifests take precedence when a server name collides. The `inputSchema` is
required; `outputSchema` is optional, but enables typed fields from MCP
`structuredContent`.

```jsonc
// .dext/mcp/docs.jsonc
{
  "name": "docs",
  "transport": "stdio",
  "command": "my-docs-mcp",
  "args": ["--stdio"],
  "tools": [{
    "name": "read",
    "description": "Read a document",
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

For a stdio MCP that reads its credential from an environment variable, declare
the variable without putting the secret in the manifest:

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

MCP calls require a trusted local workspace. Manifests support local `stdio` and Streamable HTTP. HTTP endpoints must use HTTPS, or loopback HTTP for local development. URL userinfo, query strings, fragments, inline headers, and credentials are rejected. A bearer-enabled HTTP server stores its token only through `Dext: Set MCP Access Token`. A stdio server may declare `auth: {"type":"token","env":"ENV_NAME"}`; Dext then injects its SecretStorage token into that child-process environment variable. Tokens are keyed by server and manifest scope: project manifests use workspace-scoped keys, while global manifests use global keys. Do not put credentials in a manifest or stdio arguments. `Dext: Clear MCP Access Token` removes the selected credential; `Dext: Verify MCP Server` performs an authenticated HTTP initialization check. Editing, creating, or deleting a manifest reloads its APIs automatically.
