import { describe, expect, it } from "vitest";
import { stripTypeScriptTypes } from "node:module";
import { recordWorkflow, recordedApiName, type RecordedTurn } from "../src/core/workflowRecorder.js";
import type { InputExecutionResponse } from "../src/core/types.js";

function response(method: string, kind: "ask" | "agent", confirmMessages: string[] = []): InputExecutionResponse {
  const executions = [
    ...confirmMessages.map((message) => ({
      invocation: {
        kind: "invocation" as const,
        method: "ui.confirm",
        source: "ask" as const,
        arguments: [{ name: "message", value: message }]
      },
      method: { id: "ui.confirm", title: "Confirm", version: "1.0.0" },
      result: { kind: "ui" as const, type: "confirm" as const, confirmed: true },
      context: []
    })),
    {
      invocation: { kind: "invocation" as const, method, source: "ask" as const, arguments: [] },
      method: { id: method, title: method, version: "1.0.0" },
      result: kind === "ask"
        ? { kind: "ask" as const, text: "answer" }
        : { kind: "agent" as const, text: "done" },
      context: []
    }
  ];
  return { kind: "workflow", executions } as unknown as InputExecutionResponse;
}

/** The skeleton is plain `.ts`, so the same module strip the runner uses is the
 * only compilation that matters: a skeleton the strip rejects is worse than no
 * skeleton at all. */
function assertErasable(source: string): void {
  expect(() => stripTypeScriptTypes(source, { mode: "strip" })).not.toThrow();
}

describe("recording a conversation as a TypeScript API", () => {
  it("turns each successful turn into a step and returns the last one", () => {
    const turns: RecordedTurn[] = [
      { input: "Add a health endpoint", mode: "agent", response: response("agent", "agent") },
      { input: "Explain what changed", mode: "ask", response: response("ask", "ask") }
    ];
    const recorded = recordWorkflow(turns);
    expect(recorded.fileName).toBe("add_a_health_endpoint.ts");
    expect(recorded.apiId).toBe("add_a_health_endpoint");
    expect(recorded.source).toContain('import { agent, ask, ui, type AskResult } from "dext";');
    expect(recorded.source).toContain("export async function main(): Promise<AskResult> {");
    expect(recorded.source).toContain('const step_1 = await agent({ input: "Add a health endpoint", apply: false });');
    expect(recorded.source).toContain('const step_2 = await ask({ input: "Explain what changed" });');
    // The declared return type follows the last step's real result kind.
    expect(recorded.source).toContain("return step_2;");
    // No Python-era leftovers survive into the TypeScript module.
    expect(recorded.source).not.toContain("def main");
    expect(recorded.source).not.toContain(".dx");
    expect(recorded.source).not.toContain("PrintResult");
    assertErasable(recorded.source);
  });

  it("lifts a prompt reused across turns into a main() parameter", () => {
    const turns: RecordedTurn[] = [
      { input: "Run the migration", mode: "agent", response: response("agent", "agent") },
      { input: "Something else entirely", mode: "ask", response: response("ask", "ask") },
      { input: "Run the migration", mode: "agent", response: response("agent", "agent") }
    ];
    const recorded = recordWorkflow(turns);
    expect(recorded.source).toContain("export async function main(prompt: string): Promise<AgentResult> {");
    expect(recorded.source).toContain("const step_1 = await agent({ input: prompt, apply: false });");
    expect(recorded.source).toContain("const step_3 = await agent({ input: prompt, apply: false });");
    // The one-off turn keeps its literal, because parameterizing it would invent
    // an input the conversation never varied.
    expect(recorded.source).toContain('const step_2 = await ask({ input: "Something else entirely" });');
    assertErasable(recorded.source);
  });

  it("carries a confirmation the conversation went through into the skeleton", () => {
    const recorded = recordWorkflow([{
      input: "Deploy to staging",
      mode: "agent",
      response: response("agent", "agent", ["Deploy now?"])
    }]);
    expect(recorded.source).toContain('const gate_1_1 = await ui.confirm({ message: "Deploy now?" });');
    expect(recorded.source).toContain("// Gate the step below on gate_1_1.confirmed once you decide what No should skip.");
    expect(recorded.source).toContain('const step_1 = await agent({ input: "Deploy to staging", apply: false });');
    assertErasable(recorded.source);
  });

  it("leaves a Code-mode turn as a comment instead of rewriting it as an agent call", () => {
    const recorded = recordWorkflow([
      { input: 'answer = ask(input="hi")\nprint(text=answer.text)', mode: "code", response: response("ask", "ask") },
      { input: "Summarize the result", mode: "ask", response: response("ask", "ask") }
    ]);
    expect(recorded.source).toContain("// Code-mode turn 1 ran this directly:");
    expect(recorded.source).toContain('// answer = ask(input="hi")');
    expect(recorded.source).toContain("// print(text=answer.text)");
    expect(recorded.source).toContain('const step_2 = await ask({ input: "Summarize the result" });');
    assertErasable(recorded.source);
  });

  it("logs a note when every turn was Code mode and there is nothing to return", () => {
    const recorded = recordWorkflow([
      { input: 'answer = ask(input="hi")\nconsole.log(answer)', mode: "code", response: response("ask", "ask") }
    ]);
    expect(recorded.source).toContain("export async function main(): Promise<void> {");
    expect(recorded.source).toContain('console.log("Fill in the steps above.");');
    expect(recorded.source).not.toContain("return step_");
    assertErasable(recorded.source);
  });

  it("escapes what would break the string, including a multi-line prompt", () => {
    const input = 'Review this:\nconst path = "C:\\\\tmp";';
    const recorded = recordWorkflow([{ input, mode: "ask", response: response("ask", "ask") }]);
    expect(recorded.source).toContain(`const step_1 = await ask({ input: ${JSON.stringify(input)} });`);
    expect(recorded.source).not.toContain('"""');
    assertErasable(recorded.source);
  });

  it("refuses a conversation with nothing worth recording and falls back on an unusable name", () => {
    expect(() => recordWorkflow([{ input: "  ", mode: "agent" }])).toThrow(/no successful turn/);
    expect(() => recordWorkflow([{ input: "Broken", mode: "agent", error: "failed" }])).toThrow(/no successful turn/);
    // A prompt of only punctuation or digits cannot become an identifier.
    expect(recordedApiName([{ input: "??? !!!", mode: "agent" }])).toBe("recorded_workflow");
    expect(recordedApiName([{ input: "123 456", mode: "agent" }])).toBe("recorded_workflow");
  });
});
