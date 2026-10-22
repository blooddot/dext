import { describe, expect, it, vi } from "vitest";

/**
 * The workspace host is the only place that decides which files the model may read. The fixture
 * below is documentation-heavy on purpose: vendored renderer readmes plus a large docs tree used to
 * consume both the read window and the evidence budget, leaving the model with no source at all —
 * which is why a whole-project initialization could only describe one documented flow.
 */
const tree = {
  documents: [
    "README.md",
    "README.zh-CN.md",
    "package.json",
    ...Array.from({ length: 500 }, (_, index) => `docs/guide-${String(index).padStart(3, "0")}.md`),
    ...Array.from({ length: 200 }, (_, index) => `vendor/third-party/renderers/part-${String(index).padStart(3, "0")}/README.md`)
  ],
  sources: Array.from({ length: 400 }, (_, index) => `src/features/module-${String(index).padStart(3, "0")}.ts`)
};

const files = new Map<string, string>();
// Large enough that the file budget binds and the source reserve has to do real work.
for (const path of [...tree.documents, ...tree.sources]) files.set(path, `// ${path}\n${"export const value = 1;\n".repeat(60)}`);

const relative = (uri: { path: string }): string => uri.path.replace(/^\/C:\/ws\//, "");

vi.mock("vscode", () => {
  class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
  return {
    RelativePattern,
    Uri: {
      file: (fsPath: string) => ({ scheme: "file", fsPath, path: fsPath.replace(/\\/g, "/") }),
      joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ scheme: "file", fsPath: [base.fsPath ?? "", ...parts].join("/"), path: [base.fsPath ?? "", ...parts].join("/") })
    },
    workspace: {
      fs: {
        stat: async (uri: { path: string }) => ({ size: (files.get(relative(uri)) ?? "").length }),
        readFile: async (uri: { path: string }) => new TextEncoder().encode(files.get(relative(uri)) ?? "")
      },
      findFiles: async (pattern: RelativePattern, _exclude: string, limit?: number) => {
        const glob = pattern.pattern;
        const matches = glob.includes("package.json")
          ? ["package.json"]
          : glob.includes("{README")
            ? tree.documents.filter((path) => /(?:^|\/)readme(?:\.[^/]*)?$/i.test(path))
            : glob.includes("{md")
              ? tree.documents.filter((path) => /\.(?:md|mdx|rst|txt)$/i.test(path))
              : tree.sources;
        return matches.slice(0, limit ?? matches.length).map((path) => ({ scheme: "file", fsPath: `C:/ws/${path}`, path: `/C:/ws/${path}` }));
      }
    }
  };
});

