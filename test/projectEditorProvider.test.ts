import { describe, expect, it } from "vitest";
import { ProjectEditorProvider, type ProjectEditorDataSource } from "../src/features/project/host/projectEditorProvider.js";
import type { ProjectPanelData } from "../src/features/project/presentation/projectPanel.js";
import { EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/platform/editor-tabs/editorTabManager.js";
import { EditorTabRestorer } from "../src/platform/editor-tabs/editorTabSerializer.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  revealed = 0;
  messages: unknown[] = [];
  disposed = false;
  dispose(): void { this.disposed = true; }
  reveal(): void { this.revealed += 1; }
  setHtml(html: string): void { if (this.disposed) throw new Error("Webview is disposed"); this.html = html; }
  postMessage(message: unknown): void { if (this.disposed) throw new Error("Webview is disposed"); this.messages.push(message); }
}

class FakeHost {
  readonly created: Array<{ key: string; panel: FakePanel; callbacks: EditorTabCallbacks }> = [];
  createPanel(descriptor: { key: string }, callbacks: EditorTabCallbacks): EditorTabPanelHandle {
    const panel = new FakePanel();
    this.created.push({ key: descriptor.key, panel, callbacks });
    return panel;
  }
}

const data: ProjectPanelData = {
  overview: {
    name: "Fixture", root: "C:/ws",
    objects: 0, accepted: 0, drafts: 0, needsVerification: 0,
    initialization: { status: "uninitialized" }
  },
  objects: [],
  architecture: { diagrams: [] }
};

const setup = (overrides: Partial<ProjectEditorDataSource> = {}) => {
  const host = new FakeHost();
  const manager = new EditorTabManager(host);
  const restorer = new EditorTabRestorer(manager);
  const calls: unknown[] = [];
  const dataSource: ProjectEditorDataSource = {
    load: async () => data,
    ...overrides
  };
  const provider = new ProjectEditorProvider({ manager, restorer, dataSource });
  return { host, manager, restorer, provider, calls };
};

