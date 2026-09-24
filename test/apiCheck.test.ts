import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkApis } from "../src/core/apiCheck.js";

let workspace: string;
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "dext-check-")); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });
async function put(path: string, content: string): Promise<string> {
  const fullPath = join(workspace, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}
const valid = 'def main() -> PrintResult:\n    return print(text="ok")\n';

describe("API project checks", () => {
  it.each(["\n", "\r\n"])("maps helper errors to original file offsets with %j line endings", async (newline) => {
    const source = [
      "# 中文 😀", "", "def helper() -> PrintResult:", "", "    value = 1", '    value = "two"',
      '    return print(text="ok")', "", "def main() -> PrintResult:", "    return missing()", ""
    ].join(newline);
    const path = await put(".dext/api/broken.dx", source);
    await put(".dext/api/valid.dx", valid);
    const result = await checkApis({ workspace });
    expect(result.files).toHaveLength(2);
    const reassign = result.diagnostics.find((item) => item.code === "dext/reassign");
    const target = source.indexOf('value = "two"');
    expect(reassign).toMatchObject({ path, apiId: "broken", from: target, to: target + 5 });
    expect(result.diagnostics.find((item) => item.code === "dext/unknown-api")).toMatchObject({ from: source.indexOf("missing()"), to: source.indexOf("missing()") + 7 });
    expect(result.errors).toBe(2);
  });

  it("locates signatures and syntax errors and continues to later files", async () => {
    const source = '# comment\n\ndef main(input) -> PrintResult:\n    return print(text="ok")\n';
    const path = await put(".dext/api/signature.dx", source);
    await put(".dext/api/syntax.dx", "def main( -> PrintResult:\n");
    await put(".dext/api/valid.dx", valid);
    const result = await checkApis({ workspace });
    expect(result.files).toHaveLength(3);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, code: "dext/signature", from: source.indexOf("def main") }),
      expect.objectContaining({ code: "dext/syntax" })
    ]));
  });

  it("loads imports and configured roots once, including overlapping roots", async () => {
    await put(".dext/api/team/base.dx", valid);
    await put("extra/use.dx", "from team import base\n\ndef main() -> PrintResult:\n    return base()\n");
    await put(".vscode/settings.json", '{ // shared roots\n "dext.apiDirs": ["extra", ".dext/api/team"], }');
    const result = await checkApis({ workspace, apiDirs: ["extra"] });
    expect(result.files).toHaveLength(2);
    expect(result.diagnostics).toEqual([]);
  });

  it("uses project API directories in place of legacy workspace roots", async () => {
    await put(".dext/api/main.dx", valid);
    await put("project-api/project.dx", valid);
    await put("legacy-api/legacy.dx", 'def main() -> PrintResult:\n    return unknown()\n');
    await put(".vscode/settings.json", '{ "dext.apiDirs": ["legacy-api"] }');
    const result = await checkApis({ workspace, projectApiDirs: ["project-api"] });
    expect(result.files.map((path) => path.replaceAll("\\", "/"))).toEqual([
      expect.stringContaining(".dext/api/main.dx"),
      expect.stringContaining("project-api/project.dx")
    ]);
    expect(result.files.some((path) => path.includes("legacy-api"))).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not let a duplicate definition overwrite the first plan", async () => {
    await put(".dext/api/main.dx", valid);
    await put("extra/main.dx", 'def main() -> PrintResult:\n    return unknown()\n');
    const result = await checkApis({ workspace, apiDirs: ["extra"] });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "dext/duplicate-api" })]);
  });

  it("blames only the APIs that a dependency cycle involves", async () => {
    await put(".dext/api/team/first.dx", "from team import second\n\ndef main() -> PrintResult:\n    return second()\n");
    await put(".dext/api/team/second.dx", "from team import first\n\ndef main() -> PrintResult:\n    return first()\n");
    await put(".dext/api/healthy.dx", valid);
    const result = await checkApis({ workspace });
    expect(result.diagnostics.map((item) => [item.apiId, item.code])).toEqual([
      ["team.first", "dext/cycle"],
      ["team.second", "dext/cycle"]
    ]);
    expect(result.diagnostics[0]!.message).toContain("team.first -> team.second -> team.first");
    expect(result.errors).toBe(2);
  });

  it("points an imported built-in at the direct call without blaming a missing custom import", async () => {
    await put(".dext/api/legacy.dx", 'from common import ask\n\ndef main() -> AskResult:\n    return ask(input="hi")\n');
    await put(".dext/api/team/base.dx", valid);
    await put(".dext/api/caller.dx", 'from team import missing\n\ndef main() -> PrintResult:\n    return print(text="ok")\n');
    const messages = (await checkApis({ workspace })).diagnostics.map((item) => item.message);
    expect(messages).toContain("Imported API 'common.ask' is not defined. Built-in APIs are always in scope; call ask() directly.");
    expect(messages).toContain("Imported API 'team.missing' is not defined.");
  });

  it("uses unsaved buffers for both imports and new files", async () => {
    const path = await put(".dext/api/base.dx", "invalid(");
    const other = join(workspace, ".dext/api/caller.dx");
    const result = await checkApis({ workspace, documents: new Map([
      [path, valid], [other, "import base\ndef main() -> PrintResult:\n    return base()\n"]
    ]) });
    expect(result.files).toHaveLength(2);
    expect(result.errors).toBe(0);
    expect((await checkApis({ workspace })).errors).toBeGreaterThan(0);
  });

  it("checks literal rule paths against project and global rules without interpreting dynamic paths", async () => {
    const source = 'def main(rule: str) -> AskResult:\n    return ask(input="hi", rules=["exists.md", "global.md", "missing.md", "../escape.md", rule])\n';
    await put(".dext/api/rules.dx", source);
    await put(".dext/rules/exists.md", "rule");
    await put("global/rules/global.md", "rule");
    const result = await checkApis({ workspace, globalStorage: join(workspace, "global") });
    expect(result.errors).toBe(2);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "dext/missing-rule", from: source.indexOf('"missing.md"'), to: source.indexOf('"missing.md"') + '"missing.md"'.length }),
      expect.objectContaining({ code: "dext/rule", message: expect.stringContaining("must stay below") })
    ]);
  });

  it("loads MCP schemas without executing the configured command", async () => {
    await put(".dext/mcp/service.jsonc", JSON.stringify({
      name: "test", transport: "stdio", command: "THIS_COMMAND_MUST_NEVER_RUN",
      tools: [{ name: "fetch", inputSchema: { type: "object", properties: {} } }]
    }));
    await put(".dext/api/use.dx", "def main() -> McpRawResult:\n    return mcp.test.fetch()\n");
    expect((await checkApis({ workspace })).diagnostics).toEqual([]);
  });

  it("accepts a query-authenticated HTTP manifest and keeps its url credential-free", async () => {
    await put(".dext/mcp/gateway.jsonc", JSON.stringify({
      name: "gateway", transport: "http", url: "https://mcp.example.test/server/abc",
      auth: { type: "query", name: "key" },
      tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }]
    }));
    expect((await checkApis({ workspace })).diagnostics).toEqual([]);
  });

  it("reports a manifest the registry would reject when the APIs load", async () => {
    const path = await put(".dext/mcp/gateway.jsonc", JSON.stringify({
      name: "gateway", transport: "http", url: "https://mcp.example.test/server/abc?key=secret",
      tools: [{ name: "read", inputSchema: { type: "object", properties: {} } }]
    }));
    expect((await checkApis({ workspace })).diagnostics).toEqual([
      expect.objectContaining({
        path,
        code: "dext/mcp",
        message: "MCP server 'gateway' url must not contain a query string."
      })
    ]);
  });
});
