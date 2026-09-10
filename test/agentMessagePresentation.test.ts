import { describe, expect, it } from "vitest";
import { presentAgentMessage } from "../src/agentMessagePresentation.js";

describe("Agent message presentation", () => {
  it("keeps an agent patch available for the same diff presentation", () => {
    const presentation = presentAgentMessage(JSON.stringify({
      kind: "agent",
      text: "Applied the change.",
      patch: {
        kind: "patch",
        title: "Update greeting",
        changes: [{ uri: "file:///workspace/greeting.ts", before: "export const greeting = 'hi';", after: "export const greeting = 'hello';" }]
      }
    }));

    expect(presentation).toMatchObject({
      title: "Agent",
      meta: ["1 file"],
      changes: [{ uri: "file:///workspace/greeting.ts", before: "export const greeting = 'hi';", after: "export const greeting = 'hello';" }]
    });
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
    const agent = presentAgentMessage(JSON.stringify({
      kind: "agent",
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
    expect(agent.references).toEqual([{
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
