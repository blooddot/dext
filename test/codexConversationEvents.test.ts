import { describe, expect, it } from "vitest";
import { codexConversationEvent, codexInputQuestions } from "../src/core/codexConversationEvents.js";
describe("Codex App Server event presentation", () => {
  it("retains native option labels, descriptions and secret fields", () => {
    expect(codexInputQuestions([{ id: "one", header: "Pick", question: "Which?", isSecret: true, options: [{ label: "A", description: "First" }] }]))
      .toEqual([{ id: "one", header: "Pick", question: "Which?", isSecret: true, options: [{ label: "A", description: "First" }] }]);
    expect(codexInputQuestions([{ title: "More detail?", options: null }], true)[0])
      .toMatchObject({ id: "question-1", question: "More detail?", options: [] });
    expect(codexInputQuestions([{ id: "one" }])).toEqual([]);
    expect(codexInputQuestions([{ id: "one", question: "First?" }, { id: "one", question: "Second?" }])).toEqual([]);
  });
  it("maps native task snapshots and command output to existing Process/Todo rendering", () => {
    expect(codexConversationEvent("turn/plan/updated", { plan: [{ step: "Inspect", status: "completed" }, { step: "Fix", status: "inProgress" }] })?.todos)
      .toMatchObject([{ text: "Inspect", status: "completed" }, { text: "Fix", status: "in_progress" }]);
    expect(codexConversationEvent("item/completed", { item: { id: "cmd", type: "commandExecution", command: "npm test", aggregatedOutput: "Passed" } }))
      .toMatchObject({ phase: "tool", id: "cmd", title: "npm test", text: "Passed", done: true, replace: true, toolKind: "command" });
    expect(codexConversationEvent("item/completed", { item: { id: "edit", type: "fileChange", changes: [{ path: "/repo/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] } }))
      .toMatchObject({ phase: "tool", toolKind: "file", text: "/repo/a.ts\n@@ -1 +1 @@\n-old\n+new" });
  });
  it("uses current turn token counts rather than cumulative thread usage", () => {
    expect(codexConversationEvent("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15 }, total: { totalTokens: 9999 } } })?.usage?.totalTokens).toBe(15);
  });
});
