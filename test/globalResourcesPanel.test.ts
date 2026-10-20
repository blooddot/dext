import { describe, expect, it, vi } from "vitest";
import { GlobalResourcesEditorProvider } from "../src/globalResourcesEditorProvider.js";
import { EditorTabManager, type EditorTabPanelHandle } from "../src/platform/editor-tabs/editorTabManager.js";
import { EditorTabRestorer } from "../src/platform/editor-tabs/editorTabSerializer.js";
import { buildResourceList, createFileResourceDataSource, type ResourceEditorDataSource, type ResourceEntry } from "../src/resourceDocuments.js";
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
  it("shows unregistered project files, opens their detail, and forwards source and creation actions", async () => {
    let files = [{ name: "git.commit", path: "git/commit.ts", scope: "project" as const }];
    const dataSource = createFileResourceDataSource({
      roots: () => ({ project: "C:/project/.dext", global: "C:/global" }),
      listFiles: async kind => kind === "api" ? files : [],
      readFile: async () => "export function commit() {}"
    });
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const onCommand = vi.fn();
    const provider = new GlobalResourcesEditorProvider({
      manager, restorer: new EditorTabRestorer(manager), dataSource, scope: "global", onCommand
    }, ["api", "mcp", "rule", "skill"]);
    await provider.showList();
    expect(host.created[0]!.panel.html).not.toContain('data-resource-open="api:project:git/commit.ts"');
    await provider.handleMessage(provider.listTabKey, { type: "resourceScope", scope: "project" });
    expect(host.created[0]!.panel.html).toContain('data-resource-open="api:project:git/commit.ts"');
    expect(host.created[0]!.panel.html).toContain('data-resource-node="API.git"');
    await provider.handleMessage(provider.listTabKey, { type: "resourceOpen", id: "api:project:git/commit.ts" });
    expect(host.created[0]!.panel.html).toContain('data-resource-path="C:/project/.dext/api/git/commit.ts"');
    for (const payload of [
      { command: "dext.openResourceSource", path: "C:/project/.dext/api/git/commit.ts" },
      { command: "dext.insertResourceReference", id: "api:project:git/commit.ts" },
      { command: "dext.newResource", kind: "api" }
    ]) {
      await provider.handleMessage(provider.listTabKey, { type: "resourceCommand", ...payload });
      const { command, ...parameters } = payload;
      expect(onCommand).toHaveBeenLastCalledWith(command, { scope: "project", ...parameters });
    }
    await provider.showList();
    files = [];
    await provider.handleMessage(provider.listTabKey, { type: "resourceCommand", command: "dext.reloadMethods" });
    expect(host.created[0]!.panel.html).toContain("No API resources found.");
  });

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

  it("files MCP tool APIs under MCP and nests each category like the API page", () => {
    const api = (name: string, group: string): ResourceEntry => ({
      ...entry("api", name),
      scope: "project",
      group,
      api: { signature: `${name}() -> AskResult`, parameters: [], returnType: "AskResult" }
    });
    const document = buildResourceList({
      kind: "api",
      scope: "project",
      groupBy: "kind",
      entries: [api("dev.feat", "dev"), api("dev.fix", "dev"), api("dev.plan", "dev"), api("mcp.files.read", "mcp.files")]
    });
    const html = renderGlobalResources(document, { createKinds: ["api", "mcp", "rule", "skill"], title: "Resources" });
    const apiCategory = html.slice(html.indexOf('data-resource-group="API"'), html.indexOf('data-resource-group="MCP"'));
    const mcpCategory = html.slice(html.indexOf('data-resource-group="MCP"'));
    // dev is the first level and feat/fix/plan are its second level instead of one flat API list.
    expect(apiCategory).toContain('data-resource-node="API.dev"');
    expect(apiCategory).toContain(">feat<");
    expect(apiCategory).toContain(">fix<");
    expect(apiCategory).toContain(">plan<");
    // An MCP tool is a callable API, but it is listed under MCP rather than under API.
    expect(apiCategory).not.toContain("mcp.files.read");
    expect(mcpCategory).toContain('data-resource-node="MCP.files"');
    expect(mcpCategory).toContain("mcp.files.read");
    expect(mcpCategory).toContain(">read<");
  });

  it("lists only current files, preserving nested paths and actual MCP filenames", async () => {
    const readFile = vi.fn(async (): Promise<string | undefined> => "source");
    const listFiles = vi.fn(async (kind: Exclude<ResourceKind, "file">) => {
      const path = { api: "git/commit.ts", mcp: "servers.json", rule: "team/style.md", skill: "team/release/SKILL.md" }[kind];
      return [{ name: kind, path, scope: "global" as const }];
    });
    const dataSource = createFileResourceDataSource({
      roots: () => ({ global: "/home/.dext" }), listFiles, readFile
    });
    const apis = await dataSource.list(["api"], "");
    expect(apis.map(item => item.path)).toEqual(["git/commit.ts"]);
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledWith("api");
    expect(readFile).not.toHaveBeenCalled();
    const globals = await dataSource.list(["mcp", "rule", "skill"], "");
    expect(globals.map(item => item.source.path)).toEqual([
      "/home/.dext/mcp/servers.json", "/home/.dext/rules/team/style.md", "/home/.dext/skills/team/release/SKILL.md"
    ]);
    expect((await dataSource.definition("mcp:global:servers.json"))?.content).toBe("source");
    readFile.mockResolvedValueOnce(undefined);
    expect(await dataSource.definition("mcp:global:servers.json")).toBeUndefined();
  });
});
