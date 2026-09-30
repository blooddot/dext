import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiReferenceSource, parseApiReference, type ApiReferenceCatalog } from "../src/core/apiReference.js";
import { apiReferenceEntries, buildResourceList, createSidebarResourceDataSource, renderResourceDefinition, renderResourceList } from "../src/resourceDocuments.js";
import { ApiEditorProvider } from "../src/apiEditorProvider.js";
import { EditorTabManager, type EditorTabCallbacks, type EditorTabPanelHandle } from "../src/editorTabManager.js";
import { EditorTabRestorer } from "../src/editorTabSerializer.js";
import type { SidebarState } from "../src/webviewProtocol.js";

class FakePanel implements EditorTabPanelHandle {
  html = "";
  dispose(): void {}
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

const catalog = (): ApiReferenceCatalog => ({
  version: 1,
  typescript: "5.9.3",
  modules: [
    {
      id: "node:path",
      family: "node",
      name: "path",
      documentation: "Utilities for working with file and directory paths.",
      members: [
        {
          name: "join",
          kind: "function",
          signature: "join(...paths: string[]): string",
          documentation: "Joins all given path segments together.",
          params: [{ name: "paths", text: "The path segments to join." }],
          returns: "The joined path."
        },
        {
          name: "PlatformPath",
          kind: "interface",
          signature: "interface PlatformPath",
          members: [{ name: "sep", kind: "variable", signature: "sep: string", deprecated: "Use the exported constant." }]
        }
      ]
    },
    {
      id: "js.JSON",
      family: "js",
      name: "JSON",
      members: [{
        name: "JSON",
        kind: "namespace",
        signature: "namespace JSON",
        documentation: "An intrinsic object that converts values to and from JSON.",
        members: [{
          name: "parse",
          kind: "function",
          signature: "parse(text: string): any",
          documentation: "Parses a JSON string.",
          example: 'JSON.parse("{}")'
        }]
      }]
    }
  ]
});

/** A sidebar state with one built-in API, so the data source can be exercised
 * without a workspace. */
function state(): SidebarState {
  return {
    methods: [{ id: "ask", title: "Ask", description: "Ask something.", kind: "command", source: "builtin", input: [], output: { kind: "ask" } }],
    diagnostics: [],
    mcpServers: [],
    globalDiagnostics: [],
    globalResources: { apis: [], mcps: [], rules: [], skills: [] },
    resourceRoots: {},
    agentProfiles: [],
    agentSelection: { profileId: "codex", model: "" },
    settings: {}
  } as unknown as SidebarState;
}

const teardown: string[] = [];
afterEach(async () => {
  for (const directory of teardown.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("API reference catalog", () => {
  it("parses a catalog and rejects a truncated, future or malformed one", () => {
    expect(parseApiReference(JSON.stringify(catalog()))?.modules).toHaveLength(2);
    expect(parseApiReference("not json")).toBeUndefined();
    expect(parseApiReference(JSON.stringify({ ...catalog(), version: 99 }))).toBeUndefined();
    expect(parseApiReference(JSON.stringify({ version: 1, modules: [] }))).toBeUndefined();
    // A module whose members are unusable is dropped rather than shown empty.
    const broken = { version: 1, modules: [{ id: "node:path", family: "node", name: "path", members: [{ name: "join", kind: "function" }] }] };
    expect(parseApiReference(JSON.stringify(broken))).toBeUndefined();
    const mixed = { version: 1, modules: [
      { id: "node:path", family: "node", name: "path", members: [{ name: "join", kind: "function", signature: "join(): string" }] },
      { id: "js.JSON", family: "javascript", name: "JSON", members: [{ name: "JSON", kind: "namespace", signature: "namespace JSON" }] },
      { id: "js.Math", family: "js", name: "Math", members: [] }
    ] };
    expect(parseApiReference(JSON.stringify(mixed))?.modules.map((module) => module.id)).toEqual(["node:path"]);
  });

  it("lists one entry per module, grouped as node or js and read-only", () => {
    const entries = apiReferenceEntries(catalog());
    expect(entries.map((entry) => [entry.group, entry.name, entry.displayName])).toEqual([
      ["node", "node:path", "path"],
      ["js", "js.JSON", "JSON"]
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    for (const entry of entries) {
      expect(entry.kind).toBe("api");
      expect(entry.reference).toBeDefined();
      // A reference is a declaration, not a resource file: nothing to open or run.
      expect(entry.source).toEqual({ kind: "directory", label: entry.group === "node" ? "module" : "global" });
      expect(entry.api).toBeUndefined();
    }
    expect(entries[0]!.description).toBe("Utilities for working with file and directory paths.");
    expect(entries[1]!.description).toBe("1 member from the TypeScript declaration");
    expect(apiReferenceEntries(undefined)).toEqual([]);
  });

  it("shows node and js as their own groups beside Top level", () => {
    const document = buildResourceList({ kind: "api", scope: "global", entries: apiReferenceEntries(catalog()) });
    const html = renderResourceList(document, { apiTree: true });
    expect(html).toMatch(/data-resource-node="node"[\s\S]*>path</);
    expect(html).toMatch(/data-resource-node="js"[\s\S]*>JSON</);
    // A member is searchable even though the row is the module that documents it.
    expect(html).toMatch(/data-resource-search-text="js\.JSON[^"]*parse/);
    const top = html.slice(html.indexOf('data-resource-node="."'), html.indexOf('data-resource-node="js"'));
    expect(top).not.toContain("node:path");
  });

  it("renders every member's own signature and JSDoc on the detail page", () => {
    const entry = apiReferenceEntries(catalog())[0]!;
    const html = renderResourceDefinition({ entry, content: "", source: entry.source });
    expect(html).toContain('<code>node:path</code>');
    expect(html).toContain('data-resource-copy="node:path"');
    // Members are grouped, and each one carries the declaration's signature and docs.
    expect(html).toContain("Functions");
    expect(html).toContain("join(...paths: string[]): string");
    expect(html).toContain("Joins all given path segments together.");
    expect(html).toContain("The path segments to join.");
    expect(html).toContain("The joined path.");
    expect(html).toContain("interface PlatformPath");
    expect(html).toContain("sep: string");
    expect(html).toContain("Deprecated");
    // The nested namespace of a global is expanded, and an example is kept as code.
    const jsonEntry = apiReferenceEntries(catalog())[1]!;
    const json = renderResourceDefinition({ entry: jsonEntry, content: "", source: jsonEntry.source });
    expect(json).toContain("An intrinsic object that converts values to and from JSON.");
    expect(json).toContain("parse(text: string): any");
    expect(json).toContain("JSON.parse(&quot;{}&quot;)");
    // A reference has no Dext call to insert and no source file to show.
    expect(html).not.toContain("insertResourceReference");
    expect(html).not.toContain("Source</h3>");
  });

  it("reads the catalog once and keeps a missing one absent without caching the failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-api-reference-"));
    teardown.push(directory);
    const file = join(directory, "api-reference.json");
    await writeFile(file, JSON.stringify(catalog()), "utf8");
    const source = createApiReferenceSource(file);
    expect((await source())?.modules).toHaveLength(2);
    // A second read is served from the cache, so a rewritable file cannot change it.
    await writeFile(file, JSON.stringify({ version: 1, modules: [] }), "utf8");
    expect((await source())?.modules).toHaveLength(2);

    const missing = createApiReferenceSource(join(directory, "absent.json"));
    expect(await missing()).toBeUndefined();
    // The absent file is retried: the next build's catalog is picked up.
    await writeFile(join(directory, "absent.json"), JSON.stringify(catalog()), "utf8");
    expect((await missing())?.modules).toHaveLength(2);
  });

  it("adds the reference to the API list and returns its definition without a file read", async () => {
    const readFile = vi.fn(async () => "export function main(): void {}");
    const dataSource = createSidebarResourceDataSource({ state, readFile, reference: async () => catalog() });
    const listed = await dataSource.list(["api"], "");
    expect(listed.map((entry) => entry.name)).toContain("node:path");
    expect(await dataSource.list(["api"], "json")).toHaveLength(1);
    const definition = await dataSource.definition("api:global:node:path.json");
    expect(definition?.entry.reference?.id).toBe("node:path");
    expect(definition?.content).toBe("");
    expect(readFile).not.toHaveBeenCalled();

    // Without the catalog the page lists the callable APIs alone.
    const without = createSidebarResourceDataSource({ state, readFile });
    expect((await without.list(["api"], "")).map((entry) => entry.name)).toEqual(["ask"]);
  });

  it("copies a specifier through the host rather than the Webview clipboard", async () => {
    const host = new FakeHost();
    const manager = new EditorTabManager(host);
    const copyText = vi.fn();
    const provider = new ApiEditorProvider({
      manager,
      restorer: new EditorTabRestorer(manager),
      dataSource: createSidebarResourceDataSource({ state, reference: async () => catalog() }),
      scope: "project",
      copyText
    });
    await provider.handleMessage(provider.listTabKey, { type: "resourceCopy", text: "node:path", viewState: { query: "", scrollTop: 0 } });
    expect(copyText).toHaveBeenCalledWith("node:path");
  });

  // The shipped catalog is a build artifact (dist/ is not committed), so a
  // checkout that has not been built yet skips this; `npm run check`'s
  // `generateApiReference --check` proves the built file still matches.
  it.skipIf(!existsSync(join(process.cwd(), "dist", "api-reference.json")))("documents the shipped catalog from the declarations", async () => {
    const text = await readFile(join(process.cwd(), "dist", "api-reference.json"), "utf8");
    const shipped = parseApiReference(text);
    expect(shipped).toBeDefined();
    const ids = new Set(shipped!.modules.map((module) => module.id));
    for (const id of ["node:path", "node:fs", "node:fs/promises", "js.JSON", "js.Array"]) expect(ids).toContain(id);
    const module = (id: string) => shipped!.modules.find((candidate) => candidate.id === id)!;
    const joinMember = module("node:path").members.find((member) => member.name === "join")!;
    expect(joinMember.signature).toContain("join(");
    expect(joinMember.documentation).toBeTruthy();
    const json = module("js.JSON").members[0]!;
    const parse = json.members!.find((member) => member.name === "parse")!;
    expect(parse.signature).toContain("parse(");
    expect(parse.documentation).toBeTruthy();
    expect(module("js.Array").members[0]!.members!.some((member) => member.name === "map")).toBe(true);
    for (const candidate of shipped!.modules) expect(candidate.members.length).toBeGreaterThan(0);
  });
});