describe("project evidence selection", () => {
  it("includes build entries, packaged launch arguments and actual browser entry evidence", async () => {
    const { readWorkspaceEvidence } = await import('../src/features/project/host/projectPanelDataSource.js');
    const fixtures = {
      'esbuild.mjs': 'build({ entryPoints: { main: "src/ui.ts" }, platform: "browser" });',
      'src/ui.ts': 'interface Api { postMessage(message: unknown): void; }\ndeclare function acquireVsCodeApi(): Api;\nconst api = acquireVsCodeApi();',
      'src/extension.ts': 'export function activate() {}\n' + '// gap\n'.repeat(150) + 'const root = joinPath(context.extensionUri, "vendor", "renderer");',
      'src/adapter.ts': '// gap\n'.repeat(200) + 'export function render() { return runToolProcess(process.execPath, [join(runtimeRoot, "bin/render.mjs")]); }'
    };
    for (const [path, content] of Object.entries(fixtures)) { files.set(path, content); tree.sources.push(path); }
    try {
      const evidence = await readWorkspaceEvidence({ scheme: 'file', fsPath: 'C:/ws', path: '/C:/ws' } as never, {}, { mode: 'index', include: ['src/**'] });
      expect(evidence.files.find(file => file.path === 'esbuild.mjs')).toMatchObject({ kind: 'manifest', text: expect.stringContaining('platform: "browser"') });
      expect(evidence.structure?.modules.flatMap(module => module.members).some(file => file.path === 'esbuild.mjs')).toBe(false);
      const text = evidence.files.map(file => file.text).join('\n');
      expect(text).toContain('acquireVsCodeApi()');
      expect(text).toContain('context.extensionUri, "vendor"');
      expect(text).toContain('runToolProcess(process.execPath');
      expect(evidence.files.find(file => file.path === 'src/adapter.ts')!.startLine).toBeGreaterThan(190);
    } finally { for (const path of Object.keys(fixtures)) files.delete(path); tree.sources.splice(-Object.keys(fixtures).length); }
  });
  it("balances deployment, browser and alternative transport evidence under competing runtime candidates", async () => {
    const { readWorkspaceEvidence } = await import('../src/features/project/host/projectPanelDataSource.js');
    const originalReadme = files.get('README.md')!;
    files.set('README.md', 'Documentation line\n'.repeat(3000));
    const fixtures: Record<string, string> = {
      'esbuild.mjs': 'build({ entryPoints: { main: "src/main.ts" }, platform: "browser" });',
      'src/main.ts': 'interface Api { postMessage(m: unknown): void; }\nconst api = acquireVsCodeApi();\n' + '// gap\n'.repeat(400),
      'src/extension.ts': 'export function activate() {}\n' + '// gap\n'.repeat(300) + 'const root = joinPath(context.extensionUri, "vendor", "renderer");',
      'src/renderer.ts': '// gap\n'.repeat(300) + 'export function render() { return runToolProcess(process.execPath, [join(root, "bin/render.mjs")]); }',
      'src/aTransport.ts': 'import { spawn } from "node:child_process";\nexport function main() { spawn("tool"); }\n' + '// gap\n'.repeat(300)
        + 'function http(url: string) { return fetch(url); }\n' + '// gap\n'.repeat(300) + 'function call(transport: string) { return transport === "http" ? http("local") : main(); }'
    };
    for (let i = 0; i < 12; i++) fixtures[`src/zWorker${i}.ts`] = 'import { spawn } from "node:child_process";\nexport function main() { spawn("worker"); }\n' + '// gap\n'.repeat(400);
    for (const [path, content] of Object.entries(fixtures)) { files.set(path, content); tree.sources.push(path); }
    try {
      const evidence = await readWorkspaceEvidence({ scheme: 'file', fsPath: 'C:/ws', path: '/C:/ws' } as never, {}, { mode: 'index', maxFileChars: 24000 });
      const text = evidence.files.map(file => file.text).join('\n');
      for (const expected of ['platform: "browser"', 'acquireVsCodeApi()', 'context.extensionUri, "vendor"', 'runToolProcess(process.execPath', 'fetch(url)', 'transport === "http"']) expect(text).toContain(expected);
      expect(evidence.files.filter(file => file.path === 'src/aTransport.ts')).toHaveLength(3);
    } finally { files.set('README.md', originalReadme); for (const path of Object.keys(fixtures)) files.delete(path); tree.sources.splice(-Object.keys(fixtures).length); }
  });
  it.each([120000, 20000])("retains stdio, HTTP and transport dispatch windows with a %i character budget", async maxEvidenceChars => {
    const { readWorkspaceEvidence } = await import('../src/features/project/host/projectPanelDataSource.js');
    const root = { scheme: 'file', fsPath: 'C:/ws', path: '/C:/ws' } as never;
    const path = 'src/aaaTransport.ts';
    const content = 'import { spawn } from "node:child_process";\nexport function main() { return spawn("tool"); }\n'
      + '// unread gap\n'.repeat(200) + 'export function http(url: string) { return fetch(url); }\n'
      + '// second gap\n'.repeat(200) + 'export function call(server: {transport: string}) { return server.transport === "http" ? http("local") : main(); }\n';
    files.set(path, content); tree.sources.push(path);
    const workers = Array.from({ length: 12 }, (_, i) => `src/zWorker${i}.ts`);
    for (const worker of workers) { files.set(worker, 'import { spawn } from "node:child_process";\nexport function main() { spawn("node"); }\n' + '// implementation\n'.repeat(100)); tree.sources.push(worker); }
    try {
      const packaged = await readWorkspaceEvidence(root, {}, { mode: 'index', maxFileChars: 24000, maxEvidenceChars });
      const windows = packaged.files.filter(file => file.path === path);
      expect(windows).toHaveLength(3);
      expect(windows.map(file => file.text).join('\n')).toContain('fetch(url)');
      expect(windows[2]!.text).toContain('server.transport === "http"');
      expect(windows[0]!.endLine).toBeLessThan(windows[1]!.startLine);
      expect(new Set(windows.map(file => file.contentHash)).size).toBe(1);
      expect(packaged.characterCount).toBeLessThanOrEqual(120000);
    } finally { for (const item of [path, ...workers]) files.delete(item); tree.sources.splice(-(workers.length + 1)); }
  });
  it("keeps Webview and subprocess evidence in the final payload with the whole-project 24000-character preset", async () => {
    const { readWorkspaceEvidence } = await import('../src/features/project/host/projectPanelDataSource.js');
    const root = { scheme: 'file', fsPath: 'C:/ws', path: '/C:/ws' } as never;
    const fixtures: Record<string, string> = {
      'src/extension.ts': 'import * as vscode from "vscode";\nexport function activate() {}\n',
      'src/platform/editor-tabs/editorTabManager.ts': 'export function createWebviewPanel() { return windowApi.createWebviewPanel("app"); }\n',
      'src/features/agents/host/agentRunner.ts': 'import { spawn } from "node:child_process";\nexport function main() { return spawn("agent"); }\n',
      'src/runner/kernel.ts': 'import { spawn } from "node:child_process";\nexport function main() { return spawn("node"); }\n'
    };
    for (const [path, content] of Object.entries(fixtures)) { files.set(path, content + '// implementation\n'.repeat(800)); tree.sources.push(path); }
    try {
      const packaged = await readWorkspaceEvidence(root, {}, { mode: 'index', maxFileChars: 24000, maxEvidenceChars: 120000 });
      const sources = packaged.files.filter(file => file.kind === 'source');
      expect(sources.map(file => file.path)).toEqual(expect.arrayContaining(Object.keys(fixtures)));
      expect(sources.every(file => file.text.length <= 2000)).toBe(true);
      expect(packaged.structure?.parsed).toBe(404);
      expect(packaged.files.some(file => file.path === 'README.md')).toBe(true);
    } finally { for (const path of Object.keys(fixtures)) files.delete(path); tree.sources.splice(-Object.keys(fixtures).length); }
  });

  it("indexes every source independently of AI file budgets and supplies module summaries", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, { mode: "index", maxFiles: 1, maxSourceFiles: 1, maxEvidenceChars: 1_000_000 });
    expect(packaged.structure?.parsed).toBe(400);
    expect(packaged.structure?.modules.reduce((sum, module) => sum + module.files, 0)).toBe(400);
    expect(packaged.structure?.modules[0]?.entryPoints).toContain("src/features/module-000.ts");
    expect(packaged.files.every(file => file.kind !== "source")).toBe(true);
    expect(packaged.selection.evidenceChars).toBe(120_000);
  });

  it("prioritizes a late module entry and its direct imports over unrelated sources", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const entry = "src/features/module-399.ts";
    const imported = "src/shared/run.ts";
    const unrelated = "src/unrelated/other.ts";
    const original = files.get(entry)!;
    files.set(entry, "import { run } from '../shared/run.js';\nexport function execute() { run(); }");
    files.set(imported, "export function run() {}"); files.set(unrelated, "export function other() {}");
    tree.sources.push(imported, unrelated);
    try {
      const packaged = await readWorkspaceEvidence(root, {}, { mode: "topic", preferredPaths: [entry] });
      expect(packaged.files[0]!.path).toBe(entry);
      expect(packaged.files.map(file => file.path)).toContain(imported);
      expect(packaged.files.map(file => file.path)).not.toContain(unrelated);
      expect(packaged.selection.files).toBe(32);
      expect(packaged.characterCount).toBeLessThanOrEqual(96_000);
    } finally { files.set(entry, original); files.delete(imported); files.delete(unrelated); tree.sources.splice(-2); }
  });

  it("reads indexed runtime boundaries beyond import headers with original line numbers and hashes", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const { createHash } = await import('node:crypto');
    const root = { scheme: 'file', fsPath: 'C:/ws', path: '/C:/ws' } as never;
    const path = 'src/worker.ts';
    const content = 'import { spawn } from "node:child_process";\n// spawn() is explained here, not executed.\n' + '// padding\n'.repeat(300) + 'export function main() { return spawn("node", ["worker.js"]); }\n';
    files.set(path, content); tree.sources.push(path);
    try {
      const packaged = await readWorkspaceEvidence(root, {}, { mode: 'index', maxFiles: 1, maxSourceFiles: 1 });
      const excerpt = packaged.files.find(file => file.path === path)!;
      expect(packaged.structure?.parsed).toBe(401);
      expect(excerpt.startLine).toBeGreaterThan(290);
      expect(excerpt.text).toContain('return spawn(');
      expect(excerpt.endLine).toBe(content.split('\n').length);
      expect(excerpt.contentHash).toBe(createHash('sha256').update(content).digest('hex'));
      expect(packaged.files.some(file => file.path === 'README.md')).toBe(true);
    } finally { files.delete(path); tree.sources.pop(); }
  });

  it("adds project background for source-only indexing without including unrelated documentation", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, { mode: "index", include: ["src/**"] });
    expect(packaged.structure?.parsed).toBe(400);
    expect(packaged.files.map(file => file.path)).toEqual(expect.arrayContaining(['README.md', 'package.json']));
    expect(packaged.files.some(file => file.path.startsWith('docs/') || file.path.startsWith('vendor/'))).toBe(false);
  });

  it("reads cross-directory members and excludes unrelated files from the same directory", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const entry = 'src/features/module-399.ts', second = 'src/webview/feature.ts';
    files.set(second, 'export function feature() {}'); tree.sources.push(second);
    try {
      const packaged = await readWorkspaceEvidence(root, {}, { mode: 'topic', preferredPaths: [entry], modulePaths: [entry, second] });
      const sources = packaged.files.filter(file => file.kind === 'source').map(file => file.path);
      expect(sources).toEqual([entry, second]);
      expect(packaged.coverage.join(' ')).toContain('Unrelated directory neighbors are excluded');
    } finally { files.delete(second); tree.sources.pop(); }
  });

  it("keeps project source and the project README when documentation dominates", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, {});

    const paths = packaged.files.map((file) => file.path);
    const kinds = packaged.files.map((file) => file.kind);
    // Both halves of the evidence survive: documentation for the intent, code for the diagrams.
    expect(kinds).toContain("readme");
    expect(kinds).toContain("manifest");
    expect(kinds).toContain("document");
    expect(kinds).toContain("source");
    expect(paths).toContain("README.md");
    expect(paths.some((path) => path.startsWith("src/"))).toBe(true);
    // Ownership: vendored documentation exists in the workspace but never crowds out project files.
    expect(paths.some((path) => path.startsWith("vendor/"))).toBe(false);
    // The read window was too small for everything, so the omission stays visible to the reader.
    expect(packaged.coverage.some((note) => note.includes("Documentation exceeds the limit"))).toBe(true);
    expect(packaged.omitted.files).toBeGreaterThan(0);
  }, 60_000);

  it("honours an explicit evidence scope instead of the built-in globs", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    const packaged = await readWorkspaceEvidence(root, {}, { include: ["src/**"] });
    expect(packaged.files.length).toBeGreaterThan(0);
    // A scope replaces the built-in README/documentation/manifest globs, so nothing outside it is read.
    expect(packaged.files.every((file) => file.path.startsWith("src/"))).toBe(true);
    expect(packaged.files.every((file) => file.kind === "source")).toBe(true);
  }, 60_000);

  it("drops a scope that could escape the workspace root", async () => {
    const { readWorkspaceEvidence } = await import("../src/features/project/host/projectPanelDataSource.js");
    const root = { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never;
    // Every entry is invalid, so the built-in globs stay in force rather than reading nothing.
    const packaged = await readWorkspaceEvidence(root, {}, { include: ["../outside/**", "C:/secret/**", "/etc/**"] });
    expect(packaged.files.some((file) => file.path === "README.md")).toBe(true);
  }, 60_000);
});

