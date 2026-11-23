import type { InteractionForm } from "./interactionForm.js";
import { Button } from "../../../shared/lib/ui/input/nativeControls.js";
import { Dialog } from "../../../shared/lib/ui/overlay/dialog.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

/** The dialog and the inline card share the whole-view toggle: the button names
 * the size it switches to, and the surface carries the class. */
export function interactionFullscreen(target: HTMLElement): HTMLButtonElement {
  const button = Button(domUiAdapter(target.ownerDocument), {}) as HTMLButtonElement;
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
  readonly element: HTMLDialogElement;
  private previousFocus: HTMLElement | undefined;
  constructor(form: InteractionForm) {
    const adapter = domUiAdapter(form.element.ownerDocument);
    this.element = Dialog(adapter, { label: form.definition.title }, [], { class: "interaction-dialog" }) as HTMLDialogElement;
    const close = Button(adapter, { class: "interaction-close", "aria-label": "Close interaction" }, ["×"]);
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
    const active = this.element.ownerDocument.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : undefined;
    this.element.showModal();
  }
  close(): void {
    if (!this.element.open) return;
    this.element.close();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
