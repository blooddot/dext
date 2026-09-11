import { beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";

describe("DextLanguageService workflow features", () => {
  let service: DextLanguageService;
  beforeEach(() => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    service = new DextLanguageService(registry);
  });

  it("offers Harness as a built-in backend", () => {
    expect(service.documentCompletions("ask(cli=").map((item) => item.label)).toContain("deepseek-harness");
    expect(service.documentCompletions('ask(cli="deepseek-harness", model={').map((item) => item.label)).toEqual(["model", "reasoning"]);
  });

  it("completes public top-level methods and print", () => {
    expect(service.documentCompletions("co")).toEqual([]);
    for (const source of ["随便输入一下", "input = ", "input = +"]) {
      expect(service.documentCompletions(source)).toEqual([]);
    }
    expect(service.documentCompletions("a").map((item) => item.label))
      .toEqual(["agent", "apply", "ask"]);
    expect(service.documentCompletions("agent(in").map((item) => item.label)).toEqual(["input"]);
    expect(service.documentCompletions("skill(skill=").map((item) => item.label)).toEqual([]);
  });

  it("offers private .dx helpers, signatures, hover and result fields while editing", () => {
    const header = `def summarize(value: AskResult, label: str = "summary") -> PrintResult:
    return print(text=value.text, label=label)

def main(input: str) -> PrintResult:
    answer = ask(input=input)
`;
    const call = `${header}    report = summarize(value=answer, label=`;
    expect(service.apiCompletions(`${header}    sum`).map((item) => item.label)).toContain("summarize");
    expect(service.apiSignature(call)).toMatchObject({
      label: 'summarize(value: AskResult, label?: string = "summary") -> PrintResult', activeParameter: 1
    });
    const complete = `${header}    report = summarize(value=answer)\n    report.`;
    expect(service.apiCompletions(complete).map((item) => item.label)).toEqual(["text", "label"]);
    expect(service.apiHover(call, call.lastIndexOf("summarize") + 2)?.label).toContain("summarize(value: AskResult");
    expect(service.documentCompletions(`${header}    sum`).map((item) => item.label)).not.toContain("summarize");
    expect(service.apiCompletions("sum")).toEqual([]);
  });

  it("shows a concise built-in result shape when hovering a type annotation", () => {
    const source = "def main(context: PrintResult) -> AgentResult:\n    return print(text=context.text)";
    expect(service.apiHover(source, source.indexOf("PrintResult") + 2)).toMatchObject({
      label: 'PrintResult { kind: "print"; text: string; label?: string }'
    });
    expect(service.apiHover(source, source.indexOf("AgentResult") + 2)?.documentation).toContain("Go to Definition");
  });

  it("exposes a concrete result type for a Node bridge", () => {
    const source = 'parsed = node.url.parse(url="https://example.com/task")';
    expect(service.documentHover(source, source.indexOf("parsed") + 2)).toMatchObject({
      label: "parsed: NodeUrlParseResult"
    });
  });

  it("hovers concrete UI result annotations exposed by built-in APIs", () => {
    const source = "def main() -> UiFormResult:\n    ...";
    expect(service.documentHover(source, source.indexOf("UiFormResult") + 2)).toMatchObject({
      label: expect.stringContaining("UiFormResult")
    });
  });

  it("hovers namespaced type references in generated documents", () => {
    const source = "options: list[string | ui.Option]";
    expect(service.documentHover(source, source.indexOf("Option") + 2)).toMatchObject({
      label: expect.stringContaining("ui.Option")
    });
  });

  describe("project API imports", () => {
    beforeEach(() => {
      const registry = new MethodRegistry();
      registry.registerMany(BUILTIN_METHODS, "builtin");
      registry.register({ ...registry.get("terminal")!, id: "playground.verify", input: [] }, "project");
      registry.register({ ...registry.get("ask")!, id: "playground.explain" }, "project");
      service = new DextLanguageService(registry);
      service.setCustomApiIds(new Set(["playground.verify", "playground.explain"]));
    });

    it.each([
      ["from playground import verify", "verify"],
      ["from playground import verify as check", "check"],
      ["import playground.verify", "verify"],
      ["import playground.verify as check", "check"],
      ["import playground", "playground.verify"],
      ["import playground as pg", "pg.verify"]
    ])("provides editor assistance for %s in Code and .dx", (header, name) => {
      const prefix = `${header}\n`;
      const source = `${prefix}checked = ${name}()\n`;
      expect(service.documentDiagnostics(source)).toEqual([]);
      for (const global of [true, false]) {
        const partial = name.slice(0, -1);
        const label = name.split(".").at(-1);
        expect(service.documentCompletions(prefix + partial, undefined, global).filter((item) => item.label === label))
          .toHaveLength(1);
        expect(service.documentSignature(prefix + name + "(", undefined, global)?.label)
          .toContain("playground.verify(");
        expect(service.documentCompletions(source + "checked.", undefined, global).map((item) => item.label))
          .toContain("exit_code");
        expect(service.documentCompletions(source + 'if checked.status == "', undefined, global).map((item) => item.label))
          .toEqual(["succeeded", "failed", "timed_out"]);
        expect(service.documentHover(source, source.indexOf("checked") + 2, global)?.label)
          .toBe("checked: TerminalResult");
        const member = source + "checked.stdout";
        expect(service.documentHover(member, member.length - 2, global)?.label).toBe("checked.stdout: string");
      }
    });

    it("completes imported call parameters and shows the active parameter", () => {
      const source = "from playground import explain\nanswer = explain(in";
      expect(service.documentCompletions(source).map((item) => item.label)).toEqual(["input"]);
      expect(service.documentSignature(source)).toMatchObject({
        activeParameter: 0, label: expect.stringContaining("input: string")
      });
    });

    it("resolves an import that shadows a global method consistently with compilation", () => {
      const source = "from playground import verify as ask\nchecked = ask()\n";
      expect(service.documentDiagnostics(source)).toEqual([]);
      expect(service.documentCompletions(source + "checked.").map((item) => item.label)).toContain("exit_code");
      expect(service.documentCompletions(source + "as").filter((item) => item.label === "ask")).toHaveLength(1);
      expect(service.documentSignature(source + "ask(")?.label).toContain("playground.verify(");
    });

    it("offers import targets in both editors", () => {
      for (const complete of [service.documentCompletions.bind(service), service.apiCompletions.bind(service)]) {
        expect(complete("from playground import v").map((item) => item.label)).toEqual(["verify"]);
        expect(complete("from play").map((item) => item.label)).toEqual(["playground"]);
        expect(complete("import play").map((item) => item.label)).toEqual(["playground"]);
      }
    });

    it("keeps qualified Code calls available and .dx custom APIs scoped to imports", () => {
      const source = "from playground import verify\nplayground.";
      expect(service.documentCompletions(source).map((item) => item.label)).toEqual(["explain", "verify"]);
      expect(service.apiCompletions(source)).toEqual([]);
      expect(service.documentCompletions("ver")).toEqual([]);
      expect(service.apiCompletions("ver")).toEqual([]);
    });
  });

  it("offers Agent result fields", () => {
    const source = 'task = agent(input="plan", apply=False)\ntask.';
    expect(service.documentCompletions(source).map((item) => item.label)).toEqual(["text", "summary", "patch", "files"]);
  });

  it("offers element fields after indexing a list result", () => {
    const registry = new MethodRegistry();
    registry.register({
      id: "mcp.search", title: "Search", description: "", kind: "command", version: "1.0.0",
      input: [],
      output: {
        kind: "mcpRaw",
        fields: [{
          name: "files", type: "list", items: {
            name: "item", type: "object", properties: [
              { name: "id", type: "string" },
              { name: "content", type: "string" },
              { name: "note", type: "string" }
            ]
          }
        }]
      },
      executor: { kind: "deterministic", handler: "askRespond" }
    }, "project");
    const indexed = new DextLanguageService(registry);
    const source = "rows = mcp.search()\nrows.files[0].";
    expect(indexed.documentCompletions(source).map((item) => item.label)).toEqual(["id", "content", "note"]);
  });

  it("completes terminal result fields and terminal status values", () => {
    const fields = 'terminal_result = terminal(command="node --version")\nterminal_result.';
    expect(service.documentCompletions(fields).map((item) => item.label)).toEqual([
      "status", "command", "cwd", "exit_code", "stdout", "stderr", "duration_ms"
    ]);
    const status = 'terminal_result = terminal(command="node --version")\nif terminal_result.status == "';
    expect(service.documentCompletions(status).map((item) => item.label))
      .toEqual(["succeeded", "failed", "timed_out"]);
    const member = 'terminal_result = terminal(command="node --version")\nterminal_result.stderr';
    expect(service.documentHover(member, member.length - 2)).toMatchObject({
      label: "terminal_result.stderr: string"
    });
  });

  it("completes form field types and indexed answers", () => {
    expect(service.documentCompletions('ui.form(title="Form", fields=[{"type": "').map((item) => item.label)).toEqual(["select", "radio", "checkbox", "input"]);
    expect(service.documentCompletions('reply = ui.form(title="Form", fields=[])\nreply.answers["x"].').map((item) => item.label)).toEqual(expect.arrayContaining(["selected", "value", "type"]));
    expect(service.documentSignature('ui.radio(label=')).toMatchObject({ label: expect.stringContaining("UiRadioResult") });
    expect(service.documentSignature('ui.choose(label=')).toBeUndefined();
  });

  it("distinguishes the form result, answer mapping, and indexed answer fields", () => {
    const source = 'confirmation = ui.form(title="Confirm", fields=[])\nif confirmation.answers["decision"].selected[0] == "yes":\n    print(text="ok")';
    for (const [symbol, label] of [
      ["confirmation.answers", "confirmation: UiFormResult"],
      ["answers", "confirmation.answers: dict[str, UiFieldAnswer]"],
      ["selected", 'confirmation.answers["decision"].selected: list[string] | undefined']
    ]) {
      const from = source.indexOf(symbol!);
      const hover = service.apiHover(source, from + 2)!;
      expect(hover.label).toBe(label);
      expect(source.slice(hover.rangeStart, hover.rangeEnd)).toBe(symbol!.split(".")[0]);
    }
    expect(service.documentCompletions('confirmation = ui.form(title="Confirm", fields=[])\nconfirmation.answers.'))
      .toEqual([]);
  });

  it("resolves keyword arguments to their call's parameters before same-named builtins", () => {
    const source = 'diagnosis = agent(input=print(text="apply").text, apply=False)';
    const from = source.indexOf("apply=False");
    expect(service.apiHover(source, from + 2)).toMatchObject({
      kind: "parameter", label: "apply?: boolean = True",
      documentation: expect.stringContaining("Allow trusted workspace changes"),
      rangeStart: from, rangeEnd: from + 5
    });
    expect(service.apiHover('agent(apply=', 8)).toMatchObject({ kind: "parameter", label: "apply?: boolean = True" });
    expect(service.apiHover('unknown(apply=False)', 10)).toBeUndefined();
    expect(service.apiHover('apply(result=diagnosis)', 2)?.label).toMatch(/^apply\(/);
  });

  it("keeps parameters, local variables, and sibling function scopes distinct", () => {
    const source = `def first() -> PrintResult:
    confirmation = print(text="unrelated")
    return confirmation

def second(apply: bool, context: PrintResult) -> UiFormResult:
    confirmation = ui.form(title=context.text, fields=[])
    agent(input=context.text, apply=apply)
    return confirmation`;
    expect(service.apiHover(source, source.lastIndexOf("confirmation") + 2)?.label).toBe("confirmation: UiFormResult");
    expect(service.apiHover(source, source.indexOf("context.text") + 9)?.label).toBe("context.text: string");
    expect(service.apiHover(source, source.indexOf("apply: bool") + 2)).toMatchObject({ kind: "parameter", label: "apply: bool" });
    expect(service.apiHover(source, source.lastIndexOf("apply)") + 2)).toMatchObject({ kind: "parameter", label: "apply: bool" });
    const reassigned = 'confirmation = ui.form(title="Confirm", fields=[])\nconfirmation = print(text="done")\nconfirmation.text';
    expect(service.apiHover(reassigned, reassigned.lastIndexOf("confirmation") + 2)?.label).toBe("confirmation: PrintResult");
    expect(service.apiHover('apply = False\nprint(text=apply)', 27)?.label).toBe("apply: boolean");
  });

  it("does not show method or type hovers inside strings and comments", () => {
    for (const source of ['print(text="apply UiFormResult")', '# apply UiFormResult']) {
      expect(service.apiHover(source, source.indexOf("apply") + 2)).toBeUndefined();
      expect(service.apiHover(source, source.indexOf("UiFormResult") + 2)).toBeUndefined();
    }
  });

  it("narrows form field properties after selecting its discriminator", () => {
    expect(service.documentCompletions('ui.form(title="Form", fields=[{').map((item) => item.label))
      .toEqual(expect.arrayContaining(["id", "type", "label"]));
    const radioProperties = service.documentCompletions('ui.form(title="Form", fields=[{"type": "radio", ')
      .map((item) => item.label);
    expect(radioProperties).toEqual(expect.arrayContaining(["options", "allow_custom", "custom_placeholder"]));
    expect(radioProperties).not.toContain("multiline");
  });

  it("completes ui APIs", () => {
    expect(service.documentCompletions("ui.").map((item) => item.label)).toEqual(["alert", "checkbox", "confirm", "form", "input", "radio", "select"]);
    expect(service.documentSignature("ui.radio(label=", "ui.radio(label=".length)).toMatchObject({
      activeParameter: 0,
      label: expect.stringContaining("options")
    });
  });

  it("reports removed APIs as unknown and validates parameters", () => {
    const source = "code.review(target=ref.selection)";
    expect(service.documentDiagnostics(source)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Unknown Dext API 'code.review'." })
    ]));
    expect(service.documentDiagnostics("agent(apply=1)")).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("expects boolean") }),
      expect.objectContaining({ message: "Missing required argument 'input'." })
    ]));
    const misspelled = 'agent(inpt="x")';
    expect(service.documentDiagnostics(misspelled)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Unknown argument 'inpt' for 'agent'.",
        from: misspelled.indexOf("inpt"),
        to: misspelled.indexOf("inpt") + "inpt".length
      })
    ]));
    for (const source of ["chat(message=\"x\")", "core.ask(input=\"x\")", "terminal.run(command=\"pwd\")"]) {
      expect(service.documentDiagnostics(source)).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("Unknown Dext API") })
      ]));
    }
  });

  it("provides public builtin signatures and hover", () => {
    const source = "agent(input=";
    expect(service.documentHover(source, 2)).toMatchObject({ label: expect.stringContaining("agent") });
    expect(service.documentSignature(source)).toMatchObject({ activeParameter: 0, label: expect.stringContaining("input: string") });
    expect(service.documentSignature("terminal(command=\"pwd\", cwd=")).toMatchObject({
      activeParameter: 1,
      label: expect.stringContaining("timeout_ms?: number = 120000")
    });
  });

  it("keeps parameter completion and signature highlighting in declaration order", () => {
    const completion = service.documentCompletions("agent(");
    expect(completion.map((item) => item.label)).toEqual(["input", "apply", "skills", "rules", "workspace", "cli", "model"]);
    expect(completion.map((item) => item.sortText)).toEqual(["0000", "0001", "0002", "0003", "0004", "0005", "0006"]);
    const next = service.documentCompletions('agent(input="hello", ');
    expect(next.map((item) => item.label)).toEqual(["apply", "skills", "rules", "workspace", "cli", "model"]);
    expect(next[0]?.sortText).toBe("0000");
    expect(service.documentSignature("agent(apply=False, input=")).toMatchObject({ activeParameter: 0 });
  });

  it("shows skills and rules in all conversation API signatures", () => {
    for (const method of ["agent", "ask", "plan"] as const) {
      const signature = service.documentSignature(`${method}(input=`);
      expect(signature?.label).toContain("skills?: string | string[]");
      expect(signature?.label).toContain("rules?: string | string[]");
      expect(signature?.parameters.map((parameter) => parameter.label)).toContain("skills?: string | string[]");
      expect(signature?.parameters.map((parameter) => parameter.label)).toContain("rules?: string | string[]");
    }
  });
});
