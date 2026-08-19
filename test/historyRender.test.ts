import { describe, expect, it } from "vitest";
import { highlightDext, historyTokenStyles, renderHistoryRecord, renderHistorySession } from "../src/historyRender.js";
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
      input: 'ask(input="hello")',
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

  it("renders Codex progress messages in the collapsible process trace", () => {
    const record: DextHistoryRecord = {
      id: "progress",
      createdAt: 1,
      input: "code.explain(target=ref.selection)",
      process: [{ phase: "message", text: "I will inspect the selected implementation first." }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("Thought");
    expect(html).toContain("I will inspect the selected implementation first.");
  });

  it("renders structured agent results as readable thought summaries instead of JSON", () => {
    const structured = JSON.stringify({
      kind: "review",
      status: "pass",
      summary: "The change correctly returns hello world.",
      findings: []
    });
    const record: DextHistoryRecord = {
      id: "structured-thought",
      createdAt: 1,
      input: "code.review(target=edit_result)",
      process: [{ phase: "message", text: structured }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("process-result-review");
    expect(html).toContain("Review");
    expect(html).toContain("Passed");
    expect(html).toContain("The change correctly returns hello world.");
    expect(html).not.toContain("&quot;kind&quot;");
    expect(html).not.toContain("findings");
  });

  it("keeps patch details and both diff layouts in structured thoughts", () => {
    const structured = JSON.stringify({
      kind: "edit",
      summary: "Complete hello_world.",
      patch: {
        kind: "patch",
        title: "Complete hello_world",
        changes: [{
          uri: "target-1/temp.py",
          before: "def hello_world():\n    pass",
          after: 'def hello_world():\n    return "hello world"'
        }]
      },
      files: []
    });
    const record: DextHistoryRecord = {
      id: "structured-patch",
      createdAt: 1,
      input: "code.edit(target=ref.selection, instruction=\"complete it\")",
      process: [{ phase: "message", text: structured }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("target-1/temp.py");
    expect(html).toContain("def hello_world():");
    expect(html).toContain('return &quot;hello world&quot;');
    expect(html).toContain('data-diff-mode="inline"');
    expect(html).toContain('data-diff-mode="split"');
    expect(html).toContain("diff-inline");
    expect(html).toContain("diff-split");
  });

  it("uses compact durations in history summaries and executions", () => {
    const record: DextHistoryRecord = {
      id: "duration",
      createdAt: 1,
      input: 'ask(input="hello")',
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "chat", source: "code", arguments: [] },
          method: { id: "chat", title: "Chat", kind: "command", source: "builtin" },
          result: { kind: "chat", text: "hello" },
          durationMs: 40_499
        }]
      }
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("40s499ms");
    expect(html).not.toContain("40499 ms");
  });

  it("renders readable @ reference tokens as Chips while retaining raw copy source", () => {
    const token = "@src/pathx.py#L55,1-L66,32";
    const record: DextHistoryRecord = {
      id: "reference",
      createdAt: 1,
      input: 'agent(input="Explain ' + token + '")',
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("history-file-reference");
    expect(html).toContain("pathx.py 55-66");
    expect(html).toContain(token);
  });

  it("renders image attachments as ordinary file reference Chips", () => {
    const path = ".dext/attachments/0123456789abcdef01234567.png";
    const record: DextHistoryRecord = {
      id: "image-reference",
      createdAt: 1,
      input: `ask(input="Inspect @${path}")`,
      process: [],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("data-open-file-reference");
    expect(html).toContain("0123456789abcdef01234567.png");
    expect(html).not.toContain("data-open-image-attachment");
  });

  it("groups continuous turns under one collapsible conversation", () => {
    const turns: DextHistoryRecord[] = ["first", "second"].map((text, index) => ({
      id: String(index),
      createdAt: index + 1,
      input: `ask(input="${text}")`,
      process: [],
      output: ""
    }));

    const html = renderHistorySession({ id: "session", createdAt: 1, updatedAt: 2, turns });

    expect(html).toContain('class="history-session"');
    expect(html.match(/class="history-record"/g)).toHaveLength(2);
    expect(html).toContain("2 turns");
  });
});
