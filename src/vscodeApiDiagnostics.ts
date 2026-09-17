import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkApis, type ApiCheckOptions, type ApiCheckResult } from "./core/apiCheck.js";
import { diagnosticKey, formatDiagnostic } from "./core/apiDiagnostic.js";

/** The only files `checkApis` reads, so the only ones worth taking from a buffer. */
function isCheckedFile(path: string): boolean {
  return /\.(?:dx|jsonc)$/i.test(path) || /[\\/]\.vscode[\\/]settings\.json$/i.test(path);
}

/** Validation has its own registry and never replaces the runtime's saved plans. */
export class DextApiDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("dext-api");
  private readonly output = vscode.window.createOutputChannel("Dext API Check");
  private readonly subscriptions: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private disposed = false;

  constructor(private readonly options: () => ApiCheckOptions[]) {
    const relevant = (document: vscode.TextDocument): boolean => document.languageId === "dext-api" && document.uri.scheme === "file";
    this.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument((document) => { if (relevant(document)) this.schedule(); }),
      vscode.workspace.onDidChangeTextDocument((event) => { if (relevant(event.document)) this.schedule(); }),
      vscode.workspace.onDidSaveTextDocument((document) => { if (relevant(document)) this.schedule(); }),
      // Closing an unsaved editor must restore the disk diagnostics.
      vscode.workspace.onDidCloseTextDocument((document) => { if (relevant(document)) this.schedule(); }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration("dext.apiDirs")) this.refresh(); }),
      // The scheduled path already reports a failed check; the command must too,
      // otherwise VS Code shows a bare "command failed" notification instead.
      vscode.commands.registerCommand("dext.checkApis", () => this.check(true).catch((error: unknown) => this.fail(error, true)))
    );
    this.refresh();
  }

  refresh(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    const patterns = new Set<string>();
    for (const option of this.options()) {
      patterns.add(resolve(option.workspace, ".dext"));
      for (const path of option.apiDirs ?? []) patterns.add(resolve(option.workspace, path));
      if (option.globalStorage) patterns.add(resolve(option.globalStorage));
    }
    for (const root of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, "**/*"));
      this.watchers.push(watcher, watcher.onDidCreate(() => this.schedule()), watcher.onDidChange(() => this.schedule()), watcher.onDidDelete(() => this.schedule()));
    }
    this.schedule();
  }

  schedule(): void {
    if (this.disposed) return;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check().catch((error: unknown) => this.fail(error));
    }, 250);
  }

  private fail(error: unknown, show = false): void {
    this.output.appendLine(`API check failed: ${String(error)}`);
    if (show) this.output.show(true);
  }

  async check(showOutput = false): Promise<ApiCheckResult | undefined> {
    if (this.disposed) return undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const revision = ++this.revision;
    if (!vscode.workspace.isTrusted) {
      this.collection.clear();
      if (showOutput) { this.output.appendLine("API checks require a trusted workspace."); this.output.show(true); }
      return undefined;
    }
    // Only unsaved buffers replace what is on disk, so only they are read here.
    // A clean open document matches its file, and a file deleted while its tab
    // is still open must not keep reporting diagnostics for a path that is gone
    // (which is what happens if every open document is treated as a source).
    const documents = new Map(vscode.workspace.textDocuments
      .filter((document) => document.uri.scheme === "file" && document.isDirty && isCheckedFile(document.uri.fsPath))
      .map((document) => [resolve(document.uri.fsPath), document.getText()]));
    const results = await Promise.all(this.options().map((option) => checkApis({ ...option, documents })));
    const diagnostics = [...new Map(results.flatMap((result) => result.diagnostics).map((item) => [diagnosticKey(item), item])).values()];
    const result: ApiCheckResult = {
      files: [...new Set(results.flatMap((result) => result.files))], diagnostics,
      errors: diagnostics.filter((item) => item.severity === "error").length,
      warnings: diagnostics.filter((item) => item.severity === "warning").length
    };
    const entries = new Map<string, vscode.Diagnostic[]>();
    const sources = new Map(documents);
    for (const item of diagnostics) {
      if (!sources.has(item.path)) {
        try { sources.set(item.path, await readFile(item.path, "utf8")); } catch { sources.set(item.path, ""); }
      }
      const source = sources.get(item.path)!;
      const position = (offset: number): vscode.Position => {
        const prefix = source.slice(0, Math.max(0, Math.min(offset, source.length)));
        return new vscode.Position(prefix.split("\n").length - 1, prefix.length - prefix.lastIndexOf("\n") - 1);
      };
      const diagnostic = new vscode.Diagnostic(new vscode.Range(position(item.from), position(item.to)), item.message,
        item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      // The API id belongs on the entry so a Problems row identifies the .dx
      // API a reader has to fix, not just the file it lives in.
      diagnostic.source = item.apiId ? `dext-api: ${item.apiId}` : "dext-api";
      diagnostic.code = item.code;
      const group = entries.get(item.path) ?? [];
      group.push(diagnostic);
      entries.set(item.path, group);
    }
    // Changes, reloads and closing documents invalidate results already in flight.
    if (this.disposed || revision !== this.revision) return result;
    this.collection.clear();
    // Problems only carries entries a reader can open; a directory-level
    // failure (an unreadable root, a bad settings.json) still reaches Output.
    this.collection.set([...entries]
      .filter(([path]) => /\.(?:dx|jsonc|json)$/i.test(path))
      .map(([path, items]) => [vscode.Uri.file(path), items]));
    this.output.clear();
    for (const item of diagnostics) this.output.appendLine(formatDiagnostic(item, sources.get(item.path)));
    this.output.appendLine(`${result.files.length} API file(s), ${result.errors} error(s), ${result.warnings} warning(s)`);
    if (showOutput) this.output.show(true);
    return result;
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of [...this.subscriptions, ...this.watchers, this.collection, this.output]) disposable.dispose();
  }
}
