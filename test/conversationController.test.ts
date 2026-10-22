import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse } from "../src/shared/contracts/types.js";
import { conversation, createConversationHarness } from "./conversationHarness.js";

function deferredExecution() {
  let release!: () => void;
  const executeConversation = vi.fn(() => new Promise<InputExecutionResponse>((resolve) => {
    release = () => resolve({ kind: "workflow", executions: [] });
  }));
  return { executeConversation, release: () => release() };
}

describe("ConversationController", () => {
  it("restores the saved layout, pins and the previously active tab", () => {
    const h = createConversationHarness({
      layout: { openConversationIds: ["middle"], activeConversationId: "old" },
      pinned: ["pinned"]
    });
    h.seed([conversation("old"), conversation("pinned"), conversation("middle")]);
    expect(h.controller.active().id).toBe("old");
    expect(h.controller.ordered()).toEqual(["pinned", "middle", "old"]);
  });

  it("resets a stale running plan status when nothing is running", async () => {
    const h = createConversationHarness();
    h.seed([{ ...conversation("session"), planStatus: "running", activePlanPath: "a.plan.md" }]);
    expect(h.controller.session("session")?.planStatus).toBe("active");
    await vi.waitFor(() => expect(h.history.list()[0]?.planStatus).toBe("active"));
    const noPlan = createConversationHarness();
    noPlan.seed([{ ...conversation("session"), planStatus: "running" }]);
    expect(noPlan.controller.session("session")?.planStatus).toBe("new");
  });

  it("creates a tab with Agent mode and keeps each tab's composer selection apart", async () => {
    const h = createConversationHarness();
    h.seed([conversation("first")]);
    h.controller.activate(h.controller.session("first")!);
    const firstSelection = { ...h.controller.selection("first")!, model: "first-model" };
    h.controller.setSelection("first", firstSelection);
    const created = await h.controller.start();
    expect(created.id).not.toBe("first");
    expect(h.controller.selection(created.id)?.mode).toBe("agent");
    h.controller.setSelection(created.id, { ...firstSelection, model: "second-model" });
    expect(h.controller.selection("first")?.model).toBe("first-model");
    expect(h.controller.selection(created.id)?.model).toBe("second-model");
    expect(h.controller.ordered()).toEqual(expect.arrayContaining(["first", created.id]));
  });

  it("refuses to close a running conversation and selects a neighbour otherwise", async () => {
    const execution = deferredExecution();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    h.seed([conversation("a"), conversation("b")]);
    h.controller.activate(h.controller.session("b")!);
    const running = h.coordinator.execute(h.controller.session("b")!, "agent", "running");
    await vi.waitFor(() => expect(h.coordinator.running("b")).toBe(true));
    await expect(h.controller.close("b")).rejects.toThrow("Stop this Dext turn");
    h.coordinator.abort("b");
    execution.release();
    await running;
    await h.controller.close("b");
    expect(h.controller.ordered()).not.toContain("b");
    expect(h.controller.active().id).toBe("a");
  });

  it("moves a tab inside its pin group only and persists the new order", async () => {
    const h = createConversationHarness({ pinned: ["a"] });
    h.seed([conversation("a"), conversation("b"), conversation("c")]);
    h.controller.activate(h.controller.session("c")!);
    await h.controller.move("c", "b");
    expect(h.controller.ordered()).toEqual(["a", "c", "b"]);
    await h.controller.move("b", null);
    expect(h.controller.ordered()).toEqual(["a", "c", "b"]);
    // A drop across the pinned boundary is ignored, not silently reordered.
    await h.controller.move("b", "a");
    expect(h.controller.ordered()).toEqual(["a", "c", "b"]);
    await h.controller.move("c", null);
    expect(h.controller.ordered()).toEqual(["a", "b", "c"]);
    expect(h.preferences.conversationLayout().openConversationIds).toEqual(["a", "b", "c"]);
  });

  it("renames a turn in the cached tab so a later restore cannot bring the old title back", async () => {
    const h = createConversationHarness();
    h.seed([{ ...conversation("session"), turns: [{ id: "turn", createdAt: 1, input: "prompt", process: [], output: "" }] }]);
    h.controller.activate(h.controller.session("session")!);
    await h.controller.renameTurn("session", "turn", "Readable name");
    expect(h.history.list()[0]?.turns[0]?.title).toBe("Readable name");
    expect(h.controller.session("session")?.turns[0]?.title).toBe("Readable name");
    expect(h.messages.at(-1)).toMatchObject({ type: "turnRenamed", displayTitle: "Readable name" });
    await h.controller.renameTurn("session", "turn", "");
    expect(h.history.list()[0]?.turns[0]?.title).toBeUndefined();
    expect(h.controller.session("session")?.turns[0]?.title).toBeUndefined();
  });

  it("forgets a conversation without leaving a pin or a selection behind", async () => {
    const h = createConversationHarness({ pinned: ["b"] });
    h.seed([conversation("a"), conversation("b")]);
    h.controller.activate(h.controller.session("b")!);
    await h.controller.forget("b");
    expect(h.controller.session("b")).toBeUndefined();
    expect(h.preferences.isPinned("b")).toBe(false);
    expect(h.preferences.conversationSelection("b")).toBeUndefined();
  });
});
