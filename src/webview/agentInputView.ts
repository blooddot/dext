import type { AgentInputAnswers, AgentInputState } from "../core/types.js";
import type { UiFormAnswers, UiFormDefinition, UiFormResult, UiInteractionState } from "../core/uiForm.js";
import { agentInputForm, agentFormAnswers, uiResultText } from "../uiInteractionPresentation.js";
import { InteractionForm } from "./interactionForm.js";
import { InteractionDialog } from "./interactionDialog.js";

export interface InteractionDraftStore {
  get(key: string): UiFormAnswers | undefined;
  set(key: string, draft: UiFormAnswers): void;
}
interface Card {
  id: string; status: string; form: UiFormDefinition; answers?: UiFormAnswers; action?: string | undefined;
  element: HTMLElement; control?: InteractionForm; dialog?: InteractionDialog;
  send: (result: UiFormResult) => void;
}
/** API requests and native Agent questions share controls, with separate answer adapters. */
export class AgentInputView {
  readonly element = document.createElement("section");
  private running = false;
  private readonly cards = new Map<string, Card>();
  private readonly drafts = new Map<string, UiFormAnswers>();
  constructor(private readonly respond: (requestId: string, answers: AgentInputAnswers | null) => void,
    private readonly respondUi: (state: UiInteractionState, result: UiFormResult) => void = () => {},
    private readonly scope = "", private readonly store?: InteractionDraftStore) {
    this.element.className = "agent-inputs"; this.element.hidden = true;
    this.element.setAttribute("aria-label", "Questions and interactions");
  }
  /** Returns whether this state newly put an answerable card on screen. The
   * caller uses that to bring a request the reader has never seen into view;
   * a repeated state is not new, so a reader who deliberately scrolled away is
   * not dragged back on every replayed event. */
  update(state: AgentInputState): boolean {
    const form = agentInputForm(state);
    const answers: UiFormAnswers = {};
    for (const question of state.questions) {
      if (question.isSecret) continue;
      const values = state.answers?.[question.id]?.answers;
      if (!values?.length) continue;
      answers[question.id] = question.options.length
        ? question.multiSelect ? { type: "checkbox", selected: values } : { type: "radio", selected: [], custom: values[0]! }
        : { type: "input", value: values[0]! };
    }
    return this.put({ id: `agent:${state.id}`, status: state.status === "answered" ? "submitted" : state.status === "dismissed" ? "cancelled" : "waiting", form, answers,
      element: document.createElement("section"), send: (result) => this.respond(state.id, agentFormAnswers(result)) });
  }
  updateUi(state: UiInteractionState): boolean {
    return this.put({ id: `ui:${state.requestId}`, status: state.status, form: state.form, action: state.action, ...(state.answers ? { answers: state.answers } : {}),
      element: document.createElement("section"), send: (result) => this.respondUi(state, result) });
  }
  private put(card: Card): boolean {
    const previous = this.cards.get(card.id);
    // Replayed or delayed waiting events cannot revive a terminal request.
    if (previous && previous.status !== "waiting") return false;
    if (previous?.status === card.status) { previous.dialog?.open(); return false; }
    previous?.dialog?.close(); previous?.control?.disable();
    if (previous) previous.element.replaceWith(card.element); else this.element.append(card.element);
    this.cards.set(card.id, card); this.element.hidden = false; this.render(card);
    return card.status === "waiting";
  }
  setRunning(running: boolean): void {
    if (this.running === running) { if (running) this.resume(); return; }
    this.running = running;
    for (const card of this.cards.values()) if (card.status === "waiting") this.render(card);
  }
  suspend(): void { for (const card of this.cards.values()) { card.control?.suspend(); card.dialog?.close(); } }
  focusRequest(kind: "agent" | "ui", requestId: string): boolean {
    const card = this.cards.get(`${kind}:${requestId}`);
    if (!this.running || card?.status !== "waiting" || !card.control) return false;
    card.element.scrollIntoView({ block: "center" });
    card.dialog?.open();
    card.control.element.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")?.focus({ preventScroll: true });
    return true;
  }
  resume(): void { if (this.running) for (const card of this.cards.values()) card.dialog?.open(); }
  private render(card: Card): void {
    card.dialog?.close(); card.control?.disable();
    delete card.dialog; delete card.control;
    card.element.replaceChildren(); card.element.className = "agent-input-card";
    const key = `${this.scope}:${card.id}`;
    if (this.running && card.status === "waiting") {
      const save = (draft: UiFormAnswers): void => { this.drafts.set(key, draft); this.store?.set(key, draft); };
      const form = new InteractionForm(card.form, (result) => {
        card.send(result);
        const answers = { ...result.answers };
        for (const field of card.form.fields) if (field.secret) delete answers[field.id];
        this.put({ ...card, status: result.status, answers, action: result.action, element: document.createElement("section") });
      }, this.drafts.get(key) ?? this.store?.get(key) ?? {}, save);
      card.control = form;
      if (card.form.presentation === "dialog") {
        const dialog = new InteractionDialog(form); card.dialog = dialog;
        const reopen = document.createElement("button"); reopen.type = "button"; reopen.textContent = card.form.title;
        reopen.addEventListener("click", () => dialog.open());
        card.element.append(reopen, dialog.element); queueMicrotask(() => dialog.open());
      } else {
        const close = document.createElement("button"); close.type = "button"; close.textContent = "×";
        close.className = "interaction-close"; close.setAttribute("aria-label", "Close interaction"); close.addEventListener("click", () => form.cancel());
        card.element.append(close, form.element);
        card.element.onkeydown = (event) => { if (event.key === "Escape") { event.preventDefault(); form.cancel(); } };
      }
      return;
    }
    card.element.onkeydown = null;
    const action = card.form.actions.find((action) => action.id === card.action);
    const title = document.createElement("strong"); title.textContent = `${card.form.title} — ${card.status === "submitted" ? "Submitted" : "Closed"}${action ? ` (${action.label})` : ""}`;
    card.element.append(title);
    for (const field of card.form.fields) {
      const answer = document.createElement("p");
      answer.textContent = `${field.label}: ${field.secret ? "Answer hidden" : card.answers?.[field.id] ? uiResultText(card.answers[field.id]) : "No answer submitted"}`;
      card.element.append(answer);
    }
    if (card.status !== "waiting") { this.drafts.delete(key); this.store?.set(key, {}); }
  }
}
