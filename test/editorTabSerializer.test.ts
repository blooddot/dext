import { describe, expect, it } from "vitest";
import { EditorTabManager, describeEditorTab, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { createEditorTabState } from "../src/editorTabState.js";
import { EditorTabRestorer, descriptorForKey } from "../src/editorTabSerializer.js";
import { EDITOR_TAB_VIEW_TYPES } from "../src/editorTabTypes.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  revealed = 0;
  dispose(): void {}
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

const managerFor = (host: FakeHost) => new EditorTabManager(host);

describe("editor tab serializer", () => {
  it("opens a restored page once and reuses it when the other path already opened it", () => {
    const host = new FakeHost();
    const manager = managerFor(host);
    const restorer = new EditorTabRestorer(manager);
    const state = createEditorTabState("dext.editor:project", { page: "architecture" });
    expect(restorer.restore(state, "serializer", { html: "<project/>" }).status).toBe("opened");
    expect(host.created[0]!.panel.html).toBe("<project/>");
    // The proactive restore sees the serializer already opened it and only reveals it.
    expect(restorer.restore(state, "proactive").status).toBe("reused");
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.revealed).toBe(1);
  });

  it("skips a key currently being restored by the other path", () => {
    const host = new FakeHost();
    const manager = managerFor(host);
    const restorer = new EditorTabRestorer(manager);
    const key = "dext.editor:api#Task.Query";
    expect(restorer.claim(key)).toBe(true);
    const state = createEditorTabState(key, { page: "detail" });
    expect(restorer.restore(state, "serializer").status).toBe("skipped");
    restorer.release(key);
    expect(restorer.restore(state, "proactive").status).toBe("opened");
  });

  it("reports an invalid or unknown key instead of creating a page", () => {
    const host = new FakeHost();
    const restorer = new EditorTabRestorer(managerFor(host));
    expect(restorer.restore({ key: "unknown" }, "serializer").status).toBe("invalid");
    expect(host.created).toHaveLength(0);
  });

  it("recovers an error for a lost resource while keeping the stable key", () => {
    const host = new FakeHost();
    const manager = managerFor(host);
    const restorer = new EditorTabRestorer(manager);
    const key = "dext.editor:api#Removed.Method";
    expect(restorer.restore(createEditorTabState(key), "serializer")).toMatchObject({ status: "opened", key });
    // The descriptor still carries the stable key so the page can show a recoverable error.
    expect(descriptorForKey(key)?.key).toBe(key);
  });

  it("builds descriptors from keys for every tab kind", () => {
    for (const [kind, viewType] of Object.entries(EDITOR_TAB_VIEW_TYPES)) {
      expect(descriptorForKey(`dext.editor:${kind}`)?.viewType).toBe(viewType);
    }
    expect(describeEditorTab("project", "dext.editor:project", EDITOR_TAB_VIEW_TYPES.project).title).toBe("Dext Project");
  });

  it("adopts a serializer-restored panel without creating a second one", () => {
    const host = new FakeHost();
    const manager = managerFor(host);
    const restorer = new EditorTabRestorer(manager);
    const state = createEditorTabState("dext.editor:project", { page: "knowledge" });
    const adopted = new FakePanel();
    const outcome = restorer.adoptRestored(state, () => adopted, "<restored/>");
    expect(outcome).toMatchObject({ status: "opened", key: "dext.editor:project" });
    expect(host.created).toHaveLength(0);
    expect(adopted.html).toBe("<restored/>");
    expect(manager.activeKeys).toEqual(["dext.editor:project"]);
  });

  it("disposes a restored panel when the proactive path already opened the key", () => {
    const host = new FakeHost();
    const manager = managerFor(host);
    const restorer = new EditorTabRestorer(manager);
    const state = createEditorTabState("dext.editor:project");
    expect(restorer.restore(state, "proactive").status).toBe("opened");
    let disposed = false;
    const late = new FakePanel();
    late.dispose = () => { disposed = true; };
    expect(restorer.adoptRestored(state, () => late).status).toBe("reused");
    expect(disposed).toBe(true);
    expect(host.created).toHaveLength(1);
  });
});
