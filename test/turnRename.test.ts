import { describe, expect, it, vi } from "vitest";
import { DextHistoryStore } from "../src/historyStore.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";

vi.mock("vscode", () => ({}));

class MemoryState {
  private value: unknown;
  get<T>(_: string, fallback: T): T { return (this.value as T | undefined) ?? fallback; }
  async update(_: string, value: unknown): Promise<void> { this.value = value; }
}

describe("turn renaming across History and Conversation", () => {
  it("updates the persisted turn and cached session without replacing running conversation state", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("original input", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    await history.addSuccess("sibling input", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-2");
    const cachedSession = history.list()[0]!;
    const firstTurn = cachedSession.turns[0]!;
    const siblingTurn = { ...cachedSession.turns[1]! };
    const postedSessionSignatures = new Map([["session-1", "old signature"]]);
    const post = vi.fn();
    // Exercise the public operation with an already-open session, without
    // constructing a webview or starting an agent for this storage test.
    const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
    Object.assign(sidebar, {
      history,
      sessions: new Map([[cachedSession.id, cachedSession]]),
      postedSessionSignatures,
      postWhenReady: post
    });

    await sidebar.renameTurn("session-1", "turn-1", "  Custom name  ");
    expect(cachedSession.turns[0]).toBe(firstTurn);
    expect(firstTurn.title).toBe("Custom name");
    expect(firstTurn.input).toBe("original input");
    expect(cachedSession.turns[1]).toEqual(siblingTurn);
    expect(history.list()[0]?.turns[0]?.title).toBe("Custom name");
    expect(postedSessionSignatures.has("session-1")).toBe(false);
    expect(post).toHaveBeenLastCalledWith({
      type: "turnRenamed", sessionId: "session-1", turnId: "turn-1", title: "Custom name", displayTitle: "Custom name"
    });

    await sidebar.renameTurn("session-1", "turn-1", "");
    expect(firstTurn.title).toBeUndefined();
    expect(history.list()[0]?.turns[0]?.title).toBeUndefined();
    expect(post).toHaveBeenLastCalledWith({
      type: "turnRenamed", sessionId: "session-1", turnId: "turn-1", displayTitle: "original input"
    });
    post.mockClear();
    await expect(sidebar.renameTurn("session-2", "turn-1", "wrong target")).rejects.toThrow("Conversation turn not found");
    expect(post).not.toHaveBeenCalled();
    expect(firstTurn.title).toBeUndefined();
  });
});
