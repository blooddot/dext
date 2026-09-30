# MCP configuration

English | [简体中文](mcp.zh-CN.md)

[Back to README](../README.md)

Register MCP tools as APIs named `mcp.<server>.<tool>`, typed from the manifest and validated when the call runs. This guide covers manifests, transports, and credentials.

## MCP APIs

MCP manifests live in `<workspace>/.dext/mcp/*.jsonc` or Dext global storage:
one file declares one server and its explicit tool allowlist. Each enabled tool
becomes an API named `mcp.<server>.<tool>`: its arguments are checked against the
manifest's `inputSchema` when the call runs, so a missing required argument or an
unknown one is refused by name, and a tool that declares an `outputSchema`
returns the declared result — `{ kind: "mcp.<server>.<tool>", … }` carrying the
schema's fields, with a JSON `content` body parsed and a body that is not an
object refused. A tool without an `outputSchema` returns the raw
`{ kind: "mcpRaw", server, tool, content?, structured? }` envelope instead.
Project manifests take precedence when a server name collides, and the
`inputSchema` is required.

A project's own manifests also shape the committed `dext` declaration, so those
tools are named with the result their manifest declares, whether or not Dext is
installed. The declaration nests by the id's own segments, which is exactly how the
runtime resolves a call — it joins the property names it was reached through — so a
tool the manifest named `b.c` is called as `mcp.docs.b.c`, and a node can be both a
tool and a step (`mcp.docs.b` next to `mcp.docs.b.c`). A name that cannot be written
with dots (`teambition-user`, `list-tasks`) is reached with brackets:
`mcp["teambition-user"]["list-tasks"]({ … })`. Their argument object is a plain
`Record<string, unknown>` — TypeScript cannot narrow one parameter while the same
declaration keeps a globally configured server callable (TS2411) — so each tool's
argument contract rides its hover text (`Arguments: uri: string, limit?: number`)
and the runtime stays the authority that names a missing or unknown argument. A
server only a *global* manifest declares is walked the same way and is typed as the
union of every Dext result, so an unknown tool compiles and fails at runtime, where
the method is named.

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

```ts
import { mcp } from "dext";

// `docs.read` is declared by this project's manifest, so its result is typed.
const document = await mcp.docs.read({ uri: "README.md" });
console.log(document.content);
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

MCP calls require a trusted local workspace. Manifests support local `stdio` and Streamable HTTP. HTTP endpoints must use HTTPS, or loopback HTTP for local development. URL userinfo, query strings, fragments, inline headers, and credentials are rejected. A bearer-enabled HTTP server stores its token only through `Dext: Set MCP Access Token`. A stdio server may declare `auth: {"type":"token","env":"ENV_NAME"}`; Dext then injects its SecretStorage token into that child-process environment variable. Tokens are keyed by server and manifest scope: project manifests use workspace-scoped keys, while global manifests use global keys. Do not put credentials in a manifest or stdio arguments. `Dext: Clear MCP Access Token` removes the selected credential; `Dext: Verify MCP Server` performs an authenticated initialization check against any configured server. Editing, creating, or deleting a manifest reloads its APIs automatically.

## Query-parameter authentication

A few hosted gateways accept the credential only as a URL query parameter, such
as DingTalk's `https://mcp-gw.dingtalk.com/server/<instance>?key=<key>`. The
manifest still keeps the URL credential-free and query-free: declare the
parameter name, then store the token with `Dext: Set MCP Access Token`.

```jsonc
// .dext/mcp/dingtalk_doc.jsonc
{
  "name": "dingtalk_doc",
  "transport": "http",
  "url": "https://mcp-gw.dingtalk.com/server/<instance>",
  "auth": { "type": "query", "name": "key" },
  "tools": []
}
```

At request time Dext reads the token from SecretStorage and attaches it as
`?key=<encoded token>`; the configured `url` never carries it. Every output path
— logs, diagnostics, and pickers — shows the masked URL (`?key=***`) instead, so
the credential only exists on the wire. HTTPS is required, and the endpoint
should be treated as trusted because a URL is more likely than a header to be
captured by proxies or access logs. Use `auth: {"type":"bearer"}` when the
server accepts an Authorization header; choose **HTTP · Query parameter** in
`Dext: Set MCP Access Token` for a query credential, which is stored under its
own key so an existing bearer token is untouched.

