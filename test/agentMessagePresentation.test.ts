import { describe, expect, it } from "vitest";
import { agentMessageCopyText, presentAgentMessage } from "../src/agentMessagePresentation.js";

describe("Agent message presentation", () => {
  it("turns an edit result into a compact human-readable summary", () => {
    const raw = JSON.stringify({
      kind: "edit",
      summary: "Complete hello_world and invoke it.",
      patch: {
        kind: "patch",
        title: "Complete hello_world",
        changes: [{
          uri: "target-1/temp.py",
          before: "def hello_world():\n    pass",
          after: 'def hello_world():\n    return "hello world"',
          contentHash: "internal"
        }]
      },
      files: []
    });

    const presentation = presentAgentMessage(raw);
    expect(presentation).toMatchObject({
      structured: true,
      kind: "edit",
      title: "Edit proposal",
      text: "Complete hello_world and invoke it.",
      meta: ["1 file"],
      changes: [{
        uri: "target-1/temp.py",
        before: "def hello_world():\n    pass",
        after: 'def hello_world():\n    return "hello world"'
      }]
    });
    expect(agentMessageCopyText(presentation)).not.toContain("contentHash");
    expect(agentMessageCopyText(presentation)).not.toContain('"kind"');
  });

  it("keeps normal progress prose unchanged", () => {
    const text = "Inspecting the selected implementation first.";
    expect(presentAgentMessage(text)).toEqual({
      structured: false,
      kind: "message",
      title: "",
      text,
      meta: [],
      details: [],
      changes: [],
      references: [],
      sections: []
    });
  });

  it("keeps referenced code and terminal fields as readable sections", () => {
    const explanation = presentAgentMessage(JSON.stringify({
      kind: "explain",
      text: "Uses the selected helper.",
      files: [{
        kind: "codeRef",
        uri: "file:///src/helper.py",
        range: { start: { line: 4, character: 0 }, end: { line: 7, character: 2 } },
        symbol: "helper",
        content: "def helper():\n    pass",
        contentHash: "internal"
      }]
    }));
    expect(explanation.references).toEqual([{
      uri: "file:///src/helper.py",
      location: "Lines 5-8",
      symbol: "helper",
      content: "def helper():\n    pass"
    }]);

    const terminal = presentAgentMessage(JSON.stringify({
      kind: "terminal",
      status: "succeeded",
      command: "git status",
      cwd: "C:/repo",
      exit_code: 0,
      stdout: "clean",
      stderr: "",
      duration_ms: 12
    }));
    expect(terminal.sections).toEqual([
      { title: "Working directory", text: "C:/repo", tone: "muted", code: false },
      { title: "Standard output", text: "clean", tone: "normal", code: true }
    ]);
  });

  it("presents TypedDict result kinds without reducing them to plain prose", () => {
    expect(presentAgentMessage(JSON.stringify({
      kind: "document",
      uri: "file:///workspace/readme.md",
      content: "# Readme"
    }))).toMatchObject({
      structured: true,
      kind: "document",
      title: "document",
      text: expect.stringContaining('"uri": "file:///workspace/readme.md"')
    });
  });
});
