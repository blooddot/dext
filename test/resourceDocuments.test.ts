import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { DextApplication } from "../src/application.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { MethodRegistry } from "../src/core/registry.js";
import { resourceFileName, resourcePathSegments, resourcePrompt, type ResourceSession } from "../src/resourceSession.js";

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
      writeFile: async (value: { fsPath: string }, content: Uint8Array) => writeFile(value.fsPath, content)
    } }
  };
});

let root: string;
let application: DextApplication;
beforeEach(async () => {
  Object.assign(vscode.workspace, { textDocuments: [] });
  root = await mkdtemp(join(tmpdir(), "dext-resources-"));
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  application = Object.create(DextApplication.prototype) as DextApplication;
  Object.assign(application, {
    workspaceTrusted: false, resourceWrite: Promise.resolve(),
    storage: { globalStorageUri: { fsPath: root }, attachmentPrompt: (input: string) => `${input}\nResolved attachment context` },
    registry, customApiIds: new Set(), reload: vi.fn()
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("resource documents", () => {
  it.each([
    ["api", "team.lookup", "team/lookup.dx"], ["mcp", "server", "server.jsonc"],
    ["rule", "review.md", "review.md"], ["skill", "release", "release/SKILL.md"]
  ] as const)("maps %s names to their real resource paths", (type, name, path) => {
    expect(resourceFileName(type, name)).toBe(path);
  });

  it("rejects traversal, mismatched types, and unsafe names", () => {
    for (const path of ["../outside.md", "C:/outside.md", "safe/../outside.md", "safe\\outside.md", "rule.dx"]) {
      expect(() => resourcePathSegments("rule", path)).toThrow();
    }
    expect(() => resourceFileName("skill", "../bad")).toThrow();
    expect(() => resourceFileName("api", "a..b")).toThrow();
  });

  it.each([
    ["api", "sample", "def main(input: str) -> AskResult:\n    return ask(input=input)\n", "api/sample.dx"],
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
    await writeFile(join(root, "api/team/lookup.dx"), "def main():\n    return 1\n");
    await writeFile(join(root, "api/team/ignore.md"), "Not an API");
    await mkdir(join(root, "mcp"));
    await writeFile(join(root, "mcp/settings.jsonc"), '{"name":"server","transport":"stdio","command":"node","tools":[]}');
    expect(await application.listResources("api")).toEqual([{ name: "team.lookup", path: "team/lookup.dx", scope: "global" }]);
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
});
