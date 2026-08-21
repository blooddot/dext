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

  it("renders UI results so selections and confirmations are visible in history", () => {
    const record: DextHistoryRecord = {
      id: "ui-result",
      createdAt: 1,
      input: 'choice = ui.choose(label="Pick", options=["one", "two"])',
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [
          {
            invocation: { kind: "invocation", method: "ui.choose", source: "code", arguments: [] },
            method: { id: "ui.choose", title: "Choose", kind: "command", source: "builtin" },
            result: { kind: "ui", type: "choice", selected: ["two"] },
            durationMs: 1
          },
          {
            invocation: { kind: "invocation", method: "ui.confirm", source: "code", arguments: [] },
            method: { id: "ui.confirm", title: "Confirm", kind: "command", source: "builtin" },
            result: { kind: "ui", type: "confirm", confirmed: false },
            durationMs: 1
          }
        ]
      }
    };
    const html = renderHistoryRecord(record);
    expect(html).toContain("two");
    expect(html).toContain("Cancelled");
  });

  it("renders Codex progress messages inline in the process timeline", () => {
    const record: DextHistoryRecord = {
      id: "progress",
      createdAt: 1,
      input: "code.explain(target=ref.selection)",
      process: [{ phase: "message", text: "I will inspect the selected implementation first." }],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain('class="process-message"');
    expect(html).toContain("I will inspect the selected implementation first.");
  });

  it("keeps AIOA dialogue and expandable command details in the same process timeline", () => {
    const record: DextHistoryRecord = {
      id: "aioa-work-log",
      createdAt: 1,
      input: 'agent(input="Inspect this")',
      process: [
        { phase: "message", group: "aioa-work-log", text: "Inspecting the workspace" },
        { phase: "tool", group: "aioa-work-log", title: "git status", text: "git status" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("Inspecting the workspace");
    expect(html).toContain("git status");
    expect(html).not.toContain("Ran 1 command");
    expect(html).toContain('class="process-message"');
    expect(html).toMatch(/class="history-disclosure process-event(?: process-command-group)?"/);
  });

  it("groups consecutive commands without moving them across process messages", () => {
    const record: DextHistoryRecord = {
      id: "grouped-process-commands",
      createdAt: 1,
      input: 'agent(input="update greeting")',
      process: [
        { phase: "reasoning", text: "Inspect the current implementation" },
        { phase: "tool", title: "rg greeting", text: "rg greeting" },
        { phase: "tool", title: "Get-Content greeting.ts", text: "Get-Content greeting.ts" },
        { phase: "message", text: "Apply the smallest change" },
        { phase: "tool", title: "npm test", text: "npm test" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("Ran 2 commands");
    expect(html).toContain('class="history-disclosure process-event process-command-group"');
    expect(html.indexOf("Inspect the current implementation")).toBeLessThan(html.indexOf("Ran 2 commands"));
    expect(html.indexOf("Ran 2 commands")).toBeLessThan(html.indexOf("Apply the smallest change"));
    expect(html.indexOf("Apply the smallest change")).toBeLessThan(html.indexOf("npm test"));
  });

  it("reproduces the step grouping an agent reported instead of regrouping by arrival", () => {
    const grouped = (groupId: string, title: string) => ({
      phase: "tool" as const,
      group: "aioa-work-log" as const,
      groupId,
      groupLabel: groupId === "g0" ? "运行了 2 条命令" : "已编辑 1 个文件 · 运行了 1 条命令",
      toolKind: "command" as const,
      title,
      text: title
    });
    const record: DextHistoryRecord = {
      id: "reported-groups",
      createdAt: 1,
      input: 'agent(input="fix layout")',
      process: [
        { phase: "message", group: "aioa-work-log", text: "Locating the selector" },
        grouped("g0", "rg selector"),
        grouped("g0", "rg fallback"),
        { phase: "tool", group: "aioa-work-log", toolKind: "image", solo: true, title: "已查看 shot.png", text: "已查看 shot.png" },
        { phase: "message", group: "aioa-work-log", text: "Applying the fix" },
        grouped("g1", "npm test")
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("运行了 2 条命令");
    expect(html).toContain("已编辑 1 个文件 · 运行了 1 条命令");
    expect(html).not.toContain("Ran 2 commands");
    // The standalone step keeps its own row rather than joining a group.
    expect(html).toContain('class="history-disclosure process-event process-command-solo"');
    expect(html.indexOf("运行了 2 条命令")).toBeLessThan(html.indexOf("已查看 shot.png"));
    expect(html.indexOf("已查看 shot.png")).toBeLessThan(html.indexOf("Applying the fix"));
    expect(html.indexOf("Applying the fix")).toBeLessThan(html.indexOf("npm test"));
  });

  it("preserves the arrival order of thoughts and commands", () => {
    const record: DextHistoryRecord = {
      id: "interleaved-process",
      createdAt: 1,
      input: 'agent(input="update greeting")',
      process: [
        { phase: "reasoning", text: "Inspect the current implementation" },
        { phase: "tool", title: "rg greeting", text: "rg greeting" },
        { phase: "message", text: "Apply the smallest change" }
      ],
      output: ""
    };

    const html = renderHistoryRecord(record);
    expect(html.indexOf("Inspect the current implementation")).toBeLessThan(html.indexOf("rg greeting"));
    expect(html.indexOf("rg greeting")).toBeLessThan(html.indexOf("Apply the smallest change"));
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

  it("renders an agent result patch as an expandable diff in history", () => {
    const record: DextHistoryRecord = {
      id: "agent-patch",
      createdAt: 1,
      input: "agent(input=\"update greeting\")",
      process: [],
      output: "",
      response: {
        kind: "workflow",
        executions: [{
          invocation: { kind: "invocation", method: "agent", source: "code", arguments: [] },
          method: { id: "agent", title: "Agent", kind: "command", source: "builtin" },
          result: {
            kind: "agent",
            text: "Applied the change.",
            patch: {
              kind: "patch",
              title: "Update greeting",
              changes: [{ uri: "file:///workspace/greeting.ts", before: "export const greeting = 'hi';", after: "export const greeting = 'hello';" }]
            }
          },
          durationMs: 10
        }]
      }
    };

    const html = renderHistoryRecord(record);
    expect(html).toContain("greeting.ts");
    expect(html).toContain("data-diff-mode=\"split\"");
    expect(html).toContain("export const greeting");
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