it("preserves separate chat and injected Project reader communication alongside renderer and MCP evidence", async () => {
  const { readWorkspaceEvidence } = await import("../src/features/project/host/indexing/workspaceEvidence.js");
  const fixtures: Record<string, string> = {
    "esbuild.mjs": 'build({platform:"browser",entryPoints:{chat:"src/chat.ts",project:"src/projectEntry.ts"}});',
    "src/chat.ts": 'const api = acquireVsCodeApi();\napi.postMessage({type:"ready"});\nwindow.addEventListener("message", receive);',
    "src/projectEntry.ts": 'import { start } from "./projectReader";\nconst api = (window as Window & { __dextApi?: Api }).__dextApi;\nstart(api);',
    "src/projectReader.ts": 'export function start(api) { api.postMessage({type:"projectReaderRender"}); }\n' + '// gap\n'.repeat(180) + 'window.addEventListener("message", receiveProject);',
    "src/projectHost.ts": 'import * as vscode from "vscode";\nwebview.onDidReceiveMessage(handleProject);',
    "src/renderer.ts": 'import { spawn } from "node:child_process";\nexport function render() { return runToolProcess(process.execPath, [join(runtimeRoot, "bin/render.mjs")]); }',
    "src/mcp.ts": 'import { spawn } from "node:child_process";\nexport function run() { spawn("mcp"); }\n' + '// gap\n'.repeat(150) + 'if (transport === "http") fetch(serverUrl);'
  };
  for (const [path, content] of Object.entries(fixtures)) { files.set(path, content); tree.sources.push(path); }
  try {
    const evidence = await readWorkspaceEvidence({ scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never, {}, { mode: "index", include: ["src/**"] });
    const text = evidence.files.map(file => file.text).join("\n");
    for (const marker of ["acquireVsCodeApi()", "__dextApi", "projectReaderRender", "receiveProject", "handleProject", "runToolProcess", "fetch(serverUrl)"]) expect(text).toContain(marker);
    const narrow = await readWorkspaceEvidence({ scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never, {}, { mode: "index", include: ["src/**"], maxEvidenceChars: 12000 });
    expect(narrow.coverage.join(" ")).toContain("omitted");
  } finally { for (const path of Object.keys(fixtures)) files.delete(path); tree.sources.splice(-Object.keys(fixtures).length); }
});
