import { describe, expect, it } from "vitest";
import { KnowledgeDraftQueue, type KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";
import { ProjectInitializationService, ProjectScanScheduler } from "../src/projectService.js";

const emptyScan = { modules: [], relations: [], unsupported: [], parserVersions: {} };
const draft = (id: string, baseVersion = 1): KnowledgeSuggestion => ({
  id, kind: "create", proposed: { canonicalName: `Obj${id}` }, evidence: [], reason: "ai", source: "ai", baseVersion
});

describe("project initialization", () => {
  it("completes from facts even when the AI proposer is unavailable", async () => {
    const queue = new KnowledgeDraftQueue();
    const service = new ProjectInitializationService({
      scan: async () => ({ ...emptyScan, modules: [{ id: "src/a", name: "a", language: "typescript" as const, paths: ["src/a.ts"], source: "detected" as const }] }),
      propose: async () => { throw new Error("AI offline"); }
    }, queue);
    const state = await service.start().promise;
    expect(state).toMatchObject({ status: "completed", aiAvailable: false, drafts: 0, scannedFiles: 1 });
  });

  it("supports cancel and retry without blocking development", async () => {
    const queue = new KnowledgeDraftQueue();
    let scanStarted = 0;
    const service = new ProjectInitializationService({
      scan: async () => { scanStarted += 1; return emptyScan; },
      propose: async () => [draft("s1")]
    }, queue);
    const task = service.start();
    task.cancel();
    const cancelled = await task.promise;
    expect(cancelled.status).toBe("cancelled");
    const retried = await service.retry().promise;
    expect(retried.status).toBe("completed");
    expect(retried.drafts).toBe(1);
    expect(scanStarted).toBe(2);
  });

  it("reports a failing scan as failed without throwing to the caller", async () => {
    const service = new ProjectInitializationService({ scan: async () => { throw new Error("boom"); } });
    await expect(service.start().promise).resolves.toMatchObject({ status: "failed", error: "boom" });
  });
});

describe("knowledge draft queue", () => {
  it("does not resurface a rejected suggestion for the same base version", () => {
    const queue = new KnowledgeDraftQueue();
    expect(queue.enqueue(draft("s1"))).toBe(true);
    queue.decide("s1", "rejected", 2);
    expect(queue.enqueue(draft("s1"))).toBe(false);
    expect(queue.list()).toEqual([]);
    // A newer base version is a genuinely new proposal.
    expect(queue.enqueue(draft("s1", 2))).toBe(true);
  });

  it("merges and splits drafts", () => {
    const queue = new KnowledgeDraftQueue();
    queue.enqueue(draft("a"));
    queue.enqueue(draft("b"));
    const merged = queue.merge(["a", "b"], { id: "m", proposed: { description: "both" }, reason: "merge" });
    expect(merged?.evidence).toEqual([]);
    expect(queue.list().map((item) => item.id)).toEqual(["m"]);
    const parts = queue.split("m", [{ id: "p1", proposed: { behavior: ["x"] }, reason: "split" }, { id: "p2", proposed: { behavior: ["y"] }, reason: "split" }]);
    expect(parts.map((item) => item.id)).toEqual(["p1", "p2"]);
    expect(queue.list().map((item) => item.id)).toEqual(["p1", "p2"]);
  });
});

describe("background scan scheduler", () => {
  it("coalesces file events inside the debounce window", () => {
    const scheduler = new ProjectScanScheduler({ debounceMs: 100 });
    scheduler.notify("src/a.ts", 0);
    scheduler.notify("src\\b.ts", 10);
    expect(scheduler.drain(50)).toBeUndefined();
    expect(scheduler.drain(200)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scheduler.pendingPaths).toEqual([]);
  });

  it("limits how many scans start inside a window", () => {
    const scheduler = new ProjectScanScheduler({ debounceMs: 0, maxRequestsPerWindow: 1, windowMs: 10_000 });
    scheduler.notify("a", 0);
    expect(scheduler.drain(1)).toEqual(["a"]);
    scheduler.notify("b", 2);
    expect(scheduler.drain(3)).toBeUndefined();
  });

  it("rejects a late result once a newer input version exists", () => {
    const scheduler = new ProjectScanScheduler({ debounceMs: 0 });
    scheduler.notify("a", 0);
    const version = scheduler.begin();
    scheduler.notify("b", 1);
    expect(scheduler.acceptResult(version)).toBe(false);
    expect(scheduler.acceptResult(scheduler.inputVersion)).toBe(true);
  });
});
