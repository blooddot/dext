import * as vscode from "vscode";
import {
  CompletionCache,
  CompletionClient,
  CompletionPacer,
  completionWindow,
  typedSince,
  type CompletionRequest,
  type CompletionSettings,
  type CompletionTiming
} from "./core/completionProvider.js";
import { isIgnored, parseIgnoreRules, type IgnoreRule } from "./core/ignoreRules.js";
import type { CompletionDiagnostics } from "./vscodeCompletionSetup.js";

const DEXTIGNORE = ".dextignore";
const GITIGNORE = ".gitignore";

export interface CompletionHostOptions {
  settings: () => CompletionSettings;
  apiKey: () => Promise<string | undefined>;
}

/** A request that is still arriving, kept across keystrokes so that typing the
 * start of what it is producing waits for the rest of it. */
interface PendingGeneration {
  prefix: string;
  suffix: string;
  controller: AbortController;
  promise: Promise<string>;
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
  private pending: PendingGeneration | undefined;
  private key: Promise<string | undefined> | undefined;
  private readonly pacer = new CompletionPacer();
  private lastTiming: CompletionTiming | undefined;

  constructor(private readonly options: CompletionHostOptions) {
    this.client = new CompletionClient(
      (url, init) => fetch(url, init),
      (failure) => {
        // Recorded as well as reported: the notification fires once per window,
        // so by the time anyone asks why there is no ghost text it is long gone.
        this.lastFailure = { message: failure.message, at: Date.now() };
        if (!failure.rateLimited) {
          this.reportOnce(`${failure.message} Dext will keep trying quietly.`);
          return;
        }
        // Being told to slow down is not a fault to report and then ignore: the
        // spacing is adjusted, and saying so once explains the pause.
        this.pacer.refused(Date.now(), failure.retryAfterMs);
        this.reportOnce(
          `${failure.message} Dext is spacing its completion requests out to roughly `
          + `${Math.round(1000 / this.pacer.spacing)} a second to stay under the limit.`
        );
      },
      (timing) => { this.lastTiming = timing; }
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
    this.key = undefined;
    this.pending?.controller.abort();
    this.pending = undefined;
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
    // A generation for this position is already on its way, so there is nothing
    // left to debounce: waiting again would only delay a request in flight.
    if (!this.reusable(request) && !await this.settle(settings.debounceMs, token)) {
      return this.done("the editor cancelled the request during the debounce window");
    }
    const startedAt = Date.now();
    const completion = await this.generate(settings, request, document.languageId);
    if (completion) {
      // Cached before the cancellation is looked at. The editor abandons this
      // call as soon as the next key goes down, but the answer was paid for and
      // the very next call asks about a position one character along, which the
      // cache can serve from it. Discarding it here made a slow backend feel
      // slower than it is: every keystroke threw away a finished generation.
      this.cache.set(request, completion);
      return token.isCancellationRequested
        ? this.done("answered after the editor moved on, and kept for the next keystroke")
        : this.done("offered a completion", [this.item(completion, position)]);
    }
    if (token.isCancellationRequested) return this.done("the editor cancelled the request while the model answered");
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
  report(): CompletionDiagnostics {
    const measured = { timing: this.lastTiming, spacing: this.pacer.spacing };
    if (!this.lastOutcome) {
      return { invocations: this.invocations, outcome: "never asked for a completion", since: "-", ...measured };
    }
    const seconds = Math.round((Date.now() - this.lastOutcome.at) / 1000);
    return {
      invocations: this.invocations,
      outcome: this.lastOutcome.reason,
      since: seconds < 1 ? "just now" : `${seconds}s ago`,
      ...measured
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

  /** The generation still arriving for this position, if the only thing that has
   * changed since it started is that its own opening characters were typed. */
  private reusable(request: CompletionRequest): PendingGeneration | undefined {
    const pending = this.pending;
    if (!pending || pending.suffix !== request.suffix) return undefined;
    return typedSince(pending.prefix, request.prefix) === undefined ? undefined : pending;
  }

  /** The editor cancels the previous call on every keystroke. Tying the request
   * to that cancellation meant throwing away a nearly finished generation and
   * starting from nothing each time a letter was typed, so the request outlives
   * the call that started it and the next keystroke waits on the same answer.
   * It is only abandoned once what the user typed has diverged from it. */
  private async generate(
    settings: CompletionSettings,
    request: CompletionRequest,
    languageId: string
  ): Promise<string> {
    const pending = this.reusable(request);
    if (pending) {
      const full = await pending.promise;
      const typed = typedSince(pending.prefix, request.prefix);
      if (typed !== undefined && full.startsWith(typed)) return full.slice(typed.length);
    }
    this.pending?.controller.abort();
    const controller = new AbortController();
    // Registered before the first await inside `dispatch`, so a keystroke that
    // lands while the pacer is holding a request back joins it rather than
    // queueing a second one behind it.
    const promise = this.dispatch(settings, request, languageId, controller.signal);
    this.pending = { prefix: request.prefix, suffix: request.suffix, controller, promise };
    const completion = await promise;
    // Left in place only if nothing newer has replaced it, so a slow answer
    // cannot clear the generation that superseded it.
    if (this.pending?.promise === promise) this.pending = undefined;
    return completion;
  }

  private async dispatch(
    settings: CompletionSettings,
    request: CompletionRequest,
    languageId: string,
    signal: AbortSignal
  ): Promise<string> {
    const held = this.pacer.wait(Date.now());
    if (held > 0) await new Promise((resolve) => setTimeout(resolve, held));
    if (signal.aborted) return "";
    this.pacer.started(Date.now());
    return this.client.complete(settings, { ...request, languageId }, await this.apiKey(), signal);
  }

  /** Secret storage is backed by the OS keychain, which is far too slow to ask
   * once per keystroke. Cleared whenever the key might have changed. */
  private apiKey(): Promise<string | undefined> {
    this.key ??= this.options.apiKey();
    return this.key;
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
    void vscode.window.showWarningMessage(message);
  }
}
