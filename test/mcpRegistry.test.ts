import { describe, expect, it } from "vitest";
import { McpToolRegistry, type McpTransport } from "../src/core/mcpRegistry.js";

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
});
