import { describe, expect, it } from "vitest";
import { highlightDext, historyTokenStyles, renderHistoryRecord } from "../src/historyRender.js";
import type { DextHistoryRecord } from "../src/historyStore.js";

describe("Dext history rendering", () => {
  it("uses Python token classes for Dext input", () => {
    const html = highlightDext('result = code.edit(target=ref.selection, instruction="fix")');
    expect(html).toContain("tok-variableName");
    expect(html).toContain("tok-string");
    expect(historyTokenStyles({ string: "#123456" })).toContain("#123456");
  });

  it("renders structured output instead of a raw workflow JSON block", () => {
    const record: DextHistoryRecord = {
      id: "1",
      createdAt: 1,
      input: 'chat(message="hello")',
      process: [{ phase: "reasoning", text: "Consider context" }],
      output: JSON.stringify({ kind: "workflow" }),
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "chat", source: "code", arguments: [] },
          method: { id: "chat", title: "Chat", kind: "command", source: "builtin" },
          result: { kind: "chat", text: "hello" },
          durationMs: 10
        }]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain("history-execution");
    expect(html).toContain("Consider context");
    expect(html).toContain("hello");
    expect(html).not.toContain('&quot;kind&quot;: &quot;workflow&quot;');
  });

  it("recovers structured data from legacy JSON history records", () => {
    const record: DextHistoryRecord = {
      id: "legacy",
      createdAt: 1,
      input: 'print(text="old")',
      process: [],
      output: JSON.stringify({
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "print", source: "code", arguments: [] },
          method: { id: "print", title: "Print", kind: "command", source: "builtin" },
          result: { kind: "print", text: "old" },
          durationMs: 2
        }]
      })
    };
    expect(renderHistoryRecord(record)).toContain("old");
  });
});
