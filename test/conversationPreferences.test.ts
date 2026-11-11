import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { orderHistorySessions } from "../src/features/conversations/domain/conversationOrder.js";
import { conversation, createConversationHarness } from "./conversationHarness.js";

class MemoryState {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

function preferences(): DextConversationPreferences {
  return new DextConversationPreferences(new MemoryState() as never);
}

function session(id: string, createdAt: number, updatedAt = createdAt): { id: string; createdAt: number; updatedAt: number } {
  return { id, createdAt, updatedAt };
}

describe("conversation preferences", () => {
  it("starts with no history filter applied", () => {
    const store = preferences();

    expect(store.favoritesOnly()).toBe(false);
  });

  it("orders conversations by last activity, newest first", () => {
    const sessions = [session("a", 1), session("b", 3), session("c", 2)];

    expect(orderHistorySessions(sessions, { favorites: [], favoritesOnly: false }).map((item) => item.id))
      .toEqual(["b", "c", "a"]);
  });

  it("ranks a conversation by its latest turn rather than when it started", () => {
    const sessions = [session("old-but-active", 1, 9), session("recent", 5)];

    expect(orderHistorySessions(sessions, { favorites: [], favoritesOnly: false })
      .map((item) => item.id)).toEqual(["old-but-active", "recent"]);
  });

  it("floats favorites above everything else and can hide the rest", () => {
    const sessions = [session("a", 1), session("b", 3), session("c", 2)];

    expect(orderHistorySessions(sessions, { favorites: ["a"], favoritesOnly: false })
      .map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(orderHistorySessions(sessions, { favorites: ["a", "c"], favoritesOnly: true })
      .map((item) => item.id)).toEqual(["c", "a"]);
  });

  it("keeps pins in the order they were added so tabs hold their place", async () => {
    const store = preferences();

    await store.setPinned("second", true);
    await store.setPinned("first", true);
    await store.setPinned("second", true);

    expect(store.pinned()).toEqual(["first", "second"]);
    expect(store.isPinned("second")).toBe(true);

    await store.setPinned("first", false);
    expect(store.pinned()).toEqual(["second"]);
  });

  it("persists the open tabs and selected tab for the next VS Code session", async () => {
    const store = preferences();

    await store.setConversationLayout({
      openConversationIds: ["first", "second", "first", ""],
      activeConversationId: "second"
    });

    expect(store.conversationLayout()).toEqual({
      openConversationIds: ["first", "second"],
      activeConversationId: "second"
    });

    await store.forget("second");
    expect(store.conversationLayout()).toEqual({ openConversationIds: ["first"] });
  });

  it("keeps composer selections isolated by conversation id", async () => {
    const store = preferences();
    const first = { mode: "ask" as const, permission: "workspace-write" as const, profileId: "codex", model: "gpt", reasoningEffort: "", speed: "standard", serviceTier: "default" };
    const second = { mode: "agent" as const, permission: "full-access" as const, profileId: "claude", model: "sonnet", reasoningEffort: "high", speed: "", serviceTier: "" };

    await store.setConversationSelection("first", first);
    await store.setConversationSelection("second", second);

    expect(store.conversationSelection("first")).toEqual(first);
    expect(store.conversationSelection("second")).toEqual(second);

    await store.forget("first");
    expect(store.conversationSelection("first")).toBeUndefined();
    expect(store.conversationSelection("second")).toEqual(second);
  });

  it("normalizes skills per conversation, keeps legacy selections, and caps the list", async () => {
    const store = preferences();
    const legacy = { mode: "agent" as const, permission: "workspace-write" as const, profileId: "codex", model: "gpt", reasoningEffort: "", speed: "", serviceTier: "" };
    await store.setConversationSelection("legacy", legacy);
    expect(store.conversationSelection("legacy")).toEqual(legacy);

    await store.setConversationSelection("skills", { ...legacy, skills: ["ponytail", " ponytail ", "ponytail", "bad/id"] });
    expect(store.conversationSelection("skills")?.skills).toEqual(["ponytail"]);

    await store.setConversationSelection("many", { ...legacy, skills: Array.from({ length: 70 }, (_, index) => `skill-${index}`) });
    expect(store.conversationSelection("many")?.skills).toHaveLength(64);
  });

  it("restores the saved tabs and active conversation when the controller is created again", async () => {
    const layout = { openConversationIds: ["one", "two"], activeConversationId: "two" };
    const first = createConversationHarness({ layout });
    await first.seed([conversation("one"), conversation("two")]);
    // The layout is persisted by the controller whenever a tab changes.
    expect(first.preferences.conversationLayout()).toEqual({ openConversationIds: ["one", "two"], activeConversationId: "two" });
    // A store created over the same memento restores both tabs and the active one.
    const restored = new DextConversationPreferences(first.state as never);
    expect(restored.conversationLayout()).toEqual({ openConversationIds: ["one", "two"], activeConversationId: "two" });
  });

  it("renders the History panel through the stored ordering and names", async () => {
    const panel = await readFile(resolve("src/features/conversations/host/historyEditorProvider.ts"), "utf8");

    expect(panel).toContain("const ordering = this.preferences.historyOrdering();");
    expect(panel).toContain("orderHistorySessions(this.history.summaries(true), ordering)");
    expect(panel).toContain("const name = this.preferences.title(session.id);");
    expect(panel).toContain("favorite: favorites.has(session.id)");
    // Filtering to favorites needs to say why the list came back empty.
    expect(panel).toContain("No favorite Dext conversations yet.");
  });

  it("keeps a renamed conversation addressable by the id its agent session uses", async () => {
    const h = createConversationHarness();
    await h.seed([conversation("session-1")]);
    h.controller.activate(h.controller.session("session-1")!);

    await h.preferences.setTitle("session-1", "  Auth refactor  ");
    expect(h.preferences.title("session-1")).toBe("Auth refactor");

    // Clearing the name hands the conversation back to its first message.
    await h.preferences.setTitle("session-1", "   ");
    expect(h.preferences.title("session-1")).toBeUndefined();

    // Renaming writes a label beside the conversation; the id the provider
    // sessions are bound to is never rewritten, so a new turn still runs in
    // the same agent session.
    await h.controller.rename("session-1", "Auth refactor");
    expect(h.preferences.title("session-1")).toBe("Auth refactor");
    expect(h.controller.session("session-1")?.id).toBe("session-1");
    await h.coordinator.execute(h.controller.session("session-1")!, "agent", "prompt");
    expect(h.executeConversation.mock.calls[0]?.[2].agentSessionId).toBe("session-1");
    expect(h.messages).toContainEqual(expect.objectContaining({
      type: "conversations",
      sessions: [expect.objectContaining({ id: "session-1", title: "Auth refactor" })]
    }));
  });

  it("drops a deleted conversation from pins and favorites alike", async () => {
    const store = preferences();
    await store.setPinned("gone", true);
    await store.setFavorite("gone", true);

    await store.forget("gone");

    expect(store.pinned()).toEqual([]);
    expect(store.favorites()).toEqual([]);
  });

  it("drops the selections, titles, pins and favorites of conversations history trimmed away", async () => {
    const store = preferences();
    const selection = { mode: "agent" as const, permission: "workspace-write" as const, profileId: "codex", model: "gpt", reasoningEffort: "", speed: "", serviceTier: "" };
    for (const id of ["a", "b"]) {
      await store.setConversationSelection(id, selection);
      await store.setTitle(id, `Title ${id}`);
      await store.setPinned(id, true);
      await store.setFavorite(id, true);
    }

    await store.pruneConversations(["a"]);

    expect(store.conversationSelection("a")).toEqual(selection);
    expect(store.title("a")).toBe("Title a");
    expect(store.pinned()).toEqual(["a"]);
    expect(store.favorites()).toEqual(["a"]);
    expect(store.conversationSelection("b")).toBeUndefined();
    expect(store.title("b")).toBeUndefined();
  });
});
