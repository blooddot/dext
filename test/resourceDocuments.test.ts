import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DextApplication } from "../src/app/application.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { resourceFileName, resourceFiles, resourcePathSegments, resourcePrompt, type ResourceSession } from "../src/features/resources/contracts/resourceSession.js";
import { buildResourceList, isMcpApiId, renderResourceList, resourceCategory } from "../src/features/resources/presentation/resourceDocuments.js";
import { createFileResourceDataSource } from "../src/features/resources/host/resourceEditorProvider.js";
import { describeApiFlow } from "../src/features/workflow/host/apiFlow.js";
import { SkillCatalog } from "../src/features/workflow/host/skillCatalog.js";
import type { ResourceEntry } from "../src/features/resources/contracts/resourceDocuments.js";
import { importSkillPack, SKILL_FILE_MAX_BYTES, SKILL_PACK_MAX_FILES, SKILL_PACK_MAX_BYTES, SKILL_SUPPORT_FILE_MAX_BYTES } from "../src/features/resources/host/skillImporter.js";

vi.mock("vscode", () => {
  class FileSystemError extends Error { code = "FileNotFound"; }
  const uri = (path: string) => ({ scheme: "file", fsPath: path, toString: () => path });
  const missing = (error: unknown): never => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new FileSystemError();
    throw error;
  };
  return {
    FileSystemError, FileType: { File: 1, Directory: 2 },
    Uri: { file: uri, joinPath: (root: { fsPath: string }, ...parts: string[]) => uri(join(root.fsPath, ...parts)) },
    workspace: { workspaceFolders: undefined, fs: {
      readDirectory: async (value: { fsPath: string }) => readdir(value.fsPath, { withFileTypes: true }).then((entries) => entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1])).catch(missing),
      readFile: async (value: { fsPath: string }) => readFile(value.fsPath).catch(missing),
      stat: async (value: { fsPath: string }) => stat(value.fsPath).catch(missing),
      createDirectory: async (value: { fsPath: string }) => mkdir(value.fsPath, { recursive: true }),
      delete: async (value: { fsPath: string }) => rm(value.fsPath).catch(missing),
      writeFile: async (value: { fsPath: string }, content: Uint8Array) => writeFile(value.fsPath, content)
    } }
  };
});

