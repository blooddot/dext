import { validateUiAnswers, type UiFormAnswers, type UiFormDefinition, type UiFormResult } from "../../../shared/contracts/uiForm.js";
import { droppedFilePaths, fileSelectionDropEffect, findImageItem, isFileDrag, referenceInsertion } from "../../../platform/browser/fileDrop.js";
import { selectionGroupField, type FieldControl } from "./selectionGroupField.js";
import { selectField } from "./selectField.js";
import { interactionMarkdown } from "./interactionMarkdown.js";

/** Dropped files and pasted images reach a form field as the same `@path` text
 * the Input uses, because a field answer is only a string. */
export interface InteractionFileHost {
  resolve(paths: string[]): Promise<string[]>;
  attach(file: File): Promise<string>;
  onError(error: unknown): void;
  /** Builds the Composer's chip surface for an answer. Without it the field
   * stays a native input. */
  referenceField?(options: InteractionReferenceFieldOptions): InteractionReferenceField;
}

export interface InteractionReferenceFieldOptions {
  value: string;
  placeholder?: string;
  ariaLabel: string;
  required: boolean;
  multiline: boolean;
  onChange(): void;
}

export interface InteractionReferenceField {
  element: HTMLElement;
  value(): string;
  insertReferences(expressions: readonly string[]): void;
  disable(): void;
}

