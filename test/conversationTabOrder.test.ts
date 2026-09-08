import { describe, expect, it, vi } from "vitest";
import { DextConversationPreferences } from "../src/conversationPreferences.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";

vi.mock("vscode", () => ({}));

class MemoryState {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

async function harness() {
  const preferences = new DextConversationPreferences(new MemoryState() as never);
  await preferences.setPinned("p1", true);
  await preferences.setPinned("p2", true);
  const activeSession = { id: "b", turns: [{ id: "running-turn" }] };
  const post = vi.fn();
  const schedule = vi.fn();
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  const state = {
    preferences, activeSession,
    openConversations: ["p1", "p2", "a", "b", "c"],
    hydrateSessions: vi.fn(), postConversationState: post, scheduleConversationLayoutPersist: schedule
  };
  Object.assign(sidebar, state);
  return { sidebar, preferences, activeSession, post, schedule,
    state: sidebar as unknown as typeof state & { orderedConversations(): string[]; persistConversationLayout(): Promise<void> } };
}

describe("conversation tab order", () => {
  it("moves tabs left and right and persists the order without changing the active conversation", async () => {
    const h = await harness();
    await h.sidebar.moveConversation("c", "a");
    expect(h.state.orderedConversations()).toEqual(["p1", "p2", "c", "a", "b"]);
    await h.sidebar.moveConversation("c", null);
    expect(h.state.orderedConversations()).toEqual(["p1", "p2", "a", "b", "c"]);
    await h.sidebar.moveConversation("b", "a");
    expect(h.state.activeSession).toBe(h.activeSession);
    expect(h.state.activeSession.turns).toEqual([{ id: "running-turn" }]);
    expect(h.schedule).toHaveBeenCalledTimes(3);
    expect(h.post).toHaveBeenCalledTimes(3);
    await h.state.persistConversationLayout();
    expect(h.preferences.conversationLayout()).toEqual({
      openConversationIds: ["p1", "p2", "b", "a", "c"], activeConversationId: "b"
    });
  });

  it("restores reordered pinned tabs ahead of ordinary tabs", async () => {
    const h = await harness();
    await h.sidebar.moveConversation("p2", "p1");
    await h.state.persistConversationLayout();
    h.state.openConversations = [...h.preferences.conversationLayout().openConversationIds];
    expect(h.state.orderedConversations()).toEqual(["p2", "p1", "a", "b", "c"]);
    expect(h.preferences.pinned()).toEqual(["p1", "p2"]);
    await h.sidebar.moveConversation("p2", null);
    expect(h.state.orderedConversations()).toEqual(["p1", "p2", "a", "b", "c"]);
  });

  it("ignores stale or cross-group targets without losing newly opened tabs", async () => {
    const h = await harness();
    for (const [id, before] of [["closed", "a"], ["a", "closed"], ["a", "p1"], ["p1", "a"], ["a", "a"]]) {
      await h.sidebar.moveConversation(id!, before!);
    }
    expect(h.state.orderedConversations()).toEqual(["p1", "p2", "a", "b", "c"]);
    expect(h.schedule).not.toHaveBeenCalled();
    h.state.openConversations.push("new");
    await h.sidebar.moveConversation("c", "a");
    expect(h.state.orderedConversations()).toEqual(["p1", "p2", "c", "a", "b", "new"]);
  });
});
