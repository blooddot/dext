import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStore, type ProjectFileHost } from "../src/projectStore.js";
import { ProjectInitializationService } from "../src/projectService.js";
import { runArchitectureScan } from "../src/core/projectArchitectureWorker.js";
import { KnowledgeDraftQueue, applyKnowledgeSuggestion, type KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";
import { isAcceptedObject, normalizeProjectObject, type ProjectObject } from "../src/core/projectKnowledge.js";
import { TurnReviewStore } from "../src/turnReviewStore.js";
import { TurnReviewController } from "../src/turnReviewController.js";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";

class MemoryHost implements ProjectFileHost {
  readonly files = new Map<string, string>();
  async readFile(relativePath: string): Promise<string | undefined> { return this.files.get(relativePath); }
  async writeFile(relativePath: string, content: string): Promise<void> { this.files.set(relativePath, content); }
  async deleteFile(relativePath: string): Promise<void> { this.files.delete(relativePath); }
  async listDirectory(relativeDir: string): Promise<string[]> {
    const prefix = relativeDir ? `${relativeDir.replace(/\/$/, "")}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!);
  }
}

describe("project integration", () => {
  it("initializes, stores long-term knowledge, and reviews only long-term objects", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    const queue = new KnowledgeDraftQueue();
    const suggestion: KnowledgeSuggestion = {
      id: "s1", kind: "create", proposed: { canonicalName: "TaskQuery", description: "Runs a query." },
      evidence: [{ path: "src/task.ts", symbol: "taskQuery" }], reason: "Detected an entry point.", source: "ai", baseVersion: 0
    };
    const service = new ProjectInitializationService({
      scan: async () => runArchitectureScan([
        { path: "src/app.ts", content: 'import { taskQuery } from "./task.js";' },
        { path: "src/task.ts", content: "export function taskQuery() {}" }
      ]).result,
      propose: async () => [suggestion]
    }, queue);
    const state = await service.start().promise;
    expect(state.status).toBe("completed");
    expect(state.scannedFiles).toBe(2);
    expect(queue.list()).toHaveLength(1);

    const decision = queue.decide("s1", "accepted");
    expect(decision?.decision).toBe("accepted");
    const object = applyKnowledgeSuggestion(undefined, suggestion, "accepted", 5)!;
    await store.writeObject(object);
    const persisted = await store.readObjects();
    expect(persisted.map((item) => item.canonicalName)).toEqual(["TaskQuery"]);
    // Long-term knowledge uses the three independent dimensions, not a single run status.
    expect(persisted[0]).toMatchObject({ source: "ai", confirmation: "accepted", validity: "needs_verification", ownership: "candidate" });
  });

  it("scans Python, TypeScript and Rust across one project", () => {
    const outcome = runArchitectureScan([
      { path: "src/app.ts", content: 'import { helper } from "./helper.js";' },
      { path: "src/helper.ts", content: "export function helper() {}" },
      { path: "svc/main.py", content: "from .mod import value" },
      { path: "svc/mod.py", content: "value = 1" },
      { path: "native/src/lib.rs", content: "use crate::engine;" },
      { path: "native/src/engine.rs", content: "pub fn engine() {}" }
    ]);
    const languages = new Set(outcome.result.modules.map((module) => module.language));
    expect([...languages].sort()).toEqual(["python", "rust", "typescript"]);
    expect(outcome.result.relations.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps conversation Review separate from long-term knowledge", () => {
    const reviews = new TurnReviewStore();
    const knowledge = new Map<string, ProjectObject>();
    const controller = new TurnReviewController(reviews, {
      load: async (objectId) => knowledge.get(objectId),
      save: async (object) => { knowledge.set(object.id, object); },
      remove: async (objectId) => { knowledge.delete(objectId); },
      navigate: () => {}
    });
    const review = buildTurnReview({
      runId: "run-1", sessionId: "s1", turnId: "t1", mode: "agent",
      changes: [{ uri: "src/a.ts", kind: "modified", moduleId: "src/a" }]
    });
    reviews.put(review);
    expect(controller.acceptanceCard("s1", "t1", "run-1")?.changes).toEqual(["modified src/a.ts"]);
    expect(knowledge.size).toBe(0);
    // A different run of the same turn never sees this review.
    expect(controller.find("s1", "t1", "run-2")).toBeUndefined();
    expect(controller.submitFeedback("s1", "t1", "run-1", "accepted").status).toBe("accepted");
    expect(knowledge.size).toBe(0);
  });

  it("migrates a legacy status into the three independent dimensions", () => {
    const legacy = normalizeProjectObject({
      id: "TaskQuery", canonicalName: "TaskQuery", kind: "feature", source: "code", status: "stale",
      evidence: [], version: 1
    });
    expect(legacy).toMatchObject({ confirmation: "accepted", validity: "stale" });
    expect(isAcceptedObject(legacy)).toBe(true);
  });

  it("reads the React + Tauri fixture with all three languages and an explicit IPC relation", async () => {
    const fixture = JSON.parse(await readFile(join("test", "fixtures", "projectKnowledge.json"), "utf8")) as {
      objects: unknown[];
      architecture: { modules: Array<{ language: string }>; relations: Array<{ source: string; reason?: string }> };
    };
    const objects = fixture.objects.map((object) => normalizeProjectObject(object));
    expect(new Set(objects.map((object) => object.id))).toEqual(new Set(["ui.dashboard", "task.query", "legacy.report"]));
    // Names survive a rename because references use the stable id.
    expect(objects.find((object) => object.id === "ui.dashboard")).toMatchObject({
      canonicalName: "DashboardView", displayName: "仪表盘视图", confirmation: "accepted"
    });
    // The legacy status migrates instead of being dropped.
    expect(objects.find((object) => object.id === "legacy.report")).toMatchObject({ confirmation: "accepted", validity: "stale" });

    const scan = runArchitectureScan([
      { path: "src/ui/Dashboard.tsx", content: 'import { invoke } from "@tauri-apps/api/core";' },
      { path: "src-tauri/src/tasks.rs", content: "pub fn list_tasks() {}" },
      { path: "tools/report.py", content: "from .rows import Row" },
      { path: "tools/rows.py", content: "class Row: ..." }
    ]).result;
    expect(new Set(scan.modules.map((module) => module.language))).toEqual(new Set(["typescript", "rust", "python"]));
    // A manual Tauri IPC contract is declared, not detected, and stays distinguishable in the view.
    const manual = fixture.architecture.relations.filter((relation) => relation.source === "declared");
    expect(manual.map((relation) => relation.reason)).toEqual(["Tauri IPC contract"]);
    expect(fixture.architecture.relations.some((relation) => relation.source === "detected")).toBe(true);
  });
});
