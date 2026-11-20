import type { AgentTodoItem, PlanAcceptanceItem } from "../../../shared/contracts/types.js";
import {
  agentAcceptanceProgressLabel, agentTodoProgress, buildAgentAcceptanceRows, buildAgentTodoRows, buildAgentTodoSection
} from "../presentation/agentTodoPresentation.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

/** Own state per turn so cached conversations retain both progress and the
 * user's disclosure choice. The provider remains the only source of status. */
export class AgentTodoView {
  private readonly adapter = domUiAdapter(document);
  readonly element: HTMLDetailsElement;
  private readonly meta: HTMLElement;
  private readonly list: HTMLElement;
  private readonly acceptanceSection: HTMLElement;
  private readonly acceptanceMeta: HTMLElement;
  private readonly acceptanceList: HTMLElement;
  private items: readonly AgentTodoItem[] = [];
  private acceptance: readonly PlanAcceptanceItem[] = [];
  private running = true;
  private complete = false;
  /** The row the user just clicked, so a re-render returns focus to it instead
   * of dropping a keyboard user back to the top of the panel. */
  private focusAcceptanceId: string | undefined;

  constructor(private readonly onToggleAcceptance?: (itemId: string, checked: boolean) => void) {
    const view = buildAgentTodoSection(this.adapter, [], [], { interactive: true });
    this.element = view.element as HTMLDetailsElement;
    this.meta = view.meta;
    this.list = view.list;
    this.acceptanceSection = view.acceptanceSection;
    this.acceptanceMeta = view.acceptanceMeta;
    this.acceptanceList = view.acceptanceList;
    // Only a user's click reaches this handler; the provider's task reports
    // cannot address an acceptance id.
    this.acceptanceList.addEventListener("change", (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      const itemId = input.dataset.acceptanceId;
      if (!itemId) return;
      this.focusAcceptanceId = itemId;
      this.onToggleAcceptance?.(itemId, input.checked);
    });
  }

  update(items: readonly AgentTodoItem[]): void {
    const first = this.items.length === 0;
    this.items = items;
    const progress = agentTodoProgress(items, this.running);
    this.syncVisibility();
    this.meta.textContent = progress.label;
    // A status update re-renders the rows; keep a phase the user opened open.
    const open = [...this.list.children].map((row) => row.querySelector("details")?.open === true);
    this.list.replaceChildren(...buildAgentTodoRows(this.adapter, items, this.running));
    [...this.list.children].forEach((row, index) => {
      const details = row.querySelector("details");
      if (details && open[index]) details.open = true;
    });
    if (first || progress.complete !== this.complete) this.element.open = !progress.complete || this.acceptance.some((item) => !item.checked);
    this.complete = progress.complete;
  }

  /** The user's own list. It arrives from the session's stored progress, not
   * from an agent event, and it never feeds the development task counts. */
  setAcceptance(items: readonly PlanAcceptanceItem[]): void {
    const first = this.acceptance.length === 0;
    this.acceptance = items;
    this.renderAcceptance();
    this.syncVisibility();
    // Unchecked acceptance is the one control the user still has to reach, so a
    // finished plan keeps the panel open until the last box is checked.
    if (first && items.length) this.element.open = true;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.update(this.items);
  }

  private renderAcceptance(): void {
    this.acceptanceMeta.textContent = agentAcceptanceProgressLabel(this.acceptance);
    this.acceptanceList.replaceChildren(...buildAgentAcceptanceRows(this.adapter, this.acceptance, { interactive: true }));
    const focusId = this.focusAcceptanceId;
    this.focusAcceptanceId = undefined;
    if (!focusId) return;
    for (const input of this.acceptanceList.querySelectorAll<HTMLInputElement>("input[data-acceptance-id]")) {
      if (input.dataset.acceptanceId === focusId) {
        input.focus();
        return;
      }
    }
  }

  private syncVisibility(): void {
    this.acceptanceSection.hidden = this.acceptance.length === 0;
    this.element.hidden = this.items.length === 0 && this.acceptance.length === 0;
  }
}
