import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse } from "../src/shared/contracts/types.js";
import { defaultConversationSelection } from "../src/features/conversations/domain/agentSelection.js";
import { conversation, createConversationHarness, defaultSelection } from "./conversationHarness.js";

function deferredExecution() {
  let release!: () => void;
  const executeConversation = vi.fn(() => new Promise<InputExecutionResponse>((resolve) => {
    release = () => resolve({ kind: "workflow", executions: [] });
  }));
  return { executeConversation, release: () => release() };
}

describe("ConversationController", () => {
  it("restores the saved layout, pins and the previously active tab", async () => {
    const h = createConversationHarness({
      layout: { openConversationIds: ["middle"], activeConversationId: "old" },
      pinned: ["pinned"]
    });
    await h.seed([conversation("old"), conversation("pinned"), conversation("middle")]);
    expect(h.controller.active().id).toBe("old");
    expect(h.controller.ordered()).toEqual(["pinned", "middle", "old"]);
  });

  it("resets a stale running plan status when nothing is running", async () => {
    const h = createConversationHarness();
    await h.seed([{ ...conversation("session"), planStatus: "running", activePlanPath: "a.plan.md" }]);
    expect(h.controller.session("session")?.planStatus).toBe("active");
    await vi.waitFor(async () => expect((await h.history.sessions())[0]?.planStatus).toBe("active"));
    const noPlan = createConversationHarness();
    await noPlan.seed([{ ...conversation("session"), planStatus: "running" }]);
    expect(noPlan.controller.session("session")?.planStatus).toBe("new");
  });

  it("creates a tab with Agent mode and keeps each tab's composer selection apart", async () => {
    const h = createConversationHarness();
    await h.seed([conversation("first")]);
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

  it("starts a new tab and a resource tab with no skills", async () => {
    const h = createConversationHarness({ selection: { skillLoading: "every-turn", skills: ["inherited"] } });
    await h.seed([]);
    const first = h.controller.active();
    expect(h.controller.selection(first.id)?.skillLoading).toBe("on-demand");
    expect(h.preferences.conversationSelection(first.id)?.skillLoading).toBe("on-demand");
    expect(h.controller.selection(first.id)?.skills).toBeUndefined();
    h.controller.setSelection(first.id, { ...h.controller.selection(first.id)!, skills: ["ponytail"], skillLoading: "every-turn" });
    const next = await h.controller.start();
    expect(h.controller.selection(next.id)?.skillLoading).toBe("on-demand");
    expect(h.controller.selection(next.id)?.skills).toBeUndefined();
    expect(h.preferences.conversationSelection(next.id)?.skills).toBeUndefined();
    h.controller.setSelection(next.id, { ...h.controller.selection(next.id)!, skillLoading: "every-turn", skills: ["ponytail"] });
    const cleared = await h.controller.start(true);
    expect(h.controller.ordered()).not.toContain(next.id);
    expect(h.controller.selection(cleared.id)?.skills).toBeUndefined();
    expect(h.preferences.conversationSelection(cleared.id)?.skillLoading).toBe("on-demand");
    const resource = await h.controller.start(false, { type: "skill", scope: "project" });
    expect(resource.resource).toEqual({ type: "skill", scope: "project" });
    expect(h.controller.selection(resource.id)?.skills).toBeUndefined();
    expect(h.controller.selection(resource.id)?.mode).toBe("ask");
  });

  it("hydrates an empty workspace despite a failed preference write and retries on the next request", async () => {
    const h = createConversationHarness();
    const update = vi.spyOn(h.state, "update").mockRejectedValueOnce(new Error("Temporary storage failure"));
    await h.seed([]);
    const initial = h.controller.active();
    const selection = h.controller.selection(initial.id)!;
    expect(selection.skillLoading).toBe("on-demand");
    expect(h.controller.ordered()).toEqual([initial.id]);
    expect(h.preferences.conversationSelection(initial.id)).toBeUndefined();
    await h.controller.postConversationState();
    expect(h.messages.at(-1)).toMatchObject({ type: "conversations", activeId: initial.id, selection });

    const updated = { ...selection, model: "updated-model" };
    h.controller.setSelection(initial.id, updated);
    await Promise.all([h.controller.hydrate(), h.controller.hydrate()]);
    expect(update).toHaveBeenCalledTimes(2);
    expect(h.controller.active()).toBe(initial);
    expect(h.preferences.conversationSelection(initial.id)).toEqual(updated);
    const next = await h.controller.start();
    expect(h.controller.ordered()).toEqual([initial.id, next.id]);
    expect(h.preferences.conversationSelection(next.id)?.skillLoading).toBe("on-demand");
  });

  it("restores legacy and explicitly switched selections on reopen and restart", async () => {
    const h = createConversationHarness();
    const legacy = conversation("legacy");
    const missing = conversation("missing");
    await h.state.update("dext.conversationSelections", { legacy: { skills: ["kept"] } });
    await h.seed([missing, legacy]);
    expect(h.controller.selection(legacy.id)).toMatchObject({ skillLoading: "every-turn", skills: ["kept"] });
    await h.controller.open(missing);
    expect(h.controller.selection(missing.id)?.skillLoading).toBe("every-turn");

    const switched = { ...h.controller.selection(legacy.id)!, skillLoading: "on-demand" as const };
    await h.preferences.setConversationSelection(legacy.id, switched);
    h.controller.setSelection(legacy.id, switched);
    await h.controller.close(legacy.id);
    await h.controller.open(legacy);
    expect(h.controller.selection(legacy.id)).toMatchObject(switched);
    await h.controller.persistLayout();
    const restarted = createConversationHarness({ state: h.state, layout: h.controller.layout() });
    await restarted.seed([missing, legacy]);
    expect(restarted.controller.selection(legacy.id)).toMatchObject(switched);
    await restarted.controller.open(missing);
    expect(restarted.controller.selection(missing.id)?.skillLoading).toBe("every-turn");
  });

  it.each(["success", "failure"])("restores the initial Skill loading after a first-turn %s without saved preferences", async (outcome) => {
    const h = createConversationHarness({
      executeConversation: async () => {
        if (outcome === "failure") throw new Error("Agent failed");
        return { kind: "workflow", executions: [] };
      }
    });
    const update = vi.spyOn(h.state, "update")
      .mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    await h.seed([]);
    await h.controller.hydrate();
    const initial = h.controller.active();
    expect(update).toHaveBeenCalledTimes(2);
    await h.coordinator.execute(initial, "agent", "first prompt");
    expect(h.preferences.conversationSelection(initial.id)).toBeUndefined();

    const persisted = await h.history.sessions();
    expect(persisted[0]?.turns).toHaveLength(1);
    const restarted = createConversationHarness();
    await restarted.seed(persisted);
    expect(restarted.controller.active().id).toBe(initial.id);
    expect(restarted.controller.selection(initial.id)?.skillLoading).toBe("on-demand");

    const explicit = { ...defaultSelection, skillLoading: "every-turn" as const };
    await restarted.preferences.setConversationSelection(initial.id, explicit);
    const reopened = createConversationHarness({ state: restarted.state });
    await reopened.seed(persisted);
    expect(reopened.controller.selection(initial.id)?.skillLoading).toBe("every-turn");
  });

  it("persists a new fork selection before opening its copied history", async () => {
    const h = createConversationHarness();
    const turn = { id: "turn", createdAt: 1, input: "prompt", process: [], output: "" };
    const fork = await h.history.fork([turn]);
    const selection = defaultConversationSelection({ ...defaultSelection, skillLoading: "every-turn", skills: ["inherited"] });
    await h.preferences.setConversationSelection(fork.id, selection);
    await h.controller.open(fork);
    expect(h.controller.active()).toMatchObject({ id: fork.id, turns: [expect.objectContaining({ input: "prompt" })] });
    expect(h.controller.selection(fork.id)?.skillLoading).toBe("on-demand");
    expect(h.controller.selection(fork.id)?.skills).toBeUndefined();
    expect(h.preferences.conversationSelection(fork.id)?.skillLoading).toBe("on-demand");
  });

  it("refuses to close a running conversation and selects a neighbour otherwise", async () => {
    const execution = deferredExecution();
    const h = createConversationHarness({ executeConversation: execution.executeConversation });
    await h.seed([conversation("a"), conversation("b")]);
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

  it("republishes the tab strip when an already open tab is activated", async () => {
    const h = createConversationHarness();
    await h.seed([conversation("a"), conversation("b")]);
    h.controller.activate(h.controller.session("a")!);
    h.controller.activate(h.controller.session("b")!);
    await vi.waitFor(() => expect(h.messages.filter((message) => message.type === "conversations")).toHaveLength(2));
    h.messages.length = 0;
    // A turn that ended while another tab was shown leaves the composer's copy
    // of every running flag stale; activating the tab has to refresh it, or a
    // message queued in that tab never gets sent.
    h.controller.activate(h.controller.session("a")!);
    await vi.waitFor(() => expect(h.messages.filter((message) => message.type === "conversations")).toHaveLength(1));
    const conversations = h.messages.find((message) => message.type === "conversations");
    expect(conversations).toMatchObject({ activeId: "a" });
    expect(conversations?.type === "conversations" && conversations.sessions.find((summary) => summary.id === "a")?.running).toBe(false);
  });

  it("moves a tab inside its pin group only and persists the new order", async () => {
    const h = createConversationHarness({ pinned: ["a"] });
    await h.seed([conversation("a"), conversation("b"), conversation("c")]);
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
    await h.seed([{ ...conversation("session"), turns: [{ id: "turn", createdAt: 1, input: "prompt", process: [], output: "" }] }]);
    h.controller.activate(h.controller.session("session")!);
    await h.controller.renameTurn("session", "turn", "Readable name");
    expect((await h.history.sessions())[0]?.turns[0]?.title).toBe("Readable name");
    expect(h.controller.session("session")?.turns[0]?.title).toBe("Readable name");
    expect(h.messages.at(-1)).toMatchObject({ type: "turnRenamed", title: "Readable name", displayTitle: "Readable name" });
    await h.controller.renameTurn("session", "turn", "");
    expect((await h.history.sessions())[0]?.turns[0]?.title).toBeUndefined();
    expect(h.controller.session("session")?.turns[0]?.title).toBeUndefined();
  });

  it("forgets a conversation without leaving a pin or a selection behind", async () => {
    const h = createConversationHarness({ pinned: ["b"] });
    await h.seed([conversation("a"), conversation("b")]);
    h.controller.activate(h.controller.session("b")!);
    await h.controller.forget("b");
    expect(h.controller.session("b")).toBeUndefined();
    expect(h.preferences.isPinned("b")).toBe(false);
    expect(h.preferences.conversationSelection("b")).toBeUndefined();
  });
});