describe("project editor tab", () => {
  it("routes topic actions while keeping generation in the current reading page", async () => {
    const actions: unknown[] = [];
    const { provider } = setup({
      checkKnowledge: async () => { actions.push("check"); },
      openTopicEvidence: async (id, index) => { actions.push([id, index]); },
      generateTopicDiagram: async (id) => { actions.push([id, provider.page]); },
      renderReaderDiagram: async (request) => { actions.push(request); }
    });
    await provider.show("knowledge");
    await provider.handleMessage(provider.key, { type: "projectKnowledgeCheck" });
    await provider.handleMessage(provider.key, { type: "projectTopicEvidence", topicId: "code", evidenceIndex: 0 });
    await provider.handleMessage(provider.key, { type: "projectTopicDiagram", topicId: "code" });
    expect(actions).toEqual(["check", ["code", 0], ["code", "knowledge"]]);
    const request = { diagramId: "topic-view:code", updatedAt: 1, requestId: "render-1" };
    await provider.handleMessage(provider.key, { type: "projectReaderRender", ...request });
    expect(actions.at(-1)).toEqual(request);
    await provider.handleMessage(provider.key, { type: "projectReaderRender", ...request, requestId: 1 });
    expect(actions).toHaveLength(4);
  });

  it("acknowledges settings saves and failures without replacing the user's form", async () => {
    const saves: unknown[] = [];
    const { host, provider } = setup({
      setEvidenceSettings: async (settings, version) => {
        if (version !== 0) throw new Error("Project settings changed");
        saves.push(settings);
      },
      load: async () => ({ ...data, overview: { ...data.overview, evidenceSettingsVersion: 1 } })
    });
    await provider.show();
    const panel = host.created[0]!.panel;
    const html = panel.html;
    await provider.handleMessage(provider.key, { type: "projectEvidenceSettings", settings: { depth: "whole", include: [] }, version: 0 });
    expect(saves).toEqual([{ depth: "whole", include: [] }]);
    expect(panel.messages.at(-1)).toEqual({ type: "projectEvidenceSettingsSaved", version: 1 });
    await provider.handleMessage(provider.key, { type: "projectEvidenceSettings", settings: {}, version: 1 });
    expect(panel.messages.at(-1)).toEqual({ type: "projectEvidenceSettingsSaved", error: "Project settings changed" });
    expect(panel.html).toBe(html);
  });

  it("routes project workspace settings through the data source", async () => {
    const saved: unknown[] = [];
    const { host, provider } = setup({
      setWorkspaceSettings: async (settings, version) => { saved.push({ settings, version }); },
      load: async () => ({ ...data, overview: { ...data.overview, workspaceSettingsVersion: 2 } })
    });
    await provider.show();
    await provider.handleMessage(provider.key, { type: "projectWorkspaceSettings", settings: { planDirectory: ".project/plans" }, version: 1 });
    expect(saved).toEqual([{ settings: { planDirectory: ".project/plans" }, version: 1 }]);
    expect(host.created[0]!.panel.messages.at(-1)).toEqual({ type: "projectWorkspaceSettingsSaved", version: 2 });
  });
  it("routes the unified project settings form as one save", async () => {
    const saved: unknown[] = [];
    const { host, provider } = setup({
      setProjectSettings: async (settings, version) => { saved.push({ settings, version }); },
      load: async () => ({ ...data, overview: { ...data.overview, workspaceSettingsVersion: 3, evidenceSettingsVersion: 3 } })
    });
    await provider.show();
    const settings = { workspace: { planDirectory: ".project/plans" }, evidence: { depth: "deep", include: [] } };
    await provider.handleMessage(provider.key, { type: "projectSettings", settings, version: 2 });
    expect(saved).toEqual([{ settings, version: 2 }]);
    expect(host.created[0]!.panel.messages.at(-1)).toEqual({ type: "projectSettingsSaved", version: 3 });
  });
  it("reuses one tab and restores old diagram pages inside the reader", async () => {
    const { host, provider } = setup();
    expect((await provider.show()).created).toBe(true);
    expect((await provider.show("architecture")).created).toBe(false);
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-project-page="architecture"');
    expect(host.created[0]!.panel.html).toContain("data-project-reader");
    expect(host.created[0]!.panel.html).not.toContain(">Architecture</button>");
  });

  it("switches pages from webview messages and cancels diagram work when leaving the page", async () => {
    const cancels: number[] = [];
    const { host, provider } = setup({ cancelDiagramWork: () => { cancels.push(1); } });
    await provider.show("architecture");
    await provider.handleMessage("other.tab", { page: "knowledge" });
    expect(provider.page).toBe("architecture");
    await provider.handleMessage(provider.key, { page: "knowledge" });
    expect(provider.page).toBe("knowledge");
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-project-page="knowledge"');
    expect(cancels).toHaveLength(1);
  });

  it("restores through the shared restorer without duplicating a tab", async () => {
    const { host, provider, manager } = setup();
    await provider.show("architecture");
    const status = await provider.restore({ key: provider.key, page: "architecture" });
    expect(status).toBe("reused");
    expect(manager.activeKeys).toEqual([provider.key]);
    expect(host.created).toHaveLength(1);
  });

  it("forwards reader operations with snapshot identity and explicit evidence selection", async () => {
    const calls: unknown[] = [];
    const { provider } = setup({
      renderReaderDiagram: async request => { calls.push({ op: "render", ...request }); },
      generateTopicDiagram: async topicId => { calls.push({ op: "generate", topicId }); },
      exportReaderDiagram: async request => { calls.push({ op: "export", ...request }); },
      openReaderEvidence: async request => { calls.push({ op: "evidence", ...request }); }
    });
    await provider.show("architecture");
    await provider.handleMessage(provider.key, { type: "projectReaderRender", diagramId: "view", updatedAt: 3, requestId: "render-1" });
    await provider.handleMessage(provider.key, { type: "projectTopicDiagram", topicId: "module" });
    await provider.handleMessage(provider.key, { type: "projectReaderExport", diagramId: "view", updatedAt: 3, content: "<svg/>" });
    await provider.handleMessage(provider.key, { type: "projectReaderEvidence", diagramId: "view", updatedAt: 3, elementId: "node-1", elementKind: "node", evidenceIndex: 0 });
    expect(calls).toEqual([
      { op: "render", diagramId: "view", updatedAt: 3, requestId: "render-1" },
      { op: "generate", topicId: "module" },
      { op: "export", diagramId: "view", updatedAt: 3, content: "<svg/>" },
      { op: "evidence", diagramId: "view", updatedAt: 3, elementId: "node-1", elementKind: "node", evidenceIndex: 0 }
    ]);
  });

  it("ignores retired diagram operations and incomplete reader evidence requests", async () => {
    const calls: string[] = [];
    const { provider } = setup({
      renderReaderDiagram: async () => { calls.push("render"); },
      generateTopicDiagram: async () => { calls.push("generate"); },
      exportReaderDiagram: async () => { calls.push("export"); },
      openReaderEvidence: async () => { calls.push("evidence"); }
    });
    await provider.show("overview");
    for (const type of ["projectChooseRoots", "projectAdapterPreference", "projectDiagramAction", "projectDiagramRender", "projectDiagramGenerate", "projectDiagramExport", "projectDiagramEvidence", "projectDiagramFocus", "projectEvidenceOpen"]) {
      await provider.handleMessage(provider.key, { type, diagramId: "view", version: 3, requirement: "Generate", format: "svg", content: "<svg/>", nodeId: "node", path: "src/app.ts" });
    }
    await provider.handleMessage(provider.key, { type: "projectReaderEvidence", diagramId: "view", elementId: "node-1" });
    expect(calls).toEqual([]);
  });

  it("forwards host messages and initialization progress to the active panel", async () => {
    let listener: ((message: { type: string }) => void) | undefined;
    let progress: ((state: unknown) => void) | undefined;
    const { provider, host } = setup({
      subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
      onInitializationChange: (next) => { progress = next as (state: unknown) => void; return () => { progress = undefined; }; }
    });
    await provider.show("architecture");
    listener?.({ type: "projectReaderRendered" });
    progress?.({ status: "running" });
    expect(host.created[0]!.panel.messages).toEqual([
      { type: "projectReaderRendered" },
      { type: "projectInitializationProgress", state: { status: "running" } }
    ]);
    provider.dispose();
    expect(listener).toBeUndefined();
  });

  it("pauses a running initialization through the data source", async () => {
    let paused = 0;
    const { provider } = setup({ pauseInitialization: () => { paused += 1; } });
    await provider.show("overview");
    await provider.handleMessage(provider.key, { type: "projectInitializePause" });
    expect(paused).toBe(1);
  });

  it("starts initialization without a running render when the tab closed first", async () => {
    const completedData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "completed", phase: "saving", intentGenerated: true, diagramsGenerated: 1 } } };
    const { host, manager, provider } = setup({
      initialize: async () => completedData
    });
    await provider.show("overview");
    manager.close(provider.key);
    await provider.handleMessage(provider.key, { type: "projectInitialize" });
    expect(host.created).toHaveLength(2);
    expect(host.created[1]!.panel.html).toContain('data-project-page="overview"');
  });

  it("keeps initialization progress away from a tab that closed while the run was active", async () => {
    let progress: ((state: unknown) => void) | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const runningData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "running", phase: "generating", startedAt: 1 } } };
    const completedData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "completed", phase: "saving", intentGenerated: true, diagramsGenerated: 1 } } };
    const { host, manager, provider } = setup({
      onInitializationChange: (next) => { progress = next as (state: unknown) => void; return () => { progress = undefined; }; },
      initialization: () => runningData.overview.initialization,
      initialize: async () => { await pending; return completedData; }
    });
    await provider.show("overview");
    const message = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    manager.close(provider.key);
    // VS Code's Webview throws "Webview is disposed" for a tab that closed mid-run; that must not
    // abort the AI generation that is only trying to report progress.
    expect(() => progress?.({ status: "running" })).not.toThrow();
    expect(() => progress?.({ status: "failed", error: "Generate failed: Webview is disposed" })).not.toThrow();
    finish();
    await message;
    expect(host.created).toHaveLength(2);
    expect(host.created[1]!.panel.html).toContain('data-project-page="overview"');
  });

  it("keeps the running state visible and preserves the selected page during initialization", async () => {
    let resolveInitialization!: () => void;
    const initializationDone = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    let started = false;
    let settled = false;
    const runningData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "running", phase: "generating", startedAt: 1 } } };
    const completedData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "completed", phase: "saving", intentGenerated: true, diagramsGenerated: 1 } } };
    const { host, provider } = setup({
      load: async () => started ? (settled ? completedData : runningData) : data,
      initialization: () => (settled ? completedData.overview.initialization : runningData.overview.initialization),
      initialize: async () => { started = true; await initializationDone; settled = true; return completedData; }
    });
    await provider.show("overview");
    const initializeMessage = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    expect(host.created[0]!.panel.html).toContain("project-init-running");
    await provider.handleMessage(provider.key, { type: "projectPage", page: "knowledge" });
    resolveInitialization();
    await initializeMessage;
    expect(provider.page).toBe("knowledge");
    expect(host.created[0]!.panel.html).toContain('data-project-page="knowledge"');
  });

  // Pause cancels the state machine synchronously, but the data source's `initialize()` reads the
  // checkpoint before it starts the run, so its snapshot is still the paused one for a moment. The
  // card must not be rendered from that stale snapshot, or Continue silently shows paused UI while
  // progress streams into the hidden block.
  it("renders the running card as soon as Continue is clicked, before the run starts", async () => {
    let release!: (value: ProjectPanelData) => void;
    const pending = new Promise<ProjectPanelData>((resolve) => { release = resolve; });
    const paused: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "cancelled", resumable: true, resumeStage: "batches", resumePercent: 52 } } };
    const { host, provider } = setup({
      load: async () => paused,
      initialization: () => paused.overview.initialization,
      initialize: () => pending
    });
    await provider.show("overview");
    expect(host.created[0]!.panel.html).toContain("Resume initialization");
    const message = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    expect(host.created[0]!.panel.html).toContain("project-init-running");
    expect(host.created[0]!.panel.html).toContain("data-project-initialize-pause");
    release(paused);
    await message;
    expect(host.created[0]!.panel.html).toContain("Resume initialization");
  });

  it("swaps the running card for the paused card while the aborted run is still settling", async () => {
    let progress: ((state: unknown) => void) | undefined;
    let release!: (value: ProjectPanelData) => void;
    const pending = new Promise<ProjectPanelData>((resolve) => { release = resolve; });
    const runningState = { status: "running" as const, phase: "generating" as const, startedAt: 1, percent: 42 };
    const running: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: runningState } };
    const { host, provider } = setup({
      load: async () => running,
      initialization: () => runningState,
      initialize: () => pending,
      onInitializationChange: (next) => { progress = next as (state: unknown) => void; return () => { progress = undefined; }; }
    });
    await provider.show("overview");
    const message = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    progress?.({ status: "cancelled", resumable: true, resumeStage: "batches", resumePercent: 52 });
    expect(host.created[0]!.panel.html).toContain("Initialization paused after responsibility batches (52%)");
    expect(host.created[0]!.panel.html).toContain("Resume initialization");
    expect(host.created[0]!.panel.html.split("<script>")[0]).not.toContain("data-project-initialize-pause");
    release(running);
    await message;
  });

  it("starts a new run from the paused card while the aborted run is still settling", async () => {
    let progress: ((state: unknown) => void) | undefined;
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<ProjectPanelData>((_, reject) => { rejectFirst = reject; });
    let calls = 0;
    const paused: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "cancelled", resumable: true, resumeStage: "batches", resumePercent: 52 } } };
    const completed: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "completed", phase: "saving", intentGenerated: true, diagramsGenerated: 1 } } };
    const { host, provider } = setup({
      load: async () => paused,
      initialization: () => paused.overview.initialization,
      initialize: () => { calls += 1; return calls === 1 ? first : Promise.resolve(completed); },
      onInitializationChange: (next) => { progress = next as (state: unknown) => void; return () => { progress = undefined; }; }
    });
    await provider.show("overview");
    const firstClick = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    progress?.({ status: "cancelled", resumable: true, resumeStage: "batches", resumePercent: 52 });
    const secondClick = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await secondClick;
    expect(calls).toBe(2);
    expect(host.created[0]!.panel.html).toContain('data-project-initialization-state="completed"');
    rejectFirst(new Error("Project initialization was cancelled."));
    await firstClick;
    // The stale run settling must not repaint over the newer result.
    expect(host.created[0]!.panel.html).toContain('data-project-initialization-state="completed"');
  });
});
