import { describe, expect, it } from "vitest";
import { ProjectEditorProvider } from "../src/projectEditorProvider.js";
import type { ProjectPanelData } from "../src/webview/projectPanel.js";
import { EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EditorTabRestorer } from "../src/editorTabSerializer.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  revealed = 0;
  disposed = false;
  dispose(): void { this.disposed = true; }
  reveal(): void { this.revealed += 1; }
  setHtml(html: string): void { this.html = html; }
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
    name: "Fixture", root: "C:/ws", languages: ["typescript"],
    objects: 0, accepted: 0, drafts: 0, needsVerification: 0,
    initialization: { status: "idle", aiAvailable: true, scannedFiles: 0 }
  },
  objects: [],
  architecture: { modules: [], relations: [] }
};

const setup = () => {
  const host = new FakeHost();
  const manager = new EditorTabManager(host);
  const restorer = new EditorTabRestorer(manager);
  const provider = new ProjectEditorProvider({ manager, restorer, dataSource: { load: async () => data } });
  return { host, manager, restorer, provider };
};

describe("project editor tab", () => {
  it("creates one tab and reuses it when reopened", async () => {
    const { host, provider } = setup();
    expect((await provider.show()).created).toBe(true);
    expect((await provider.show("architecture")).created).toBe(false);
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-project-page="architecture"');
  });

  it("switches pages from webview messages without new panels", async () => {
    const { host, provider } = setup();
    await provider.show();
    await provider.handleMessage("other.tab", { page: "knowledge" });
    expect(provider.page).toBe("overview");
    await provider.handleMessage(provider.key, { page: "knowledge" });
    expect(provider.page).toBe("knowledge");
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-project-page="knowledge"');
  });

  it("restores through the shared restorer without duplicating a tab", async () => {
    const { host, provider, manager } = setup();
    await provider.show("architecture");
    const status = await provider.restore({ key: provider.key, page: "architecture" });
    expect(status).toBe("reused");
    expect(manager.activeKeys).toEqual([provider.key]);
    expect(host.created).toHaveLength(1);
  });

  it("routes adapter preference and explicit diagram actions without touching input forwarding", async () => {
    const { host, provider, calls } = (() => {
      const host = new FakeHost();
      const manager = new EditorTabManager(host);
      const restorer = new EditorTabRestorer(manager);
      const calls: string[] = [];
      const dataSource = {
        load: async () => data,
        setDiagramAdapter: (kind: string, adapterId?: string) => { calls.push(`set:${kind}:${adapterId ?? "auto"}`); },
        regenerateDiagram: (kind: string) => { calls.push(`regen:${kind}`); },
        exportDiagram: (kind: string, format?: string) => { calls.push(`export:${kind}:${format ?? "default"}`); }
      };
      const provider = new ProjectEditorProvider({ manager, restorer, dataSource });
      return { host, provider, calls };
    })();
    await provider.show("architecture");
    await provider.handleMessage(provider.key, { type: "projectAdapterPreference", kind: "architecture", adapterId: "drawio" });
    await provider.handleMessage(provider.key, { type: "projectDiagramAction", action: "regenerate", kind: "architecture" });
    await provider.handleMessage(provider.key, { type: "projectDiagramAction", action: "export", kind: "architecture", format: "drawio" });
    expect(host.created[0]!.panel.html).toContain('data-project-page="architecture"');
    expect(calls).toEqual(["set:architecture:drawio", "regen:architecture", "export:architecture:drawio"]);
  });

  it("keeps the running state visible and preserves the selected page during initialization", async () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const restorer = new EditorTabRestorer(manager);
    let started = false;
    let resolveInitialization!: () => void;
    const initializationDone = new Promise<void>((resolve) => { resolveInitialization = resolve; });
    let initializationDoneSettled = false;
    const runningData = { ...data, overview: { ...data.overview, initialization: { status: "running" as const, aiAvailable: true, scannedFiles: 0 } } };
    const completedData = { ...data, overview: { ...data.overview, initialization: { status: "completed" as const, aiAvailable: true, scannedFiles: 3 } } };
    const provider = new ProjectEditorProvider({
      manager,
      restorer,
      dataSource: {
        load: async () => started ? (initializationDoneSettled ? completedData : runningData) : data,
        initialize: async () => { started = true; await initializationDone; initializationDoneSettled = true; return completedData; }
      }
    });
    await provider.show("overview");
    const initializeMessage = provider.handleMessage(provider.key, { type: "projectInitialize" });
    await Promise.resolve();
    expect(host.created[0]!.panel.html).toContain("project-scan-progress-running");
    await provider.handleMessage(provider.key, { type: "projectPage", page: "knowledge" });
    resolveInitialization();
    await initializeMessage;
    expect(provider.page).toBe("knowledge");
    expect(host.created[0]!.panel.html).toContain('data-project-page="knowledge"');
  });
});
