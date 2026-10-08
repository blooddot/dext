import { monaco, initializeMonacoWorkers } from "./monacoEnvironment.js";
import { applyMonacoTheme } from "./monacoTheme.js";
import { DEXT_COMPOSER_SCHEME, installDextTypescript } from "./monacoTypescript.js";
import { ReferenceProjection, referenceDecorations } from "./monacoReferences.js";
import type { ClipboardClient } from "./clipboardClient.js";
import type { FileSearchClient } from "./fileSearchClient.js";
import type { ProjectReferenceClient } from "./projectReferenceClient.js";
import { codeReferencePasteText } from "./codeReferencePaste.js";
import { bindFileDropTarget, droppedFilePaths, fileSelectionDropEffect, isFileDrag } from "./fileDrop.js";
import { fileReferenceRemovalEdit } from "./fileReferenceDecorations.js";
import { inputReferenceProjections, normalizeInputReferenceSource, type ContextReferenceOccurrence } from "../core/fileReference.js";
import { fileReferenceInsertion } from "./inputInsertion.js";
import type { EditorTokenTheme } from "../vscodeTheme.js";

export interface CodeEditorOptions {
  parent: HTMLElement;
  dropTarget?: HTMLElement;
  workerUri?: string;
  /** Legacy language channel. The TypeScript worker owns completion,
   * hover, signature help and diagnostics now, so the editor never calls it;
   * the host may still pass it while the removed language stack is cleaned up. */
  broker?: unknown;
  clipboard: ClipboardClient;
  files: FileSearchClient;
  projects?: ProjectReferenceClient;
  resolveDroppedFiles(paths: string[]): Promise<string[]>;
  onRun(): void;
  onOpenReference(reference: ContextReferenceOccurrence): void;
  onDiagnosticsChanged(counts: { errors: number; warnings: number }): void;
  onInputKindChanged(kind: "empty" | "workflow" | "invalid"): void;
  onSourceChanged?(): void;
  onError(error: unknown): void;
  /** Asks the extension for the generated `dext` declaration and the workspace's API
   * modules. The host also pushes them; asking means a Webview that missed that
   * message — or was created before it — still gets a working editor. */
  requestComposerTypes?(): void;
  /** What the editor ended up with, so the host can say so in its Output channel. */
  reportComposerTypes?(counts: { builtins: number; modules: number }): void;
}
export function pasteEventText(event: Pick<ClipboardEvent, "clipboardData">): string | undefined {
  const data = event.clipboardData;
  const type = data && [...data.types].find(type => type.toLowerCase() === "text/plain");
  return type && data ? data.getData(type) : undefined;
}
async function browserClipboardText(): Promise<string | undefined> {
  try { return await navigator.clipboard?.readText(); } catch { return undefined; }
}
let nextModel = 0;
type ComposerEditorMode = "chat" | "code";

/** The public source contract is always the complete readable Dext document.
 * Monaco's private model contains atomic reference characters, never persisted. */
export class DextCodeEditor {
  readonly view: monaco.editor.IStandaloneCodeEditor;
  readonly model: monaco.editor.ITextModel;
  readonly projection = new ReferenceProjection();
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly chatEnter: monaco.editor.IContextKey<boolean>;
  private languageEnabled = true;
  private submitOnEnter = true;
  private dropRevision = 0;
  private destroyed = false;
  private diagnosticsTimer?: ReturnType<typeof setTimeout>;
  private theme?: EditorTokenTheme;
  private removeFileDropListeners?: () => void;
  private transforming = false;
  private pendingReferenceProjection = false;

