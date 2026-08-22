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

  it("compiles a for loop over a list and types the loop variable from its items", () => {
    const result = compile([
      'prompts = ["first", "second"]',
      "for prompt in prompts:",
      "    ask(input=prompt)"
    ].join("\n"));
    expect(result.diagnostics).toEqual([]);
    const loop = result.program?.statements.at(-1);
    expect(loop).toMatchObject({ kind: "for", variable: "prompt" });
    expect(loop?.kind === "for" && loop.body).toHaveLength(1);
    // A list literal can be looped over directly.
    expect(compile('for prompt in ["a", "b"]:\n    ask(input=prompt)').diagnostics).toEqual([]);
    // The loop variable takes the element type, so a string list feeds a string
    // argument without a cast.
    expect(compile('for size in [1, 2]:\n    ask(input=size)').diagnostics.map((item) => item.message).join("\n"))
      .toContain("expects string");
  });

  it("keeps the loop variable inside the loop", () => {
    expect(compile([
      'prompts = ["first"]',
      "for prompt in prompts:",
      "    ask(input=prompt)",
      "ask(input=prompt)"
    ].join("\n")).diagnostics.map((item) => item.message).join("\n")).toContain("prompt");
  });

  it("compiles a list comprehension into a typed fan-out", () => {
    const result = compile([
      'prompts = ["a", "b"]',
      'reviews = [agent(input=prompt, apply=False) for prompt in prompts]'
    ].join("\n"));
    expect(result.diagnostics).toEqual([]);
    const statement = result.program?.statements.at(-1);
    expect(statement).toMatchObject({
      kind: "assign",
      assignment: "reviews",
      expression: { kind: "comprehension", variable: "prompt" }
    });
    // The element type is the call's result type, so looping over the fan-out
    // gives items whose fields resolve.
    expect(compile([
      'prompts = ["a"]',
      "answers = [ask(input=prompt) for prompt in prompts]",
      "for answer in answers:",
      "    print(text=answer.text)"
    ].join("\n")).diagnostics).toEqual([]);
  });

  it("rejects comprehension shapes whose result length is not knowable", () => {
    const messages = (source: string): string =>
      compile(source).diagnostics.map((item) => item.message).join("\n");
    expect(messages('reviews = [ask(input=p) for p in ["a"] if p == "a"]'))
      .toContain("exactly one 'for' clause and no 'if' filter");
    expect(messages('reviews = [ask(input=p) for p in ["a"] for q in ["b"]]'))
      .toContain("exactly one 'for' clause and no 'if' filter");
    expect(messages('name = "x"\nreviews = [ask(input=name) for p in name]'))
      .toContain("A comprehension requires a list but string was given");
  });

  it("keeps the comprehension variable out of the surrounding scope", () => {
    expect(compile([
      'prompts = ["a"]',
      "answers = [ask(input=prompt) for prompt in prompts]",
      "print(text=prompt)"
    ].join("\n")).diagnostics.map((item) => item.message).join("\n")).toContain("Unknown variable 'prompt'");
  });

  it("compiles try/except with an optional finally and error name", () => {
    const result = compile([
      "try:",
      '    checked = terminal(command="npm test")',
      "except Exception as failure:",
      "    print(text=failure)",
      "finally:",
      '    print(text="done")'
    ].join("\n"));
    expect(result.diagnostics).toEqual([]);
    const statement = result.program?.statements.at(-1);
    expect(statement).toMatchObject({ kind: "try", error: "failure" });
    expect(statement?.kind === "try" && statement.finalizer).toHaveLength(1);
    // A bare except and a missing finally are both fine.
    expect(compile('try:\n    print(text="a")\nexcept:\n    print(text="b")').diagnostics).toEqual([]);
  });

  it("keeps try, except, and finally scopes from leaking into each other", () => {
    const messages = (source: string): string =>
      compile(source).diagnostics.map((item) => item.message).join("\n");
    // The error name belongs to the handler alone.
    expect(messages('try:\n    print(text="a")\nexcept Exception as failure:\n    print(text="failure")\nfinally:\n    print(text=failure)'))
      .toContain("Unknown variable 'failure'");
    // A step in the body may never have run, so what it bound cannot be read
    // after the statement.
    expect(messages('try:\n    answer = ask(input="x")\nexcept:\n    print(text="b")\nprint(text=answer.text)'))
      .toContain("Unknown variable 'answer'");
  });

  it("rejects try forms Dext does not model", () => {
    const messages = (source: string): string =>
      compile(source).diagnostics.map((item) => item.message).join("\n");
    expect(messages('try:\n    print(text="a")\nexcept Exception:\n    print(text="b")\nexcept Exception:\n    print(text="c")'))
      .toContain("single except block");
    // Filtering on an exception type would be a promise Dext cannot keep.
    expect(messages('try:\n    print(text="a")\nexcept ValueError:\n    print(text="b")'))
      .toContain("catches every failure");
    expect(messages('try:\n    print(text="a")\nexcept:\n    print(text="b")\nelse:\n    print(text="c")'))
      .toContain("takes except and finally but not else");
    expect(messages('try:\n    print(text="a")\nfinally:\n    print(text="b")'))
      .toContain("requires a body and an except block");
  });

  it("rejects a for loop that is not over a list or takes more than one variable", () => {
    expect(compile('name = "x"\nfor item in name:\n    ask(input=item)').diagnostics.map((item) => item.message).join("\n"))
      .toContain("for requires a list but string was given");
    expect(compile('for a, b in ["x"]:\n    ask(input=a)').diagnostics.map((item) => item.message).join("\n"))
      .toContain("exactly one loop variable");
  });
});
