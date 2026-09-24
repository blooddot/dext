import { describe, expect, it } from "vitest";
import { ProjectEditorProvider, type ProjectEditorDataSource } from "../src/projectEditorProvider.js";
import type { ProjectPanelData } from "../src/webview/projectPanel.js";
import { EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EditorTabRestorer } from "../src/editorTabSerializer.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  revealed = 0;
  messages: unknown[] = [];
  disposed = false;
  dispose(): void { this.disposed = true; }
  reveal(): void { this.revealed += 1; }
  setHtml(html: string): void { this.html = html; }
  postMessage(message: unknown): void { this.messages.push(message); }
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
    initialization: { status: "uninitialized", drafts: 0 }
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
    await provider.handleMessage(provider.key, { type: "projectWorkspaceSettings", settings: { reviewPreset: "experience" }, version: 1 });
    expect(saved).toEqual([{ settings: { reviewPreset: "experience" }, version: 1 }]);
    expect(host.created[0]!.panel.messages.at(-1)).toEqual({ type: "projectWorkspaceSettingsSaved", version: 2 });
  });
  it("routes the unified project settings form as one save", async () => {
    const saved: unknown[] = [];
    const { host, provider } = setup({
      setProjectSettings: async (settings, version) => { saved.push({ settings, version }); },
      load: async () => ({ ...data, overview: { ...data.overview, workspaceSettingsVersion: 3, evidenceSettingsVersion: 3 } })
    });
    await provider.show();
    const settings = { workspace: { reviewPreset: "experience" }, evidence: { depth: "deep", include: [] } };
    await provider.handleMessage(provider.key, { type: "projectSettings", settings, version: 2 });
    expect(saved).toEqual([{ settings, version: 2 }]);
    expect(host.created[0]!.panel.messages.at(-1)).toEqual({ type: "projectSettingsSaved", version: 3 });
  });
  it("creates one tab, reuses it and labels the third page as diagrams", async () => {
    const { host, provider } = setup();
    expect((await provider.show()).created).toBe(true);
    expect((await provider.show("architecture")).created).toBe(false);
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-project-page="architecture"');
    expect(host.created[0]!.panel.html).toContain(">Diagrams<");
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

  it("addresses diagram operations by stable id and version", async () => {
    const calls: unknown[] = [];
    const { provider } = setup({
      renderDiagram: (diagramId, version, options) => { calls.push({ op: "render", diagramId, version, options }); },
      generateDiagram: (request) => { calls.push({ op: "generate", ...request }); },
      exportDiagram: (request) => { calls.push({ op: "export", ...request }); },
      openDiagramEvidence: (diagramId, nodeId, path, line) => { calls.push({ op: "evidence", diagramId, nodeId, path, line }); }
    });
    await provider.show("architecture");
    await provider.handleMessage(provider.key, { type: "projectDiagramRender", diagramId: "view", version: 3, refresh: true });
    await provider.handleMessage(provider.key, { type: "projectDiagramGenerate", requirement: "更新订单流程", kind: "workflow", diagramId: "view" });
    await provider.handleMessage(provider.key, { type: "projectDiagramExport", diagramId: "view", version: 3, format: "svg", content: "<svg/>" });
    await provider.handleMessage(provider.key, { type: "projectDiagramEvidence", diagramId: "view", nodeId: "node-1", path: "README.md", line: 25 });
    await provider.handleMessage(provider.key, { type: "projectDiagramCancel" });
    expect(calls).toEqual([
      { op: "render", diagramId: "view", version: 3, options: { refresh: true } },
      { op: "generate", requirement: "更新订单流程", kind: "workflow", diagramId: "view" },
      { op: "export", diagramId: "view", version: 3, format: "svg", content: "<svg/>" },
      { op: "evidence", diagramId: "view", nodeId: "node-1", path: "README.md", line: 25 }
    ]);
  });

  it("never opens a file for a card click and only opens evidence the node declares", async () => {
    const calls: unknown[] = [];
    const { provider } = setup({
      openDiagramEvidence: (diagramId, nodeId, path, line) => { calls.push({ diagramId, nodeId, path, line }); }
    });
    await provider.show("architecture");
    // A node selection message that carries no evidence target must not open anything.
    await provider.handleMessage(provider.key, { type: "projectDiagramFocus", diagramId: "view", nodeId: "node-1" });
    await provider.handleMessage(provider.key, { type: "projectDiagramEvidence", diagramId: "view", nodeId: "node-1" });
    expect(calls).toEqual([]);
  });

  it("ignores removed scan and multi-engine message entries", async () => {
    const calls: unknown[] = [];
    const { provider } = setup({
      renderDiagram: () => { calls.push("render"); },
      generateDiagram: () => { calls.push("generate"); },
      exportDiagram: () => { calls.push("export"); }
    });
    await provider.show("overview");
    await provider.handleMessage(provider.key, { type: "projectChooseRoots" });
    await provider.handleMessage(provider.key, { type: "projectAdapterPreference", kind: "architecture", adapterId: "drawio" });
    await provider.handleMessage(provider.key, { type: "projectDiagramAction", action: "regenerate", kind: "architecture" });
    await provider.handleMessage(provider.key, { type: "projectDiagramAction", action: "export", kind: "architecture", format: "drawio" });
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
    listener?.({ type: "projectDiagramRendered" });
    progress?.({ status: "running" });
    expect(host.created[0]!.panel.messages).toEqual([
      { type: "projectDiagramRendered" },
      { type: "projectInitializationProgress", state: { status: "running" } }
    ]);
    provider.dispose();
    expect(listener).toBeUndefined();
  });

  it("keeps the running state visible and preserves the selected page during initialization", async () => {
    let resolveInitialization!: () => void;
    const initializationDone = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    let started = false;
    let settled = false;
    const runningData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "running", phase: "generating", drafts: 0, startedAt: 1 } } };
    const completedData: ProjectPanelData = { ...data, overview: { ...data.overview, initialization: { status: "completed", phase: "saving", drafts: 0, intentGenerated: true, diagramsGenerated: 1 } } };
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
});
