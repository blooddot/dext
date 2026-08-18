import { describe, expect, it } from "vitest";
import { HttpMcpTransport, McpToolRegistry, type McpFetch, type McpTransport } from "../src/core/mcpRegistry.js";

function jsonResponse(value: unknown, sessionId?: string): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {})
    }
  });
}

function requestMessage(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("McpToolRegistry", () => {
  it("validates configured servers before registering tools", () => {
    const registry = new McpToolRegistry({ call: async () => ({}) });
    expect(registry.setServers([{ name: "bad name", transport: "stdio", command: "mock" }]))
      .toEqual(["MCP server names must use letters, numbers, dots, underscores, or hyphens."]);
    expect(registry.setTools([{ server: "missing", tool: "read" }]))
      .toEqual(["MCP tool 'missing.read' references unknown server 'missing'."]);
  });

  it("calls a registered tool through an injected transport and preserves structured content", async () => {
    const calls: Array<{ server: string; tool: string; argumentsValue: Record<string, unknown> }> = [];
    const transport: McpTransport = {
      call: async (server, tool, argumentsValue) => {
        calls.push({ server: server.name, tool, argumentsValue });
        return {
          content: "document loaded",
          structuredContent: { uri: "file:///workspace/readme.md", content: "# Readme" }
        };
      }
    };
    const registry = new McpToolRegistry(transport);
    expect(registry.setServers([{ name: "docs", transport: "stdio", command: "fake-mcp" }])).toEqual([]);
    expect(registry.setTools([{ server: "docs", tool: "read", description: "Read a document" }])).toEqual([]);

    await expect(registry.call("docs.read", { uri: "readme.md" }))
      .resolves.toEqual({
        kind: "mcpRaw",
        server: "docs",
        tool: "read",
        content: "document loaded",
        structured: { uri: "file:///workspace/readme.md", content: "# Readme" }
      });
    expect(calls).toEqual([{ server: "docs", tool: "read", argumentsValue: { uri: "readme.md" } }]);
  });

  it("rejects unknown canonical tool names before opening a transport", async () => {
    const registry = new McpToolRegistry({ call: async () => ({}) });
    registry.setServers([{ name: "docs", transport: "stdio", command: "fake-mcp" }]);
    registry.setTools([{ server: "docs", tool: "read" }]);
    await expect(registry.call("docs.missing", {})).rejects.toThrow("not registered");
  });

  it("uses the configured canonical name as an exact lookup key without splitting it", async () => {
    const calls: Array<{ server: string; tool: string; argumentsValue: Record<string, unknown> }> = [];
    const registry = new McpToolRegistry({
      call: async (server, tool, argumentsValue) => {
        calls.push({ server: server.name, tool, argumentsValue });
        return {};
      }
    });
    registry.setServers([{ name: "docs.read", transport: "stdio", command: "fake-mcp" }]);
    registry.setTools([{ server: "docs.read", tool: "file" }]);

    await expect(registry.call("docs.read.file", { path: "README.md" })).resolves.toEqual({
      kind: "mcpRaw",
      server: "docs.read",
      tool: "file"
    });
    expect(calls).toEqual([{ server: "docs.read", tool: "file", argumentsValue: { path: "README.md" } }]);
  });

  it("reports collisions between distinct configured pairs with the same canonical name", () => {
    const registry = new McpToolRegistry({ call: async () => ({}) });
    registry.setServers([
      { name: "docs", transport: "stdio", command: "docs-mcp" },
      { name: "docs.read", transport: "stdio", command: "read-mcp" }
    ]);

    expect(registry.setTools([
      { server: "docs", tool: "read.file" },
      { server: "docs.read", tool: "file" }
    ])).toEqual(["MCP tool name 'docs.read.file' collides between server 'docs' tool 'read.file' and server 'docs.read' tool 'file'."]);
  });

  it("accepts HTTPS and loopback HTTP servers but rejects credential-bearing or unsafe HTTP configuration", () => {
    const registry = new McpToolRegistry({ call: async () => ({}) });
    expect(registry.setServers([
      { name: "remote", transport: "http", url: "https://mcp.example.test/v1", auth: { type: "bearer" } },
      { name: "local", transport: "http", url: "http://127.0.0.1:8787/mcp" },
      { name: "query", transport: "http", url: "https://mcp.example.test/v1?value=1" },
      { name: "plain", transport: "http", url: "http://mcp.example.test/v1" },
      { name: "unsafe", transport: "http", url: "https://mcp.example.test/v1", headers: {} }
    ])).toEqual([
      "MCP server 'query' url must not contain a query string.",
      "MCP server 'plain' url must use HTTPS or loopback HTTP.",
      "MCP server 'unsafe' must not configure 'headers'; store access tokens with the Dext MCP command instead."
    ]);
    expect(registry.listServers().map((server) => server.name)).toEqual(["local", "remote"]);
  });

  it("uses Streamable HTTP initialize, initialized notification, tools/call, and session termination", async () => {
    const requests: Array<{ method: string; message?: Record<string, unknown>; session?: string | null; accept?: string | null }> = [];
    const fetcher: McpFetch = async (_url, init) => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const message = method === "POST" ? requestMessage(init) : undefined;
      requests.push({
        method,
        ...(message ? { message } : {}),
        session: headers.get("mcp-session-id"),
        accept: headers.get("accept")
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (message?.method === "initialize") return jsonResponse({ jsonrpc: "2.0", id: message.id, result: {} }, "session-a");
      if (message?.method === "notifications/initialized") return new Response(null, { status: 202 });
      return jsonResponse({
        jsonrpc: "2.0",
        id: message?.id,
        result: { content: [{ type: "text", text: "ok" }], structuredContent: { ready: true } }
      });
    };
    const transport = new HttpMcpTransport(fetcher);
    const registry = new McpToolRegistry(transport);
    registry.setServers([{ name: "remote", transport: "http", url: "https://mcp.example.test/v1" }]);
    registry.setTools([{ server: "remote", tool: "status" }]);

    await expect(registry.call("remote.status", {})).resolves.toMatchObject({
      kind: "mcpRaw", content: "ok", structured: { ready: true }
    });
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(requests.map((request) => request.message?.method)).toEqual([
      "initialize", "notifications/initialized", "tools/call", undefined
    ]);
    expect(requests.slice(1).map((request) => request.session)).toEqual(["session-a", "session-a", "session-a"]);
    expect(requests[0]?.accept).toContain("application/json");
    expect(requests[0]?.accept).toContain("text/event-stream");
  });

  it("accepts an SSE tools/call response and renews a missing HTTP session once", async () => {
    let initializeCount = 0;
    let toolCallCount = 0;
    const fetcher: McpFetch = async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = requestMessage(init);
      if (message.method === "initialize") {
        initializeCount += 1;
        return jsonResponse({ jsonrpc: "2.0", id: message.id, result: {} }, `session-${initializeCount}`);
      }
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      toolCallCount += 1;
      if (toolCallCount === 1) return new Response(null, { status: 404 });
      return new Response(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "renewed" }] }
      })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const registry = new McpToolRegistry(new HttpMcpTransport(fetcher));
    registry.setServers([{ name: "remote", transport: "http", url: "https://mcp.example.test/v1" }]);
    registry.setTools([{ server: "remote", tool: "status" }]);

    await expect(registry.call("remote.status", {})).resolves.toMatchObject({ content: "renewed" });
    expect(initializeCount).toBe(2);
    expect(toolCallCount).toBe(2);
  });

  it("rejects HTTP redirects and bearer calls without a SecretStorage-provided token", async () => {
    const redirecting = new McpToolRegistry(new HttpMcpTransport(async () => new Response(null, {
      status: 302,
      headers: { location: "https://other.example.test/mcp" }
    })));
    redirecting.setServers([{ name: "remote", transport: "http", url: "https://mcp.example.test/v1" }]);
    redirecting.setTools([{ server: "remote", tool: "status" }]);
    await expect(redirecting.call("remote.status", {})).rejects.toThrow("refused a redirect");

    const bearer = new McpToolRegistry({ call: async () => ({}) });
    bearer.setServers([{ name: "secure", transport: "http", url: "https://mcp.example.test/v1", auth: { type: "bearer" } }]);
    bearer.setTools([{ server: "secure", tool: "status" }]);
    await expect(bearer.call("secure.status", {})).rejects.toThrow("requires an access token");
  });

  it("verifies a configured server through the transport without exposing configuration secrets", async () => {
    const verified: string[] = [];
    const registry = new McpToolRegistry({
      call: async () => ({}),
      verify: async (server) => { verified.push(server.name); }
    });
    registry.setServers([{ name: "remote", transport: "http", url: "https://mcp.example.test/v1", auth: { type: "bearer" } }]);
    registry.setAccessTokenProvider(async () => undefined);
    await expect(registry.verifyServer("remote")).rejects.toThrow("requires an access token");
    expect(verified).toEqual([]);
  });
});