export class InteractionForm {
  readonly element = document.createElement("form");
  private sent = false;
  private inactive = false;
  private refresh = (): void => {};
  private readonly controls = new Map<string, FieldControl>();
  constructor(readonly definition: UiFormDefinition, private readonly respond: (result: UiFormResult) => void,
    draft: UiFormAnswers = {}, private readonly saveDraft: (draft: UiFormAnswers) => void = () => {},
    private readonly files?: InteractionFileHost) {
    this.element.className = "interaction-form";
    this.element.noValidate = true;
    const head = document.createElement("div"); head.className = "interaction-head";
    const title = document.createElement("h3"); title.textContent = definition.title; head.append(title);
    if (definition.description) head.append(interactionMarkdown(definition.description));
    this.element.append(head);
    const error = document.createElement("p"); error.className = "interaction-error"; error.setAttribute("role", "alert");
    // The error only reports on the action the user actually pressed: showing every
    // unmet requirement up front made an untouched form look broken.
    let attempted: string | undefined;
    const actionButtons = new Map<string, HTMLButtonElement>();
    const reason = (cause: unknown): string => cause instanceof Error ? cause.message : "Check your answers.";
    const refresh = (): void => {
      if (this.sent || this.inactive) return;
      const answers = this.read();
      this.saveDraft(this.publicDraft(answers));
      for (const [action, button] of actionButtons) {
        try { validateUiAnswers(definition, answers, action); button.disabled = this.sent; }
        catch { button.disabled = true; }
      }
      if (attempted === undefined) return;
      try { validateUiAnswers(definition, answers, attempted); error.textContent = ""; }
      catch (cause) { error.textContent = reason(cause); }
    };
    const submit = (action: string): void => {
      if (this.sent || this.inactive) return;
      attempted = action;
      try { this.send({ kind: "ui", type: "form", status: "submitted", action, answers: validateUiAnswers(definition, this.read(), action) }); }
      catch (cause) { error.textContent = reason(cause); }
    };
    for (const field of definition.fields) {
      const fieldset = document.createElement("fieldset"); fieldset.className = "interaction-field";
      const legend = document.createElement("legend"); legend.textContent = `${field.label}${field.required ? " *" : ""}`;
      fieldset.append(legend);
      if (field.description) { const description = document.createElement("p"); description.textContent = field.description; fieldset.append(description); }
      let control: FieldControl;
      if (field.type === "input") {
        const answer = draft[field.id];
        const initial = answer?.type === "input" ? answer.value : field.default ?? "";
        // A secret never leaves the native control, so it cannot be projected.
        const reference = field.secret ? undefined : this.files?.referenceField?.({
          value: initial, ...(field.placeholder ? { placeholder: field.placeholder } : {}),
          ariaLabel: field.label, required: field.required, multiline: Boolean(field.multiline), onChange: refresh
        });
        if (reference) {
          control = { element: reference.element, read: () => ({ type: "input", value: reference.value() }), clearSecret: () => {},
            disable: () => reference.disable() };
        } else {
          const input = field.multiline && !field.secret ? document.createElement("textarea") : document.createElement("input");
          if (input instanceof HTMLInputElement) input.type = field.secret ? "password" : "text";
          input.autocomplete = "off"; input.maxLength = 20000;
          input.setAttribute("aria-label", field.label); input.setAttribute("aria-required", String(field.required));
          input.value = initial;
          input.placeholder = field.placeholder ?? ""; input.addEventListener("input", refresh);
          if (!field.secret) this.bindFiles(input, refresh);
          control = { element: input, read: () => ({ type: "input", value: input.value }), clearSecret: () => { if (field.secret) input.value = ""; } };
        }
      } else control = field.type === "select" ? selectField(field, draft[field.id], refresh) : selectionGroupField(field, draft[field.id], refresh);
      this.controls.set(field.id, control); fieldset.append(control.element); this.element.append(fieldset);
    }
    const actions = document.createElement("div"); actions.className = "interaction-actions";
    if (definition.show_cancel) {
      const cancel = document.createElement("button"); cancel.type = "button";
      cancel.className = "interaction-button interaction-cancel"; cancel.textContent = definition.cancel_label;
      cancel.addEventListener("click", () => this.cancel()); actions.append(cancel);
    }
    // Primary last so it reads as the rightmost choice, and the only submit button
    // so Enter always resolves to it rather than to whichever button comes first.
    let primary: string | undefined;
    for (const action of [...definition.actions].sort((left, right) => Number(left.primary) - Number(right.primary))) {
      const promoted = action.primary && primary === undefined;
      if (promoted) primary = action.id;
      const button = document.createElement("button");
      button.type = promoted ? "submit" : "button";
      button.className = `interaction-button${promoted ? " interaction-primary" : ""}`;
      button.textContent = action.label;
      if (action.description) button.title = action.description;
      if (!promoted) button.addEventListener("click", () => submit(action.id));
      actionButtons.set(action.id, button);
      actions.append(button);
    }
    this.element.append(error, actions);
    this.element.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(primary ?? definition.actions[0]!.id);
    });
    this.refresh = refresh;
    refresh();
  }
  /** A text field takes the same dropped references and pasted images as the
   * Input. Both resolve to `@path`, which is all an answer string carries. */
  private bindFiles(field: HTMLInputElement | HTMLTextAreaElement, refresh: () => void): void {
    const files = this.files; if (!files) return;
    // An input and a textarea share these events; the union only loses that.
    const target = field as HTMLTextAreaElement;
    const insert = (expressions: readonly string[]): void => {
      if (!expressions.length || this.sent || this.inactive || !target.isConnected) return;
      const from = target.selectionStart ?? target.value.length, to = target.selectionEnd ?? from;
      const edit = referenceInsertion(target.value, from, to, expressions);
      target.value = edit.value; target.setSelectionRange(edit.caret, edit.caret); refresh();
    };
    const active = (on: boolean): void => { target.classList.toggle("file-drop-active", on); };
    target.addEventListener("dragover", (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = fileSelectionDropEffect(event.dataTransfer!.effectAllowed);
      active(true);
    });
    target.addEventListener("dragleave", () => active(false));
    target.addEventListener("drop", (event: DragEvent) => {
      active(false); if (!isFileDrag(event)) return;
      // A drop without paths is ordinary text: leave it to the browser.
      event.preventDefault(); event.stopPropagation();
      const paths = droppedFilePaths(event.dataTransfer);
      if (!paths.length) {
        if ([...event.dataTransfer!.types].some((type) => type.toLowerCase() === "files")) {
          files.onError(new Error("The dropped files did not include paths. Drag files from the VS Code Explorer into the form."));
        }
        return;
      }
      void files.resolve(paths).then(insert).catch((error) => files.onError(error));
    });
    target.addEventListener("paste", (event: ClipboardEvent) => {
      const file = findImageItem(event.clipboardData)?.getAsFile(); if (!file) return;
      event.preventDefault(); event.stopPropagation();
      void files.attach(file).then((relativePath) => insert([`@${relativePath}`])).catch((error) => files.onError(error));
    });
  }
  private read(): UiFormAnswers { return Object.fromEntries([...this.controls].map(([id, control]) => [id, control.read()])); }
  private publicDraft(answers: UiFormAnswers): UiFormAnswers {
    const result = { ...answers }; for (const field of this.definition.fields) if (field.secret) delete result[field.id]; return result;
  }
  cancel(): void { this.send({ kind: "ui", type: "form", status: "cancelled", answers: {} }); }
  private send(result: UiFormResult): void {
    if (this.sent || this.inactive) return; this.sent = true; this.saveDraft({});
    this.disable(); this.respond(result);
  }
  disable(): void {
    this.inactive = true;
    for (const control of this.controls.values()) control.disable?.();
    for (const input of this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input,button,textarea")) input.disabled = true;
    this.suspend();
  }
  suspend(): void {
    for (const control of this.controls.values()) control.clearSecret();
    this.refresh();
  }
}
