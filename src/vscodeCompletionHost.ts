import * as vscode from "vscode";
import { relative } from "node:path";
import { randomUUID } from "node:crypto";
import { completionIdentity, HttpCompletionBackend } from "./core/completionBackend.js";
import { completionCandidate } from "./core/completionCandidate.js";
import { completionBudget } from "./core/completionProfiles.js";
import { adaptationKey, adaptationPolicy } from "./core/completionAdaptation.js";
import { fingerprint } from "./core/completionContext.js";
import { CompletionMemory, type CompletionMemoryStore, type CompletionEpochs } from "./core/completionMemory.js";
import { CompletionFeedback, type AcceptedCompletion } from "./core/completionFeedback.js";
import type { DextCompletionContext } from "./vscodeCompletionContext.js";
import {
  CompletionCache,
  CompletionClient,
  CompletionPacer,
  completionWindow,
  typedSince,
  type CompletionRequest,
  type CompletionFetch,
  type CompletionSettings,
  type CompletionTiming
} from "./core/completionProvider.js";
import { isIgnored, parseIgnoreRules, type IgnoreRule } from "./core/ignoreRules.js";
import type { CompletionDiagnostics } from "./vscodeCompletionSetup.js";

const DEXTIGNORE = ".dextignore";
const GITIGNORE = ".gitignore";

export interface CompletionHostOptions {
  fetch?: CompletionFetch;
  settings: (uri?: vscode.Uri) => CompletionSettings;
  apiKey: () => Promise<string | undefined>;
  context?: DextCompletionContext;
  memoryStore?: CompletionMemoryStore;
  memoryEpochs?: CompletionEpochs;
}

/** A request that is still arriving, kept across keystrokes so that typing the
 * start of what it is producing waits for the rest of it. */
interface PendingGeneration {
  request: CompletionRequest;
  identity: string;
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
  private readonly http: HttpCompletionBackend;
  private readonly status: vscode.StatusBarItem;
  private ignoreRules: IgnoreRule[] | undefined;
  private reportedFailure = false;
  private disabledForSession = false;
  private invocations = 0;
  private lastOutcome: { reason: string; at: number } | undefined;
  private lastFailure: { message: string; at: number } | undefined;
  private pending: PendingGeneration | undefined;
  private key: Promise<string | undefined> | undefined;
  private httpAccountScope: string = randomUUID();
  private readonly pacer = new CompletionPacer();
  private lastTiming: CompletionTiming | undefined;
  private epoch = 0;
  private invocation = 0;
  private disposed = false;
  private readonly memory: CompletionMemory;
  private readonly feedback: CompletionFeedback;
  private readonly offers = new Map<string, AcceptedCompletion>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly observeTimer: ReturnType<typeof setInterval>;
  private readonly measurements: Record<string, number>[] = [];
  private lastContext: { prefixChars: number; suffixChars: number; relatedChars: number; sources: Record<string, number>; policy: { samples: number; output: number; examples: number } } | undefined;
  private readonly decisions = new Map<string, number>();
  private lastEdit: { uri: string; version: number; at: number } | undefined;

