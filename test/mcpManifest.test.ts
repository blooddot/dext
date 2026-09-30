import { describe, expect, it } from "vitest";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { MethodRegistry } from "../src/core/registry.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";

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

/** Registers a loaded manifest the way the extension does, so the assertions
 * can read the same registry the runtime dispatches against. */
function register(source: string, path: string) {
  const loaded = parseMcpManifest(source, path);
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  registry.registerMany(loaded.methods, "project");
  return { loaded, registry };
}

describe("MCP manifests", () => {
  it("create typed mcp namespace APIs from the selected tools", () => {
    const { loaded, registry } = register(manifest, ".dext/mcp/github.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.server).toMatchObject({ name: "github", transport: "stdio", command: "github-mcp" });
    expect(loaded.tools).toEqual([expect.objectContaining({ server: "github", tool: "search_issues" })]);
    expect(loaded.methods[0]).toMatchObject({
      id: "mcp.github.search_issues",
      output: expect.objectContaining({ kind: "mcp.github.search_issues", resultType: "GithubSearchIssuesResult" })
    });

    const method = registry.get("mcp.github.search_issues")!;
    expect(method.input.map((field) => field.name)).toEqual(["owner", "state"]);
    expect(method.input.find((field) => field.name === "owner")).toMatchObject({ type: "string", required: true });
    expect(method.input.find((field) => field.name === "state")).toMatchObject({ type: "enum", values: ["open", "closed"] });
  });

  it("keeps a hyphenated server in the method id and its result type", () => {
    const { loaded, registry } = register(
      manifest.replaceAll('"github"', '"teambition-user"'),
      ".dext/mcp/teambition-user.jsonc"
    );
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.methods[0]).toMatchObject({
      id: "mcp.teambition-user.search_issues",
      output: expect.objectContaining({ kind: "mcp.teambition-user.search_issues", resultType: "TeambitionUserSearchIssuesResult" })
    });
    expect(registry.get("mcp.teambition-user.search_issues")).toBeDefined();
  });

  it("keeps hyphenated parameter names from a hyphenated server", () => {
    const source = manifest
      .replaceAll('"github"', '"teambition-user"')
      .replace('"owner": {', '"x-operator-id": { "type": "string" }, "owner": {');
    const { loaded, registry } = register(source, ".dext/mcp/teambition-user.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.methods[0]?.input.map((field) => field.name)).toEqual(["x-operator-id", "owner", "state"]);
    expect(registry.get("mcp.teambition-user.search_issues")?.input.find((field) => field.name === "x-operator-id"))
      .toMatchObject({ type: "string" });
  });

  it("extracts fields of objects nested in MCP result arrays", () => {
    const { loaded } = register(manifest.replace(
      '"items": { "type": "array" }',
      '"items": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "content": { "type": "string" } } } }'
    ), ".dext/mcp/github.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    const items = loaded.methods[0]?.output.fields?.find((field) => field.name === "items");
    expect(items).toMatchObject({ type: "list" });
    expect(items?.items?.properties?.map((field) => field.name)).toEqual(["id", "content"]);
  });

  it("types a Teambition-style result array as mcp.<server>.<tool>", () => {
    const { loaded, registry } = register(`{
      "name": "team", "transport": "stdio", "command": "team-mcp",
      "tools": [{ "name": "query", "inputSchema": { "type": "object", "properties": {} },
        "outputSchema": { "type": "object", "properties": {
          "result": { "type": "array", "items": { "type": "object", "properties": {
            "id": { "type": "string" }, "content": { "type": "string" }
          } } }, "code": { "type": "integer" }
        } }
      }]
    }`, "team.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    const method = registry.get("mcp.team.query")!;
    expect(method.output).toMatchObject({ kind: "mcp.team.query", resultType: "TeamQueryResult" });
    expect(method.output.fields?.map((field) => field.name)).toEqual(["result", "code"]);
    expect(method.output.fields?.find((field) => field.name === "result")?.items?.properties?.map((field) => field.name))
      .toEqual(["id", "content"]);
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

  it("loads the tools of a query-authenticated HTTP gateway manifest", () => {
    const { loaded, registry } = register(JSON.stringify({
      name: "dingtalk_doc", transport: "http",
      url: "https://mcp-gw.dingtalk.com/server/abc", auth: { type: "query", name: "key" },
      tools: [{
        name: "get_document_content",
        inputSchema: { type: "object", properties: { nodeId: { type: "string" } }, required: ["nodeId"] }
      }]
    }), ".dext/mcp/dingtalk_doc.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.server).toMatchObject({ auth: { type: "query", name: "key" } });
    expect(registry.get("mcp.dingtalk_doc.get_document_content")?.input)
      .toEqual([expect.objectContaining({ name: "nodeId", type: "string", required: true })]);
  });

  it("accepts nullable fields and explicitly declared error metadata", () => {
    const loaded = parseMcpManifest(JSON.stringify({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            result: {
              type: "array",
              items: { type: "object", properties: { startDate: { type: ["string", "null"] } } }
            },
            traceId: { type: "string" },
            errorCode: { type: "string" }
          }
        }
      }]
    }), "team.jsonc");
    expect(loaded.diagnostics).toEqual([]);
    const contract = new AxAdapter().compile(loaded.methods[0]!);
    expect(contract.outputSchema.parse({
      kind: "mcp.team.query",
      result: [{ startDate: null }],
      traceId: "trace-1",
      errorCode: "TASK_NOT_FOUND"
    })).toMatchObject({ errorCode: "TASK_NOT_FOUND" });
  });
});
