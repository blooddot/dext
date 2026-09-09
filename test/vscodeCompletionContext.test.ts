import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { normalizeCompletionSettings } from "../src/core/completionProvider.js";
import { DextCompletionContext, documentWindow } from "../src/vscodeCompletionContext.js";
const state = vi.hoisted(() => ({ files: new Map<string, string>(), documents: [] as vscode.TextDocument[], visible: [] as vscode.TextEditor[], query: vi.fn(), changed: (event: vscode.TextDocumentChangeEvent) => { void event; } }));
vi.mock("node:fs/promises", () => ({ realpath: (path: string) => Promise.resolve(path) }));
vi.mock("vscode", () => {
  class Position { constructor(readonly line: number, readonly character: number) {} }
  class Range { constructor(readonly start: Position, readonly end: Position) {} }
  class Uri {
    readonly scheme = "file";
    constructor(readonly fsPath: string) {}
    toString() { return "file:///" + this.fsPath.replaceAll("\\", "/"); }
    static parse(value: string) { return new Uri(value.replace("file:///", "")); }
    static joinPath(uri: Uri, ...parts: string[]) { return new Uri([uri.fsPath, ...parts].join("/")); }
  }
  const disposable = () => ({ dispose() {} });
  const watcher = () => ({ dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable });
  return { Position, Range, Uri, window: { get visibleTextEditors() { return state.visible; } },
    commands: { executeCommand: (...args: unknown[]) => state.query(...args) as Promise<unknown> },
    workspace: {
      get textDocuments() { return state.documents; },
      getWorkspaceFolder: (uri: Uri) => ({ uri: new Uri(uri.fsPath.startsWith("C:/other/") ? "C:/other" : "C:/repo") }),
      onDidChangeTextDocument: (fn: typeof state.changed) => { state.changed = fn; return disposable(); },
      onDidOpenTextDocument: disposable, onDidCloseTextDocument: disposable, onDidChangeWorkspaceFolders: disposable,
      createFileSystemWatcher: watcher,
      openTextDocument: (uri: Uri) => Promise.resolve(state.documents.find((d) => d.uri.toString() === uri.toString())),
      fs: { readFile: (uri: Uri) => { const value = state.files.get(uri.fsPath); if (value === undefined) return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })); return Promise.resolve(new TextEncoder().encode(value)); } }
    }
  };
});
import { Position, Range, Uri } from "vscode";
function document(text: string, path = "C:/repo/a.ts") {
  const offsetAt = (p: vscode.Position) => text.split("\n").slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character;
  const positionAt = (offset: number) => { const lines = text.slice(0, Math.min(text.length, offset)).split("\n"); return new Position(lines.length - 1, lines.at(-1)!.length); };
  const getText = vi.fn((range?: vscode.Range) => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text);
  const doc = { uri: Uri.parse("file:///" + path), languageId: "typescript", version: 1, isClosed: false, isDirty: true, getText, offsetAt, positionAt } as unknown as vscode.TextDocument;
  state.documents.push(doc); return { doc, getText };
}
const settings = normalizeCompletionSettings({ enabled: true, model: "test", endpoint: "http://localhost", prefixChars: 2000, suffixChars: 1000 });
beforeEach(() => { state.documents.length = 0; state.visible.length = 0; state.files.clear(); state.query.mockReset(); state.query.mockResolvedValue([]); });
afterEach(() => { vi.useRealTimers(); });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe("editor context collection", () => {
  it("reads a bounded range from a large document without full-document getText", () => {
    const { doc, getText } = document("x".repeat(1_000_000)); const request = documentWindow(doc, new Position(0, 500_000), settings);
    expect(request.prefix.length + request.suffix.length).toBeLessThanOrEqual(3000);
    expect(getText.mock.calls.every(([range]) => range instanceof Range)).toBe(true);
  });
  it("fails closed while ignore rules load and isolates workspace rules", async () => {
    state.files.set("C:/repo/.dextignore", "blocked.ts");
    const { doc } = document("const a = ", "C:/repo/blocked.ts"); const other = document("const b = ", "C:/other/blocked.ts").doc;
    const context = new DextCompletionContext(() => settings);
    expect(context.allowed(doc.uri)).toBe(false); expect(context.allowed(other.uri)).toBe(false); await tick();
    expect(context.allowed(doc.uri)).toBe(false); expect(context.allowed(other.uri)).toBe(true); context.dispose();
  });
  it("returns a basic snapshot while type providers are stuck and keeps their slots occupied", async () => {
    state.query.mockImplementation(() => new Promise(() => undefined));
    const { doc } = document("const value = user."); const context = new DextCompletionContext(() => settings);
    context.allowed(doc.uri); await tick();
    const request = context.snapshot(doc, doc.positionAt(19)); expect(request.prefix).toBe("const value = user."); await tick();
    for (let i = 0; i < 20; i++) context.snapshot(doc, doc.positionAt(18));
    expect(state.query).toHaveBeenCalledTimes(1); expect(context.report().queries[0]?.running).toBe(1); context.dispose();
  });
  it("reads current unsaved definitions and invalidates only used dependency snapshots", async () => {
    const { doc } = document("const value = user."); const related = document("interface User { displayName: string }", "C:/repo/types.ts").doc;
    state.query.mockResolvedValue([{ uri: related.uri, range: new Range(new Position(0, 0), new Position(0, 37)) }]);
    const context = new DextCompletionContext(() => settings); context.allowed(doc.uri); await tick();
    context.snapshot(doc, doc.positionAt(18)); await tick();
    const request = context.snapshot(doc, doc.positionAt(18)); expect(request.context).toContain("displayName"); expect(context.dependencyValid(request)).toBe(true);
    context.invalidate(related.uri.toString()); expect(context.dependencyValid(request)).toBe(false); context.dispose();
  });
});
