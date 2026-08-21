import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DextConversationPreferences, orderHistorySessions } from "../src/conversationPreferences.js";

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
  it("shows the most recent conversation first without being asked", () => {
    const store = preferences();

    expect(store.sortOrder()).toBe("newest");
    expect(store.favoritesOnly()).toBe(false);
  });

  it("orders conversations by last activity in the requested direction", () => {
    const sessions = [session("a", 1), session("b", 3), session("c", 2)];
    const ordering = { favorites: [], favoritesOnly: false };

    expect(orderHistorySessions(sessions, { ...ordering, order: "newest" }).map((item) => item.id))
      .toEqual(["b", "c", "a"]);
    expect(orderHistorySessions(sessions, { ...ordering, order: "oldest" }).map((item) => item.id))
      .toEqual(["a", "c", "b"]);
  });

  it("ranks a conversation by its latest turn rather than when it started", () => {
    const sessions = [session("old-but-active", 1, 9), session("recent", 5)];

    expect(orderHistorySessions(sessions, { order: "newest", favorites: [], favoritesOnly: false })
      .map((item) => item.id)).toEqual(["old-but-active", "recent"]);
  });

  it("floats favorites above everything else and can hide the rest", () => {
    const sessions = [session("a", 1), session("b", 3), session("c", 2)];

    expect(orderHistorySessions(sessions, { order: "newest", favorites: ["a"], favoritesOnly: false })
      .map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(orderHistorySessions(sessions, { order: "newest", favorites: ["a", "c"], favoritesOnly: true })
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

  it("renders the History panel through the stored ordering and names", async () => {
    const panel = await readFile(resolve("src/historyEditorProvider.ts"), "utf8");

    expect(panel).toContain("const ordering = this.preferences.historyOrdering();");
    expect(panel).toContain("orderHistorySessions(this.history.list(), ordering)");
    expect(panel).toContain("const name = this.preferences.title(session.id);");
    expect(panel).toContain("favorite: favorites.has(session.id)");
    // Filtering to favorites needs to say why the list came back empty.
    expect(panel).toContain("No favorite Dext conversations yet.");
  });

  it("keeps a renamed conversation addressable by the id its agent session uses", async () => {
    const store = preferences();
    const sidebar = await readFile(resolve("src/sidebarProvider.ts"), "utf8");

    await store.setTitle("session-1", "  Auth refactor  ");
    expect(store.title("session-1")).toBe("Auth refactor");

    // Clearing the name hands the conversation back to its first message.
    await store.setTitle("session-1", "   ");
    expect(store.title("session-1")).toBeUndefined();

    // Renaming writes a label beside the conversation; the id the CLI and AIOA
    // sessions are bound to is never rewritten.
    expect(sidebar).toMatch(/async renameConversation\(sessionId: string, title: string\)[\s\S]*?this\.preferences\.setTitle\(sessionId, title\)/);
    expect(sidebar).toContain("this.preferences.title(session.id) ?? conversationTitle(session)");
    expect(sidebar).toMatch(/agentSessionId: sessionId/);
  });

  it("drops a deleted conversation from pins and favorites alike", async () => {
    const store = preferences();
    await store.setPinned("gone", true);
    await store.setFavorite("gone", true);

    await store.forget("gone");

    expect(store.pinned()).toEqual([]);
    expect(store.favorites()).toEqual([]);
  });
});
