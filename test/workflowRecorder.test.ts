import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { recordWorkflow, recordedApiName, type RecordedTurn } from "../src/core/workflowRecorder.js";
import type { InputExecutionResponse } from "../src/core/types.js";

function response(method: string, kind: "chat" | "agent", confirmMessages: string[] = []): InputExecutionResponse {
  const executions = [
    ...confirmMessages.map((message) => ({
      invocation: {
        kind: "invocation" as const,
        method: "ui.confirm",
        source: "chat" as const,
        arguments: [{ name: "message", value: message }]
      },
      method: { id: "ui.confirm", title: "Confirm", version: "1.0.0" },
      result: { kind: "ui" as const, type: "confirm" as const, confirmed: true },
      context: []
    })),
    {
      invocation: { kind: "invocation" as const, method, source: "chat" as const, arguments: [] },
      method: { id: method, title: method, version: "1.0.0" },
      result: kind === "chat"
        ? { kind: "chat" as const, text: "answer" }
        : { kind: "agent" as const, text: "done" },
      context: []
    }
  ];
  return { kind: "workflow", executions } as unknown as InputExecutionResponse;
}

/** Compiling through the real loader is the only assertion that matters: a
 * skeleton the loader rejects is worse than no skeleton at all. */
async function load(source: string, fileName: string) {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return loadCustomApis(
    true,
    ["/repo/.dext/api"],
    async () => [`/repo/.dext/api/${fileName}`],
    async () => source,
    registry
  );
}

describe("recording a conversation as a .dx workflow", () => {
  it("turns each successful turn into a step and returns the last one", async () => {
    const turns: RecordedTurn[] = [
      { input: "Add a health endpoint", mode: "agent", response: response("agent", "agent") },
      { input: "Explain what changed", mode: "ask", response: response("ask", "chat") }
    ];
    const recorded = recordWorkflow(turns);
    expect(recorded.fileName).toBe("add_a_health_endpoint.dx");
    expect(recorded.apiId).toBe("add_a_health_endpoint");
    expect(recorded.source).toContain('step_1 = agent(input="Add a health endpoint", apply=False)');
    expect(recorded.source).toContain('step_2 = ask(input="Explain what changed")');
    // The declared return type follows the last step's real result kind.
    expect(recorded.source).toContain("-> ChatResult:");
    expect(recorded.source).toContain("return step_2");
    const loaded = await load(recorded.source, recorded.fileName);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.methods.map((method) => method.definition.id)).toEqual(["add_a_health_endpoint"]);
  });

  it("lifts a prompt reused across turns into a main() parameter", async () => {
    const turns: RecordedTurn[] = [
      { input: "Run the migration", mode: "agent", response: response("agent", "agent") },
      { input: "Something else entirely", mode: "ask", response: response("ask", "chat") },
      { input: "Run the migration", mode: "agent", response: response("agent", "agent") }
    ];
    const recorded = recordWorkflow(turns);
    expect(recorded.source).toContain("def main(prompt: str) ->");
    expect(recorded.source).toContain("step_1 = agent(input=prompt, apply=False)");
    expect(recorded.source).toContain("step_3 = agent(input=prompt, apply=False)");
    // The one-off turn keeps its literal, because parameterizing it would invent
    // an input the conversation never varied.
    expect(recorded.source).toContain('step_2 = ask(input="Something else entirely")');
    const loaded = await load(recorded.source, recorded.fileName);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.methods[0]?.definition.input.map((field) => field.name)).toEqual(["prompt"]);
  });

  it("carries a confirmation the conversation went through into the skeleton", async () => {
    const recorded = recordWorkflow([{
      input: "Deploy to staging",
      mode: "agent",
      response: response("agent", "agent", ["Deploy now?"])
    }]);
    expect(recorded.source).toContain('gate_1_1 = ui.confirm(message="Deploy now?")');
    expect(recorded.source).toContain("Gate the step below on gate_1_1.confirmed");
    const loaded = await load(recorded.source, recorded.fileName);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("leaves a Code-mode turn as a comment instead of rewriting it as an agent call", async () => {
    const recorded = recordWorkflow([
      { input: 'answer = ask(input="hi")\nprint(text=answer.text)', mode: "code", response: response("ask", "chat") },
      { input: "Summarize the result", mode: "ask", response: response("ask", "chat") }
    ]);
    expect(recorded.source).toContain('# answer = ask(input="hi")');
    expect(recorded.source).toContain("# print(text=answer.text)");
    expect(recorded.source).toContain('step_2 = ask(input="Summarize the result")');
    const loaded = await load(recorded.source, recorded.fileName);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("keeps a multi-line prompt readable and escapes what would break the string", async () => {
    const recorded = recordWorkflow([{
      input: 'Review this:\nconst path = "C:\\\\tmp";',
      mode: "ask",
      response: response("ask", "chat")
    }]);
    expect(recorded.source).toContain('"""');
    const loaded = await load(recorded.source, recorded.fileName);
    expect(loaded.diagnostics).toEqual([]);
  });

  it("refuses a conversation with nothing worth recording and falls back on an unusable name", () => {
    expect(() => recordWorkflow([{ input: "  ", mode: "agent" }])).toThrow(/no successful turn/);
    expect(() => recordWorkflow([{ input: "Broken", mode: "agent", error: "failed" }])).toThrow(/no successful turn/);
    // A prompt of only punctuation or digits cannot become an identifier.
    expect(recordedApiName([{ input: "??? !!!", mode: "agent" }])).toBe("recorded_workflow");
    expect(recordedApiName([{ input: "123 456", mode: "agent" }])).toBe("recorded_workflow");
  });
});