  /**
   * The Composer's TypeScript support never arrived.
   *
   * Every other way of saying this is invisible: a missing declaration means no
   * completion, no API modules and no diagnostic that anything is wrong. The marker
   * says what to do, and `onTypesApplied` removes it as soon as the types do arrive.
   */
  private reportMissingTypes(): void {
    if (this.destroyed) return;
    // Across the whole buffer: a zero-width marker is invisible, and an invisible signal
    // is the failure this exists to prevent.
    monaco.editor.setModelMarkers(this.model, "dext-types", [{
      severity: monaco.MarkerSeverity.Warning,
      message: "Dext's TypeScript types did not load in this window, so this editor cannot complete the Dext APIs. Run \"Developer: Reload Window\" — the input is running an older Webview bundle than the extension.",
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: Math.max(1, this.model.getLineCount()),
      endColumn: this.model.getLineMaxColumn(Math.max(1, this.model.getLineCount()))
    }]);
  }

  constructor(private readonly options: CodeEditorOptions) {
    const uri = options.workerUri ?? document.querySelector<HTMLMetaElement>('meta[name="dext-editor-worker"]')?.content;
    if (uri) this.disposables.push(initializeMonacoWorkers(uri));
    // The composer is a TypeScript editor now: the kernel runs plain TypeScript,
    // and Monaco's TypeScript worker provides the language features.
    this.disposables.push(installDextTypescript({
      ...(uri ? { workerUri: uri } : {}),
      ...(options.requestComposerTypes
        ? { requestTypes: (): void => { options.requestComposerTypes?.(); } }
        : {}),
      onTypesApplied: (counts) => {
        monaco.editor.setModelMarkers(this.model, "dext-types", []);
        options.reportComposerTypes?.(counts);
      },
      onTypesMissing: () => { this.reportMissingTypes(); }
    }));
    this.model = monaco.editor.createModel("", "typescript", monaco.Uri.parse(`${DEXT_COMPOSER_SCHEME}:/composer-${++nextModel}.ts`));
    this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    // VS Code forwards Webview clipboard commands through document.execCommand.
    // Monaco's textarea input supports that bridge; Chromium EditContext does not.
    this.view = monaco.editor.create(options.parent, {
      model: this.model, automaticLayout: true, editContext: false, ariaLabel: "Dext input",
      fontSize: 13, lineHeight: 24, minimap: { enabled: false }, scrollBeyondLastLine: false, wordWrap: "off",
      wordWrapBreakAfterCharacters: " \t", wordWrapBreakBeforeCharacters: "", wordBreak: "keepAll", wrappingIndent: "none",
      lineNumbersMinChars: 3, glyphMargin: false, folding: false, fixedOverflowWidgets: true,
      padding: { top: 8, bottom: 8 }, quickSuggestions: { other: true, strings: true, comments: false },
      wordBasedSuggestions: "off", unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      parameterHints: { enabled: true }, hover: { delay: 300 }, renderValidationDecorations: "on"
    });
    this.decorations = this.view.createDecorationsCollection();
    const composing = this.view.createContextKey<boolean>("dextInputComposing", false);
    // Chat soft wraps can leave Monaco's IME textarea only 1px tall, painting
    // clipped text across the line. It also contains raw reference tokens.
    // Let the editor paint chat/reference text while native IME retains focus.
    this.disposables.push(this.view.onDidCompositionStart(() => {
      composing.set(true);
      options.parent.classList.toggle("dext-projected-composition", !this.languageEnabled || this.projection.references(this.model.getValue()).length > 0);
    }));
    this.disposables.push(this.view.onDidCompositionEnd(() => {
      composing.set(false);
      options.parent.classList.remove("dext-projected-composition");
      queueMicrotask(() => { if (!this.destroyed && this.pendingReferenceProjection) this.projectTypedReferences(); });
    }));
    this.disposables.push({ dispose: () => options.parent.classList.remove("dext-projected-composition") });
    this.disposables.push(this.view.onDidLayoutChange(() => this.renderReferences()));
    this.disposables.push(this.view.onDidChangeConfiguration(event => { if (event.hasChanged(monaco.editor.EditorOption.fontInfo)) this.renderReferences(); }));
    // Monaco's suggest widget otherwise consumes the first Escape while
    // parameter help remains open. Dismiss both through their native commands;
    // leave the event available for snippet/find cancellation as well.
    this.disposables.push(this.view.onKeyDown(event => { if (event.keyCode === monaco.KeyCode.Escape) this.dismissAssistance(); }));
    this.chatEnter = this.view.createContextKey<boolean>("dextChatEnter", false);
    // The TypeScript worker publishes diagnostics as markers on the model.
    this.disposables.push(monaco.editor.onDidChangeMarkers((resources) => {
      if (resources.some((resource) => resource.toString() === this.model.uri.toString())) this.scheduleDiagnostics();
    }));
    this.disposables.push(this.model.onDidChangeContent(event => {
      if (this.transforming) return;
      this.dropRevision++;
      this.renderReferences();
      this.options.onSourceChanged?.();
      this.scheduleDiagnostics();
      // Close a manually typed reference only at a separator. Do not rewrite
      // undo/redo events: the original projected edit belongs to native history.
      if (!event.isUndoing && !event.isRedoing && event.changes.some(change => /[\s"')]/.test(change.text))) {
        queueMicrotask(() => { if (!this.destroyed) this.projectTypedReferences(); });
      }
    }));
    const action = (id: string, keys: number[], run: () => void, precondition = "editorTextFocus") => this.disposables.push(this.view.addAction({ id, label: id, keybindings: keys, precondition, run }));
    action("dext.run", [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], () => options.onRun(), "editorTextFocus && !dextInputComposing");
    action("dext.send", [monaco.KeyCode.Enter], () => options.onRun(), "editorTextFocus && dextChatEnter && !suggestWidgetVisible && !inSnippetMode && !dextInputComposing");
    // lineBreakInsert deliberately leaves the cursor before the new line.
    // Native typing advances every cursor and retains indentation/undo behavior.
    action("dext.newline", [monaco.KeyMod.Shift | monaco.KeyCode.Enter], () => this.view.trigger("keyboard", "type", { text: "\n" }), "editorTextFocus && !dextInputComposing");
    action("dext.suggest", [monaco.KeyMod.Alt | monaco.KeyCode.Slash], () => this.triggerSuggest());
    action("dext.openReference", [monaco.KeyMod.Alt | monaco.KeyCode.Enter], () => {
      const offset = this.model.getOffsetAt(this.view.getPosition()!);
      const ref = this.projection.references(this.model.getValue()).find(ref => ref.viewFrom === offset || ref.viewTo === offset);
      if (ref) options.onOpenReference(ref.reference);
    });
    action("dext.pasteRaw", [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyV], () => { void this.paste(undefined, true); });
    // Let the browser dispatch Ctrl+V so image paste still reaches the parent.
    const copy = (event: ClipboardEvent): boolean => {
      if (!this.view.hasTextFocus()) return false;
      event.preventDefault(); event.stopImmediatePropagation();
      const text = this.selectedSource();
      if (text) { event.clipboardData?.setData("text/plain", text); void options.clipboard.write(text); }
      return true;
    };
    const cut = (event: ClipboardEvent) => { if (copy(event)) this.view.trigger("keyboard", "cut", {}); };
    const paste = (event: ClipboardEvent) => { if (event.defaultPrevented || !this.view.hasTextFocus()) return; event.preventDefault(); event.stopImmediatePropagation(); void this.paste(pasteEventText(event)); };
    let pointerStart: { x: number; y: number; index: number; close: boolean } | undefined;
    const pointerDown = (event: MouseEvent) => {
      const chip = event.target instanceof Element ? event.target.closest('.dext-ref-chip') : null;
      const index = chip?.className.match(/ref-open-(\d+)/)?.[1]; pointerStart = undefined;
      if (index === undefined || !chip?.firstChild) return;
      const range = document.createRange(), close = chip.textContent.lastIndexOf('×');
      range.setStart(chip.firstChild, close); range.setEnd(chip.firstChild, close + 1);
      const box = range.getBoundingClientRect();
      pointerStart = { x: event.clientX, y: event.clientY, index: Number(index), close: event.clientX >= box.left - 3 && event.clientX <= box.right + 3 };
    };
    const pointer = (event: MouseEvent) => {
      if (pointerStart && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 4) this.referencePointer(event, pointerStart.index, pointerStart.close);
      pointerStart = undefined;
    };
    options.parent.addEventListener("copy", copy, true); options.parent.addEventListener("cut", cut, true);
    options.parent.addEventListener("paste", paste, true); options.parent.addEventListener("mousedown", pointerDown, true); options.parent.addEventListener("mouseup", pointer, true);
    this.disposables.push({
      dispose: () => {
        options.parent.removeEventListener("copy", copy, true); options.parent.removeEventListener("cut", cut, true);
        options.parent.removeEventListener("paste", paste, true); options.parent.removeEventListener("mousedown", pointerDown, true); options.parent.removeEventListener("mouseup", pointer, true);
      }
    });
    this.removeFileDropListeners = bindFileDropTarget(options.dropTarget ?? options.parent, {
      dragover: event => this.fileDragOver(event), drop: event => this.fileDrop(event), leave: () => this.setFileDragActive(false)
    });
    const themeObserver = new MutationObserver(() => this.applyTheme(this.theme));
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    this.disposables.push({ dispose: () => themeObserver.disconnect() });
    this.applyTheme(); this.scheduleDiagnostics();
  }

  get source(): string { return this.projection.decode(this.model.getValue()); }
  private sourceRange(from: number, to: number): monaco.Range {
    const text = this.model.getValue();
    return monaco.Range.fromPositions(this.model.getPositionAt(this.projection.toView(text, from)), this.model.getPositionAt(this.projection.toView(text, to, "right")));
  }
  private selection() {
    const value = this.model.getValue(), selected = this.view.getSelection()!;
    return {
      from: this.projection.toSource(value, this.model.getOffsetAt(selected.getStartPosition())),
      to: this.projection.toSource(value, this.model.getOffsetAt(selected.getEndPosition()))
    };
  }
  focus(): void { this.view.focus(); }
  setSubmitOnEnter(enabled: boolean): void { this.submitOnEnter = enabled; this.chatEnter.set(!this.languageEnabled && enabled); }
  setPlaceholder(text: string): void { this.view.updateOptions({ placeholder: text }); }
  setValue(value: string, cursor = value.length): void {
    this.dropRevision++;
    this.pendingReferenceProjection = false;
    this.dismissAssistance();
    const source = normalizeInputReferenceSource(value.replace(/\r\n?/g, "\n"));
    // setValue establishes a new draft boundary and clears another conversation's undo stack.
    this.projection.reset(); this.model.setValue(this.projection.encode(source)); this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    this.view.setPosition(this.model.getPositionAt(this.projection.toView(this.model.getValue(), Math.min(cursor, source.length), "right")));
    this.renderReferences(); this.scheduleDiagnostics(); this.focus();
  }
  private edit(from: number, to: number, text: string, cursor = text.length): void {
    const projected = this.projection.encode(normalizeInputReferenceSource(text.replace(/\r\n?/g, "\n")));
    const range = this.sourceRange(from, to);
    this.view.pushUndoStop();
    this.view.executeEdits("dext", [{ range, text: projected }]);
    const position = this.model.getPositionAt(this.projection.toView(this.model.getValue(), from + cursor, "right"));
    this.view.setPosition(position); this.view.revealPositionInCenterIfOutsideViewport(position); this.view.pushUndoStop(); this.focus();
  }
  insertFileReferences(expressions: readonly string[], position?: number): void {
    const selection = this.selection(); const from = position ?? selection.from, to = position ?? selection.to;
    const edit = fileReferenceInsertion(this.source, from, to, expressions); this.edit(edit.from, edit.to, edit.text, edit.cursorOffset);
  }
  removeFileReference(payload: string): void {
    const ref = inputReferenceProjections(this.source).find(ref => ref.reference.payload === payload);
    if (!ref) return; const edit = fileReferenceRemovalEdit(this.source, ref); this.edit(edit.from, edit.to, edit.insert);
  }
  private renderReferences(): void {
    const font = this.view.getOption(monaco.editor.EditorOption.fontInfo) as { typicalHalfwidthCharacterWidth: number };
    const columns = Math.max(4, Math.min(20, Math.floor(this.view.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - 6));
    this.decorations.set(referenceDecorations(this.projection, this.model, columns));
  }
  private projectTypedReferences(): void {
    if (this.view.inComposition) { this.pendingReferenceProjection = true; return; }
    this.pendingReferenceProjection = false;
    const value = this.model.getValue();
    const edits = inputReferenceProjections(value).map(ref => ({ range: monaco.Range.fromPositions(this.model.getPositionAt(ref.interpolationStart), this.model.getPositionAt(ref.interpolationEnd)), text: this.projection.encode(ref.reference.expression) }));
    if (!edits.length) return;
    this.transforming = true; this.view.executeEdits("dext.project", edits); this.transforming = false; this.renderReferences();
  }
  private referencePointer(event: MouseEvent, index: number, close: boolean): void {
    const ref = this.projection.references(this.model.getValue())[index]; if (!ref) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (close) {
      const edit = fileReferenceRemovalEdit(this.source, { reference: ref.reference, interpolationStart: ref.sourceFrom, interpolationEnd: ref.sourceTo });
      this.edit(edit.from, edit.to, edit.insert);
    } else this.options.onOpenReference(ref.reference);
  }
  private selectedSource(): string {
    const selections = [...(this.view.getSelections() ?? [])].sort((left, right) => monaco.Range.compareRangesUsingStarts(left, right));
    const values: string[] = [];
    let previousLine = 0;
    for (const selection of selections) {
      if (!selection.isEmpty()) values.push(this.projection.decode(this.model.getValueInRange(selection)));
      else if (this.view.getOption(monaco.editor.EditorOption.emptySelectionClipboard) && selection.startLineNumber !== previousLine) {
        values.push(this.projection.decode(this.model.getLineContent(selection.startLineNumber)) + "\n");
      }
      previousLine = selection.startLineNumber;
    }
    return values.join("\n");
  }
  private replaceSelections(text: string): void {
    this.view.pushUndoStop();
    this.view.executeEdits("dext.paste", (this.view.getSelections() ?? []).map(range => ({ range, text: this.projection.encode(text.replace(/\r\n?/g, "\n")) })));
    this.view.pushUndoStop(); this.focus();
  }
  private async paste(eventText?: string, raw = false): Promise<void> {
    const source = this.source, revision = this.dropRevision, selection = this.selection(), selections = JSON.stringify(this.view.getSelections());
    const result = await this.options.clipboard.read(raw ? "text" : "code");
    let text: string;
    try {
      text = !raw && result && (result.codeReference || result.fileReferences?.length)
        ? codeReferencePasteText(source, selection.from, selection.to, result)
        // An Explorer copy puts VS Code's file list on the clipboard, which the
        // browser may report as empty text: fall through to what the host kept.
        : eventText || result?.text || await browserClipboardText() || "";
    }
    catch (error) { this.options.onError(error); return; }
    if (this.destroyed || !this.view.hasTextFocus() || revision !== this.dropRevision || JSON.stringify(this.view.getSelections()) !== selections) return;
    if (text) this.replaceSelections(text);
  }
  private setFileDragActive(active: boolean): void { this.options.parent.classList.toggle("file-drop-active", active); }
  private fileDragOver(event: DragEvent): boolean {
    const active = isFileDrag(event);
    this.setFileDragActive(active);
    if (!active) return false;
    event.preventDefault();
    event.dataTransfer!.dropEffect = fileSelectionDropEffect(event.dataTransfer!.effectAllowed);
    return true;
  }
  private fileDrop(event: DragEvent): boolean {
    this.setFileDragActive(false); if (!isFileDrag(event)) return false;
    const paths = droppedFilePaths(event.dataTransfer);
    if (!paths.length) {
      if (![...event.dataTransfer!.types].some(type => type.toLowerCase() === "files")) return false;
      event.preventDefault(); event.stopPropagation(); this.options.onError(new Error("The dropped files did not include paths. Hold Shift and drag files from the VS Code Explorer into the input.")); return true;
    }
    event.preventDefault(); event.stopPropagation();
    const hit = this.view.getTargetAtClientPoint(event.clientX, event.clientY)?.position ?? this.view.getPosition()!;
    const position = this.projection.toSource(this.model.getValue(), this.model.getOffsetAt(hit)), revision = this.dropRevision;
    void this.options.resolveDroppedFiles(paths).then(expressions => { if (!this.destroyed && revision === this.dropRevision && expressions.length) this.insertFileReferences(expressions, position); })
      .catch((error: unknown) => { if (!this.destroyed && revision === this.dropRevision) this.options.onError(error); });
    return true;
  }
  triggerSuggest(): void { if (this.view.hasTextFocus()) this.view.trigger("dext", "editor.action.triggerSuggest", {}); }
  triggerParameterHints(): void { if (this.view.hasTextFocus() && this.languageEnabled) this.view.trigger("dext", "editor.action.triggerParameterHints", {}); }
  private dismissAssistance(): void { for (const action of ["hideSuggestWidget", "closeParameterHints", "editor.action.hideHover"]) this.view.trigger("dext", action, {}); }
  applyTheme(theme?: EditorTokenTheme): void {
    if (theme) this.theme = theme; applyMonacoTheme(this.theme);
    const css = getComputedStyle(document.body);
    this.view.updateOptions({
      fontFamily: css.getPropertyValue("--vscode-editor-font-family").trim() || "Consolas, monospace",
      fontSize: parseFloat(css.getPropertyValue("--vscode-editor-font-size")) || 13
    });
  }
  setMode(mode: ComposerEditorMode): void {
    const enabled = mode === "code";
    const language = enabled ? "typescript" : "plaintext";
    // The mode is also what gives the model its language, and a mode that has not
    // switched yet must not be remembered as switched: the badge is local, so the
    // editor can show "Code" over a plain-text model and complete nothing at all.
    if (enabled === this.languageEnabled && this.model.getLanguageId() === language) return;
    this.dropRevision++; this.dismissAssistance(); this.languageEnabled = enabled;
    monaco.editor.setModelLanguage(this.model, language);
    // Chat modes are plain text and use the compact Cursor-like surface;
    // Code keeps the full editor gutter and language affordances.
    this.view.updateOptions({
      wordWrap: enabled ? "off" : "on",
      lineNumbers: enabled ? "on" : "off",
      lineDecorationsWidth: 10,
      renderLineHighlight: "none",
      parameterHints: { enabled },
      renderValidationDecorations: enabled ? "on" : "off"
    });
    this.chatEnter.set(!enabled && this.submitOnEnter); this.scheduleDiagnostics();
  }
  refreshLanguageState(): void { this.dropRevision++; this.scheduleDiagnostics(); }
  private scheduleDiagnostics(): void { if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer); this.diagnosticsTimer = setTimeout(() => { this.publishDiagnostics(); }, 120); }
  /** Diagnostics come from the TypeScript worker as markers on the model, so
   * they are read back from Monaco instead of the removed language service. */
  private publishDiagnostics(): void {
    if (this.destroyed) return;
    const markers = monaco.editor.getModelMarkers({ resource: this.model.uri });
    this.options.onDiagnosticsChanged({
      errors: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Error).length,
      warnings: markers.filter(marker => marker.severity === monaco.MarkerSeverity.Warning).length
    });
    this.options.onInputKindChanged(this.source.trim() ? "workflow" : "empty");
  }
  goToFirstDiagnostic(): boolean {
    const marker = monaco.editor.getModelMarkers({ resource: this.model.uri })[0]; if (!marker) return false;
    this.view.setSelection(marker); this.view.revealRangeInCenterIfOutsideViewport(marker); this.focus(); return true;
  }
  destroy(): void {
    this.destroyed = true; this.dropRevision++; if (this.diagnosticsTimer) clearTimeout(this.diagnosticsTimer);
    this.removeFileDropListeners?.(); for (const item of this.disposables) item.dispose(); this.view.dispose(); this.model.dispose();
  }
}
