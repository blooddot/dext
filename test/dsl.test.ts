import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { compileWorkflow } from "../src/core/workflow.js";

function compile(source: string) {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return compileWorkflow(source, registry);
}

describe("Dext Python workflow compiler", () => {
  it("accepts the public top-level APIs and print", () => {
    const result = compile([
      'answer = ask(input="Explain @src/selection.ts")',
      'preview = agent(input="Implement @src/a.ts", apply=False)',
      "apply(result=preview)",
      'terminal = terminal(command="git status")',
      "print(text=answer.text)"
    ].join("\n"));
    expect(result.diagnostics).toEqual([]);
    expect(result.program?.statements).toHaveLength(5);
  });

  it("accepts skills, MCP, and UI under their public namespaces", () => {
    const result = compile(`skill = skill(skill="dev-feat", input="implement", workspace="@client")
data = mcp(tool="docs.read", input={"uri": "README.md", "options": {"tags": ["guide", "api"]}, "file": "@README.md"})
choice = ui.choose(label="Pick", options=["one", "two"])`);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects removed MCP server and JSON-string input arguments", () => {
    expect(compile('mcp(server="docs", tool="docs.read")').diagnostics.map((item) => item.message).join("\n"))
      .toContain("Unknown argument 'server' for 'mcp'");
    expect(compile('mcp(tool="docs.read", input="{}")').diagnostics.map((item) => item.message).join("\n"))
      .toContain("expects dict[str, object]");
  });

  it("migrates legacy input f-string references but rejects arbitrary f-strings", () => {
    expect(compile('ask(input=f"look at {ref.file(\'src/a.ts\')}")').diagnostics).toEqual([]);
    expect(compile('agent(input=f"change {ref.dir(\'src\')}")').diagnostics).toEqual([]);
    expect(compile('ask(input=f"bad {1 + 2}")').diagnostics.map((item) => item.message).join("\n"))
      .toContain("FormatString");
    expect(compile('print(text=f"bad {ref.selection}")').diagnostics.map((item) => item.message).join("\n"))
      .toContain("FormatString");
  });

  it("accepts editor-generated @ input and still rejects a raw string/reference binary expression", () => {
    expect(compile('ask(input="Review @docs/drag-drop.md")').diagnostics).toEqual([]);
    expect(compile('ask(input="Review " + ref.file("docs/drag-drop.md"))').diagnostics.map((item) => item.message).join("\n"))
      .toContain("BinaryExpression");
  });

  it("rejects all removed public APIs", () => {
    for (const api of ["chat", "core.ask", "core.agent", "core.apply", "core.terminal", "core.skill", "core.mcp", "code.apply", "code.edit", "code.explain", "code.review", "terminal.run", "skill.run", "mcp.call"]) {
      expect(compile(`${api}(input="x")`).diagnostics.map((item) => item.message).join("\n"))
        .toContain(`Unknown Dext API '${api}'`);
    }
  });

  it("checks public API argument types and required fields", () => {
    expect(compile("ask(input=1)").diagnostics.map((item) => item.message).join("\n")).toContain("expects string");
    expect(compile("agent(apply=False)").diagnostics.map((item) => item.message).join("\n")).toContain("Missing required argument 'input'");
    expect(compile("terminal(command=1)").diagnostics.map((item) => item.message).join("\n")).toContain("expects string");
  });

  it("supports literal variable declarations and reuses them as arguments", () => {
    expect(compile('prompt = "Explain the selected code"\nagent(input=prompt)').diagnostics).toEqual([]);
    expect(compile('prompt: str = "Explain"\nagent(input=prompt)').diagnostics).toEqual([]);
  });

  it("supports list and dict literal variables", () => {
    expect(compile('tags = ["a", "b"]\nopts = {"x": 1}').diagnostics).toEqual([]);
  });

  it("rejects mismatched literal variable type annotations", () => {
    expect(compile('prompt: int = "hello"').diagnostics.map((item) => item.message).join("\n"))
      .toContain("declared as number but assigned string");
  });
});
