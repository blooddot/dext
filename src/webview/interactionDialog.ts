import type { InteractionForm } from "./interactionForm.js";

/** Each request owns its dialog and callback; local confirmations cannot overwrite it. */
export class InteractionDialog {
  readonly element = document.createElement("dialog");
  private previousFocus: HTMLElement | undefined;
  constructor(form: InteractionForm) {
    this.element.className = "interaction-dialog";
    this.element.setAttribute("aria-label", form.definition.title);
    const close = document.createElement("button"); close.type = "button"; close.textContent = "×";
    close.className = "interaction-close"; close.setAttribute("aria-label", "Close interaction");
    close.addEventListener("click", () => form.cancel());
    this.element.addEventListener("cancel", (event) => { event.preventDefault(); form.cancel(); });
    this.element.append(close, form.element);
  }
  open(): void {
    if (this.element.open || !this.element.isConnected) return;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.element.showModal();
  }
  close(): void {
    if (this.element.open) this.element.close();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
