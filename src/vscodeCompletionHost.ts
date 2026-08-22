import * as vscode from "vscode";
import {
  CompletionCache,
  CompletionClient,
  completionWindow,
  type CompletionSettings
} from "./core/completionProvider.js";
import { isIgnored, parseIgnoreRules, type IgnoreRule } from "./core/ignoreRules.js";

const DEXTIGNORE = ".dextignore";
const GITIGNORE = ".gitignore";

export interface CompletionHostOptions {
  settings: () => CompletionSettings;
  apiKey: () => Promise<string | undefined>;
}

/** Inline completion for ordinary source files, backed by a separate low-latency
 * model. Distinct from the Dext sidebar: this one has to answer between two
 * keystrokes, so it debounces, caches, and gives up quietly. */
export class DextCompletionHost implements vscode.InlineCompletionItemProvider {
  private readonly cache = new CompletionCache();
  private readonly client: CompletionClient;
  private readonly status: vscode.StatusBarItem;
  private ignoreRules: IgnoreRule[] | undefined;
  private reportedFailure = false;
  private disabledForSession = false;
  private invocations = 0;
  private lastOutcome: { reason: string; at: number } | undefined;
  private lastFailure: { message: string; at: number } | undefined;

  constructor(private readonly options: CompletionHostOptions) {
    this.client = new CompletionClient(
      (url, init) => fetch(url, init),
      (message) => {
        // Recorded as well as reported: the notification fires once per window,
        // so by the time anyone asks why there is no ghost text it is long gone.
        this.lastFailure = { message, at: Date.now() };
        this.reportOnce(message);
      }
    );
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "dext.completionMenu";
    this.refresh();
  }

  /** Settings changed, or the toggle was used. Cached completions were produced
   * under the old configuration, so they go. */
  refresh(): void {
    this.cache.clear();
    this.ignoreRules = undefined;
    this.reportedFailure = false;
    const settings = this.options.settings();
    if (!settings.enabled) {
      // The item stays put while unconfigured: it is the entry point to the
      // setup wizard, and hiding it left first-time users with nothing to click.
      this.status.text = "$(sparkle) Dext: off";
      this.status.tooltip = "Dext inline completion is not set up. Click to choose a model.";
      this.status.show();
      return;
    }
    const active = !this.disabledForSession;
    this.status.text = active ? "$(sparkle) Dext" : "$(circle-slash) Dext";
    this.status.tooltip = active
      ? `Dext completion is on (${settings.api} · ${settings.model}). Click for options.`
      : "Dext completion is off for this window. Click for options.";
    this.status.show();
  }

  /** Off for this window only, so sharing an editor with another completion
   * extension does not mean editing settings. */
  toggle(): void {
    if (!this.options.settings().enabled) {
      void vscode.commands.executeCommand("dext.configureCompletionModel");
      return;
    }
    this.disabledForSession = !this.disabledForSession;
    this.refresh();
  }

  /** Switched off for this window without settings having changed. */
  get suspended(): boolean {
    return this.disabledForSession;
  }

  /** Exposed so the setup wizard tests connectivity over the same transport that
   * completions use, rather than a second hand-rolled request. */
  verify(settings: CompletionSettings, apiKey?: string): Promise<string> {
    return this.client.verify(settings, apiKey);
  }

