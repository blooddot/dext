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
});
