import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DextApplication } from "../src/app/application.js";
import type { McpServerConfig, McpToolConfig } from "../src/features/mcp/contracts/mcp.js";

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
      writeFile: async (value: { fsPath: string }, content: Uint8Array) => writeFile(value.fsPath, content)
    } }
  };
});

interface LoadedManifests {
  servers: McpServerConfig[];
  tools: McpToolConfig[];
  methods: unknown[];
  diagnostics: string[];
}

let root: string;
let application: DextApplication;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dext-mcp-manifests-"));
  await mkdir(mcpDirectory(), { recursive: true });
  application = Object.create(DextApplication.prototype) as DextApplication;
  Object.assign(application, {
    storage: { globalStorageUri: vscode.Uri.file(join(root, "global")) },
    projectWorkspaceSettings: { mcpDirs: [] }
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

function mcpDirectory(): string {
  return join(root, "project", ".dext", "mcp");
}

function manifest(name: string): string {
  return JSON.stringify({ name, tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] });
}

function load(): Promise<LoadedManifests> {
  return (application as unknown as {
    loadMcpManifests(folder: unknown, includeGlobal?: boolean): Promise<LoadedManifests>;
  }).loadMcpManifests({ uri: vscode.Uri.file(join(root, "project")) }, false);
}

describe("MCP manifest loading", () => {
  it("skips a manifest over the size limit instead of reading it", async () => {
    await writeFile(join(mcpDirectory(), "huge.jsonc"), manifest("huge").padEnd(300 * 1024, " "));
    await writeFile(join(mcpDirectory(), "small.jsonc"), manifest("small"));
    const loaded = await load();
    expect(loaded.servers.map((server) => server.name)).toEqual(["small"]);
    expect(loaded.diagnostics.join("\n")).toMatch(/huge\.jsonc: manifest is 307200 bytes, over the 262144-byte limit/);
  });

  it("reads at most 200 manifests and reports the rest once", async () => {
    for (let index = 0; index <= 200; index += 1) await writeFile(join(mcpDirectory(), `m${index}.jsonc`), manifest(`s${index}`));
    const loaded = await load();
    expect(loaded.servers).toHaveLength(200);
    expect(loaded.diagnostics.filter((message) => message.includes("reading the first 200 manifest files only"))).toHaveLength(1);
  });

  it("discovers a server's tools past an oversized manifest", async () => {
    Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(join(root, "project")) }] });
    await writeFile(join(mcpDirectory(), "a-huge.jsonc"), manifest("huge").padEnd(300 * 1024, " "));
    const target = join(mcpDirectory(), "local.jsonc");
    await writeFile(target, `${manifest("local")}\n`);
    Object.assign(application, {
      workspaceTrusted: true,
      reload: vi.fn(),
      mcp: {
        getServer: (name: string) => name === "local"
          ? { name: "local", transport: "stdio", command: "local-mcp", auth: { type: "token", env: "LOCAL_TOKEN" }, scope: "project" }
          : undefined,
        discoverServerTools: async () => [{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } }]
      }
    });
    await expect(application.discoverAndPersistMcpTools("local")).resolves.toBe(1);
    expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({ name: "local", tools: [{ name: "ping" }] });
  });
});
