import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStore, type ProjectFileHost } from "../src/projectStore.js";
import { ProjectInitializationService } from "../src/projectService.js";
import { buildProjectEvidencePackage, ProjectAiGenerationService, type ProjectAiProvider } from "../src/core/projectAiGeneration.js";
import { projectIntentSchema } from "../src/core/projectIntent.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";
import { ProjectDiagramAdapterRegistry } from "../src/core/projectDiagramRegistry.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, ProjectDiagramAdapter } from "../src/core/projectDiagramAdapter.js";
import { applyKnowledgeSuggestion, type KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";
import { isAcceptedObject, normalizeProjectObject, type ProjectObject } from "../src/core/projectKnowledge.js";
import { TurnReviewStore } from "../src/turnReviewStore.js";
import { TurnReviewController } from "../src/turnReviewController.js";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";

class MemoryHost implements ProjectFileHost {
  readonly files = new Map<string, string>();
  writes = 0;
  async readFile(relativePath: string): Promise<string | undefined> { return this.files.get(relativePath); }
  async writeFile(relativePath: string, content: string): Promise<void> { this.writes += 1; this.files.set(relativePath, content); }
  async deleteFile(relativePath: string): Promise<void> { this.files.delete(relativePath); }
  async listDirectory(relativeDir: string): Promise<string[]> {
    const prefix = relativeDir ? `${relativeDir.replace(/\/$/, "")}/` : "";
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split("/")[0]!);
  }
}

const intent = () => projectIntentSchema.parse({
  schemaVersion: 1,
  brief: { name: "Example", summary: "A task application", evidence: [{ path: "README.md", line: 1 }] },
  updatedAt: 1
});