let root: string;
let application: DextApplication;
beforeEach(async () => {
  Object.assign(vscode.workspace, { textDocuments: [], workspaceFolders: undefined });
  root = await mkdtemp(join(tmpdir(), "dext-resources-"));
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  application = Object.create(DextApplication.prototype) as DextApplication;
  Object.assign(application, {
    workspaceTrusted: false, resourceWrite: Promise.resolve(),
    storage: { globalStorageUri: { fsPath: root }, attachmentPrompt: (input: string) => `${input}\nResolved attachment context` },
    registry, reload: vi.fn(), skills: new SkillCatalog()
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("resource documents", () => {
  it("discovers unregistered project API files and reads their source without executing them", async () => {
    Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] });
    Object.assign(application, { workspaceTrusted: true });
    const project = join(root, ".dext");
    await mkdir(join(project, "api/git"), { recursive: true });
    await mkdir(join(project, "rules/team"), { recursive: true });
    await mkdir(join(project, "skills/release"), { recursive: true });
    await mkdir(join(project, "mcp"), { recursive: true });
    await mkdir(join(root, "api"), { recursive: true });
    const content = 'throw new Error("Must never execute during discovery");\nexport function commit() {}\n';
    await writeFile(join(project, "api/git/commit.ts"), content);
    await writeFile(join(project, "api/dext.d.ts"), 'declare module "dext" {}');
    await writeFile(join(root, "api/ask.ts"), 'export function main() {}');
    await writeFile(join(project, "rules/team/style.md"), '# Style');
    await writeFile(join(project, "skills/release/SKILL.md"), '# Release');
    await writeFile(join(project, "mcp/config.jsonc"), '{"name":"different-name"}');
    const dataSource = createFileResourceDataSource({
      roots: () => ({ project, global: root }),
      listFiles: kind => application.listResources(kind),
      readFile: entry => readFile(entry.source.path!, "utf8")
    });
    const apis = await dataSource.list(["api"], "");
    expect(apis.filter(entry => entry.scope === "project").map(entry => entry.name)).toEqual(["git.commit"]);
    expect(apis.filter(entry => entry.name === "ask")).toHaveLength(1);
    expect(apis.find(entry => entry.id === "api:global:ask.ts")?.source.kind).toBe("global");
    const document = await dataSource.definition("api:project:git/commit.ts");
    expect(document?.content).toBe(content);
    expect(document?.entry.source.path?.replaceAll("\\", "/")).toBe(`${project.replaceAll("\\", "/")}/api/git/commit.ts`);
    const other = await dataSource.list(["rule", "skill", "mcp"], "");
    expect(other.map(entry => entry.id)).toEqual(expect.arrayContaining([
      "rule:project:team/style.md", "skill:project:release/SKILL.md", "mcp:project:config.jsonc"
    ]));
    expect(other.find(entry => entry.id === "rule:project:team/style.md")?.group).toBe("team");
    expect(other.find(entry => entry.id === "skill:project:release/SKILL.md")?.group).toBe(".");
    expect((await dataSource.definition("mcp:project:config.jsonc"))?.content).toContain("different-name");
    await rm(join(project, "api/git/commit.ts"));
    expect(await dataSource.list(["api"], "git.commit")).toEqual([]);
    expect(await dataSource.definition("api:project:git/commit.ts")).toBeUndefined();
    Object.assign(application, { workspaceTrusted: false });
    expect((await dataSource.list(["rule", "skill", "mcp"], "")).filter(entry => entry.scope === "project")).toEqual([]);
  });

  it("initializes the workspace package once and preserves it on API reload", async () => {
    Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] });
    Object.assign(application, { workspaceImportsDext: async () => true });
    await mkdir(join(root, ".dext", "api"), { recursive: true });
    const writer = application as unknown as { writeWorkspaceDextProject(methods: []): Promise<void> };
    await writer.writeWorkspaceDextProject([]);
    const path = join(root, ".dext", "package.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ type: "module", devDependencies: { "@types/node": "^22" } });
    const content = '{"type":"module","dependencies":{"parse5":"7.3.0"},"scripts":{"test":"node --test"}}\n';
    await writeFile(path, content);
    await writeFile(join(root, ".dext", "api", "dext.d.ts"), "outdated");
    await writer.writeWorkspaceDextProject([]);
    expect(await readFile(path, "utf8")).toBe(content);
    expect(await readFile(join(root, ".dext", "api", "dext.d.ts"), "utf8")).toContain('declare module "dext"');
  });

  it("keeps Top level APIs separate from node and ui namespaces", () => {
    const entry = (name: string): ResourceEntry => ({
      id: `api:global:${name}`, kind: "api", scope: "global", name, path: `${name.replaceAll(".", "/")}.ts`,
      group: name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : ".", source: { kind: "directory", label: "builtin" }
    });
    const html = renderResourceList(buildResourceList({ kind: "api", scope: "global", entries: [entry("ask"), entry("node.path"), entry("ui.input")] }), { apiTree: true });
    expect(html).toMatch(/data-resource-node="\."[\s\S]*Top level[\s\S]*ask/);
    expect(html).toMatch(/data-resource-node="node"/);
    expect(html).toMatch(/data-resource-node="ui"/);
    expect(html.indexOf('data-resource-node="node"')).toBeGreaterThan(html.indexOf('data-resource-node="."'));
    const top = html.slice(html.indexOf('data-resource-node="."'), html.indexOf('data-resource-node="node"'));
    expect(top).not.toContain("node.path");
  });

  it("offers the open-directory button only when the page host enables it", () => {
    const document = buildResourceList({ kind: "api", scope: "project", entries: [] });
    expect(renderResourceList(document)).not.toContain("openResourceDirectory");
    const html = renderResourceList(document, { openResourceDirectory: true });
    expect(html).toContain('data-resource-command="dext.openResourceDirectory"');
    expect(html).toContain('title="Open project resources folder"');
    expect(html).toContain('title="Open project resources folder" aria-label="Open project resources folder">');
  });

  it("files MCP tool APIs under the MCP category", () => {
    const api = (name: string, kind: ResourceEntry["kind"] = "api"): ResourceEntry => ({
      id: `${kind}:project:${name}`, kind, scope: "project", name, path: `${name}.ts`, group: ".",
      source: { kind: "project", label: "Project" }
    });
    expect(resourceCategory(api("mcp.files.read"))).toBe("mcp");
    expect(resourceCategory(api("mcp.files.read", "mcp"))).toBe("mcp");
    expect(resourceCategory(api("dev.feat"))).toBe("api");
    // `mcp` on its own is an ordinary namespace, not an MCP tool id.
    expect(resourceCategory(api("mcp.files"))).toBe("api");
    expect(isMcpApiId("mcp.files.read")).toBe(true);
    expect(isMcpApiId("mcpx.files.read")).toBe(false);
  });

  it.each([
    ["api", "team.lookup", "team/lookup.ts"], ["mcp", "server", "server.jsonc"],
    ["rule", "review.md", "review.md"], ["skill", "release", "release/SKILL.md"]
  ] as const)("maps %s names to their real resource paths", (type, name, path) => {
    expect(resourceFileName(type, name)).toBe(path);
  });

  it("rejects traversal, mismatched types, and unsafe names", () => {
    for (const path of ["../outside.md", "C:/outside.md", "safe/../outside.md", "safe\\outside.md", "rule.ts"]) {
      expect(() => resourcePathSegments("rule", path)).toThrow();
    }
    expect(() => resourceFileName("skill", "../bad")).toThrow();
    expect(() => resourceFileName("api", "a..b")).toThrow();
  });

  it.each([
    ["api", "sample", 'export async function main(input: string): Promise<AskResult> {\n  return await ask({ input });\n}\n', "api/sample.ts"],
    ["rule", "review.md", "Review changes.\n", "rules/review.md"],
    ["skill", "release", "# Release\nVerify first.\n", "skills/release/SKILL.md"],
    ["mcp", "server", '{"name":"server","transport":"stdio","command":"node","tools":[]}\n', "mcp/server.jsonc"]
  ] as const)("creates %s only at the confirmed destination and refuses duplicates", async (type, name, content, path) => {
    const resource: ResourceSession = { type, scope: "global", draft: { name, content } };
    const saved = await application.saveResource(resource);
    expect(saved.content).toBe(content);
    expect(await readFile(join(root, path), "utf8")).toBe(content);
    await expect(application.saveResource(resource)).rejects.toThrow("already exists");
  });

  it("updates the selected file and rejects edits made after it was loaded", async () => {
    const resource: ResourceSession = { type: "rule", scope: "global", draft: { name: "review", content: "Original" } };
    resource.target = await application.saveResource(resource);
    resource.draft = { name: "review", content: "Revised" };
    resource.target = await application.saveResource(resource);
    expect(await readFile(join(root, "rules/review.md"), "utf8")).toBe("Revised\n");
    await writeFile(join(root, "rules/review.md"), "Changed by editor\n");
    resource.draft.content = "Stale draft";
    await expect(application.saveResource(resource)).rejects.toThrow("changed on disk");
    expect(await readFile(join(root, "rules/review.md"), "utf8")).toBe("Changed by editor\n");
  });

  it("serializes concurrent saves so two tabs cannot overwrite the same version", async () => {
    const original: ResourceSession = { type: "rule", scope: "global", draft: { name: "review", content: "Original" } };
    const target = await application.saveResource(original);
    const first: ResourceSession = { type: "rule", scope: "global", target, draft: { name: "review", content: "First tab" } };
    const second: ResourceSession = { ...first, draft: { name: "review", content: "Second tab" } };
    const results = await Promise.allSettled([application.saveResource(first), application.saveResource(second)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(await readFile(join(root, "rules/review.md"), "utf8")).toBe("First tab\n");
  });

  it("refuses to overwrite unsaved editor changes", async () => {
    const resource: ResourceSession = { type: "rule", scope: "global", draft: { name: "review", content: "Original" } };
    resource.target = await application.saveResource(resource);
    Object.assign(vscode.workspace, { textDocuments: [{ uri: { toString: () => join(root, "rules/review.md") }, isDirty: true }] });
    resource.draft = { name: "review", content: "Revised" };
    await expect(application.saveResource(resource)).rejects.toThrow("unsaved editor changes");
    expect(await readFile(join(root, "rules/review.md"), "utf8")).toBe("Original\n");
  });

  it("lists nested resources and reads MCP names independently of filenames", async () => {
    await mkdir(join(root, "api/team"), { recursive: true });
    await writeFile(join(root, "api/team/lookup.ts"), "export function main() { return 1; }\n");
    await writeFile(join(root, "api/team/ignore.md"), "Not an API");
    await mkdir(join(root, "mcp"));
    await writeFile(join(root, "mcp/settings.jsonc"), '{"name":"server","transport":"stdio","command":"node","tools":[]}');
    expect(await application.listResources("api")).toEqual([{ name: "team.lookup", path: "team/lookup.ts", scope: "global" }]);
    expect(await application.readResource("mcp", "global", "settings.jsonc", "settings")).toMatchObject({ name: "server", path: "settings.jsonc" });
  });

  it("discovers nested MCP manifests and classifies them by directory", async () => {
    await mkdir(join(root, "mcp/git"), { recursive: true });
    await writeFile(join(root, "mcp/git/server.jsonc"), '{"name":"server","transport":"stdio","command":"node","tools":[]}');
    expect(await application.listResources("mcp")).toEqual([{ name: "server", path: "git/server.jsonc", scope: "global" }]);
    expect(resourcePathSegments("mcp", "git/server.jsonc")).toEqual(["git", "server.jsonc"]);
    const dataSource = createFileResourceDataSource({
      roots: () => ({ global: root }),
      listFiles: kind => application.listResources(kind),
      readFile: entry => readFile(entry.source.path!, "utf8")
    });
    const [manifest] = await dataSource.list(["mcp"], "");
    expect(manifest).toMatchObject({ kind: "mcp", name: "server", path: "git/server.jsonc", group: "git" });
    expect((await dataSource.definition("mcp:global:git/server.jsonc"))?.content).toContain('"name":"server"');
  });

  it("documents the single-purpose wrapper rule when creating an API", () => {
    const prompt = resourcePrompt({ type: "api", scope: "global" }, "Create an API");
    expect(prompt).toContain("exactly one responsibility");
    expect(prompt).toContain("only that one top-level API call");
    expect(prompt).toContain("Entry functions only compose named wrappers and ordinary helpers");
    expect(prompt).toContain("askForPlan");
    expect(prompt).toContain("runAgent");
    expect(prompt).toContain("export async function main");
  });

  it("blocks a new API that mixes top-level API calls", async () => {
    application.setApiFlowAnalyzer(describeApiFlow);
    const resource: ResourceSession = { type: "api", scope: "global", draft: {
      name: "mixed",
      content: 'import { ask, agent } from "dext";\nexport function main() { return Promise.all([ask({}), agent({})]); }'
    } };
    await expect(application.saveResource(resource)).rejects.toThrow(/main/);
    await expect(application.saveResource(resource)).rejects.toThrow(/ask and agent/);
    await expect(application.saveResource(resource)).rejects.toThrow(/one named wrapper|own named wrapper/);
    expect(await readdir(root)).toEqual([]);
  });

  it("only warns when an existing API breaks the wrapper rule", async () => {
    const resource: ResourceSession = { type: "api", scope: "global", draft: {
      name: "legacy",
      content: 'import { ask } from "dext";\nexport function main() { return ask({}); }'
    } };
    resource.target = await application.saveResource(resource);
    application.setApiFlowAnalyzer(describeApiFlow);
    resource.draft = {
      name: "legacy",
      content: 'import { ask, agent } from "dext";\nexport function main() { return Promise.all([ask({}), agent({})]); }'
    };
    await expect(application.saveResource(resource)).resolves.toMatchObject({ name: "legacy" });
  });

  it("surfaces flow issues in the generated draft text", async () => {
    application.setApiFlowAnalyzer(describeApiFlow);
    const content = 'import { ask, agent } from "dext";\nexport function main() { return Promise.all([ask({}), agent({})]); }';
    const execute = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify({ name: "mixed", content }) } }));
    Object.assign(application, { runtime: { executeConversation: execute } });
    const result = await application.draftResource({ type: "api", scope: "global" }, "Create an API");
    expect(result.draft.content).toBe(content);
    const text = result.response.kind === "workflow" ? (result.response.executions[0]!.result as { text: string }).text : "";
    expect(text).toContain("API flow issues:");
    expect(text).toContain("main");
    expect(text).toContain("wrapper");
    expect(await readdir(root)).toEqual([]);
  });

  it("generates a read-only draft using the current content and attachment context without writing files", async () => {
    const execute = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify({ name: "review", content: "Revised rule" }) } }));
    Object.assign(application, { runtime: { executeConversation: execute } });
    const resource: ResourceSession = { type: "rule", scope: "global", target: { name: "review", path: "review.md", content: "Original rule" } };
    const result = await application.draftResource(resource, "Make it concise", { agentSessionId: "one" });
    expect(execute.mock.calls[0]).toEqual(["ask", expect.stringContaining("Original rule"), { agentSessionId: "one", resourceSource: "describe" }]);
    expect(execute.mock.calls[0]).toEqual(["ask", expect.stringContaining("Resolved attachment context"), expect.anything()]);
    expect(result.draft.content).toBe("Revised rule");
    expect(await readdir(root)).toEqual([]);
    resource.draft = result.draft;
    expect(resourcePrompt(resource, "Continue")).toContain("Revised rule");
  });

  it("rejects import outside a pristine new Skill before calling the model", async () => {
    const execute = vi.fn();
    Object.assign(application, { runtime: { executeConversation: execute } });
    const cases: ResourceSession[] = [
      { type: "rule", scope: "global" },
      { type: "skill", scope: "global", target: { name: "review", path: "review/SKILL.md", content: "# Review" } },
      { type: "skill", scope: "global", draft: { name: "review", content: "# Review" } }
    ];
    for (const resource of cases) {
      await expect(application.draftResource(resource, "https://github.com/acme/skills", { resourceSource: "import" }))
        .rejects.toThrow("Import is only available for a new Skill with no existing draft.");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("builds an imported Skill pack draft without calling the model and renders the report first", async () => {
    const execute = vi.fn();
    Object.assign(application, { runtime: { executeConversation: execute } });
    const manifest = {
      name: "ponytail",
      version: 1 as const,
      source: "https://github.com/acme/ponytail",
      importedAt: "2026-10-26T00:00:00.000Z",
      skills: [
        { id: "ponytail", name: "Ponytail", description: "Lean code", directory: "skills/ponytail", commands: [], warnings: [] },
        { id: "ponytail-audit", name: "Audit", description: "Audit code", directory: "skills/ponytail-audit", commands: [], warnings: [] }
      ],
      commands: [],
      analysis: { mode: "deterministic" as const, selected: ["skills/ponytail", "skills/ponytail-audit"], excluded: [], skipped: [] }
    };
    const imported = {
      primarySkillId: "ponytail",
      report: "# ponytail skill pack\n\nDiscovery: deterministic",
      manifest,
      draft: {
        name: "ponytail",
        content: "---\nname: ponytail\ndescription: Lean code\n---\n# Ponytail\n",
        files: [
          { path: "skills/ponytail-audit/SKILL.md", content: "---\nname: Audit\n---\n# Audit\n" },
          { path: "skill-packs/ponytail/pack.json", content: JSON.stringify(manifest) },
          { path: "skill-packs/ponytail/SOURCE.md", content: "# ponytail skill pack" }
        ]
      }
    };
    const importSkillPack = vi.fn(async () => imported);
    Object.assign(application, { importSkillPack });
    const resource: ResourceSession = { type: "skill", scope: "global" };
    const result = await application.draftResource(resource, "https://github.com/acme/ponytail", { resourceSource: "import" });
    expect(importSkillPack).toHaveBeenCalledWith("https://github.com/acme/ponytail", expect.objectContaining({
      analyzer: expect.any(Function)
    }));
    expect(execute).not.toHaveBeenCalled();
    expect(resource.origin).toBe("import");
    expect(result.draft).toEqual(imported.draft);
    const text = result.response.executions[0]!.result.kind === "ask" ? result.response.executions[0]!.result.text : "";
    expect(text.indexOf("Discovery: deterministic")).toBeLessThan(text.indexOf("Draft: skills/ponytail/SKILL.md"));
    expect(text).toContain("Draft: skills/ponytail-audit/SKILL.md");
    expect(text).toContain("Draft: skill-packs/ponytail/pack.json");

    // Retrying an import turn replaces its own unsaved draft.
    resource.draft = result.draft;
    await expect(application.draftResource(resource, "https://github.com/acme/ponytail", { resourceSource: "import" }))
      .resolves.toMatchObject({ draft: imported.draft });
  });

  it("routes the ambiguity analyzer through structured output or an Ask fallback and emits one status", async () => {
    const imported = {
      primarySkillId: "review",
      report: "report",
      manifest: {} as never,
      draft: {
        name: "review", content: "# Review\n",
        files: [{ path: "skill-packs/p/pack.json", content: "{}" }]
      }
    };
    let analyzer: ((request: unknown) => Promise<unknown>) | undefined;
    Object.assign(application, {
      importSkillPack: vi.fn(async (_input: string, options: { analyzer: (request: unknown) => Promise<unknown> }) => {
        analyzer = options.analyzer;
        return imported;
      }),
      agents: {
        currentSelection: () => ({ profileId: "codex", model: "gpt-5", reasoningEffort: "high", speed: "standard", serviceTier: "default" }),
        list: () => [{ id: "codex", provider: "codex", label: "Codex", command: "codex", models: ["gpt-5"] }]
      }
    });
    const structured = vi.fn(async (_input: string, _schema: object, _metadata: Readonly<Record<string, unknown>>) => {
      void _input; void _schema; void _metadata;
      return { text: JSON.stringify({ packName: "p", skillDirectories: ["skills/review"], excluded: [], confidence: "high", summary: "ok" }) };
    });
    const ask = vi.fn();
    const onAgentEvent = vi.fn();
    Object.assign(application, { runtime: { executeStructuredJson: structured, executeConversation: ask } });
    await application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/skills", {
      resourceSource: "import", onAgentEvent,
      model: "gpt-5", reasoningEffort: "high", speed: "standard", serviceTier: "default"
    });
    const selection = await analyzer!({
      repository: "https://github.com/acme/skills",
      sourceUrl: "https://github.com/acme/skills",
      candidates: [{ directory: "skills/review", id: "review", fileCount: 1, shallow: "ok" }]
    });
    expect(selection).toMatchObject({ packName: "p", skillDirectories: ["skills/review"] });
    expect(structured).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(onAgentEvent).toHaveBeenCalledOnce();
    expect(onAgentEvent.mock.calls[0]?.[0]).toMatchObject({ title: "Analyzing repository structure" });
    const metadata = structured.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(metadata).toMatchObject({ agent: "codex", model: "gpt-5", reasoningEffort: "high", speed: "standard", serviceTier: "default" });
    expect(metadata).not.toHaveProperty("ui");
    expect(metadata).not.toHaveProperty("conversationContext");

    // Harness cannot use the provider structured-output channel, so it asks.
    Object.assign(application, {
      agents: {
        currentSelection: () => ({ profileId: "deepseek-harness" }),
        list: () => [{ id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: "dsh", models: [] }]
      }
    });
    const asked = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify({ packName: "p", skillDirectories: ["skills/review"], excluded: [], confidence: "high", summary: "ok" }) } }));
    Object.assign(application, { runtime: { executeStructuredJson: structured, executeConversation: asked } });
    await application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/skills", { resourceSource: "import" });
    await analyzer!({
      repository: "https://github.com/acme/skills", sourceUrl: "https://github.com/acme/skills",
      candidates: [{ directory: "skills/review", id: "review", fileCount: 1, shallow: "ok" }]
    });
    expect(asked).toHaveBeenCalledOnce();
    expect(structured).toHaveBeenCalledOnce();

    // An unsupported structured channel falls back to Ask.
    const unsupported = vi.fn(async () => { throw new Error("Agent 'Codex' does not support the provider's native structured output."); });
    Object.assign(application, {
      agents: {
        currentSelection: () => ({ profileId: "codex" }),
        list: () => [{ id: "codex", provider: "codex", label: "Codex", command: "codex", models: [] }]
      },
      runtime: { executeStructuredJson: unsupported, executeConversation: asked }
    });
    await application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/skills", { resourceSource: "import" });
    await analyzer!({
      repository: "https://github.com/acme/skills", sourceUrl: "https://github.com/acme/skills",
      candidates: [{ directory: "skills/review", id: "review", fileCount: 1, shallow: "ok" }]
    });
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it("rejects import shapes before analysis and a bare GitHub URL in Describe mode", async () => {
    const execute = vi.fn();
    const importSkillPack = vi.fn();
    Object.assign(application, { runtime: { executeConversation: execute }, importSkillPack });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "describe a skill", { resourceSource: "import" }))
      .rejects.toThrow("Import needs a single public GitHub");
    expect(importSkillPack).not.toHaveBeenCalled();
    await expect(application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/ponytail"))
      .rejects.toThrow("Switch to Import");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preflights existing pack and skill targets again before writing", async () => {
    const imported = {
      primarySkillId: "ponytail",
      report: "report",
      manifest: {} as never,
      draft: {
        name: "ponytail",
        content: "---\nname: ponytail\n---\n# Ponytail\n",
        files: [
          { path: "skills/ponytail-audit/SKILL.md", content: "# Audit\n" },
          { path: "skill-packs/ponytail/pack.json", content: "{}" }
        ]
      }
    };
    Object.assign(application, { importSkillPack: vi.fn(async () => imported) });
    await mkdir(join(root, "skill-packs", "ponytail"), { recursive: true });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/ponytail", { resourceSource: "import" }))
      .rejects.toThrow("already installed");

    await rm(join(root, "skill-packs"), { recursive: true, force: true });
    await mkdir(join(root, "skills", "ponytail-audit"), { recursive: true });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "https://github.com/acme/ponytail", { resourceSource: "import" }))
      .rejects.toThrow("Skill 'ponytail-audit' already exists");

    // A target created between draft and Create is re-checked and nothing is staged.
    await rm(join(root, "skills"), { recursive: true, force: true });
    Object.assign(application, { importSkillPack: vi.fn(async () => imported) });
    const resource: ResourceSession = { type: "skill", scope: "global", origin: "import" };
    await mkdir(join(root, "skill-packs", "ponytail"), { recursive: true });
    await expect(application.saveResource({ ...resource, draft: imported.draft })).rejects.toThrow("already installed");
    await expect(readdir(join(root, "skills"))).rejects.toThrow();
  });

  it("writes every pack file and reloads a grouped skill catalog", async () => {
    const manifest = {
      name: "ponytail",
      version: 1 as const,
      source: "https://github.com/acme/ponytail",
      importedAt: "2026-10-26T00:00:00.000Z",
      skills: [
        { id: "ponytail", name: "Ponytail", description: "Lean code", directory: "skills/ponytail", commands: [], warnings: [] },
        { id: "ponytail-audit", name: "Audit", description: "Audit code", directory: "skills/ponytail-audit", commands: [], warnings: [] }
      ],
      commands: [],
      analysis: { mode: "deterministic" as const, selected: ["skills/ponytail", "skills/ponytail-audit"], excluded: [], skipped: [] }
    };
    const draft = {
      name: "ponytail",
      content: "---\nname: ponytail\ndescription: Lean code\n---\n# Ponytail\n",
      files: [
        { path: "skills/ponytail-audit/SKILL.md", content: "---\nname: Audit\ndescription: Audit code\n---\n# Audit\n" },
        { path: "skill-packs/ponytail/pack.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
        { path: "skill-packs/ponytail/SOURCE.md", content: "# pack\n" }
      ]
    };
    const saved = await application.saveResource({ type: "skill", scope: "global", origin: "import", draft });
    expect(saved.path).toBe("ponytail/SKILL.md");
    expect(await readFile(join(root, "skills/ponytail/SKILL.md"), "utf8")).toContain("name: ponytail");
    expect(await readFile(join(root, "skills/ponytail-audit/SKILL.md"), "utf8")).toContain("name: Audit");
    expect(await readFile(join(root, "skill-packs/ponytail/pack.json"), "utf8")).toContain('"ponytail-audit"');

    await application.skills.reload(root, [], join(root, "skills"));
    expect(application.skills.list()).toMatchObject([
      { id: "ponytail", packId: "ponytail", packName: "ponytail" },
      { id: "ponytail-audit", packId: "ponytail", packName: "ponytail" }
    ]);
  });

  it("imports and saves large skill data files without truncation", async () => {
    const library = {
      "sections.json": JSON.stringify("x".repeat(276_144)),
      "sites.json": JSON.stringify("x".repeat(869_071)),
      "photos.json": JSON.stringify("x".repeat(160_630))
    };
    const imported = await importSkillPack("https://github.com/Leonxlnx/taste-skill.git", { archive: {
      source: { kind: "repo", owner: "Leonxlnx", repo: "taste-skill", path: "", repositoryUrl: "https://github.com/Leonxlnx/taste-skill" },
      ref: "main", commit: "abc1234", files: new Map(Object.entries({
        "skills/taste-skill/SKILL.md": `---\nname: taste-skill\ndescription: Design a page.\n---\n# Taste\n${"界".repeat(100_000)}`,
        ...Object.fromEntries(Object.entries(library).map(([name, content]) => [`skills/taste-skill/library/${name}`, content]))
      }).map(([path, content]) => [path, new TextEncoder().encode(content)]))
    } });
    const saved = await application.saveResource({ type: "skill", scope: "global", origin: "import", draft: imported.draft });
    expect(saved.path).toBe("taste-skill/SKILL.md");
    for (const [name, content] of Object.entries(library)) {
      expect(await readFile(join(root, "skills/taste-skill/library", name), "utf8")).toBe(content);
    }
    const target = await application.readResource("skill", "global", saved.path, saved.name);
    expect(target.content).toBe(imported.draft.content);
    expect((await application.saveResource({ type: "skill", scope: "global", target, draft: target })).content).toBe(target.content);
  });

  it("accepts a 1 MiB SKILL.md and rejects oversized UTF-8 instructions on save and reopen", async () => {
    const draft = { name: "large", content: "x".repeat(SKILL_FILE_MAX_BYTES) };
    const saved = await application.saveResource({ type: "skill", scope: "global", draft });
    expect((await application.readResource("skill", "global", saved.path, saved.name)).content).toBe(draft.content);
    for (const content of [draft.content + "x", "界".repeat(Math.floor(SKILL_FILE_MAX_BYTES / 3) + 1)]) {
      await expect(application.saveResource({ type: "skill", scope: "global", draft: { name: "oversize", content } })).rejects.toThrow("too large");
      await writeFile(join(root, "skills/large/SKILL.md"), content);
      await expect(application.readResource("skill", "global", saved.path, saved.name)).rejects.toThrow("too large");
    }
    await expect(application.saveResource({ type: "rule", scope: "global", draft: { name: "large", content: "x".repeat(200_001) } })).rejects.toThrow("too large");
  });

  it("limits only the skill preview and saves every complete companion", async () => {
    const files = Array.from({ length: 6 }, (_, index) => ({ path: `skills/review/data/${index}.txt`, content: `START-${index}\n${"x".repeat(20_000)}\nEND-${index}` }));
    const draft = { name: "review", content: "# Review", files };
    Object.assign(application, { runtime: { executeConversation: vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify(draft) } })) } });
    const result = await application.draftResource({ type: "skill", scope: "global" }, "Generate");
    const response = result.response.executions[0]!.result;
    const text = response.kind === "ask" ? response.text : "";
    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain("Preview truncated; the complete file will be saved.");
    expect(text).toContain("Draft: skills/review/data/5.txt");
    expect(text).not.toContain("END-0");
    expect(result.draft.files).toEqual(files);
    await application.saveResource({ type: "skill", scope: "global", draft: result.draft });
    for (const file of files) expect(await readFile(join(root, file.path), "utf8")).toBe(file.content);
  });

  it("includes the primary skill in the save byte budget and checks supporting UTF-8 bytes", async () => {
    const content = "x".repeat(SKILL_SUPPORT_FILE_MAX_BYTES);
    await expect(application.saveResource({ type: "skill", scope: "global", draft: {
      name: "review", content: "# Review", files: [
        { path: "skills/review/data/a.txt", content }, { path: "skills/review/data/b.txt", content }
      ]
    } })).rejects.toThrow("too large");
    expect(SKILL_PACK_MAX_BYTES).toBe(2 * SKILL_SUPPORT_FILE_MAX_BYTES);
    expect(await readdir(root)).toEqual([]);
    expect(() => resourceFiles([{ path: "skills/review/data.txt", content: "界界" }], { maxFileBytes: 5 })).toThrow("too large");
    expect(() => resourceFiles([{ path: "skills/review/data.txt", content: "界界" }], { maxTotalBytes: 5 })).toThrow("too large");
  });

  it("applies per-kind skill limits and allows skill-packs only for imported drafts", async () => {
    Object.assign(application, { runtime: { executeConversation: vi.fn(async () => ({
      result: { kind: "ask", text: JSON.stringify({ name: "review", content: "# Review", files: [{ path: "skill-packs/pack/x.md", content: "x" }] }) }
    })) } });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "Generate"))
      .rejects.toThrow("Invalid supporting file path: skill-packs/pack/x.md");

    const many = Array.from({ length: SKILL_PACK_MAX_FILES }, (_, index) => ({ path: `skills/review/file-${index}.md`, content: "x" }));
    Object.assign(application, { runtime: { executeConversation: vi.fn(async () => ({
      result: { kind: "ask", text: JSON.stringify({ name: "review", content: "# Review", files: many }) }
    })) } });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "Generate"))
      .rejects.toThrow(`up to ${SKILL_PACK_MAX_FILES - 1} supporting files`);

    Object.assign(application, { runtime: { executeConversation: vi.fn(async () => ({
      result: { kind: "ask", text: JSON.stringify({ name: "review", content: "# Review", files: [{ path: "skills/other/SKILL.md", content: "x".repeat(SKILL_FILE_MAX_BYTES + 1) }] }) }
    })) } });
    await expect(application.draftResource({ type: "skill", scope: "global" }, "Generate"))
      .rejects.toThrow(`SKILL.md is larger than ${SKILL_FILE_MAX_BYTES} bytes.`);
  });

  it("preserves MCP allowlists and comments when updating", async () => {
    const content = '// Keep this explanation\n{"name":"server","transport":"stdio","command":"node","tools":[{"name":"lookup","inputSchema":{"type":"object"}}]}\n';
    const resource: ResourceSession = { type: "mcp", scope: "global", draft: { name: "server", content } };
    resource.target = await application.saveResource(resource);
    resource.draft!.content = content.replace('"node"', '"node-next"');
    await application.saveResource(resource);
    expect(await readFile(join(root, "mcp/server.jsonc"), "utf8")).toBe(resource.draft!.content);
  });

  const bundle = (): ResourceSession => ({ type: "api", scope: "global", draft: {
    name: "docs.review", content: 'import { ask } from "dext";\nexport function main(input: string) { return ask({ input, rules: ["review.md"] }); }',
    files: [
      { path: "rules/review.md", content: "Review with evidence." },
      { path: "templates/review.md", content: "# Review\n" },
      { path: "skills/review/references/checks.md", content: "Check tests." }
    ]
  } });

  it.each(["global", "project"] as const)("saves a complete %s resource bundle and retains companions on revision", async (scope) => {
    const resource = bundle();
    resource.scope = scope;
    if (scope === "project") {
      Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root) }] });
      Object.assign(application, { workspaceTrusted: true });
    }
    const destination = scope === "project" ? join(root, ".dext") : root;
    resource.target = await application.saveResource(resource);
    for (const file of resource.target.files!) expect(await readFile(join(destination, file.path), "utf8")).toBe(file.content);
    expect(await readFile(join(destination, "api/docs/review.ts"), "utf8")).toContain('rules: ["review.md"]');
    resource.draft = { name: "docs.review", content: resource.target.content, files: [{ path: "rules/review.md", content: "Updated policy" }] };
    resource.target = await application.saveResource(resource);
    expect(resource.target.files).toHaveLength(3);
    expect(await readFile(join(destination, "rules/review.md"), "utf8")).toBe("Updated policy\n");
    resource.draft = { name: "docs.review", content: resource.target.content };
    expect((await application.saveResource(resource)).files).toEqual(resource.target.files);
  });

  it("renders every draft file and preserves companions when the next model response omits them", async () => {
    const resource = bundle();
    const execute = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify(resource.draft) } }));
    Object.assign(application, { runtime: { executeConversation: execute } });
    const result = await application.draftResource({ type: "api", scope: "global" }, "Create review API");
    expect(result.draft.files).toEqual(resource.draft!.files);
    const text = result.response.kind === "workflow" ? (result.response.executions[0]!.result as { text: string }).text : "";
    expect(text).toContain("Draft: rules/review.md");
    expect(text).toContain("Review with evidence.");
    expect(text).toContain("```typescript");
    expect(await readdir(root)).toEqual([]);
    execute.mockImplementation(async () => ({ result: { kind: "ask", text: JSON.stringify({ name: "docs.review", content: "export function main() {}" }) } }));
    const revised = await application.draftResource({ ...resource, draft: result.draft }, "Revise API");
    expect(revised.draft.files).toEqual(result.draft.files);
    expect(execute.mock.calls[1]).toEqual(["ask", expect.stringContaining("Review with evidence."), { resourceSource: "describe" }]);
    expect(resourcePrompt(resource, "Create")).toContain('rules: ["example.md"]');
  });

  it.each(["../outside.md", "rules/../../outside.md", "/rules/a.md", "C:/rules/a.md", ".dext/rules/a.md", "rules/a\\b.md", "rules/a.md:stream", "rules/a.md.", "rules/CON.md", "api/helper.ts", "rules/a.ts"])("rejects unsafe or unsupported companion path %s", async (path) => {
    const resource = bundle();
    resource.draft!.files = [{ path, content: "Policy" }];
    await expect(application.saveResource(resource)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects malformed, duplicate, oversized, and primary-file aliases", async () => {
    for (const value of [null, {}, [{ path: "rules/a.md" }], [{ path: "rules/a.md", content: "" }], [{ path: "rules/a.md", content: "a".repeat(200_001) }],
      [{ path: "rules/a.md", content: "a" }, { path: "rules/A.md", content: "b" }]]) expect(() => resourceFiles(value)).toThrow();
    await expect(application.saveResource({ type: "rule", scope: "global", draft: {
      name: "review", content: "main", files: [{ path: "rules/review.md", content: "alias" }]
    } })).rejects.toThrow("duplicates");
    expect(await readdir(root)).toEqual([]);
  });

  it("checks all companion collisions before creating any files", async () => {
    await mkdir(join(root, "templates"));
    await writeFile(join(root, "templates/review.md"), "Existing template");
    await expect(application.saveResource(bundle())).rejects.toThrow("already exists");
    expect(await readdir(root)).toEqual(["templates"]);
    expect(await readFile(join(root, "templates/review.md"), "utf8")).toBe("Existing template");
  });

  it.each(["disk", "editor"])("checks companion %s changes before updating the primary resource", async (source) => {
    const resource = bundle();
    resource.target = await application.saveResource(resource);
    resource.draft!.content = "export function main() { return 42; }";
    const path = join(root, "rules/review.md");
    if (source === "disk") await writeFile(path, "External edit");
    else Object.assign(vscode.workspace, { textDocuments: [{ uri: vscode.Uri.file(path), isDirty: true }] });
    await expect(application.saveResource(resource)).rejects.toThrow(source === "disk" ? "changed on disk" : "unsaved editor changes");
    expect(await readFile(join(root, "api/docs/review.ts"), "utf8")).toBe(resource.target.content);
  });

  it("removes newly created companions when a later write fails, allowing retry", async () => {
    const resource = bundle();
    const originalWrite = vscode.workspace.fs.writeFile.bind(vscode.workspace.fs);
    const write = vi.spyOn(vscode.workspace.fs, "writeFile").mockImplementation(async (uri, content) => {
      if (uri.fsPath.endsWith("review.ts")) throw new Error("Disk full");
      return originalWrite(uri, content);
    });
    await expect(application.saveResource(resource)).rejects.toThrow("Disk full");
    for (const file of resource.draft!.files!) await expect(readFile(join(root, file.path))).rejects.toThrow();
    write.mockRestore();
    await expect(application.saveResource(resource)).resolves.toMatchObject({ files: expect.any(Array) });
  });

  it("restores updated companions if saving the primary file fails", async () => {
    const resource = bundle();
    resource.target = await application.saveResource(resource);
    resource.draft!.files![0]!.content = "Revised policy";
    resource.draft!.content = "export function main() { return 2; }";
    const originalWrite = vscode.workspace.fs.writeFile.bind(vscode.workspace.fs);
    let failed = false;
    vi.spyOn(vscode.workspace.fs, "writeFile").mockImplementation(async (uri, content) => {
      if (uri.fsPath.endsWith("review.ts") && !failed) { failed = true; throw new Error("Write failed"); }
      return originalWrite(uri, content);
    });
    await expect(application.saveResource(resource)).rejects.toThrow("Write failed");
    expect(await readFile(join(root, "rules/review.md"), "utf8")).toBe(resource.target.files![0]!.content);
    expect(await readFile(join(root, "api/docs/review.ts"), "utf8")).toBe(resource.target.content);
  });
});
