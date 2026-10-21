import { describe, expect, it } from "vitest";
import { conversation, createConversationHarness } from "./conversationHarness.js";

describe("turn renaming across History and Conversation", () => {
  it("updates the persisted turn and cached session without replacing running conversation state", async () => {
    const harness = createConversationHarness();
    harness.seed([
      conversation("session-1", [
        { id: "turn-1", createdAt: 1, input: "original input", process: [], output: "", mode: "ask" },
        { id: "turn-2", createdAt: 2, input: "sibling input", process: [], output: "", mode: "ask" }
      ])
    ]);
    const cachedSession = harness.controller.session("session-1");
    if (!cachedSession) throw new Error("The seeded conversation was not hydrated.");
    const firstTurn = cachedSession.turns[0]!;
    const siblingTurn = { ...cachedSession.turns[1]! };
    // Pretend the conversation has already been rendered, so the next activation
    // can take the cached-signature path unless the rename invalidates it.
    harness.controller.markOutputPosted(cachedSession);

    await harness.controller.renameTurn("session-1", "turn-1", "  Custom name  ");
    // An open conversation keeps its own turn objects while a turn is running;
    // renaming only edits the label instead of replacing that state.
    expect(cachedSession.turns[0]).toBe(firstTurn);
    expect(firstTurn.title).toBe("Custom name");
    expect(firstTurn.input).toBe("original input");
    expect(cachedSession.turns[1]).toEqual(siblingTurn);
    expect(harness.history.list()[0]?.turns[0]?.title).toBe("Custom name");
    expect(harness.messages.at(-1)).toEqual({
      type: "turnRenamed", sessionId: "session-1", turnId: "turn-1", title: "Custom name", displayTitle: "Custom name"
    });

    // The Webview caches a rendered conversation by signature. Renaming an
    // already-rendered turn must invalidate it, otherwise the old title stays.
    harness.messages.length = 0;
    harness.controller.activate(cachedSession);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.messages.filter((message) => message.type === "outputSessionRef")).toEqual([]);
    expect(harness.messages.filter((message) => message.type === "outputSession").map((message) => message.session.id))
      .toEqual(["session-1"]);

    await harness.controller.renameTurn("session-1", "turn-1", "");
    expect(firstTurn.title).toBeUndefined();
    expect(harness.history.list()[0]?.turns[0]?.title).toBeUndefined();
    expect(harness.messages.at(-1)).toEqual({
      type: "turnRenamed", sessionId: "session-1", turnId: "turn-1", displayTitle: "original input"
    });

    harness.messages.length = 0;
    await expect(harness.controller.renameTurn("session-2", "turn-1", "wrong target"))
      .rejects.toThrow("Conversation turn not found");
    expect(harness.messages).toEqual([]);
    expect(firstTurn.title).toBeUndefined();
  });
});
