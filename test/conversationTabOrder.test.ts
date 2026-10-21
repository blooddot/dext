import { describe, expect, it } from "vitest";
import { conversation, createConversationHarness } from "./conversationHarness.js";

function harness() {
  const h = createConversationHarness({
    pinned: ["p1", "p2"],
    layout: { openConversationIds: ["p1", "p2", "a", "b", "c"], activeConversationId: "b" }
  });
  h.seed([conversation("p1"), conversation("p2"), conversation("a"), conversation("b"), conversation("c")]);
  h.controller.activate(h.controller.session("b")!);
  return h;
}

describe("conversation tab order", () => {
  it("moves tabs left and right and persists the order without changing the active conversation", async () => {
    const h = harness();
    await h.controller.move("c", "a");
    expect(h.controller.ordered()).toEqual(["p1", "p2", "c", "a", "b"]);
    await h.controller.move("c", null);
    expect(h.controller.ordered()).toEqual(["p1", "p2", "a", "b", "c"]);
    await h.controller.move("b", "a");
    expect(h.controller.ordered()).toEqual(["p1", "p2", "b", "a", "c"]);
    expect(h.controller.active().id).toBe("b");
    await h.controller.flushScheduledLayout();
    expect(h.preferences.conversationLayout()).toEqual({
      openConversationIds: ["p1", "p2", "b", "a", "c"], activeConversationId: "b"
    });
  });

  it("restores reordered pinned tabs ahead of ordinary tabs", async () => {
    const h = harness();
    await h.controller.move("p2", "p1");
    await h.controller.flushScheduledLayout();
    expect(h.controller.ordered()).toEqual(["p2", "p1", "a", "b", "c"]);
    expect(h.preferences.pinned()).toEqual(["p1", "p2"]);
    await h.controller.move("p2", null);
    expect(h.controller.ordered()).toEqual(["p1", "p2", "a", "b", "c"]);
  });

  it("ignores stale or cross-group targets without losing newly opened tabs", async () => {
    const h = harness();
    for (const [id, before] of [["closed", "a"], ["a", "closed"], ["a", "p1"], ["p1", "a"], ["a", "a"]]) {
      await h.controller.move(id!, before!);
    }
    expect(h.controller.ordered()).toEqual(["p1", "p2", "a", "b", "c"]);
    const created = await h.controller.start();
    await h.controller.move("c", "a");
    expect(h.controller.ordered()).toEqual(["p1", "p2", "c", "a", "b", created.id]);
  });
});
