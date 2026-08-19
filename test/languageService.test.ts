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

  it("completes public top-level methods and print", () => {
    expect(service.documentCompletions("co")).toEqual([]);
    expect(service.documentCompletions("a").map((item) => item.label))
      .toEqual(["agent", "apply", "ask"]);
    expect(service.documentCompletions("agent(in").map((item) => item.label)).toEqual(["input"]);
    expect(service.documentCompletions("skill(skill=").map((item) => item.label)).toEqual([]);
  });

  it("offers Agent result fields", () => {
    const source = 'task = agent(input="plan", apply=False)\ntask.';
    expect(service.documentCompletions(source).map((item) => item.label)).toEqual(["text", "summary", "patch", "files"]);
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
    expect(service.documentSignature("mcp(tool=\"docs.read\", input=")).toMatchObject({
      activeParameter: 1,
      label: "mcp(tool: string, input: dict[str, object] = {}) -> McpRawResult"
    });
  });
});
