import type { InteractionForm } from "./interactionForm.js";

/** The dialog and the inline card share the whole-view toggle: the button names
 * the size it switches to, and the surface carries the class. */
export function interactionFullscreen(target: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button"); button.type = "button";
  const render = (full: boolean): void => {
    const label = full ? "Restore interaction size" : "Fullscreen interaction";
    button.className = `interaction-close interaction-fullscreen-toggle codicon codicon-chrome-${full ? "restore" : "maximize"}`;
    button.setAttribute("aria-label", label); button.title = label;
  };
  button.addEventListener("click", () => {
    const full = !target.classList.contains("interaction-fullscreen");
    target.classList.toggle("interaction-fullscreen", full); render(full);
  });
  render(false);
  return button;
}

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
    const fullscreen = interactionFullscreen(this.element);
    // Escape leaves fullscreen first so a maximized form is not cancelled by habit.
    this.element.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (this.element.classList.contains("interaction-fullscreen")) { fullscreen.click(); return; }
      form.cancel();
    });
    this.element.append(fullscreen, close, form.element);
  }
  open(): void {
    if (this.element.open || !this.element.isConnected) return;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.element.showModal();
  }
  close(): void {
    if (!this.element.open) return;
    this.element.close();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
