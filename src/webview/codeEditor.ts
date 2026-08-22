import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags, type Tag } from "@lezer/highlight";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  insertNewlineAndIndent
} from "@codemirror/commands";
import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  type Extension
} from "@codemirror/state";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  hoverTooltip,
  lineNumbers,
  keymap,
  showTooltip,
  type Tooltip,
  type ViewUpdate
} from "@codemirror/view";
import type { SignatureHelp } from "../core/languageService.js";
import type { ClipboardClient, ClipboardReadResult } from "./clipboardClient.js";
import type { FileSearchClient } from "./fileSearchClient.js";
import { codeReferencePasteText } from "./codeReferencePaste.js";
import { fileReferenceDecorations } from "./fileReferenceDecorations.js";
import { inputReferenceProjections, normalizeInputReferenceSource } from "../core/fileReference.js";
import type { ContextReferenceOccurrence } from "../core/fileReference.js";
import { sourceSnapshotMatches } from "./languageClient.js";
import type { LanguageRequestBroker } from "./languageClient.js";
import {
  fileReferenceInsertion,
  inlineInsertion,
  invocationInsertion
} from "./inputInsertion.js";
import type { EditorTokenTheme } from "../vscodeTheme.js";

export interface CodeEditorOptions {
  parent: HTMLElement;
  broker: LanguageRequestBroker;
  clipboard: ClipboardClient;
  files: FileSearchClient;
  onRun(): void;
  onOpenReference(reference: ContextReferenceOccurrence): void;
  onDiagnosticsChanged(counts: { errors: number; warnings: number }): void;
  onInputKindChanged(kind: "empty" | "workflow" | "invalid"): void;
  onSourceChanged?(): void;
  onError(error: unknown): void;
}

export function pasteEventText(event: Pick<ClipboardEvent, "clipboardData">): string | undefined {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return undefined;
  const plainTextType = [...clipboardData.types]
    .find((type) => type.toLowerCase() === "text/plain");
  return plainTextType ? clipboardData.getData(plainTextType) : undefined;
}

const signatureEffect = StateEffect.define<Tooltip | null>();
const tokenTags: Readonly<Record<keyof EditorTokenTheme, readonly Tag[]>> = {
  keyword: [tags.keyword, tags.controlKeyword],
  string: [tags.string, tags.special(tags.string)],
  number: [tags.number],
  boolean: [tags.bool, tags.null],
  comment: [tags.comment, tags.docComment],
  function: [tags.function(tags.variableName), tags.function(tags.propertyName)],
  property: [tags.propertyName, tags.attributeName],
  variable: [tags.variableName, tags.definition(tags.variableName)],
  type: [tags.typeName, tags.className],
  operator: [tags.operator, tags.operatorKeyword],
  punctuation: [tags.punctuation, tags.bracket]
};

function themeExtension(theme?: EditorTokenTheme): Extension {
  if (!theme) return syntaxHighlighting(defaultHighlightStyle);
  const rules = (Object.entries(theme) as [keyof EditorTokenTheme, string | undefined][])
    .filter((entry): entry is [keyof EditorTokenTheme, string] => Boolean(entry[1]))
    .map(([name, color]) => ({ tag: tokenTags[name], color }));
  return rules.length
    ? syntaxHighlighting(HighlightStyle.define(rules))
    : syntaxHighlighting(defaultHighlightStyle);
}
const signatureField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection) value = null;
    for (const effect of transaction.effects) {
      if (effect.is(signatureEffect)) value = effect.value;
    }
    return value;
  },
  provide: (field) => showTooltip.from(field)
});

function completionType(kind: string): string {
  if (kind === "namespace") return "namespace";
  if (kind === "method") return "method";
  if (kind === "parameter") return "property";
  if (kind === "reference") return "variable";
  return "value";
}

function diagnosticMarkClass(severity: Diagnostic["severity"]): string {
  return `dext-diagnostic-${severity === "hint" ? "info" : severity}`;
}

function signatureDom(document: Document, signature: SignatureHelp): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "dext-signature-tooltip";
  const code = document.createElement("code");
  const active = signature.parameters[signature.activeParameter]?.label;
  if (!active) {
    code.textContent = signature.label;
  } else {
    const offset = signature.label.indexOf(active);
    if (offset < 0) code.textContent = signature.label;
    else {
      code.append(document.createTextNode(signature.label.slice(0, offset)));
      const emphasized = document.createElement("strong");
      emphasized.textContent = active;
      code.append(emphasized, document.createTextNode(signature.label.slice(offset + active.length)));
    }
  }
  dom.append(code);
  const documentation = signature.parameters[signature.activeParameter]?.documentation
    || signature.documentation;
  if (documentation) {
    const detail = document.createElement("div");
    detail.className = "dext-tooltip-detail";
    detail.textContent = documentation;
    dom.append(detail);
  }
  return dom;
}

