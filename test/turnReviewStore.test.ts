import { describe, expect, it } from "vitest";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";
import { TurnReviewStore } from "../src/turnReviewStore.js";

const review = (sessionId: string, turnId: string, runId: string, createdAt: number) => buildTurnReview({
  sessionId, turnId, runId, mode: "agent", changes: [{ uri: "src/a.ts", kind: "modified" }], createdAt
});

describe("turn review store", () => {
  it("keys reviews by session, turn and run so a retry cannot inherit acceptance", () => {
    const store = new TurnReviewStore();
    store.put({ ...review("s1", "t1", "run-1", 1), acceptance: "accepted" });
    store.put(review("s1", "t1", "run-2", 2));
    expect(store.get("s1", "t1", "run-1")?.acceptance).toBe("accepted");
    expect(store.get("s1", "t1", "run-2")?.acceptance).toBe("pending");
    expect(store.get("s1", "t2", "run-1")).toBeUndefined();
    expect(store.getForRun("s1", "t1", "run-1")?.acceptance).toBe("accepted");
  });

  it("evicts the oldest runs at capacity and clears a conversation without touching others", () => {
    const store = new TurnReviewStore(2);
    store.put(review("s1", "t1", "r1", 1));
    store.put(review("s1", "t2", "r2", 2));
    store.put(review("s2", "t1", "r3", 3));
    expect(store.size).toBe(2);
    expect(store.get("s1", "t1", "r1")).toBeUndefined();
    expect(store.deleteSession("s1")).toBe(1);
    expect(store.get("s2", "t1", "r3")).toBeDefined();
  });

  it("round-trips through a snapshot", () => {
    const store = new TurnReviewStore();
    store.put(review("s1", "t1", "r1", 1));
    const restored = new TurnReviewStore();
    restored.restore(store.snapshot());
    expect(restored.get("s1", "t1", "r1")?.runId).toBe("r1");
  });
});
