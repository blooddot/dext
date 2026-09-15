import { describe, expect, it } from "vitest";
import { GlobalResourcesEditorProvider } from "../src/globalResourcesEditorProvider.js";
import { EditorTabManager, type EditorTabPanelHandle } from "../src/editorTabManager.js";import { EditorTabRestorer } from "../src/editorTabSerializer.js";
import { buildResourceList, createSidebarResourceDataSource, type ResourceEditorDataSource, type ResourceEntry } from "../src/resourceDocuments.js";
import type { ResourceKind } from "../src/resourceSession.js";
import { renderGlobalResources } from "../src/webview/globalResourcesPanel.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  dispose(): void {}
  reveal(): void {}
  setHtml(html: string): void { this.html = html; }
}

class FakeHost {
  readonly created: Array<{ key: string; panel: FakePanel }> = [];
  createPanel(descriptor: { key: string }): EditorTabPanelHandle {
    const panel = new FakePanel();
    this.created.push({ key: descriptor.key, panel });
    return panel;
  }
}

function entry(kind: ResourceKind, name: string): ResourceEntry {
  return {
    id: `${kind}:global:${name}`,
    kind,
    scope: "global",
    name,
    path: `${name}.jsonc`,
    group: kind,
    source: { kind: "global", label: "Global" }
  };
}

describe("global resources panel", () => {
  it("keeps every category and creation action available when no resources exist", () => {
    const html = renderGlobalResources(buildResourceList({ kind: "mcp", scope: "global", entries: [], groupBy: "kind" }));
    for (const label of ["MCP", "Rule", "Skill"]) {
      expect(html).toContain(`data-resource-group="${label}"`);
      expect(html).toContain(`New ${label}`);
    }
    expect(html).toContain("Global Resources");
  });

  it("keeps categories for a multi-kind page", () => {
    const document = buildResourceList({
      kind: "mcp",
      scope: "global",
      entries: [entry("mcp", "files"), entry("rule", "style"), entry("skill", "ship")],
      groupBy: "kind"
    });
    expect(document.groups.map((group) => group.label)).toEqual(["MCP", "Rule", "Skill"]);
  });

  it("lists every configured kind and nothing from the API directory", async () => {
    const requested: Array<readonly ResourceKind[]> = [];
    const dataSource: ResourceEditorDataSource = {
      list: (kinds) => {
        requested.push(kinds);
        return Promise.resolve(kinds.flatMap((kind) => [entry(kind, `${kind}-one`)]));
      },
      definition: () => Promise.resolve(undefined)
    };
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const provider = new GlobalResourcesEditorProvider({
      manager,
      restorer: new EditorTabRestorer(manager),
      dataSource,
      scope: "global"
    });
    await provider.showList();
    expect(requested).toEqual([["mcp", "rule", "skill"]]);
    const html = host.created[0]!.panel.html;
    expect(html).toContain('data-resource-group="MCP"');
    expect(html).toContain('data-resource-group="Rule"');
    expect(html).not.toContain('data-resource-group="API"');
    expect(html).toContain("dext.newResource");
  });

  it("maps sidebar methods and global resources into one searchable data source", async () => {
    const dataSource = createSidebarResourceDataSource({
      state: () => ({
        methods: [{ id: "ask", title: "Ask", description: "Question", kind: "prompt", source: "builtin" }],
        globalResources: {
          apis: [{ name: "ask", detail: "builtin" }],
          mcps: [{ name: "files", detail: "stdio" }],
          rules: [{ name: "style" }],
          skills: [{ name: "ship", detail: "release" }]
        },
        resourceRoots: { global: "/home/.dext" }
      } as never)
    });
    const apis = await dataSource.list(["api"], "");
    expect(apis.map((item) => item.name)).toContain("ask");
    const globals = await dataSource.list(["mcp", "rule", "skill"], "");
    expect(globals.map((item) => `${item.kind}:${item.name}`)).toEqual(["mcp:files", "rule:style", "skill:ship"]);
    // A built-in API lives in the extension bundle, so it has no project or global source path.
    expect(apis[0]?.source.path).toBeUndefined();
    expect(globals[0]?.source.path).toBe("/home/.dext/mcp/files.jsonc");
    expect(await dataSource.list(["mcp"], "release")).toHaveLength(0);
  });
});
