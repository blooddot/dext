import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { DextApplication } from "../src/application.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { resourceFileName, resourcePathSegments, resourcePrompt, resourceFiles, type ResourceSession } from "../src/resourceSession.js";
import { buildResourceList, isMcpApiId, renderResourceList, resourceCategory, type ResourceEntry } from "../src/resourceDocuments.js";

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
    registry, reload: vi.fn()
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("resource documents", () => {
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

  it("generates a read-only draft using the current content and attachment context without writing files", async () => {
    const execute = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify({ name: "review", content: "Revised rule" }) } }));
    Object.assign(application, { runtime: { executeConversation: execute } });
    const resource: ResourceSession = { type: "rule", scope: "global", target: { name: "review", path: "review.md", content: "Original rule" } };
    const result = await application.draftResource(resource, "Make it concise", { agentSessionId: "one" });
    expect(execute.mock.calls[0]).toEqual(["ask", expect.stringContaining("Original rule"), { agentSessionId: "one" }]);
    expect(execute.mock.calls[0]).toEqual(["ask", expect.stringContaining("Resolved attachment context"), expect.anything()]);
    expect(result.draft.content).toBe("Revised rule");
    expect(await readdir(root)).toEqual([]);
    resource.draft = result.draft;
    expect(resourcePrompt(resource, "Continue")).toContain("Revised rule");
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
    expect(execute.mock.calls[1]).toEqual(["ask", expect.stringContaining("Review with evidence."), {}]);
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
