import { describe, expect, it, vi } from "vitest";
import type { ProjectDiagram } from "../src/features/project/contracts/projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterDocument, ProjectDiagramAdapter } from "../src/features/project/contracts/projectDiagramAdapter.js";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import { ProjectDiagramAdapterRegistry } from "../src/features/project/host/diagrams/projectDiagramRegistry.js";
import { attachProjectStructure, buildProjectEvidencePackage, type IndexedProjectEvidence } from "../src/features/project/host/generation/projectAiGeneration.js";
import type { ProjectInitializationCheckpointStore, ProjectModelCheckpoint } from "../src/features/project/host/generation/projectModelCheckpoint.js";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";

vi.mock("vscode", () => ({ Uri: {}, workspace: {} }));

describe("Project topic host", () => {
  it("reconciles generated index identities before saving and leaves saved diagrams untouched", async () => {
    const { createProjectPanelDataSource } = await import('../src/features/project/host/projectPanelDataSource.js');
    const files = [{ path: 'src/code.ts', content: 'export function execute() {}' }];
    const index = await buildStructureIndex(files);
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files }), index.summary);
    let intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: 'App' }, contexts: [
      { id: 'stable-code', canonicalName: 'Code', purpose: 'Old purpose', detail: 'outline', sourceFiles: ['src/code.ts'], entryPoints: ['src/code.ts'] }
    ] });
    const diagram: ProjectDiagram = { schemaVersion: 1, id: 'saved', title: 'Code', kind: 'architecture', version: 1, updatedAt: 1, nodes: [], relations: [],
      metadata: { topicId: 'stable-code', topicAnalysis: 1, topicSummary: 'Old explanation', topicBasis: buildProjectTopics(intent)[0]!.basis! } };
    const snapshot = JSON.stringify(diagram), writeDiagram = vi.fn();
    const source = createProjectPanelDataSource({ name: 'App', root: 'C:/ws', rootUri: {} as never, readEvidence: async () => evidence, readStructureIndex: async () => evidence,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent,
        writeIntent: async value => { intent = value; }, readDiagrams: async () => [diagram], writeDiagram },
      projectAiProvider: { id: 'fixture', generate: async request => {
        if (request.prompt.includes('Candidate file facts:')) return { text: JSON.stringify({ contexts: [{ canonicalName: 'Execution', purpose: 'Execute code', sourceFiles: ['src/code.ts'], entryPoints: ['src/code.ts'] }] }) };
        const ids = [...new Set(request.prompt.match(/responsibility:[a-f0-9]+/g))];
        return { text: JSON.stringify({ brief: { name: 'App', summary: 'Execute code', evidence: [{ path: 'src/code.ts', line: 1 }] },
          capabilities: [{ canonicalName: 'Execution', description: 'Execute workflows', contextIds: ids }] }) };
      } }
    });
    await source.initialize?.();
    expect(intent.contexts[0]!.id).toBe('stable-code');
    expect(intent.capabilities[0]!.contextIds).toEqual(['stable-code']);
    expect((await source.load()).knowledge?.topics?.[0]).toMatchObject({ analysisState: 'stale', diagram });
    expect(writeDiagram).not.toHaveBeenCalled();
    expect(JSON.stringify(diagram)).toBe(snapshot);
  });

  it("builds only an index, analyzes on explicit request, replaces one result and preserves it after failure", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    let intent: ReturnType<typeof projectIntentSchema.parse> | undefined;
    const saved: ProjectDiagram[] = [{ schemaVersion: 1, id: "unrelated", title: "Unrelated", kind: "architecture", nodes: [], relations: [], version: 0, updatedAt: 1 }];
    const writeIntent = vi.fn(async (value: NonNullable<typeof intent>) => { intent = value; });
    const writeDiagram = vi.fn(async (diagram: ProjectDiagram) => { const position = saved.findIndex(item => item.id === diagram.id); if (position < 0) saved.push(diagram); else saved[position] = diagram; });
    const readEvidence = vi.fn(async (request: { requirement?: string }) => buildProjectEvidencePackage({ ...request, files: [{ path: "src/code.ts", content: "export function execute() {}" }], knowledge: [{ id: "code", kind: "context", name: "Code" }] }));
    const index = await buildStructureIndex([{ path: "src/code.ts", content: "export function execute() {}" }]);
    const readStructureIndex = vi.fn(async () => attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: "src/code.ts", content: "export function execute() {}" }], knowledge: [{ id: "code", kind: "context", name: "Code" }] }), index.summary));
    let fail = false;
    const control: { pause?: Promise<void> } = {};
    let markStarted: (() => void) | undefined;
    const source = createProjectPanelDataSource({ name: "Example", root: "C:/ws", rootUri: {} as never, readEvidence, readStructureIndex,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent, writeIntent, readDiagrams: async () => saved, writeDiagram },
      projectAiProvider: { id: "fixture", generate: async request => {
        if (fail) throw new Error("Fixture failure");
        if (control.pause) { markStarted?.(); await control.pause; }
        const evidence = [{ path: "src/code.ts", line: 1 }];
        if (request.prompt.includes("Candidate file facts:")) return { text: JSON.stringify({ contexts: [{ canonicalName: "Execution", purpose: "Runs code", sourceFiles: ["src/code.ts"], entryPoints: ["src/code.ts"], uncertainties: [] }] }) };
        if (request.prompt.includes("Optionally describe C4")) {
          const ids = [...new Set(request.prompt.match(/responsibility:[a-f0-9]+/g) ?? [])];
          return { text: JSON.stringify({ brief: { name: "Example", summary: "Runs code", evidence }, capabilities: [{ canonicalName: "Execution", description: "Runs code", contextIds: ids }] }) };
        }
        return { text: JSON.stringify({ diagram: { schemaVersion: 1, id: "code-view", title: "Code", kind: "architecture", nodes: [{ id: "execute", label: "Execute", description: "Runs the source.", role: "component", semanticIds: ["code"], evidence }], relations: [], metadata: { topicSummary: "Executes code and returns its output." } } }) };
      } }
    });
    await source.load(); expect(readEvidence).not.toHaveBeenCalled(); expect(readStructureIndex).not.toHaveBeenCalled();
    await source.initialize?.();
    expect(readStructureIndex).toHaveBeenCalledTimes(1);
    expect(readEvidence).not.toHaveBeenCalled();
    expect(writeDiagram).not.toHaveBeenCalled();
    expect((await source.load()).knowledge?.topics?.[0]).toMatchObject({ analysisState: "outline" });
    const topicId = (await source.load()).knowledge?.topics?.[0]?.id;
    await source.generateTopicDiagram?.(topicId!);
    expect(readEvidence).toHaveBeenCalledTimes(1);
    expect(readEvidence.mock.calls[0]![0]).toMatchObject({ preferredPaths: ["src/code.ts"] });
    expect(readStructureIndex).toHaveBeenCalledTimes(1);
    expect(writeIntent).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(2);
    expect((await source.load()).knowledge?.topics?.[0]).toMatchObject({ analysisState: "ready", description: "Executes code and returns its output." });
    await source.generateTopicDiagram?.(topicId!);
    expect(saved).toHaveLength(2); expect(saved[1]!.version).toBe(1);
    const previous = JSON.stringify(saved);
    fail = true; await source.generateTopicDiagram?.(topicId!);
    expect(JSON.stringify(saved)).toBe(previous);
    expect(writeIntent).toHaveBeenCalledTimes(1);
    fail = false;
    let resume!: () => void;
    control.pause = new Promise<void>(resolve => { resume = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const cancelled = source.generateTopicDiagram?.(topicId!);
    await started;
    source.cancelDiagramWork?.(); resume(); await cancelled;
    expect(JSON.stringify(saved)).toBe(previous);
  });

  it("renders exact derived snapshots, rejects old ones and cancels superseded requests without writing history", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, flows: [{ id: "run", canonicalName: "Run", steps: [{ id: "step", label: "Step" }] }] });
    const writes = vi.fn();
    const registry = new ProjectDiagramAdapterRegistry({ load: async () => undefined, save: writes });
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    let hold = false;
    const artifact = (document: DiagramAdapterDocument): DiagramAdapterArtifact => ({ format: "html", mimeType: "text/html", content: "<html>fixture</html>", adapterId: "fixture", adapterVersion: "1", diagramId: document.diagramId });
    const adapter: ProjectDiagramAdapter = { id: "fixture", version: "1", capabilities: [], supports: () => true,
      transform: async (diagram) => ({ adapterId: "fixture", adapterVersion: "1", diagramId: diagram.id, kind: diagram.kind, payload: { mapping: { ids: { step: "n-1" }, reverseIds: { "n-1": "step" } } } }),
      render: async (document) => { if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; entered?.(); }); } return artifact(document); },
      preview: async (document) => artifact(document), export: async (document) => artifact(document),
      validate: async () => ({ adapterId: "fixture", adapterVersion: "1", status: "passed", checkedAt: 1, issues: [] }), dispose: () => {}
    };
    registry.register(adapter);
    const source = createProjectPanelDataSource({ name: "Example", root: "C:/ws", rootUri: {} as never, diagramRegistry: registry, readEvidence: async () => buildProjectEvidencePackage({ files: [] }),
      readStructureIndex: async () => buildProjectEvidencePackage({ files: [] }) as IndexedProjectEvidence,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent } });
    const messages: { type: string; [key: string]: unknown }[] = [];
    source.subscribe?.(message => messages.push(message));
    const request = { diagramId: "topic-view:run", updatedAt: 1, requestId: "first" };
    await source.renderReaderDiagram?.(request);
    expect(messages.at(-1)).toMatchObject({ type: "projectReaderRendered", ...request, html: "<html>fixture</html>", mapping: { reverseIds: { "n-1": "step" } } });
    await source.renderReaderDiagram?.({ ...request, updatedAt: 0 });
    expect(messages.at(-1)).toMatchObject({ error: expect.stringContaining("changed") });
    messages.length = 0;
    hold = true;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const old = source.renderReaderDiagram?.({ ...request, requestId: "old" });
    await started;
    await source.renderReaderDiagram?.({ ...request, requestId: "new" });
    release!(); await old;
    expect(messages.filter(message => message.type === "projectReaderRendered").map(message => message.requestId)).toEqual(["new"]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("publishes the complete generated view with its topic link, without requiring Archify rendering", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [{ id: "code", canonicalName: "Code", evidence: [{ path: "src/code.ts", line: 1 }] }],
      structure: { hash: "structure-hash", files: 1, parsed: 1, modules: 1, failed: 2, unsupported: 3, unresolved: 0, issues: [] } });
    let saved: ProjectDiagram[] = [];
    const written: { structure?: unknown; structureIndex?: unknown; trigger?: string }[] = [];
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent,
        readDiagrams: async () => saved, writeDiagram: async (diagram) => { saved = [diagram]; },
        writeEvidenceSummary: async (summary) => { written.push(summary); } },
      readEvidence: async (request) => buildProjectEvidencePackage({ ...request, files: [{ path: "src/code.ts", content: "export function execute() {}" }], knowledge: [{ id: "code", kind: "context", name: "Code" }] }),
      readStructureIndex: async () => buildProjectEvidencePackage({ files: [] }) as IndexedProjectEvidence,
      projectAiProvider: { id: "fixture", generate: async (request) => {
        // A CLI may stream tool results and answer chunks; neither belongs on the status line.
        request.onEvent?.({ phase: "tool", title: "read", text: "<path>src/code.ts</path><content>export function execute() {}</content>" });
        request.onEvent?.({ phase: "message", text: '{"diagram":' });
        request.onEvent?.({ phase: "status", title: "Validating AI output", text: "Checking sources." });
        const diagram = {
          schemaVersion: 1, id: "code-view", title: "Code", kind: "architecture", version: 0, updatedAt: 1,
          metadata: { topicSummary: "Executes source code." },
          nodes: [{ id: "execute", description: "Runs the supplied source code.", label: "Execute", role: "component", semanticIds: ["code"], evidence: [{ path: "src/code.ts", line: 1 }] }], relations: []
        };
        return { text: JSON.stringify({ diagram }) };
      } }
    });
    const messages: { type: string; [key: string]: unknown }[] = [];
    source.subscribe?.((message) => messages.push(message));
    await source.generateTopicDiagram?.("code");
    expect(saved, JSON.stringify(messages.filter((message) => message.type === "projectDiagramGenerateFailed"))).toHaveLength(1);
    expect(saved[0]!.metadata?.topicId).toBe("code");
    const progress = messages.filter((message) => message.type === "projectDiagramProgress").map((message) => String(message.message));
    expect(progress).toContain("Validating AI output: Checking sources.");
    expect(progress.some((line) => line.includes("export function execute") || line.includes('"diagram"'))).toBe(false);
    // A bounded topic read records the persisted index without claiming it was attached to the prompt.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ trigger: "diagram", structureIndex: { hash: "structure-hash", files: 1, parsed: 1, modules: 1, failed: 2, unsupported: 3 } });
    expect(written[0]!.structure).toBeUndefined();
    expect(messages.find((message) => message.type === "projectDiagramGenerated")).toMatchObject({ document: saved[0], topics: [{ id: "code", diagrams: [{ id: "code-view" }] }] });
    expect(messages.some((message) => message.type === "projectDiagramRenderFailed")).toBe(false);
  });

  it("checks only on request, opens declared evidence and scopes diagram reads by saved topic ID", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [{ id: "code", canonicalName: "Code", entryPoints: ["src/code.ts"], sourceFiles: ["src/code.ts", "src/ui/feature.ts"], evidence: [{ path: "src/code.ts", line: 3, contentHash: "before" }] }] });
    const snapshot = vi.fn(async () => ({ contentHash: "after" }));
    const open = vi.fn(async () => {});
    const readEvidence = vi.fn(async (request: { requirement?: string }) => buildProjectEvidencePackage({ files: [], ...request }));
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent },
      readEvidence, readStructureIndex: vi.fn(), evidenceSnapshot: snapshot, openEvidence: open,
      projectAiProvider: { id: "fixture", generate: async () => { throw new Error("Stop before saving"); } }
    });
    const messages: { type: string; [key: string]: unknown }[] = [];
    source.subscribe?.((message) => messages.push(message));
    expect((await source.load()).knowledge?.topics?.[0]?.id).toBe("code");
    expect(snapshot).not.toHaveBeenCalled();
    await source.checkKnowledge?.();
    expect(messages.at(-1)).toMatchObject({ type: "projectKnowledgeChecked", checks: [{ id: "code", state: "changed" }] });
    await source.openTopicEvidence?.("unknown", 0);
    await source.openTopicEvidence?.("code", -1);
    expect(open).not.toHaveBeenCalled();
    await source.openTopicEvidence?.("code", 0);
    expect(open).toHaveBeenCalledWith("src/code.ts", 3);
    open.mockClear();
    const request = { diagramId: "topic-view:code", updatedAt: 1, elementId: "code", elementKind: "node" as const, evidenceIndex: 0 };
    await source.openReaderEvidence?.({ ...request, updatedAt: 0 });
    await source.openReaderEvidence?.({ ...request, evidenceIndex: -1 });
    await source.openReaderEvidence?.({ ...request, elementId: "not-recorded" });
    expect(open).not.toHaveBeenCalled();
    await source.openReaderEvidence?.(request);
    expect(open).toHaveBeenCalledWith("src/code.ts", 3);
    await source.generateTopicDiagram?.("code");
    expect(readEvidence.mock.calls[0]?.[0]).toMatchObject({ preferredPaths: ["src/code.ts", "src/ui/feature.ts"], modulePaths: ["src/code.ts", "src/ui/feature.ts"] });
    expect(readEvidence.mock.calls[0]?.[0].requirement).toContain("Explain one topic: Code");
    expect(messages.some((message) => message.type === "projectDiagramGenerateFailed")).toBe(true);
  });

  it("adds Structure and Type maps only from a current cached index and never sends them to AI", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [{ id: "code", canonicalName: "Code", purpose: "Runs code", evidence: [{ path: "src/model.ts", line: 1 }] }] });
    const index = await buildStructureIndex([
      { path: "src/model.ts", content: "export class Base { id: string } export class Child extends Base { run(): void {} }" },
      { path: "src/entry.ts", content: "export function entry() {}" }
    ]);
    const generate = vi.fn(async () => ({ text: JSON.stringify({ diagram: { schemaVersion: 1, id: "code-view", title: "Code", kind: "architecture", nodes: [], relations: [] } }) }));
    const artifact = (document: DiagramAdapterDocument): DiagramAdapterArtifact => ({ format: "html", mimeType: "text/html", content: "<html>derived</html>", adapterId: "fixture", adapterVersion: "1", diagramId: document.diagramId });
    const adapter: ProjectDiagramAdapter = { id: "fixture", version: "1", capabilities: [], supports: () => true,
      transform: async (diagram) => ({ adapterId: "fixture", adapterVersion: "1", diagramId: diagram.id, kind: diagram.kind, payload: {} }),
      render: async (document) => { expect(document.kind).toBe("tree"); return artifact(document); },
      preview: async (document) => artifact(document), export: async (document) => artifact(document),
      validate: async () => ({ adapterId: "fixture", adapterVersion: "1", status: "passed", checkedAt: 1, issues: [] }), dispose: () => {}
    };
    const registry = new ProjectDiagramAdapterRegistry({ load: async () => undefined, save: async () => {} });
    registry.register(adapter);
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never, diagramRegistry: registry,
      readEvidence: async () => buildProjectEvidencePackage({ files: [] }), readStructureIndex: async () => buildProjectEvidencePackage({ files: [] }) as IndexedProjectEvidence,
      readStructure: async () => ({ summary: index.summary, graph: index.graph, updatedAt: 9 }),
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent },
      projectAiProvider: { id: "fixture", generate }
    });
    const messages: { type: string; [key: string]: unknown }[] = [];
    source.subscribe?.((message) => messages.push(message));
    const topics = (await source.load()).knowledge?.topics ?? [];
    expect(topics.map((topic) => topic.id)).toEqual(expect.arrayContaining(["structure:map", "structure:types"]));
    expect(topics.find((topic) => topic.id === "structure:map")?.diagram).toMatchObject({ kind: "tree", metadata: { structureMap: true } });
    expect(topics.find((topic) => topic.id === "structure:types")?.diagram).toMatchObject({ kind: "class", metadata: { classMap: true } });
    await source.generateTopicDiagram?.("structure:map");
    expect(generate).not.toHaveBeenCalled();
    expect(messages.at(-1)).toMatchObject({ type: "projectDiagramGenerateFailed", error: expect.stringContaining("derived") });
    await source.renderReaderDiagram?.({ diagramId: "structure:map", updatedAt: 9, requestId: "derived" });
    expect(messages.at(-1)).toMatchObject({ type: "projectReaderRendered", requestId: "derived", html: "<html>derived</html>" });
  });

  it("pauses a running initialization, keeps a stage checkpoint and resumes without repeating batches", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const files = Array.from({ length: 13 }, (_, index) => ({ path: `src/features/f${index}.ts`, content: `export function f${index}() {}` }));
    const index = await buildStructureIndex(files);
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: "README.md", content: "App" }] }, { maxTotalChars: 48_000 }), index.summary);
    let checkpoint: ProjectModelCheckpoint | undefined;
    let clears = 0;
    const store: ProjectInitializationCheckpointStore = {
      read: async () => checkpoint,
      write: async (next) => { checkpoint = structuredClone(next); },
      clear: async () => { checkpoint = undefined; clears += 1; }
    };
    let intent: ReturnType<typeof projectIntentSchema.parse> | undefined;
    const writeIntent = vi.fn(async (value: NonNullable<typeof intent>) => { intent = value; });
    let batches = 0;
    let blockSecond = true;
    let started!: () => void;
    const secondBatchStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = async (request: { prompt: string }) => {
      const ids = [...new Set(request.prompt.match(/responsibility:[a-f0-9]+/g) ?? [])];
      if (request.prompt.includes("Optionally describe C4")) {
        return { text: JSON.stringify({ brief: { name: "App", summary: "App", evidence: [{ path: "README.md", line: 1 }] },
          capabilities: [{ canonicalName: "Features", description: "Features", contextIds: ids }] }) };
      }
      if (request.prompt.includes("Responsibility outlines:")) {
        const items = JSON.parse(request.prompt.match(/Responsibility outlines: ([^\n]+)/)![1]!) as { name: string; purpose: string; sourceFiles: string[]; entryPoints: string[] }[];
        return { text: JSON.stringify({ contexts: items.map((item) => ({ canonicalName: item.name, purpose: item.purpose, sourceFiles: item.sourceFiles, entryPoints: item.entryPoints })) }) };
      }
      batches += 1;
      if (blockSecond && batches === 2) { started(); await gate; }
      const candidates = JSON.parse(request.prompt.match(/Candidate file facts: ([^\n]+)/)![1]!) as { files: { path: string }[] }[];
      const candidatesFiles = candidates.flatMap((candidate) => candidate.files);
      return { text: JSON.stringify({ contexts: candidatesFiles.map((file) => ({ canonicalName: file.path, purpose: "Feature", sourceFiles: [file.path], entryPoints: [file.path] })) }) };
    };
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never, checkpoint: store,
      readEvidence: async () => buildProjectEvidencePackage({ files: [] }), readStructureIndex: async () => evidence,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent, writeIntent },
      projectAiProvider: { id: "fixture", generate }
    });
    const first = source.initialize!();
    await secondBatchStarted;
    source.pauseInitialization?.();
    release();
    await expect(first).rejects.toThrow(/cancelled/i);
    expect(source.initialization?.()).toMatchObject({ status: "cancelled", resumable: true, resumeStage: "batches" });
    expect(checkpoint?.stage).toBe("batches");
    expect(checkpoint?.batches?.length).toBe(1);
    expect(writeIntent).not.toHaveBeenCalled();

    blockSecond = false;
    await source.initialize!();
    // Batch 1 completed before Pause, so Resume runs only the remaining batch (1 call for the
    // aborted batch and 1 for the resumed one, on top of batch 1) instead of both batches again.
    expect(batches).toBe(3);
    expect(clears).toBe(1);
    expect(checkpoint).toBeUndefined();
    expect(writeIntent).toHaveBeenCalledTimes(1);
    expect(new Set(intent!.contexts.flatMap((context) => context.sourceFiles ?? [])).size).toBe(13);
  });

  it("hides derived topics when the cache is absent", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [{ id: "code", canonicalName: "Code", purpose: "Runs code" }] });
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never,
      readEvidence: async () => buildProjectEvidencePackage({ files: [] }), readStructureIndex: async () => buildProjectEvidencePackage({ files: [] }) as IndexedProjectEvidence,
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }), readIntent: async () => intent }
    });
    const topics = (await source.load()).knowledge?.topics ?? [];
    expect(topics.some((topic) => topic.kind === "structure" || topic.kind === "types")).toBe(false);
  });

  it("hydrates a checkpoint as a resumable card after a reload", async () => {
    const { createProjectPanelDataSource } = await import("../src/features/project/host/projectPanelDataSource.js");
    const checkpoint: ProjectModelCheckpoint = {
      version: 2, createdAt: 1, updatedAt: 2,
      fingerprint: { structureHash: "a".repeat(64), structureVersion: 2, indexVersion: 4, evidenceInputHash: "b".repeat(64), promptVersion: "project-model-7", schemaVersion: 2, ai: "{}" },
      stage: "reconcile", fraction: 0.5, attempts: 3
    };
    let cleared = 0;
    const source = createProjectPanelDataSource({
      name: "Example", root: "C:/ws", rootUri: {} as never,
      readEvidence: async () => buildProjectEvidencePackage({ files: [] }), readStructureIndex: async () => buildProjectEvidencePackage({ files: [] }) as IndexedProjectEvidence,
      checkpoint: { read: async () => checkpoint, write: async () => undefined, clear: async () => { cleared += 1; } },
      store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }) }
    });
    expect((await source.load()).overview.initialization).toMatchObject({
      status: "cancelled", resumable: true, resumeStage: "reconcile", resumePercent: 53
    });
    expect(cleared).toBe(0);
  });
});
