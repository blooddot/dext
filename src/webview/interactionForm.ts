import { validateUiAnswers, type UiFormAnswers, type UiFormDefinition, type UiFormResult } from "../core/uiForm.js";
import { selectionGroupField, type FieldControl } from "./selectionGroupField.js";
import { selectField } from "./selectField.js";

export class InteractionForm {
  readonly element = document.createElement("form");
  private sent = false;
  private readonly controls = new Map<string, FieldControl>();
  constructor(readonly definition: UiFormDefinition, private readonly respond: (result: UiFormResult) => void,
    draft: UiFormAnswers = {}, private readonly saveDraft: (draft: UiFormAnswers) => void = () => {}) {
    this.element.className = "interaction-form";
    this.element.noValidate = true;
    const head = document.createElement("div"); head.className = "interaction-head";
    const title = document.createElement("h3"); title.textContent = definition.title; head.append(title);
    if (definition.description) { const description = document.createElement("p"); description.className = "interaction-description"; description.textContent = definition.description; head.append(description); }
    this.element.append(head);
    const error = document.createElement("p"); error.className = "interaction-error"; error.setAttribute("role", "alert");
    // The error only reports on the action the user actually pressed: showing every
    // unmet requirement up front made an untouched form look broken.
    let attempted: string | undefined;
    const reason = (cause: unknown): string => cause instanceof Error ? cause.message : "Check your answers.";
    const refresh = (): void => {
      const answers = this.read();
      this.saveDraft(this.publicDraft(answers));
      if (attempted === undefined) return;
      try { validateUiAnswers(definition, answers, attempted); error.textContent = ""; }
      catch (cause) { error.textContent = reason(cause); }
    };
    const submit = (action: string): void => {
      if (this.sent) return;
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
        const input = field.multiline && !field.secret ? document.createElement("textarea") : document.createElement("input");
        if (input instanceof HTMLInputElement) input.type = field.secret ? "password" : "text";
        input.autocomplete = "off"; input.maxLength = 20000;
        input.setAttribute("aria-label", field.label); input.setAttribute("aria-required", String(field.required));
        const answer = draft[field.id]; input.value = answer?.type === "input" ? answer.value : field.default ?? "";
        input.placeholder = field.placeholder ?? ""; input.addEventListener("input", refresh);
        control = { element: input, read: () => ({ type: "input", value: input.value }), clearSecret: () => { if (field.secret) input.value = ""; } };
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
      actions.append(button);
    }
    this.element.append(error, actions);
    this.element.addEventListener("submit", (event) => {
      event.preventDefault();
      submit(primary ?? definition.actions[0]!.id);
    });
    refresh();
  }
  private read(): UiFormAnswers { return Object.fromEntries([...this.controls].map(([id, control]) => [id, control.read()])); }
  private publicDraft(answers: UiFormAnswers): UiFormAnswers {
    const result = { ...answers }; for (const field of this.definition.fields) if (field.secret) delete result[field.id]; return result;
  }
  cancel(): void { this.send({ kind: "ui", type: "form", status: "cancelled", answers: {} }); }
  private send(result: UiFormResult): void {
    if (this.sent) return; this.sent = true; this.saveDraft({});
    this.disable(); this.respond(result);
  }
  disable(): void {
    for (const input of this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input,button,textarea")) input.disabled = true;
    this.suspend();
  }
  suspend(): void {
    for (const control of this.controls.values()) control.clearSecret();
  }
}
