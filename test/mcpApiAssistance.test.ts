import { describe, expect, it } from "vitest";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { mcpApiDefinitionTarget } from "../src/core/apiNavigation.js";
import { callableApiDocument } from "../src/core/builtinApiDefinitions.js";
import { pythonHoverCode } from "../src/vscodeHover.js";

const manifest = parseMcpManifest(JSON.stringify({
  name: "teambition-user", transport: "http", url: "https://example.com/mcp",
  tools: [{ name: "queryTaskV3", description: "Query task details.\nIncludes the task note.",
    inputSchema: { type: "object", required: ["taskId"], properties: {
      taskId: { type: "string", description: "Task identifier." },
      "x-operator-id": { type: "string", description: "Optional operator." }
    } },
    outputSchema: { type: "object", required: ["note"], properties: { note: { type: "string", description: "Markdown note." } } }
  }]
}), "teambition-user.jsonc");

describe("MCP editor assistance", () => {
  const registry = new MethodRegistry();
  registry.registerMany(manifest.methods, "project");
  const service = new DextLanguageService(registry);
  const source = 'task = mcp.teambition-user.queryTaskV3(taskId="123", x-operator-id="me")\ntask.note';

  it("uses the manifest schema for method, argument and result hovers in both editors", () => {
    expect(manifest.diagnostics).toEqual([]);
    for (const hover of [service.apiHover.bind(service), service.documentHover.bind(service)]) {
      const method = hover(source, source.indexOf("queryTaskV3") + 2)!;
      expect(method.label).toContain("mcp.teambition-user.queryTaskV3(taskId: string");
      expect(method.documentation).toContain("Query task details.");
      expect(pythonHoverCode(method.label)).toContain("def queryTaskV3(taskId: str");
      expect(hover(source, source.indexOf("taskId") + 2)).toMatchObject({ kind: "parameter", documentation: "Task identifier." });
      expect(hover(source, source.indexOf("x-operator-id") + 3)).toMatchObject({ kind: "parameter", documentation: "Optional operator." });
      expect(hover(source, source.lastIndexOf("note") + 1)).toMatchObject({ label: "task.note: string", documentation: "Markdown note." });
      expect(hover(source, 1)?.label).toContain("task:");
    }
  });

  it("resolves every segment of the MCP call without treating arguments as definitions", () => {
    for (const name of ["mcp", "teambition-user", "queryTaskV3"]) {
      const target = mcpApiDefinitionTarget(source, source.indexOf(name) + 1)!;
      expect(target.id).toBe("mcp.teambition-user.queryTaskV3");
      expect(source.slice(target.originFrom, target.originTo)).toBe(target.id);
    }
    expect(mcpApiDefinitionTarget(source, source.indexOf("taskId") + 1)).toBeUndefined();
  });

  it.each(['# mcp.teambition-user.queryTaskV3()', 'text = "mcp.teambition-user.queryTaskV3()"', 'text = """\nmcp.teambition-user.queryTaskV3()\n"""'])("ignores MCP names in text: %s", (source) => {
    const cursor = source.indexOf("queryTaskV3") + 2;
    expect(service.apiHover(source, cursor)).toBeUndefined();
    expect(mcpApiDefinitionTarget(source, cursor)).toBeUndefined();
  });

  it("generates exact definition ranges and keeps multiline documentation commented", () => {
    const document = callableApiDocument(registry.list(), "Dext MCP APIs");
    const range = document.ranges.get("mcp.teambition-user.queryTaskV3")!;
    expect(document.text.slice(range.nameFrom, range.nameTo)).toBe("queryTaskV3");
    expect(document.text).toContain("taskId: str");
    expect(document.text).toContain("#   note: str — Markdown note.");
    expect(document.text).toContain("# Includes the task note.");
    const server = document.ranges.get("mcp.teambition-user")!;
    expect(document.text.slice(server.nameFrom, server.nameTo)).toBe("teambition-user");
  });
});
