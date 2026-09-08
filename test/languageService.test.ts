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
    const header = `def summarize(value: ChatResult, label: str = "summary") -> PrintResult:
    return print(text=value.text, label=label)

def main(input: str) -> PrintResult:
    answer = ask(input=input)
`;
    const call = `${header}    report = summarize(value=answer, label=`;
    expect(service.apiCompletions(`${header}    sum`).map((item) => item.label)).toContain("summarize");
    expect(service.apiSignature(call)).toMatchObject({
      label: 'summarize(value: ChatResult, label?: string = "summary") -> PrintResult', activeParameter: 1
    });
    const complete = `${header}    report = summarize(value=answer)\n    report.`;
    expect(service.apiCompletions(complete).map((item) => item.label)).toEqual(["text", "label"]);
    expect(service.apiHover(call, call.lastIndexOf("summarize") + 2)?.label).toContain("summarize(value: ChatResult");
    expect(service.documentCompletions(`${header}    sum`).map((item) => item.label)).not.toContain("summarize");
    expect(service.apiCompletions("sum")).toEqual([]);
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

  it("completes ui APIs", () => {
    expect(service.documentCompletions("ui.").map((item) => item.label)).toEqual(["choose", "confirm", "input"]);
    expect(service.documentSignature("ui.choose(label=", "ui.choose(label=".length)).toMatchObject({
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