const diagram = (id = "architecture"): ProjectDiagram => ({
  schemaVersion: 1, id, title: "Architecture", kind: "architecture", version: 0, updatedAt: 1,
  nodes: [{ id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/app.ts", line: 1 }] }],
  relations: []
});

function providerFor(config: { initialize?: unknown; diagram?: unknown }): ProjectAiProvider {
  return {
    id: "mock",
    generate: async (request) => {
      const value = request.promptVersion === "project-knowledge-4" ? config.initialize : config.diagram;
      return { text: JSON.stringify(value) };
    }
  };
}

const evidence = (requirement?: string) => buildProjectEvidencePackage({
  projectName: "Example",
  files: [{ path: "README.md", content: "# Example" }, { path: "src/app.ts", content: "export function start() {}" }],
  ...(requirement ? { requirement } : {})
});

function persistence(store: ProjectStore) {
  return async (output: { intent?: ReturnType<typeof intent>; diagrams?: readonly ProjectDiagram[] }): Promise<void> => {
    if (output.intent) await store.writeIntent(output.intent);
    for (const item of output.diagrams ?? []) await store.writeDiagram(item);
    const definition = await store.readDefinition();
    const saved = await store.writeDefinition({ ...definition, knowledge: { ...definition.knowledge, enabled: true, ...(output.intent ? { initialized: true } : {}) } }, definition.version);
    if (saved.status === "conflict") throw new Error("conflict");
  };
}

describe("project integration without any static scan", () => {
  it("initializes from bounded evidence, saves intent and diagram, and reports success only after persistence", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    const service = new ProjectInitializationService({
      prepareEvidence: async () => evidence(),
      generate: async (packageValue) => new ProjectAiGenerationService(providerFor({ initialize: { intent: intent(), diagrams: [diagram()] } })).generate(packageValue),
      persist: async (output, signal) => {
        if (signal.aborted) throw new Error("cancelled");
        await persistence(store)(output);
      }
    });
    const state = await service.start().promise;
    expect(state.status).toBe("completed");
    expect(state.intentGenerated).toBe(true);
    expect(state.diagramsGenerated).toBe(1);
    expect(await store.readIntent()).toBeDefined();
    expect((await store.readDiagrams()).map((item) => item.id)).toEqual(["architecture"]);
    expect((await store.readDefinition()).knowledge.initialized).toBe(true);
    expect(host.files.has(".dext/project-intent.json")).toBe(true);
    expect(host.files.has(".dext/diagrams/architecture.json")).toBe(true);
  });

  it("recovers an uninitialized knowledge model while keeping saved diagrams viewable", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    await store.writeDiagram(diagram("saved"));
    const hydration = await store.readInitialization();
    expect(hydration).toMatchObject({ hasIntent: false, diagramCount: 1, markedInitialized: false });
    const service = new ProjectInitializationService({ prepareEvidence: async () => evidence(), generate: async () => ({}), persist: async () => undefined });
    service.hydrate(hydration);
    expect(service.snapshot.status).toBe("uninitialized");
    expect(service.snapshot.diagramsGenerated).toBe(1);
  });

  it("adds one on-demand diagram without overwriting knowledge or other diagrams", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    await store.writeIntent(intent() as never);
    await store.writeDiagram(diagram("first"));
    const service = new ProjectAiGenerationService(providerFor({ diagram: { diagram: { ...diagram("second"), title: "Second" } } }));
    const result = await service.generateDiagram(evidence("Add a second view"), { requirement: "Add a second view", kind: "architecture" });
    await store.writeDiagram(result.diagram);
    expect((await store.readDiagrams()).map((item) => item.id).sort()).toEqual(["first", "second"]);
    expect((await store.readIntent())?.brief.summary).toBe("A task application");
  });

  it("renders and exports through the single engine, then falls back to the same diagram's last good version", async () => {
    class Renderer implements ProjectDiagramAdapter {
      readonly id = "archify";
      readonly version = "2.17.0-dev.1";
      readonly capabilities: readonly DiagramAdapterCapability[] = [{ kind: "architecture", formats: ["html"], features: ["interactive", "validation"] }];
      fail = false;
      supports(): boolean { return true; }
      async transform(diagramValue: ProjectDiagram): Promise<DiagramAdapterDocument> { return { adapterId: this.id, adapterVersion: this.version, diagramId: diagramValue.id, kind: diagramValue.kind, payload: {} }; }
      async preview(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> { return this.artifact(document.diagramId); }
      async render(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> {
        if (this.fail) throw new Error("renderer failed");
        return this.artifact(document.diagramId);
      }
      private artifact(diagramId: string): DiagramAdapterArtifact { return { format: "html", mimeType: "text/html", content: "<html>viewer</html>", adapterId: this.id, adapterVersion: this.version, diagramId }; }
      async export(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> { return this.render(document); }
      async validate() { return { adapterId: this.id, adapterVersion: this.version, status: "passed" as const, checkedAt: 1, issues: [] }; }
      dispose(): void {}
    }
    const renderer = new Renderer();
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(renderer);
    const first = await registry.render(diagram("view"));
    expect(first.status).toBe("rendered");
    expect(first.artifact?.format).toBe("html");
    expect(registry.latest("view")?.artifact.content).toContain("viewer");
    renderer.fail = true;
    const failed = await registry.render({ ...diagram("view"), version: 1 });
    expect(failed.status).toBe("failed");
    expect(failed.usedLastGood).toBe(true);
    expect(failed.displayedVersion).toBe(0);
    expect(failed.artifact?.content).toBe(first.artifact?.content);
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
    expect(controller.find("s1", "t1", "run-2")).toBeUndefined();
    expect(controller.submitFeedback("s1", "t1", "run-1", "accepted").status).toBe("accepted");
    expect(knowledge.size).toBe(0);
  });

  it("migrates legacy objects and reads the React + Tauri fixture without a scan", async () => {
    const legacy = normalizeProjectObject({
      id: "TaskQuery", canonicalName: "TaskQuery", kind: "feature", source: "code", status: "stale",
      evidence: [], version: 1
    });
    expect(legacy).toMatchObject({ confirmation: "accepted", validity: "stale" });
    expect(isAcceptedObject(legacy)).toBe(true);

    const fixture = JSON.parse(await readFile(join("test", "fixtures", "projectKnowledge.json"), "utf8")) as { objects: unknown[] };
    const objects = fixture.objects.map((object) => normalizeProjectObject(object));
    expect(new Set(objects.map((object) => object.id))).toEqual(new Set(["ui.dashboard", "task.query", "legacy.report"]));
    expect(objects.find((object) => object.id === "legacy.report")).toMatchObject({ confirmation: "accepted", validity: "stale" });
  });

  it("applies an accepted knowledge suggestion into a long-term object", () => {
    const suggestion: KnowledgeSuggestion = {
      id: "s1", kind: "create", proposed: { canonicalName: "TaskQuery", description: "Runs a query." },
      evidence: [{ path: "src/task.ts", symbol: "taskQuery" }], reason: "Detected an entry point.", source: "ai", baseVersion: 0
    };
    const object = applyKnowledgeSuggestion(undefined, suggestion, "accepted", 5)!;
    expect(object).toMatchObject({ canonicalName: "TaskQuery", source: "ai", confirmation: "accepted", validity: "needs_verification", ownership: "candidate" });
  });
});
