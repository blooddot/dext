import { monaco } from "./monacoEnvironment.js";
import { applyMonacoTheme } from "./monacoTheme.js";
import { ReferenceProjection, referenceDecorations } from "./monacoReferences.js";
import { inputReferenceProjections, normalizeInputReferenceSource } from "../features/workspace/domain/fileReference.js";
import { fileReferenceRemovalEdit } from "./fileReferenceDecorations.js";
import { pasteEventText } from "./codeEditor.js";
import {
  bindFileDropTarget, droppedFilePaths, fileSelectionDropEffect, findImageItem, isFileDrag, referenceInsertion
} from "../platform/browser/fileDrop.js";
import type { ClipboardClient } from "./clipboardClient.js";
import type { InteractionFileHost, InteractionReferenceField } from "../features/conversations/browser/interactionForm.js";

export interface ReferenceFieldOptions {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  required: boolean;
  multiline: boolean;
  onChange(): void;
}

/** A form answer is plain text, so the field shows `@path` as the Composer's
 * chip: the chip is display only, the answer keeps the full path. */
export class ReferenceField implements InteractionReferenceField {
  readonly element = document.createElement("div");
  private readonly model: monaco.editor.ITextModel;
  private readonly view: monaco.editor.IStandaloneCodeEditor;
  private readonly projection = new ReferenceProjection();
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private pendingProjection = false;
  private disposed = false;