function completionApply(item: { insertText: string }): Completion["apply"] {
  if (!item.insertText.includes('""')) return item.insertText;
  return snippet(item.insertText.replace('""', '"${}"'));
}

function selectionMatches(
  view: EditorView,
  source: string,
  anchor: number,
  head: number
): boolean {
  const current = view.state.selection.main;
  return sourceSnapshotMatches(view.state.doc.toString(), source)
    && current.anchor === anchor
    && current.head === head;
}

export class DextCodeEditor {
  readonly view: EditorView;
  private readonly theme = new Compartment();
  private readonly language = new Compartment();
  private readonly lineWrapping = new Compartment();
  private readonly submitKeymap = new Compartment();
  private diagnosticsTimer: ReturnType<typeof setTimeout> | undefined;
  private signatureTimer: ReturnType<typeof setTimeout> | undefined;
  private diagnostics: Diagnostic[] = [];
  private languageEnabled = true;
  private submitOnEnter = true;

  constructor(private readonly options: CodeEditorOptions) {
    const extensions: Extension[] = [
      history(),
      this.language.of(python()),
      this.lineWrapping.of([]),
      this.theme.of(themeExtension()),
      // Ahead of the main keymap so that a chat-mode Enter is claimed before
      // the default binding turns it into a newline.
      this.submitKeymap.of(this.submitKeymapExtension()),
      lineNumbers(),
      lintGutter(),
      highlightSpecialChars(),
      drawSelection(),
      closeBrackets(),
      signatureField,
      fileReferenceDecorations({
        onOpen: (reference) => options.onOpenReference(reference)
      }),
      autocompletion({
        override: [
          (context) => this.fileCompletions(context),
          (context) => this.completions(context)
        ],
        activateOnTyping: true,
        activateOnCompletion: (completion) => ["namespace", "method", "property"].includes(completion.type ?? ""),
        defaultKeymap: false,
        icons: true,
        maxRenderedOptions: 50
      }),
      hoverTooltip((view, position) => this.hover(view, position), {
        hoverTime: 300,
        hideOnChange: true
      }),
      EditorState.languageData.of(() => [{
        closeBrackets: { brackets: ["(", "[", '"'] }
      }]),
      EditorView.contentAttributes.of({
        "aria-label": "Dext input",
        spellcheck: "false",
        autocapitalize: "off",
        autocomplete: "off"
      }),
      EditorView.updateListener.of((update) => this.updated(update)),
      EditorView.domEventHandlers({
        copy: (event) => {
          event.preventDefault();
          void this.copy();
          return true;
        },
        cut: (event) => {
          event.preventDefault();
          void this.cut();
          return true;
        },
        paste: (event) => {
          event.preventDefault();
          void this.paste(pasteEventText(event));
          return true;
        }
      }),
      keymap.of([
        indentWithTab,
        { key: "Mod-c", run: () => { void this.copy(); return true; } },
        { key: "Mod-x", run: () => { void this.cut(); return true; } },
        { key: "Mod-v", run: () => { void this.paste(); return true; } },
        { key: "Alt-/", run: () => { startCompletion(this.view); return true; } },
        { key: "Mod-Enter", run: () => { this.options.onRun(); return true; } },
        { key: "F8", run: () => this.navigateDiagnostic(1) },
        { key: "Shift-F8", run: () => this.navigateDiagnostic(-1) },
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...defaultKeymap
      ])
    ];
    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({ doc: "", extensions })
    });
    this.scheduleDiagnostics(0);
  }

  get source(): string {
    return this.view.state.doc.toString();
  }

  /** Chat modes treat the composer as a message box, so Enter sends and
   * Shift+Enter breaks the line. Code mode is a real editor: Enter must always
   * add a line there and Mod-Enter stays the way to run. */
  private submitKeymapExtension(): Extension {
    if (this.languageEnabled || !this.submitOnEnter) return [];
    return keymap.of([
      {
        key: "Enter",
        run: (view) => {
          // An open completion list owns Enter first, otherwise picking a file
          // from the @ menu would send the message instead.
          if (acceptCompletion(view)) return true;
          this.options.onRun();
          return true;
        }
      },
      { key: "Shift-Enter", run: insertNewlineAndIndent }
    ]);
  }

  private refreshSubmitKeymap(): void {
    this.view.dispatch({
      effects: this.submitKeymap.reconfigure(this.submitKeymapExtension())
    });
  }

  setSubmitOnEnter(enabled: boolean): void {
    if (this.submitOnEnter === enabled) return;
    this.submitOnEnter = enabled;
    this.refreshSubmitKeymap();
  }

  focus(): void {
    this.view.focus();
  }

  setValue(value: string, cursor = value.length): void {
    const normalized = normalizeInputReferenceSource(value);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: normalized },
      selection: { anchor: Math.max(0, Math.min(cursor, normalized.length)) },
      scrollIntoView: true,
      userEvent: "input"
    });
    this.focus();
  }

  insertInline(text: string, position?: number): void {
    this.insert(text, position, inlineInsertion);
  }

  insertFileReferences(expressions: readonly string[], position?: number): void {
    const normalized = normalizeInputReferenceSource(this.source);
    if (normalized !== this.source) {
      this.setValue(normalized, this.view.state.selection.main.head);
    }
    const selection = this.view.state.selection.main;
    const from = position === undefined
      ? selection.from
      : Math.max(0, Math.min(position, this.view.state.doc.length));
    const to = position === undefined ? selection.to : from;
    const insertion = fileReferenceInsertion(this.source, from, to, expressions);
    this.view.dispatch({
      changes: { from: insertion.from, to: insertion.to, insert: insertion.text },
      selection: { anchor: insertion.from + insertion.cursorOffset },
      scrollIntoView: true,
      userEvent: "input"
    });
    this.focus();
  }

  removeFileReference(payload: string): void {
    const projection = inputReferenceProjections(this.source).find(
      (candidate) => candidate.reference.payload === payload
    );
    if (!projection) return;
    this.view.dispatch({
      changes: {
        from: projection.interpolationStart,
        to: projection.interpolationEnd
      },
      selection: { anchor: projection.interpolationStart },
      scrollIntoView: true,
      userEvent: "delete"
    });
    this.focus();
  }

  insertInvocation(text: string): void {
    this.insert(text, undefined, invocationInsertion);
  }

  private insert(
    text: string,
    position: number | undefined,
    edit: typeof inlineInsertion
  ): void {
    const selection = this.view.state.selection.main;
    const from = position === undefined
      ? selection.from
      : Math.max(0, Math.min(position, this.view.state.doc.length));
    const to = position === undefined ? selection.to : from;
    const insertion = edit(this.source, from, to, text);
    this.view.dispatch({
      changes: { from, to, insert: insertion.text },
      selection: { anchor: from + insertion.cursorOffset },
      scrollIntoView: true,
      userEvent: "input"
    });
    this.focus();
  }

  positionAtPoint(x: number, y: number): number | undefined {
    return this.view.posAtCoords({ x, y }) ?? undefined;
  }

  triggerSuggest(): void {
    this.focus();
    startCompletion(this.view);
  }

  triggerParameterHints(): void {
    this.focus();
    void this.updateSignature();
  }

  applyTheme(theme?: EditorTokenTheme): void {
    this.view.dispatch({ effects: this.theme.reconfigure(themeExtension(theme)) });
  }

  goToFirstDiagnostic(): boolean {
    return this.navigateDiagnostic(1, true);
  }

  refreshLanguageState(): void {
    if (!this.languageEnabled) return;
    this.scheduleDiagnostics(0);
    this.updateInputKind();
  }

  setLanguageEnabled(enabled: boolean): void {
    if (this.languageEnabled === enabled) return;
    this.languageEnabled = enabled;
    this.view.dispatch({
      effects: [
        this.language.reconfigure(enabled ? python() : []),
        this.lineWrapping.reconfigure(enabled ? [] : EditorView.lineWrapping),
        this.submitKeymap.reconfigure(this.submitKeymapExtension())
      ]
    });
    if (enabled) {
      this.refreshLanguageState();
      return;
    }
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    if (this.signatureTimer) clearTimeout(this.signatureTimer);
    this.diagnostics = [];
    this.view.dispatch(setDiagnostics(this.view.state, []));
    this.view.dispatch({ effects: signatureEffect.of(null) });
    this.options.onDiagnosticsChanged({ errors: 0, warnings: 0 });
  }

  destroy(): void {
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    if (this.signatureTimer) clearTimeout(this.signatureTimer);
    this.view.destroy();
  }

  /** The `@` picker is deliberately independent of the language service: chat
   * modes turn that service off, and attaching a file is exactly the thing the
   * composer needs there. */
  private async fileCompletions(context: CompletionContext): Promise<CompletionResult | null> {
    const token = context.matchBefore(/@[^\s@#"'`(){}[\],]*/);
    if (!token) return null;
    const source = context.state.doc.toString();
    // An `@` glued to a word is an email or a decorator argument, never a
    // reference the user is starting to type.
    if (/[\p{L}\p{N}_.+-]/u.test(source[token.from - 1] ?? "")) return null;
    const files = await this.options.files.search(token.text.slice(1));
    if (context.aborted || !files.length) return null;
    return {
      from: token.from,
      to: token.to,
      // The host already ranked these; re-filtering here would drop matches
      // that span directory boundaries.
      filter: false,
      options: files.map((path) => {
        const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
        return {
          label: `@${path}`,
          ...(directory ? { detail: directory } : {}),
          type: "file",
          apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
            // The trailing space closes the reference chip so the next keystroke
            // is not absorbed into the path.
            const insert = `@${path} `;
            view.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
              scrollIntoView: true,
              userEvent: "input.complete"
            });
          }
        };
      })
    };
  }

  private async completions(context: CompletionContext): Promise<CompletionResult | null> {
    if (!this.languageEnabled) return null;
    const source = context.state.doc.toString();
    const response = await this.options.broker.request(source, context.pos, {
      get isCancellationRequested() { return context.aborted; },
      onCancellationRequested(listener) {
        context.addEventListener("abort", listener, { onDocChange: true });
        return { dispose() {} };
      }
    });
    if (!response || context.aborted || context.state.doc.toString() !== source) return null;
    const first = response.completions[0];
    if (!first) return null;
    return {
      from: first.replaceStart,
      to: first.replaceEnd,
      options: response.completions.map((item) => {
        const apply = completionApply(item);
        return {
          label: item.label,
          detail: item.detail,
          type: completionType(item.kind),
          ...(apply ? { apply } : {})
        };
      })
    };
  }

  private async hover(view: EditorView, position: number): Promise<Tooltip | null> {
    if (!this.languageEnabled) return null;
    const source = view.state.doc.toString();
    const response = await this.options.broker.request(source, position);
    if (!response?.hover || !sourceSnapshotMatches(view.state.doc.toString(), source)) return null;
    const hover = response.hover;
    return {
      pos: hover.rangeStart,
      end: hover.rangeEnd,
      above: true,
      create(currentView) {
        const dom = currentView.dom.ownerDocument.createElement("div");
        dom.className = "dext-hover-tooltip";
        const label = currentView.dom.ownerDocument.createElement("code");
        label.textContent = hover.label;
        dom.append(label);
        if (hover.documentation) {
          const detail = currentView.dom.ownerDocument.createElement("div");
          detail.className = "dext-tooltip-detail";
          detail.textContent = hover.documentation;
          dom.append(detail);
        }
        return { dom };
      }
    };
  }

  private updated(update: ViewUpdate): void {
    if (!update.docChanged && !update.selectionSet) return;
    if (update.docChanged) {
      // Input mode can disable language services, but the composer still needs
      // to react immediately when its text changes.
      this.options.onSourceChanged?.();
      const source = this.source;
      const normalized = normalizeInputReferenceSource(source);
      if (normalized !== source) {
        const selection = this.view.state.selection.main;
        queueMicrotask(() => {
          if (this.source !== source) return;
          this.view.dispatch({
            changes: { from: 0, to: source.length, insert: normalized },
            selection: { anchor: Math.min(selection.anchor, normalized.length), head: Math.min(selection.head, normalized.length) },
            userEvent: "input.migrate"
          });
        });
        return;
      }
      if (this.languageEnabled) {
        this.scheduleDiagnostics(120);
        this.updateInputKind();
      }
    }
    if (!this.languageEnabled) return;
    if (this.signatureTimer) clearTimeout(this.signatureTimer);
    this.signatureTimer = setTimeout(() => void this.updateSignature(), 60);
  }

  private updateInputKind(): void {
    const source = this.source;
    if (!source.trim()) {
      this.options.onInputKindChanged("empty");
      return;
    }
    void this.options.broker.request(source, this.view.state.selection.main.head).then((response) => {
      if (!response || !sourceSnapshotMatches(this.source, source)) return;
      this.options.onInputKindChanged(response.inputKind);
    });
  }

  private scheduleDiagnostics(delay: number): void {
    if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    this.diagnosticsTimer = setTimeout(() => void this.updateDiagnostics(), delay);
  }

  private async updateDiagnostics(): Promise<void> {
    if (!this.languageEnabled) return;
    const source = this.source;
    if (!source.trim()) {
      this.diagnostics = [];
      this.view.dispatch(setDiagnostics(this.view.state, []));
      this.options.onDiagnosticsChanged({ errors: 0, warnings: 0 });
      return;
    }
    const response = await this.options.broker.request(source, source.length);
    if (!response || !sourceSnapshotMatches(this.source, source)) return;
    const diagnostics: Diagnostic[] = response.diagnostics.map((diagnostic) => {
      const offset = Math.max(0, Math.min(source.length, diagnostic.from ?? diagnostic.offset));
      return {
        from: offset,
        to: Math.max(offset, Math.min(source.length, diagnostic.to ?? offset + 1)),
        severity: diagnostic.severity,
        message: diagnostic.message,
        markClass: diagnosticMarkClass(diagnostic.severity)
      };
    });
    this.diagnostics = diagnostics;
    this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
    this.options.onDiagnosticsChanged({
      errors: response.diagnostics.filter(({ severity }) => severity === "error").length,
      warnings: response.diagnostics.filter(({ severity }) => severity === "warning").length
    });
  }

  private navigateDiagnostic(direction: 1 | -1, fromStart = false): boolean {
    if (!this.diagnostics.length) return false;
    const cursor = fromStart ? -1 : this.view.state.selection.main.head;
    const ordered = [...this.diagnostics].sort((left, right) => left.from - right.from);
    const target = direction === 1
      ? ordered.find((diagnostic) => diagnostic.from > cursor) ?? ordered[0]
      : [...ordered].reverse().find((diagnostic) => diagnostic.from < cursor) ?? ordered.at(-1);
    if (!target) return false;
    this.view.dispatch({
      selection: { anchor: target.from, head: target.to },
      scrollIntoView: true
    });
    this.focus();
    return true;
  }

  private async updateSignature(): Promise<void> {
    if (!this.languageEnabled) return;
    const source = this.source;
    const cursor = this.view.state.selection.main.head;
    const response = await this.options.broker.request(source, cursor);
    if (!response || !sourceSnapshotMatches(this.source, source)
      || this.view.state.selection.main.head !== cursor) return;
    const tooltip: Tooltip | null = response.signature ? {
      pos: cursor,
      above: true,
      create: (view) => ({ dom: signatureDom(view.dom.ownerDocument, response.signature!) })
    } : null;
    this.view.dispatch({ effects: signatureEffect.of(tooltip) });
  }

  private async copy(): Promise<void> {
    const selection = this.view.state.selection.main;
    if (selection.empty) return;
    await this.options.clipboard.write(this.view.state.sliceDoc(selection.from, selection.to));
    this.focus();
  }

  private async cut(): Promise<void> {
    const source = this.source;
    const selection = this.view.state.selection.main;
    if (selection.empty) return;
    const copied = await this.options.clipboard.write(
      this.view.state.sliceDoc(selection.from, selection.to)
    );
    if (!copied || !selectionMatches(this.view, source, selection.anchor, selection.head)) return;
    this.replaceSelection("", "delete.cut");
  }

  private async paste(eventText?: string): Promise<void> {
    const source = this.source;
    const selection = this.view.state.selection.main;
    const result = await this.options.clipboard.read("code");
    if (!selectionMatches(this.view, source, selection.anchor, selection.head)) return;
    if (!result) {
      if (eventText !== undefined) this.replaceSelection(eventText, "input.paste");
      return;
    }
    let text: string;
    try {
      // Browser paste data is useful as a fallback, but the host clipboard is
      // authoritative when it can recover a structured workspace reference.
      text = result.codeReference
        ? this.pasteText(source, selection.from, selection.to, result)
        : eventText || result.text;
    } catch (error) {
      this.options.onError(error);
      return;
    }
    if (text) this.replaceSelection(text, "input.paste");
  }

  private pasteText(
    source: string,
    selectionStart: number,
    selectionEnd: number,
    result: ClipboardReadResult
  ): string {
    return codeReferencePasteText(source, selectionStart, selectionEnd, result);
  }

  private replaceSelection(text: string, userEvent: string): void {
    const selection = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length },
      scrollIntoView: true,
      userEvent
    });
    this.focus();
  }
}
