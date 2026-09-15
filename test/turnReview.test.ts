import { describe, expect, it } from "vitest";
import { projectObjectSchema, type ProjectObject } from "../src/core/projectKnowledge.js";
import { buildTurnReview, reviewCanBeAccepted } from "../src/core/turnReviewBuilder.js";
import { reviewRequiresUserAcceptance } from "../src/core/turnReview.js";
import type { KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";
import { TurnReviewController, type ReviewKnowledgeSink } from "../src/turnReviewController.js";
import { TurnReviewStore } from "../src/turnReviewStore.js";

const object = (id: string, extra: Partial<ProjectObject> = {}): ProjectObject => projectObjectSchema.parse({
  id, canonicalName: id, kind: "module", source: "user", confirmation: "accepted", version: 1, ...extra
});

class MemorySink implements ReviewKnowledgeSink {
  readonly saved = new Map<string, ProjectObject>();
  readonly removed: string[] = [];
  readonly navigated: string[] = [];
  async load(objectId: string): Promise<ProjectObject | undefined> { return this.saved.get(objectId); }
  async save(value: ProjectObject): Promise<void> { this.saved.set(value.id, value); }
  async remove(objectId: string): Promise<void> { this.removed.push(objectId); }
  async navigate(objectId: string): Promise<void> { this.navigated.push(objectId); }
}

describe("turn review", () => {
  it("keeps missing hooks neutral and rejects changed evidence", () => {
    const review = buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "agent", factValidation: [{ objectId: "o", evidence: { path: "a.ts" }, kind: "changed" }] });
    expect(review.hookSummaries).toEqual([]);
    expect(reviewCanBeAccepted(review)).toBe(false);
  });

  it("does not require acceptance for pure ask turns", () => {
    const review = buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "ask" });
    expect(review.acceptance).toBe("not_required");
    expect(reviewRequiresUserAcceptance(review)).toBe(false);
  });
});

describe("turn review controller", () => {
  const agentReview = (runId: string, extra: Record<string, unknown> = {}) => buildTurnReview({
    runId, sessionId: "s1", turnId: "t1", mode: "agent",
    changes: [{ uri: "src/a.ts", kind: "modified" }],
    projectVersion: 1,
    ...extra
  });

  it("cannot apply feedback to the wrong session, turn, or run", () => {
    const store = new TurnReviewStore();
    store.put(agentReview("run-1"));
    const controller = new TurnReviewController(store);
    expect(controller.submitFeedback("s1", "t1", "run-2", "accepted").status).toBe("not_found");
    expect(controller.submitFeedback("s1", "t2", "run-1", "accepted").status).toBe("not_found");
    expect(controller.submitFeedback("s2", "t1", "run-1", "accepted").status).toBe("not_found");
    expect(controller.submitFeedback("s1", "t1", "run-1", "accepted").status).toBe("accepted");
  });

  it("refuses a review bound to an older project version", () => {
    const store = new TurnReviewStore();
    store.put(agentReview("run-1", { projectVersion: 1 }));
    const controller = new TurnReviewController(store);
    const result = controller.submitFeedback("s1", "t1", "run-1", "accepted", { currentProjectVersion: 2 });
    expect(result.status).toBe("stale");
    expect(store.get("s1", "t1", "run-1")?.acceptance).toBe("pending");
  });

  it("suppresses an acceptance card for ask turns and for turns with nothing to accept", () => {
    const store = new TurnReviewStore();
    store.put(buildTurnReview({ runId: "ask", sessionId: "s1", turnId: "t1", mode: "ask" }));
    store.put(buildTurnReview({ runId: "empty", sessionId: "s1", turnId: "t1", mode: "agent", changes: [] }));
    const controller = new TurnReviewController(store);
    expect(controller.acceptanceCard("s1", "t1", "ask")).toBeUndefined();
    expect(controller.acceptanceCard("s1", "t1", "empty")).toBeUndefined();
    expect(controller.acceptanceCard("s1", "t1", "run-1")).toBeUndefined();
  });

  it("offers diff jumps and blocks acceptance when evidence changed", () => {
    const store = new TurnReviewStore();
    store.put(agentReview("run-1"));
    store.put(agentReview("run-2", { factValidation: [{ objectId: "o", evidence: { path: "a.ts" }, kind: "changed" }] }));
    const controller = new TurnReviewController(store);
    expect(controller.diffTargets("s1", "t1", "run-1")).toEqual(["src/a.ts"]);
    expect(controller.acceptanceCard("s1", "t1", "run-1")?.canAccept).toBe(true);
    expect(controller.acceptanceCard("s1", "t1", "run-2")?.canAccept).toBe(false);
  });

  it("adopts knowledge suggestions independently from accepting the code review", async () => {
    const store = new TurnReviewStore();
    store.put(agentReview("run-1"));
    const sink = new MemorySink();
    sink.saved.set("TaskQuery", object("TaskQuery", { version: 1 }));
    const controller = new TurnReviewController(store, sink);
    const suggestion: KnowledgeSuggestion = {
      id: "k1", objectId: "TaskQuery", kind: "update", proposed: { description: "bounded query" },
      evidence: [{ path: "src/a.ts" }], reason: "changed", source: "ai", baseVersion: 1
    };
    // Accepting the code review does not adopt any knowledge suggestion.
    controller.submitFeedback("s1", "t1", "run-1", "accepted");
    expect(sink.saved.get("TaskQuery")?.description).toBe("");
    const adopted = await controller.adoptKnowledgeSuggestion(suggestion, "accepted", 0);
    expect(adopted).toMatchObject({ status: "adopted", navigated: true });
    expect(sink.saved.get("TaskQuery")?.description).toBe("bounded query");
    expect(sink.saved.get("TaskQuery")?.validity).toBe("needs_verification");
    expect(sink.navigated).toEqual(["TaskQuery"]);
    // Accepting the code review still stands unchanged.
    expect(store.get("s1", "t1", "run-1")?.acceptance).toBe("accepted");
  });

  it("refuses a knowledge suggestion written against an older object version", async () => {
    const sink = new MemorySink();
    sink.saved.set("TaskQuery", object("TaskQuery", { version: 4 }));
    const controller = new TurnReviewController(new TurnReviewStore(), sink);
    const stale: KnowledgeSuggestion = {
      id: "k1", objectId: "TaskQuery", kind: "update", proposed: { description: "old" },
      evidence: [], reason: "old", source: "ai", baseVersion: 1
    };
    await expect(controller.adoptKnowledgeSuggestion(stale, "accepted", 0)).resolves.toMatchObject({ status: "stale" });
    expect(sink.saved.get("TaskQuery")?.description).toBe("");
  });
});