  constructor(
    private readonly files: Pick<InteractionFileHost, "resolve" | "attach" | "onError">,
    private readonly clipboard: Pick<ClipboardClient, "read">,
    private readonly options: ReferenceFieldOptions
  ) {
    this.element.className = `interaction-reference-field${options.multiline ? "" : " interaction-reference-line"}`;
    applyMonacoTheme();
    const source = normalizeInputReferenceSource(options.value.replace(/\r\n?/g, "\n"));
    this.model = monaco.editor.createModel(this.projection.encode(source), "plaintext");
    this.model.setEOL(monaco.editor.EndOfLineSequence.LF);
    this.view = monaco.editor.create(this.element, {
      model: this.model, automaticLayout: true, editContext: false, ariaLabel: options.ariaLabel,
      ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      wordWrap: options.multiline ? "on" : "off", wrappingIndent: "none", lineNumbers: "off", lineDecorationsWidth: 10,
      // Tab leaves the field like the native control it replaces.
      tabFocusMode: true,
      scrollbar: { vertical: options.multiline ? "auto" : "hidden", horizontal: "hidden" },
      renderLineHighlight: "none", renderValidationDecorations: "off", glyphMargin: false, folding: false,
      minimap: { enabled: false }, overviewRulerLanes: 0, hideCursorInOverviewRuler: true,
      scrollBeyondLastLine: false, fixedOverflowWidgets: true, padding: { top: 6, bottom: 6 },
      // An answer is not code: a new line keeps no indentation of its own.
      autoIndent: "none",
      quickSuggestions: false, wordBasedSuggestions: "off",
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false }
    });
    if (options.required) this.element.querySelector("textarea")?.setAttribute("aria-required", "true");
    const css = getComputedStyle(document.body);
    this.view.updateOptions({
      fontFamily: css.getPropertyValue("--vscode-editor-font-family").trim() || "Consolas, monospace",
      fontSize: parseFloat(css.getPropertyValue("--vscode-editor-font-size")) || 13
    });
    if (!options.multiline) {
      // A single-line answer takes no line break: Enter submits, Shift+Enter does
      // what it did in the input this replaced.
      const submit = (): void => { if (!this.view.inComposition) this.element.closest("form")?.requestSubmit(); };
      this.disposables.push(this.view.addAction({ id: "dext.form.submit", label: "Submit", keybindings: [monaco.KeyCode.Enter], precondition: "editorTextFocus", run: submit }));
      this.disposables.push(this.view.addAction({ id: "dext.form.noNewline", label: "No line break", keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter], precondition: "editorTextFocus", run: () => {} }));
    }
    this.decorations = this.view.createDecorationsCollection();
    this.disposables.push(this.view.onDidLayoutChange(() => this.render()));
    this.disposables.push(this.model.onDidChangeContent((event) => {
      this.render(); this.options.onChange();
      // A reference is complete only at a separator: typing inside a path must
      // not turn a half-written one into a chip.
      if (!event.isUndoing && !event.isRedoing && event.changes.some((change) => /[\s"')]/.test(change.text))) {
        queueMicrotask(() => this.projectTyped());
      }
      if (!options.multiline) queueMicrotask(() => this.collapseLines());
    }));
    // Chat wrapping can clip the native IME textarea, and it holds raw tokens.
    this.disposables.push(this.view.onDidCompositionStart(() => {
      this.element.classList.toggle("dext-projected-composition", this.projection.references(this.model.getValue()).length > 0);
    }));
    this.disposables.push(this.view.onDidCompositionEnd(() => {
      this.element.classList.remove("dext-projected-composition");
      queueMicrotask(() => { if (!this.disposed && this.pendingProjection) this.projectTyped(); });
    }));
    const listeners = new AbortController();
    this.element.addEventListener("mousedown", (event) => this.removeChip(event), { capture: true, signal: listeners.signal });
    this.element.addEventListener("paste", (event) => this.paste(event), { capture: true, signal: listeners.signal });
    this.disposables.push({ dispose: () => listeners.abort() });
    this.disposables.push({
      dispose: bindFileDropTarget(this.element, {
        dragover: (event) => this.fileDragOver(event), drop: (event) => this.fileDrop(event),
        leave: () => this.element.classList.remove("file-drop-active")
      })
    });
    this.render();
  }

  value(): string { return this.projection.decode(this.model.getValue()); }

  /** Dropped files and pasted images arrive as `@path`: the same text the Input
   * inserts, which is all a form answer carries. */
  insertReferences(expressions: readonly string[]): void {
    if (!expressions.length || this.disposed) return;
    const value = this.model.getValue(), selection = this.view.getSelection()!;
    const from = this.projection.toSource(value, this.model.getOffsetAt(selection.getStartPosition()));
    const to = this.projection.toSource(value, this.model.getOffsetAt(selection.getEndPosition()));
    const insertion = referenceInsertion(this.value(), from, to, expressions);
    this.replace(from, to, insertion.value.slice(from, insertion.caret));
  }

  /** The settled form cannot answer, and its editor must not keep a model alive. */
  disable(): void {
    this.disposed = true;
    this.element.classList.remove("dext-projected-composition");
    for (const item of this.disposables) item.dispose();
    this.view.dispose(); this.model.dispose(); this.element.replaceChildren();
  }

  private replace(from: number, to: number, text: string): void {
    const value = this.model.getValue();
    const range = monaco.Range.fromPositions(
      this.model.getPositionAt(this.projection.toView(value, from)),
      this.model.getPositionAt(this.projection.toView(value, to, "right"))
    );
    this.view.executeEdits("dext.form", [{ range, text: this.projection.encode(text) }]);
    this.view.setPosition(this.model.getPositionAt(this.projection.toView(this.model.getValue(), from + text.length, "right")));
    this.view.focus();
  }

  private render(): void {
    const font = this.view.getOption(monaco.editor.EditorOption.fontInfo) as { typicalHalfwidthCharacterWidth: number };
    const columns = Math.max(4, Math.min(20, Math.floor(this.view.getLayoutInfo().contentWidth / font.typicalHalfwidthCharacterWidth) - 6));
    this.decorations.set(referenceDecorations(this.projection, this.model, columns));
  }

  /** A single-line answer cannot hold a line break: a multi-line paste keeps its
   * words and loses its newlines, like the input this field replaces. */
  private collapseLines(): void {
    if (this.disposed) return;
    const value = this.model.getValue();
    if (!value.includes("\n")) return;
    this.view.executeEdits("dext.form.lines", [{ range: this.model.getFullModelRange(), text: value.replaceAll("\n", " ") }]);
  }

  private projectTyped(): void {
    if (this.disposed) return;
    if (this.view.inComposition) { this.pendingProjection = true; return; }
    this.pendingProjection = false;
    const edits = inputReferenceProjections(this.model.getValue()).map((ref) => ({
      range: monaco.Range.fromPositions(this.model.getPositionAt(ref.interpolationStart), this.model.getPositionAt(ref.interpolationEnd)),
      text: this.projection.encode(ref.reference.expression)
    }));
    if (edits.length) this.view.executeEdits("dext.form.references", edits);
  }

  private removeChip(event: MouseEvent): void {
    const chip = event.target instanceof Element ? event.target.closest(".dext-ref-chip") : null;
    const index = chip?.className.match(/ref-open-(\d+)/)?.[1];
    if (index === undefined || !chip?.firstChild) return;
    // Only the × closes a chip; the rest of it is still the reference's text.
    const range = document.createRange(), close = chip.textContent.lastIndexOf("×");
    range.setStart(chip.firstChild, close); range.setEnd(chip.firstChild, close + 1);
    const box = range.getBoundingClientRect();
    if (event.clientX < box.left - 3 || event.clientX > box.right + 3) return;
    const reference = this.projection.references(this.model.getValue())[Number(index)];
    if (!reference) return;
    event.preventDefault(); event.stopPropagation();
    const edit = fileReferenceRemovalEdit(this.value(), {
      reference: reference.reference, interpolationStart: reference.sourceFrom, interpolationEnd: reference.sourceTo
    });
    this.replace(edit.from, edit.to, edit.insert);
  }

  private paste(event: ClipboardEvent): void {
    if (this.disposed) return;
    const file = findImageItem(event.clipboardData)?.getAsFile();
    if (file) {
      event.preventDefault(); event.stopPropagation();
      void this.files.attach(file).then((path) => this.insertReferences([`@${path}`])).catch((error) => this.files.onError(error));
      return;
    }
    const pasted = pasteEventText(event) ?? "";
    event.preventDefault(); event.stopPropagation();
    void this.clipboard.read("code").then((result) => {
      if (this.disposed) return;
      // A copied selection or Explorer file arrives as its `@path`, like the
      // Input's paste; everything else stays the text that was copied.
      if (result?.codeReference || result?.fileReferences?.length) { this.insertReferences([result.text]); return; }
      const text = pasted || result?.text;
      if (text) this.insertPlain(text);
    }).catch((error) => { this.files.onError(error); if (pasted) this.insertPlain(pasted); });
  }

  private insertPlain(text: string): void {
    if (this.disposed) return;
    const projected = this.projection.encode(text.replace(/\r\n?/g, "\n"));
    this.view.executeEdits("dext.form.paste", (this.view.getSelections() ?? []).map((range) => ({ range, text: projected })));
    this.view.focus();
  }

  private fileDragOver(event: DragEvent): boolean {
    const active = isFileDrag(event);
    this.element.classList.toggle("file-drop-active", active);
    if (!active) return false;
    event.preventDefault();
    event.dataTransfer!.dropEffect = fileSelectionDropEffect(event.dataTransfer!.effectAllowed);
    return true;
  }

  private fileDrop(event: DragEvent): boolean {
    this.element.classList.remove("file-drop-active");
    if (!isFileDrag(event)) return false;
    const paths = droppedFilePaths(event.dataTransfer);
    if (!paths.length) {
      if (![...event.dataTransfer!.types].some((type) => type.toLowerCase() === "files")) return false;
      event.preventDefault(); event.stopPropagation();
      this.files.onError(new Error("The dropped files did not include paths. Drag files from the VS Code Explorer into the form."));
      return true;
    }
    event.preventDefault(); event.stopPropagation();
    const hit = this.view.getTargetAtClientPoint(event.clientX, event.clientY)?.position ?? this.view.getPosition()
      ?? this.model.getFullModelRange().getEndPosition();
    this.view.setPosition(hit);
    void this.files.resolve(paths)
      .then((expressions) => { if (!this.disposed) this.insertReferences(expressions); })
      .catch((error) => this.files.onError(error));
    return true;
  }
}
