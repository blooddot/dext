import { describe, expect, it } from "vitest";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";

const manifest = `{
  // A checked-in MCP contract contains no credential values.
  "name": "github",
  "transport": "stdio",
  "command": "github-mcp",
  "tools": [{
    "name": "search_issues",
    "description": "Search issues.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "owner": { "type": "string", "description": "Repository owner." },
        "state": { "type": "string", "enum": ["open", "closed"] }
      },
      "required": ["owner"]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "total_count": { "type": "integer" },
        "items": { "type": "array" }
      },
      "required": ["total_count", "items"]
    }
  }]
}`;

describe("MCP manifests", () => {
  it("create typed mcp namespace APIs from the selected tools", () => {
    const loaded = parseMcpManifest(manifest, ".dext/mcp/github.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.server).toMatchObject({ name: "github", transport: "stdio", command: "github-mcp" });
    expect(loaded.tools).toEqual([expect.objectContaining({ server: "github", tool: "search_issues" })]);
    expect(loaded.methods[0]).toMatchObject({
      id: "mcp.github.search_issues",
      input: [
        expect.objectContaining({ name: "owner", type: "string", required: true }),
        expect.objectContaining({ name: "state", type: "enum", values: ["open", "closed"] })
      ],
      output: expect.objectContaining({ kind: "mcp.github.search_issues", resultType: "GithubSearchIssuesResult" })
    });

    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    registry.registerMany(loaded.methods, "project");
    const language = new DextLanguageService(registry);
    expect(language.documentCompletions("mcp.").map((item) => item.label)).toEqual(["github"]);
    expect(language.documentCompletions("mcp.github.").map((item) => item.label)).toEqual(["search_issues"]);
    expect(language.documentCompletions("mcp.github.search_issues(state=").map((item) => item.label)).toEqual(["open", "closed"]);
    expect(language.documentCompletions("issues = mcp.github.search_issues(owner=\"dext\")\nissues.").map((item) => item.label))
      .toEqual(["total_count", "items"]);
  });

  it("rejects untyped tools rather than publishing an unchecked API", () => {
    const loaded = parseMcpManifest('{ "name": "bad", "transport": "stdio", "command": "x", "tools": [{ "name": "run" }] }', "bad.jsonc");
    expect(loaded.methods).toEqual([]);
    expect(loaded.diagnostics.join(" ")).toContain("requires an object 'inputSchema'");
  });

  it("accepts manifests written by the pre-0.1 tool discovery shape", () => {
    const loaded = parseMcpManifest(`{
      "name": "docs", "transport": "http", "url": "https://example.test/mcp",
      "tools": [{ "server": "docs", "tool": "read", "inputSchema": { "type": "object", "properties": {} } }]
    }`, "legacy.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.tools[0]).toMatchObject({ server: "docs", tool: "read" });
    expect(loaded.methods[0]?.id).toBe("mcp.docs.read");
  });
});
