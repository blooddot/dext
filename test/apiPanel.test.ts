import { describe, expect, it, vi } from "vitest";
import { ApiEditorProvider } from "../src/apiEditorProvider.js";
import { GlobalResourcesEditorProvider } from "../src/globalResourcesEditorProvider.js";
import type { ResourceEditorDataSource, ResourceEntry } from "../src/resourceDocuments.js";
import { EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EditorTabRestorer } from "../src/editorTabSerializer.js";

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

const apiEntry = (name: string): ResourceEntry => ({
  id: `api:project:${name}`, kind: "api", scope: "project", name, path: `${name}.dx`, group: ".",
  source: { kind: "project", label: "Project", path: `.dext/api/${name}.dx` }
});

const dataSource = (): ResourceEditorDataSource => ({
  list: async (_kind, query) => [apiEntry("Task.Query"), apiEntry("User.Get")].filter((entry) => !query || entry.name.toLowerCase().includes(query.toLowerCase())),
  definition: async (id) => id === "api:project:Task.Query"
    ? { entry: apiEntry("Task.Query"), content: "def main() -> AskResult" }
    : undefined
});

const setup = () => {
  const host = new FakeHost();
  const manager = new EditorTabManager(host);
  const restorer = new EditorTabRestorer(manager);
  return { host, manager, restorer };
};

describe("API editor tab", () => {
  it("ignores commands from other page kinds and reloads its list after refresh", async () => {
    const { host, manager, restorer } = setup();
    const onCommand = vi.fn();
    const source = dataSource();
    const list = vi.spyOn(source, "list");
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: source, scope: "project", onCommand });
    await provider.showList();
    await provider.handleMessage("dext.editor:globalResources", { type: "resourceCommand", command: "dext.newResource", kind: "mcp" });
    expect(onCommand).not.toHaveBeenCalled();
    await provider.handleMessage(provider.listTabKey, { type: "resourceCommand", command: "dext.reloadMethods", query: "user" });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(list).toHaveBeenLastCalledWith(["api"], "");
    expect(host.created[0]!.panel.html).toContain("Task.Query");
  });

  it("reuses the list page and searches in place", async () => {
    const { host, manager, restorer } = setup();
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: dataSource(), scope: "project" });
    expect((await provider.showList()).created).toBe(true);
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain('data-resource-kind="api"');
    await provider.showList("user");
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain("User.Get");
    expect(host.created[0]!.panel.html).toContain('data-resource-search value="user"');
    // Filtering happens in the page so clearing the search can reveal all entries again.
    expect(host.created[0]!.panel.html).toContain("Task.Query");
  });

  it("opens the same detail target once and reports a lost resource", async () => {
    const { host, manager, restorer } = setup();
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: dataSource(), scope: "project" });
    expect((await provider.showDetail("api:project:Task.Query")).created).toBe(true);
    expect((await provider.showDetail("api:project:Task.Query")).created).toBe(false);
    expect(host.created).toHaveLength(1);
    expect(host.created[0]!.panel.html).toContain("insertResourceReference");
    await expect(provider.showDetail("api:project:Gone")).rejects.toThrow(/no longer available/);
  });

  it("browses details in the list tab and restores search and scroll through back/forward", async () => {
    const { host, manager, restorer } = setup();
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: dataSource(), scope: "project" });
    await provider.showList();
    const panel = host.created[0]!.panel;
    expect(panel.html).toContain('title="Back" disabled');
    await provider.handleMessage(provider.listTabKey, { type: "resourceOpen", id: "api:project:Task.Query", viewState: { query: "Task", scrollTop: 240 } });
    expect(host.created).toHaveLength(1);
    expect(manager.activeKeys).toEqual([provider.listTabKey]);
    expect(panel.html).toContain('aria-current="page">Task.Query');
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "back", viewState: { scrollTop: 80 } });
    expect(panel.html).toContain('data-resource-search value="Task"');
    expect(panel.html).toContain('data-resource-scroll="240"');
    expect(panel.html).toContain('title="Back" disabled');
    expect(panel.html).not.toContain('title="Forward" disabled');
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "forward" });
    expect(panel.html).toContain('data-resource-scroll="80"');
    expect(panel.html).toContain('title="Forward" disabled');
  });

  it("drops forward history after a new destination and refreshes the current detail", async () => {
    const { host, manager, restorer } = setup();
    const source = dataSource();
    const definition = vi.spyOn(source, "definition");
    const onCommand = vi.fn();
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: source, scope: "project", onCommand });
    await provider.showList();
    await provider.showDetail("api:project:Task.Query");
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "back" });
    await provider.showList("user");
    expect(host.created[0]!.panel.html).toContain('title="Forward" disabled');
    await provider.showDetail("api:project:Task.Query");
    await provider.handleMessage(provider.listTabKey, { type: "resourceCommand", command: "dext.reloadMethods" });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(definition).toHaveBeenCalledTimes(3);
    expect(host.created[0]!.panel.html).toContain('aria-current="page">Task.Query');
    expect(host.created).toHaveLength(1);
  });

  it("keeps navigation available if a previously visited API disappears", async () => {
    const { host, manager, restorer } = setup();
    const source = dataSource();
    const provider = new ApiEditorProvider({ manager, restorer, dataSource: source, scope: "project" });
    await provider.showList();
    await provider.showDetail("api:project:Task.Query");
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "back" });
    source.definition = async () => undefined;
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "forward" });
    expect(host.created[0]!.panel.html).toContain('data-resource-error="1"');
    await provider.handleMessage(provider.listTabKey, { type: "resourceNavigate", direction: "back" });
    expect(host.created[0]!.panel.html).toContain('data-resource-search');
  });
});

describe("Global Resources editor tab", () => {
  it("keeps categories, refresh and the existing resource operations", async () => {
    const { host, manager, restorer } = setup();
    const provider = new GlobalResourcesEditorProvider({ manager, restorer, dataSource: dataSource(), scope: "global" });
    expect(provider.resourceKinds).toEqual(["mcp", "rule", "skill"]);
    await provider.showList();
    expect(host.created[0]!.panel.html).toContain("reloadMethods");
    await provider.handleMessage(provider.listTabKey, { type: "refresh" });
    expect(host.created).toHaveLength(1);
  });
});