  dispose(): void {
    this.status.dispose();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    this.invocations += 1;
    const settings = this.options.settings();
    if (!settings.enabled) return this.done("the backend is not configured or is turned off in settings");
    if (this.disabledForSession) return this.done("completion is switched off for this window");
    // `.dx` has a typed API completion provider of its own; a FIM model guessing
    // at the same position would only fight it.
    if (document.languageId === "dext-api") return this.done("a .dx file is left to the typed API provider");
    if (document.uri.scheme !== "file") return this.done(`the document scheme is '${document.uri.scheme}', not 'file'`);
    if (await this.excluded(document.uri)) return this.done("the file is excluded by .gitignore or .dextignore");
    const request = completionWindow(document.getText(), document.offsetAt(position), settings);
    if (!request.prefix.trim()) return this.done("there is no code before the cursor to continue");
    const cached = this.cache.get(request);
    if (cached !== undefined) {
      return cached
        ? this.done("served from cache", [this.item(cached, position)])
        : this.done("a previous request for this exact position returned nothing");
    }
    if (!await this.settle(settings.debounceMs, token)) {
      return this.done("the editor cancelled the request during the debounce window");
    }
    const startedAt = Date.now();
    const completion = await this.client.complete(
      settings,
      { ...request, languageId: document.languageId },
      await this.options.apiKey(),
      this.signal(token)
    );
    if (token.isCancellationRequested) return this.done("the editor cancelled the request while the model answered");
    if (completion) {
      this.cache.set(request, completion);
      return this.done("offered a completion", [this.item(completion, position)]);
    }
    // `complete` reports a failure as an empty string so a broken keystroke stays
    // invisible, which makes a timeout indistinguishable from a model with
    // nothing to add unless the error that arrived meanwhile is checked for.
    const failure = this.lastFailure && this.lastFailure.at >= startedAt ? this.lastFailure.message : undefined;
    if (failure) return this.done(`the request failed: ${failure}`);
    // An empty answer is cached; a failed one is not, or a single outage would
    // poison the position until the next settings change.
    this.cache.set(request, completion);
    return this.done("the model answered with nothing to insert");
  }

  private done(reason: string, items: vscode.InlineCompletionItem[] = []): vscode.InlineCompletionItem[] {
    this.lastOutcome = { reason, at: Date.now() };
    return items;
  }

  /** What happened the last time the editor asked, and whether it has ever
   * asked at all. The second is the more useful of the two: an invocation count
   * of zero means nothing in Dext is at fault. */
  report(): { invocations: number; outcome: string; since: string } {
    if (!this.lastOutcome) {
      return { invocations: this.invocations, outcome: "never asked for a completion", since: "-" };
    }
    const seconds = Math.round((Date.now() - this.lastOutcome.at) / 1000);
    return {
      invocations: this.invocations,
      outcome: this.lastOutcome.reason,
      since: seconds < 1 ? "just now" : `${seconds}s ago`
    };
  }

  /** One completion for the real cursor, with the debounce, the cache and
   * cancellation taken out of the way, so a diagnosis reflects the backend
   * rather than the timing. Throws what went wrong. */
  async probe(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
    const settings = this.options.settings();
    const request = completionWindow(document.getText(), document.offsetAt(position), settings);
    return this.client.verify(
      settings,
      await this.options.apiKey(),
      { ...request, languageId: document.languageId }
    );
  }

  private item(text: string, position: vscode.Position): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
  }

  /** Waits out the debounce window. Returns false if the keystroke that asked
   * for this completion has already been superseded. */
  private async settle(debounceMs: number, token: vscode.CancellationToken): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, debounceMs));
    return !token.isCancellationRequested;
  }

  private signal(token: vscode.CancellationToken): AbortSignal {
    const controller = new AbortController();
    token.onCancellationRequested(() => controller.abort());
    return controller.signal;
  }

  /** Ignore rules are read once per window and reused, because reading two files
   * on every keystroke would cost more than the completion itself. */
  private async excluded(uri: vscode.Uri): Promise<boolean> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return true;
    if (!this.ignoreRules) this.ignoreRules = await this.loadIgnoreRules(folder.uri);
    const relative = vscode.workspace.asRelativePath(uri, false);
    return isIgnored(this.ignoreRules, relative);
  }

  private async loadIgnoreRules(root: vscode.Uri): Promise<IgnoreRule[]> {
    const names = this.options.settings().ignoreGitignore ? [GITIGNORE, DEXTIGNORE] : [DEXTIGNORE];
    const rules: IgnoreRule[] = [];
    for (const name of names) {
      try {
        const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
        // `.dextignore` is read last so it can re-include something `.gitignore`
        // excluded, which is the only way to complete in a generated file.
        rules.push(...parseIgnoreRules(new TextDecoder().decode(content)));
      } catch {
        // A missing ignore file is the normal case.
      }
    }
    return rules;
  }

  private reportOnce(message: string): void {
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    void vscode.window.showWarningMessage(`${message} Dext will keep trying quietly.`);
  }
}