  constructor(private readonly options: CompletionHostOptions) {
    this.memory = new CompletionMemory(options.memoryStore, options.settings().adaptation, Date.now, options.memoryEpochs);
    options.context?.onInvalidExample((root, example) => this.memory.removeExample(root, example));
    this.feedback = new CompletionFeedback((entry, outcome) => {
      this.memory.record(entry.root, entry.key, outcome);
      if (outcome === "retained") this.memory.addExample(entry.root, {
        path: relative(vscode.Uri.parse(entry.root).fsPath, vscode.Uri.parse(entry.uri).fsPath).replaceAll("\\", "/"),
        offset: entry.offset, length: entry.text.length, hash: fingerprint(entry.text), updated: Date.now()
      });
    });
    if (vscode.workspace.onDidChangeTextDocument) this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.lastEdit = { uri: event.document.uri.toString(), version: event.document.version, at: performance.now() };
        this.feedback.change(event.document.uri.toString(), event.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })), event.reason === vscode.TextDocumentChangeReason.Undo);
      }), vscode.workspace.onDidCloseTextDocument((doc) => {
        this.feedback.close(doc.uri.toString());
        this.pending?.controller.abort(); this.pending = undefined;
      }));
    this.observeTimer = setInterval(() => this.feedback.mature((entry) => {
      const doc = vscode.workspace.textDocuments?.find((d) => d.uri.toString() === entry.uri);
      if (!doc || (options.context && !options.context.allowed(doc.uri))) return undefined;
      return { text: doc.getText(new vscode.Range(doc.positionAt(entry.offset), doc.positionAt(entry.offset + entry.text.length))), saved: !doc.isDirty };
    }), 5000);
    this.observeTimer.unref();
    this.client = new CompletionClient(
      options.fetch ?? ((url, init) => fetch(url, init)),
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
      (timing) => {
        this.lastTiming = timing;
        this.measurements.push(Object.fromEntries(Object.entries(timing).filter((entry): entry is [string, number] => typeof entry[1] === "number")));
        while (this.measurements.length > 200) this.measurements.shift();
      }
    );
    this.http = new HttpCompletionBackend(this.client, () => this.apiKey());
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.status.command = "dext.completionMenu";
    this.refresh();
  }

  /** Settings changed, or the toggle was used. Cached completions were produced
   * under the old configuration, so they go. */
  refresh(): void {
    this.epoch++; this.invocation++;
    this.offers.clear(); this.feedback.clear(); this.options.context?.clear();
    this.memory.setMode(this.options.settings().adaptation, vscode.workspace.workspaceFolders?.map((f) => f.uri.toString()) ?? []);
    this.cache.clear();
    this.ignoreRules = undefined;
    this.reportedFailure = false;
    this.key = undefined;
    this.httpAccountScope = randomUUID();
    this.pending?.controller.abort();
    this.pending = undefined;
    const settings = this.options.settings();
    if (settings.enabled) void this.apiKey().catch(() => undefined);
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

  accept(id: string): void {
    const entry = this.offers.get(id); this.offers.delete(id);
    if (entry && this.options.settings().adaptation !== "off") this.feedback.accept(entry);
  }

  async clearMemory(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const root = uri ? vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() : undefined;
    const cleared = root ? this.memory.clear(root) : Promise.resolve();
    // Invalidate visible/cached suggestions immediately, even if storage is slow.
    this.refresh();
    await cleared;
  }

  memoryReport() { return this.memory.report(); }

  dispose(): void {
    this.disposed = true; this.epoch++; this.pending?.controller.abort();
    clearInterval(this.observeTimer); this.http.dispose(); this.memory.dispose(); this.feedback.clear();
    this.subscriptions.forEach((s) => { s.dispose(); }); this.offers.clear();
    this.status.dispose();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[]> {
    this.invocations += 1;
    const at = performance.now(); const epoch = this.epoch;
    const editAt = this.lastEdit?.uri === document.uri.toString() && this.lastEdit.version === document.version ? this.lastEdit.at : undefined;
    const finish = (reason: string, items: vscode.InlineCompletionItem[] = [], cacheAt?: number) => {
      this.measurements.push({ providerMs: performance.now() - at, returnedCandidates: items.length, cancelled: Number(token.isCancellationRequested),
        ...(editAt === undefined ? {} : { editToReturnMs: performance.now() - editAt }) });
      while (this.measurements.length > 200) this.measurements.shift();
      return this.done(reason, items, cacheAt);
    };
    const settings = { ...this.options.settings(document.uri) };
    if (this.disposed) return finish("completion host is closed");
    if (!settings.enabled) return finish("the backend is not configured or is turned off in settings");
    if (this.disabledForSession) return finish("completion is switched off for this window");
    // `.dx` has a typed API completion provider of its own; a FIM model guessing
    // at the same position would only fight it.
    if (document.languageId === "dext-api") return finish("a .dx file is left to the typed API provider");
    if (document.uri.scheme !== "file") return finish(`the document scheme is '${document.uri.scheme}', not 'file'`);
    // Ignored automatic requests must not supersede a manual request during debounce.
    const invocation = ++this.invocation;
    const filterAt = performance.now();
    const excluded = await this.excluded(document.uri);
    this.measurements.push({ fileFilterMs: performance.now() - filterAt });
    if (excluded) return finish("the file is excluded by .gitignore or .dextignore");
    const version = document.version;
    const assemblyAt = performance.now();
    const request: CompletionRequest = { ...this.snapshot(document, position, settings), timingOrigin: { providerAt: at, ...(editAt === undefined ? {} : { editAt }) } };
    this.measurements.push({ contextAssemblyMs: performance.now() - assemblyAt });
    this.lastContext = { prefixChars: request.prefix.length, suffixChars: request.suffix.length, relatedChars: request.context?.length ?? 0,
      sources: (request.sources ?? []).reduce<Record<string, number>>((counts, source) => { const kind = source.kind ?? "definition"; counts[kind] = (counts[kind] ?? 0) + 1; return counts; }, {}),
      policy: request.policy ?? { samples: 0, output: 1, examples: 1 } };
    if (!request.prefix.trim()) return finish("there is no code before the cursor to continue");
    const cached = this.cache.get(request);
    if (cached !== undefined) {
      return cached
        ? finish("served from cache", token.isCancellationRequested ? [] : this.items(cached, request, document, position, context), at)
        : finish("a previous request for this exact position returned nothing");
    }
    // A generation for this position is already on its way, so there is nothing
    // left to debounce: waiting again would only delay a request in flight.
    const debounceAt = performance.now();
    if (!this.reusable(request)) {
      const settled = await this.settle(settings.debounceMs, token);
      this.measurements.push({ debounceMs: performance.now() - debounceAt });
      if (!settled) return finish("the editor cancelled the request during the debounce window");
    }
    const startedAt = Date.now();
    const sentAt = performance.now();
    const completion = await this.generate(settings, request, document.languageId, invocation);
    this.measurements.push({ generationReadyMs: performance.now() - at, prepareAndDebounceMs: sentAt - at, generationMs: performance.now() - sentAt });
    if (this.measurements.length > 200) this.measurements.shift();
    if (epoch !== this.epoch || this.disposed || (this.options.context && !this.options.context.dependencyValid(request))) return finish("the completion dependencies changed");
    if (completion) {
      // Cached before the cancellation is looked at. The editor abandons this
      // call as soon as the next key goes down, but the answer was paid for and
      // the very next call asks about a position one character along, which the
      // cache can serve from it. Discarding it here made a slow backend feel
      // slower than it is: every keystroke threw away a finished generation.
      this.cache.set(request, completion);
      return token.isCancellationRequested || (version !== undefined && document.version !== version)
        ? finish("answered after the editor moved on, and kept for the next keystroke")
        : (() => {
          const items = this.items(completion, request, document, position, context);
          return finish(items.length ? "offered a completion" : "the candidate was filtered or conflicts with the selected suggestion", items);
        })();
    }
    if (token.isCancellationRequested) return finish("the editor cancelled the request while the model answered");
    // `complete` reports a failure as an empty string so a broken keystroke stays
    // invisible, which makes a timeout indistinguishable from a model with
    // nothing to add unless the error that arrived meanwhile is checked for.
    const failure = this.lastFailure && this.lastFailure.at >= startedAt ? this.lastFailure.message : undefined;
    if (failure) return finish(`the request failed: ${failure}`);
    // An empty answer is cached; a failed one is not, or a single outage would
    // poison the position until the next settings change.
    this.cache.set(request, completion);
    return finish("the model answered with nothing to insert");
  }

  private done(reason: string, items: vscode.InlineCompletionItem[] = [], at?: number): vscode.InlineCompletionItem[] {
    if (at !== undefined) { this.measurements.push({ cachedMs: performance.now() - at }); if (this.measurements.length > 200) this.measurements.shift(); }
    this.lastOutcome = { reason, at: Date.now() };
    return items;
  }

  /** What happened the last time the editor asked, and whether it has ever
   * asked at all. The second is the more useful of the two: an invocation count
   * of zero means nothing in Dext is at fault. */
  report(): CompletionDiagnostics {
    const measured = { timing: this.lastTiming, spacing: this.pacer.spacing, measurements: this.measurements.slice(-200), memory: this.memory.report(),
      context: this.lastContext, background: this.options.context?.report(), decisions: Object.fromEntries(this.decisions) };
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
    const settings = this.options.settings(document.uri);
    if (await this.excluded(document.uri)) throw new Error("The file is excluded or its ignore rules are still loading.");
    const request = this.snapshot(document, position, settings);
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
    if (!pending || pending.identity !== completionIdentity(request) || pending.suffix !== request.suffix) return undefined;
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
    languageId: string,
    invocation: number
  ): Promise<string> {
    const pending = this.reusable(request);
    if (pending) {
      const full = await pending.promise;
      const typed = typedSince(pending.prefix, request.prefix);
      if (typed !== undefined && full.startsWith(typed)) return full.slice(typed.length);
      if (invocation !== this.invocation) return "";
    }
    if (invocation !== this.invocation || this.disposed) return "";
    this.pending?.controller.abort();
    const controller = new AbortController();
    // Registered before the first await inside `dispatch`, so a keystroke that
    // lands while the pacer is holding a request back joins it rather than
    // queueing a second one behind it.
    const promise = this.dispatch(settings, request, languageId, controller.signal);
    this.pending = { request, identity: completionIdentity(request), prefix: request.prefix, suffix: request.suffix, controller, promise };
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
    const queuedAt = performance.now();
    const held = this.pacer.wait(Date.now());
    if (held > 0) await new Promise((resolve) => setTimeout(resolve, held));
    if (signal.aborted) return "";
    this.measurements.push({ pacingMs: performance.now() - queuedAt });
    if (this.measurements.length > 200) this.measurements.shift();
    this.pacer.started(Date.now());
    const policy = request.policy ?? adaptationPolicy(this.memory.bucket(request.workspace ?? "", adaptationKey(request.backendScope ?? "", languageId, request.singleLine === true)));
    const effective = { ...settings, maxTokens: completionBudget(settings, request, policy.output) };
    const result = await this.http.generate(effective, { ...request, languageId }, signal);
    if (result.outcome !== "success" && result.outcome !== "empty") this.lastFailure = { message: result.reason ?? result.outcome, at: Date.now() };
    return result.text;
  }

  /** Secret storage is backed by the OS keychain, which is far too slow to ask
   * once per keystroke. Cleared whenever the key might have changed. */
  private apiKey(): Promise<string | undefined> {
    if (!this.key) {
      const epoch = this.epoch;
      const at = performance.now();
      this.key = this.options.apiKey().then((key) => {
        this.measurements.push({ credentialLoadMs: performance.now() - at });
        while (this.measurements.length > 200) this.measurements.shift();
        if (epoch === this.epoch) this.httpAccountScope = fingerprint(key ?? "http-without-credential");
        return key;
      });
    }
    return this.key;
  }

  private snapshot(document: vscode.TextDocument, position: vscode.Position, settings: CompletionSettings): CompletionRequest {
    const scope = fingerprint(JSON.stringify(["http", settings.api, settings.endpoint, settings.model, this.httpAccountScope]));
    const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? "";
    const policy = adaptationPolicy(this.memory.bucket(root, adaptationKey(scope, document.languageId, true)));
    const request = this.options.context ? this.options.context.snapshot(document, position, this.memory.examples(root), policy.examples)
      : completionWindow(document.getText(), document.offsetAt(position), settings);
    const frozen = adaptationPolicy(this.memory.bucket(root, adaptationKey(scope, document.languageId, request.singleLine === true)));
    const snapshot = { ...request, workspace: root, uri: document.uri.toString(), version: document.version, offset: document.offsetAt(position), languageId: document.languageId, backendScope: scope,
      policy: frozen, strategy: fingerprint(JSON.stringify(frozen)) };
    const pending = this.pending;
    if (pending && completionIdentity({ ...snapshot, dependency: pending.request.dependency ?? "" }) === pending.identity
      && snapshot.suffix === pending.suffix && typedSince(pending.prefix, snapshot.prefix) !== undefined
      && (!this.options.context || this.options.context.dependencyValid(pending.request))) {
      // Late retrieval/learning cannot replace the snapshot of compatible work.
      return { ...snapshot, context: pending.request.context ?? "", dependency: pending.request.dependency ?? "",
        sources: pending.request.sources ?? [], strategy: pending.request.strategy ?? "", policy: pending.request.policy ?? frozen };
    }
    return snapshot;
  }

  private items(text: string, request: CompletionRequest, document: vscode.TextDocument, position: vscode.Position, context: vscode.InlineCompletionContext): vscode.InlineCompletionItem[] {
    const processingAt = performance.now();
    const decide = (reason: string) => {
      this.decisions.set(reason, Math.min(1_000_000, (this.decisions.get(reason) ?? 0) + 1));
      this.measurements.push({ candidateProcessingMs: performance.now() - processingAt });
      while (this.measurements.length > 200) this.measurements.shift();
    };
    const candidate = completionCandidate(text, request); if (!candidate) { decide("empty_or_invalid_text"); return []; }
    const offset = Math.max(0, (request.offset ?? 0) - candidate.replaceBefore);
    if (this.feedback.isSuppressed(request.backendScope ?? "", request.uri ?? "", offset, candidate.text) && Number(context.triggerKind) !== 0) { decide("recently_undone"); return []; }
    const positionAt = (document as Partial<vscode.TextDocument>).positionAt;
    const range = positionAt ? new vscode.Range(document.positionAt(offset), document.positionAt((request.offset ?? 0) + candidate.replaceAfter)) : new vscode.Range(position, position);
    const insertText = positionAt ? candidate.text : text;
    if (context.selectedCompletionInfo && (!range.isEqual(context.selectedCompletionInfo.range) || !insertText.startsWith(context.selectedCompletionInfo.text))) { decide("selected_completion_conflict"); return []; }
    const item = new vscode.InlineCompletionItem(insertText, range);
    item.filterText = candidate.original + insertText;
    item.command = { command: "dext.completionAccepted", title: "Record completion acceptance", arguments: [candidate.id] };
    this.offers.set(candidate.id, { id: candidate.id, uri: request.uri ?? "", root: request.workspace ?? "", scope: request.backendScope ?? "",
      key: adaptationKey(request.backendScope ?? "", request.languageId ?? "", request.singleLine === true), offset, text: candidate.text, original: candidate.original, acceptedAt: Date.now() });
    while (this.offers.size > 64) this.offers.delete(this.offers.keys().next().value!);
    decide("returned_candidate");
    return [item];
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
    if (this.options.context) return !this.options.context.allowed(uri);
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
