import { describe, expect, it, vi } from "vitest";
import { createVscodeEditorTabHost, wrapVscodeWebviewPanel, describeEditorTab, EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EDITOR_TAB_VIEW_TYPES } from "../src/editorTabTypes.js";
import { renderEditorTabHtml } from "../src/editorTabHtml.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  revealed = 0;
  disposed = false;
  reveal(): void { this.revealed += 1; }
  dispose(): void { this.disposed = true; }
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

describe("editor tab manager", () => {
  it("loads the stylesheet and permits page scripts for both new and restored panels", () => {
    const makePanel = () => ({ dispose: vi.fn(), onDidDispose: vi.fn(), webview: { html: "", onDidReceiveMessage: vi.fn() } });
    const created = makePanel();
    const restored = makePanel();
    const renderHtml = (_panel: unknown, body: string) => renderEditorTabHtml(body, "https://webview.test/media/editorTabs.css", "https://webview.test");
    const callbacks = { onDispose: vi.fn(), onMessage: vi.fn() };
    const host = createVscodeEditorTabHost({ createWebviewPanel: () => created }, { renderHtml });
    const current = host.createPanel(describeEditorTab("api", "dext.editor:api", EDITOR_TAB_VIEW_TYPES.api), callbacks);
    const adopted = wrapVscodeWebviewPanel(restored, callbacks, renderHtml);
    for (const handle of [current, adopted]) handle.setHtml?.('<div>API</div><script>acquireVsCodeApi()</script>');
    for (const panel of [created, restored]) {
      expect(panel.webview.html).toContain('<!DOCTYPE html>');
      expect(panel.webview.html).toContain('href="https://webview.test/media/editorTabs.css"');
      const nonce = panel.webview.html.match(/<script nonce="([^"]+)"/)?.[1];
      expect(nonce).toBeTruthy();
      expect(panel.webview.html).toContain(`script-src 'nonce-${nonce}'`);
    }
  });

  it("creates once per stable key and reveals the existing panel on reopen", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const descriptor = describeEditorTab("project", "dext.editor:project", EDITOR_TAB_VIEW_TYPES.project);
    const first = manager.open(descriptor);
    const second = manager.open(descriptor);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(host.created).toHaveLength(1);
    expect((second.panel as FakePanel).revealed).toBe(1);
    expect(manager.activeKeys).toEqual(["dext.editor:project"]);
  });

  it("releases the key on close and disposes the panel without deleting data", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    manager.open(describeEditorTab("api", "dext.editor:api#Task.Query", EDITOR_TAB_VIEW_TYPES.api));
    expect(manager.close("dext.editor:api#Task.Query")).toBe(true);
    expect(manager.has("dext.editor:api#Task.Query")).toBe(false);
    expect(host.created[0]!.panel.disposed).toBe(true);
  });

  it("forwards webview messages with the originating key and disposes on host dispose", () => {
    const host = new FakeHost();
    const messages: Array<[string, unknown]> = [];
    const manager = new EditorTabManager(host, (key, message) => messages.push([key, message]));
    manager.open(describeEditorTab("globalResources", "dext.editor:globalResources", EDITOR_TAB_VIEW_TYPES.globalResources));
    host.created[0]!.callbacks.onMessage({ type: "refresh" });
    expect(messages).toEqual([["dext.editor:globalResources", { type: "refresh" }]]);
    manager.dispose();
    expect(manager.activeKeys).toEqual([]);
  });

  it("keeps the live tab when a panel that adoption replaced reports its own dispose", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const descriptor = describeEditorTab("project", "dext.editor:project", EDITOR_TAB_VIEW_TYPES.project);
    const live = manager.open(descriptor);
    // A restored panel for an already-open key is disposed by `adopt`, which must not close the
    // registered one through its own dispose callback.
    const restored = new FakePanel();
    const adopted = manager.adopt(descriptor.key, descriptor, restored);
    expect(restored.disposed).toBe(true);
    restored.dispose(); // the panel notifies VS Code's onDidDispose
    expect(manager.closeIfCurrent(descriptor.key, restored)).toBe(false);
    expect(manager.has(descriptor.key)).toBe(true);
    expect((live.panel as FakePanel).disposed).toBe(false);
    expect(manager.closeIfCurrent(descriptor.key, live.panel)).toBe(true);
    expect(manager.has(descriptor.key)).toBe(false);
    expect(adopted.created).toBe(false);
  });

  it("adapts a VS Code window and wires dispose callbacks", () => {
    const disposeListeners: Array<() => void> = [];
    const reveal = vi.fn();
    const dispose = vi.fn();
    const windowApi = {
      createWebviewPanel: vi.fn(() => ({
        reveal,
        dispose,
        onDidDispose: (listener: () => void) => disposeListeners.push(listener),
        webview: { html: "", onDidReceiveMessage: vi.fn() }
      }))
    };
    const host = createVscodeEditorTabHost(windowApi, { column: 1 });
    const onDispose = vi.fn();
    const panel = host.createPanel(
      describeEditorTab("history", "dext.editor:history", EDITOR_TAB_VIEW_TYPES.history),
      { onDispose, onMessage: vi.fn() }
    );
    panel.setHtml?.("<html></html>");
    panel.reveal();
    disposeListeners[0]!();
    expect(reveal).toHaveBeenCalled();
    expect(onDispose).toHaveBeenCalledOnce();
  });
});
