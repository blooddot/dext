import * as vscode from "vscode";
import { relative, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { CompletionContextQueue, assembleContext, completionExampleSnippet, fingerprint, type CompletionSnippet } from "./core/completionContext.js";
import { completesSingleLine, type CompletionRequest, type CompletionSettings } from "./core/completionProvider.js";
import { isIgnored, parseIgnoreRules, type IgnoreRule } from "./core/ignoreRules.js";
import type { ExampleReference } from "./core/completionMemory.js";

export function documentWindow(document: vscode.TextDocument, position: vscode.Position, settings: CompletionSettings): CompletionRequest {
  const offset = document.offsetAt(position);
  const prefix = document.getText(new vscode.Range(document.positionAt(Math.max(0, offset - settings.prefixChars)), position));
  const suffix = document.getText(new vscode.Range(position, document.positionAt(offset + settings.suffixChars)));
  return { prefix, suffix, offset, uri: document.uri.toString(), version: document.version, languageId: document.languageId,
    singleLine: completesSingleLine({ prefix, suffix }) };
}
interface RuleState { rules: IgnoreRule[]; gitignore: boolean; generation: number }
interface ContextEntry { version: number; at: number; snippets: CompletionSnippet[] }

export class DextCompletionContext {
  private readonly rules = new Map<string, RuleState>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly paths = new Map<string, boolean>();
  private readonly cache = new Map<string, ContextEntry>();
  private readonly imports = new Map<string, CompletionSnippet>();
  private readonly queue = new CompletionContextQueue();
  private readonly recent = new Map<string, CompletionSnippet[]>();
  private epoch = 0;
  private readonly revisions = new Map<string, number>();
  private revision = 0;
  private readonly warming = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly windows = new Map<string, { offset: number; text: string; version: number }>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private invalidExample: (root: string, example: ExampleReference) => void = () => undefined;
  onInvalidExample(listener: (root: string, example: ExampleReference) => void): void { this.invalidExample = listener; }
  constructor(private readonly settings: (uri?: vscode.Uri) => CompletionSettings) {
    this.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
      const uri = event.document.uri.toString();
      const previous = this.windows.get(uri);
      this.invalidate(uri, event.contentChanges.every((change) => change.rangeOffset >= 1800));
      if (!this.allowed(event.document.uri)) return;
      const root = this.root(event.document.uri)!;
      const changes = event.contentChanges.slice(0, 4).map((c) => {
        const start = c.rangeOffset - (previous?.offset ?? 0);
        const before = previous && start >= 0 && start + c.rangeLength <= previous.text.length
          ? previous.text.slice(start, start + Math.min(c.rangeLength, 400)) : `[${c.rangeLength} characters replaced]`;
        return `Before: ${before}\nAfter: ${c.text.slice(0, 500)}`;
      }).join("\n");
      const history = (this.recent.get(root) ?? []).filter((s) => s.uri !== uri);
      if (changes.trim()) history.unshift({ uri, version: event.document.version, kind: "recent", text: changes, score: 0.7 });
      this.recent.set(root, history.slice(0, 8));
      while (this.recent.size > 8) this.recent.delete(this.recent.keys().next().value!);
      this.warm(event.document);
    }), vscode.workspace.onDidCloseTextDocument((document) => this.invalidate(document.uri.toString())),
    vscode.workspace.onDidOpenTextDocument((document) => { if (document.uri.scheme === "file") void this.loadRules(document.uri).then(() => { this.warm(document); }); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.clear()));
    const watcher = vscode.workspace.createFileSystemWatcher("**/{.gitignore,.dextignore}");
    this.subscriptions.push(watcher, watcher.onDidChange(() => this.clear()), watcher.onDidCreate(() => this.clear()), watcher.onDidDelete(() => this.clear()));
    const files = vscode.workspace.createFileSystemWatcher("**/*");
    this.subscriptions.push(files, files.onDidChange((uri) => this.invalidate(uri.toString())), files.onDidDelete((uri) => {
      this.paths.delete(uri.toString()); this.invalidate(uri.toString());
    }));
    for (const editor of vscode.window.visibleTextEditors) void this.loadRules(editor.document.uri).then(() => { this.warm(editor.document); });
  }
  private warm(document: vscode.TextDocument): void {
    const root = this.root(document.uri); if (!root || this.disposed) return;
    const old = this.warming.get(root); if (old) clearTimeout(old);
    if (!old && this.warming.size >= 8) return;
    const timer = setTimeout(() => {
      this.warming.delete(root);
      if (document.isClosed || this.disposed || !this.allowed(document.uri)) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === document.uri.toString());
      if (editor) this.snapshot(document, editor.selection.active);
    }, 200);
    timer.unref(); this.warming.set(root, timer);
  }
  root(uri: vscode.Uri): string | undefined { return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString(); }
  private relative(uri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri); if (!folder) return undefined;
    const path = relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
    return path && !path.startsWith("../") && !isAbsolute(path) ? path : undefined;
  }
  allowed(uri: vscode.Uri): boolean {
    if (this.disposed || uri.scheme !== "file") return false;
    const root = this.root(uri); if (!root) return false;
    const state = this.rules.get(root);
    if (!state || state.gitignore !== this.settings(uri).ignoreGitignore || !this.paths.has(uri.toString())) {
      void this.loadRules(uri); return false;
    }
    const path = this.relative(uri);
    return this.paths.get(uri.toString()) === true && path !== undefined && !isIgnored(state.rules, path);
  }
  private loadRules(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const pending = this.loading.get(key); if (pending) return pending;
    if (this.loading.size >= 16 || this.disposed) return Promise.resolve();
    const promise = this.readRules(uri).catch(() => undefined).finally(() => { this.loading.delete(key); });
    this.loading.set(key, promise); return promise;
  }
  private async readRules(uri: vscode.Uri): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri); if (!folder) return;
    const root = folder.uri.toString();
    const epoch = this.epoch;
    const settings = this.settings(uri);
    const paths = await Promise.all([realpath(folder.uri.fsPath), realpath(uri.fsPath)]);
    const path = relative(paths[0], paths[1]);
    const inside = path !== ".." && !path.startsWith(`..\\`) && !path.startsWith("../") && !isAbsolute(path);
    let state = this.rules.get(root);
    if (!state || state.gitignore !== settings.ignoreGitignore) {
      const rules: IgnoreRule[] = [];
      for (const name of settings.ignoreGitignore ? [".gitignore", ".dextignore"] : [".dextignore"]) {
        try {
          const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
          if (content.length > 262144) return;
          rules.push(...parseIgnoreRules(new TextDecoder().decode(content)));
        } catch (error) {
          if (!(error instanceof Error) || !/FileNotFound|ENOENT/.test(String((error as { code?: string }).code))) return;
        }
      }
      state = { rules, gitignore: settings.ignoreGitignore, generation: epoch };
    }
    if (this.disposed || this.epoch !== epoch) return;
    this.rules.set(root, state); this.paths.set(uri.toString(), inside);
    if (!this.revisions.has(uri.toString())) this.revisions.set(uri.toString(), ++this.revision);
    while (this.rules.size > 8) this.rules.delete(this.rules.keys().next().value!);
    while (this.paths.size > 256) this.paths.delete(this.paths.keys().next().value!);
  }
  snapshot(document: vscode.TextDocument, position: vscode.Position, examples: readonly ExampleReference[] = [], exampleWeight = 1): CompletionRequest {
    const settings = this.settings(document.uri);
    const base = documentWindow(document, position, settings);
    this.windows.set(document.uri.toString(), { offset: (base.offset ?? 0) - base.prefix.length, text: base.prefix + base.suffix, version: document.version });
    while (this.windows.size > 96) this.windows.delete(this.windows.keys().next().value!);
    const root = this.root(document.uri) ?? "";
    const uri = document.uri.toString();
    const cached = this.cache.get(uri);
    const snippets = cached && cached.version === document.version && performance.now() - cached.at < 60_000 ? cached.snippets : this.imports.has(uri) ? [this.imports.get(uri)!] : [];
    const eligible = [...snippets, ...(this.recent.get(root) ?? [])].filter((s) => s.uri !== uri || s.kind !== "recent")
      .filter((s) => this.allowed(vscode.Uri.parse(s.uri)))
      .map((s) => ({ ...s, revision: s.kind === "imports" ? s.revision ?? 0 : this.revisions.get(s.uri) ?? 0, score: s.score * (s.kind === "example" ? exampleWeight : 1) }));
    if (!cached || cached.version !== document.version || performance.now() - cached.at > 30_000) {
      this.queue.schedule(uri, () => this.collect(document, position, examples));
    }
    const result = assembleContext({ ...base, workspace: root }, eligible, settings);
    return result;
  }
  private async collect(document: vscode.TextDocument, position: vscode.Position, examples: readonly ExampleReference[]): Promise<void> {
    if (!this.allowed(document.uri)) return;
    const version = document.version;
    const root = this.root(document.uri)!;
    const epoch = this.epoch;
    const at = performance.now();
    const snippets: CompletionSnippet[] = [];
    const header = document.getText(new vscode.Range(new vscode.Position(0, 0), document.positionAt(1800)));
    const imports = header.split("\n").filter((line) => /^\s*(import |from |export (?:interface|type|class)|interface |type )/.test(line)).join("\n");
    if (imports) {
      const uri = document.uri.toString(); const previous = this.imports.get(uri);
      const snippet: CompletionSnippet = { uri, version: 0, kind: "imports", text: imports, score: 1, revision: previous?.text === imports ? previous.revision ?? 0 : ++this.revision };
      this.imports.set(uri, snippet); snippets.push(snippet);
      while (this.imports.size > 96) this.imports.delete(this.imports.keys().next().value!);
    }
    // Both queries are bounded by this task's single concurrency slot. Late results never enter a snapshot.
    const point = new vscode.Position(position.line, Math.max(0, position.character - 1));
    let locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeTypeDefinitionProvider", document.uri, point);
    if (!locations?.length && performance.now() - at <= 100) locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", document.uri, point);
    for (const location of (locations ?? []).slice(0, 2)) {
      if (performance.now() - at > 100) break;
      const target = "targetUri" in location ? location.targetUri : location.uri;
      if (this.root(target) !== root) continue;
      await this.loadRules(target);
      if (!this.allowed(target)) continue;
      const doc = await vscode.workspace.openTextDocument(target);
      const range = "targetRange" in location ? location.targetRange : location.range;
      const start = doc.offsetAt(range.start);
      const end = Math.min(doc.offsetAt(range.end), start + 1200);
      snippets.push({ uri: target.toString(), version: doc.version, kind: "definition", text: doc.getText(new vscode.Range(doc.positionAt(start), doc.positionAt(end))), score: 1.5 });
    }
    const nearby = documentWindow(document, position, this.settings(document.uri));
    for (const example of examples.slice(0, 4)) {
      if (performance.now() - at > 100) break;
      const target = vscode.Uri.joinPath(vscode.Uri.parse(root), example.path);
      await this.loadRules(target);
      if (!this.allowed(target)) { this.invalidExample(root, example); continue; }
      const doc = await vscode.workspace.openTextDocument(target);
      const text = doc.getText(new vscode.Range(doc.positionAt(example.offset), doc.positionAt(example.offset + example.length)));
      if (fingerprint(text) !== example.hash) { this.invalidExample(root, example); continue; }
      const snippet = completionExampleSnippet(example, text, nearby, target.toString(), doc.version);
      if (snippet) snippets.push(snippet);
    }
    if (this.disposed || document.isClosed || document.version !== version || this.epoch !== epoch) return;
    // Imports are cheap and valid even if the language provider has exceeded its deadline.
    this.cache.set(document.uri.toString(), { version, at: performance.now(), snippets: performance.now() - at > 100 ? snippets.filter((s) => s.kind === "imports") : snippets });
    while (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value!);
  }
  dependencyValid(request: CompletionRequest): boolean {
    if (request.sources?.some((s) => (s.kind === "imports" ? this.imports.get(s.uri)?.revision : this.revisions.get(s.uri) ?? 0) !== s.revision)) return false;
    if (!request.uri) return true;
    const cached = this.cache.get(request.uri);
    return !cached || cached.snippets.every((snippet) => {
      const doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === snippet.uri);
      return (snippet.kind === "imports" || !doc || doc.version === snippet.version) && this.allowed(vscode.Uri.parse(snippet.uri));
    });
  }
  invalidate(uri: string, keepImports = false): void {
    if (!keepImports) this.imports.delete(uri);
    this.revisions.set(uri, ++this.revision);
    while (this.revisions.size > 512) this.revisions.delete(this.revisions.keys().next().value!);
    this.windows.delete(uri);
    this.cache.delete(uri);
    for (const [key, entry] of this.cache) if (entry.snippets.some((s) => s.uri === uri)) this.cache.delete(key);
    for (const [root, entries] of this.recent) this.recent.set(root, entries.filter((s) => s.uri !== uri));
  }
  clear(): void {
    this.epoch++;
    this.rules.clear(); this.cache.clear(); this.paths.clear(); this.recent.clear();
    this.imports.clear();
    this.windows.clear(); for (const timer of this.warming.values()) clearTimeout(timer); this.warming.clear();
  }
  report() { return { cachedFiles: this.cache.size, roots: this.rules.size, queries: [this.queue.report()] }; }
  dispose(): void { this.disposed = true; this.subscriptions.forEach((s) => { s.dispose(); }); this.queue.dispose(); this.clear(); }
}
