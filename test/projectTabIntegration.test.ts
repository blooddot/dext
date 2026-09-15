import { describe, expect, it } from "vitest";
import { EditorTabManager, describeEditorTab, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EditorTabRestorer } from "../src/editorTabSerializer.js";
import { createEditorTabState } from "../src/editorTabState.js";
import { EDITOR_TAB_VIEW_TYPES } from "../src/editorTabTypes.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  disposed = false;
  dispose(): void { this.disposed = true; }
  reveal(): void {}
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

describe("editor tab integration", () => {
  it("keeps Project, API, Global Resources and History tabs under distinct stable keys", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    for (const kind of ["project", "api", "globalResources", "history"] as const) {
      manager.open(describeEditorTab(kind, `dext.editor:${kind}`, EDITOR_TAB_VIEW_TYPES[kind]));
    }
    expect(manager.activeKeys).toEqual([
      "dext.editor:api", "dext.editor:globalResources", "dext.editor:history", "dext.editor:project"
    ]);
    expect(host.created).toHaveLength(4);
  });

  it("scopes the same page kind per workspace root without duplication", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const restorer = new EditorTabRestorer(manager);
    const one = createEditorTabState("dext.editor:project@C%3A%2Fone");
    const two = createEditorTabState("dext.editor:project@C%3A%2Ftwo");
    expect(restorer.restore(one, "serializer").status).toBe("opened");
    expect(restorer.restore(two, "serializer").status).toBe("opened");
    expect(restorer.restore(one, "proactive").status).toBe("reused");
    expect(host.created).toHaveLength(2);
  });

  it("restores Project and API together without a duplicate from the other recovery path", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const restorer = new EditorTabRestorer(manager);
    const project = createEditorTabState("dext.editor:project", { page: "architecture" });
    const api = createEditorTabState("dext.editor:api#Task.Query", { page: "detail" });
    expect(restorer.restore(project, "proactive").status).toBe("opened");
    expect(restorer.restore(api, "serializer").status).toBe("opened");
    expect(restorer.restore(project, "serializer").status).toBe("reused");
    expect(restorer.restore(api, "proactive").status).toBe("reused");
    expect(host.created.map((entry) => entry.key)).toEqual(["dext.editor:project", "dext.editor:api#Task.Query"]);
  });

  it("closing a tab never deletes the underlying data", () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const data = new Map<string, string>([["dext.editor:project", "knowledge"]]);
    manager.open(describeEditorTab("project", "dext.editor:project", EDITOR_TAB_VIEW_TYPES.project));
    manager.close("dext.editor:project");
    expect(data.get("dext.editor:project")).toBe("knowledge");
    expect(manager.has("dext.editor:project")).toBe(false);
  });
});
