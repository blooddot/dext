import type { AgentTodoItem, PlanAcceptanceItem } from "../../../shared/contracts/types.js";
import { agentAcceptanceProgressLabel, agentAcceptanceRows, agentTodoProgress, agentTodoRows } from "../presentation/agentTodoPresentation.js";

/** Own state per turn so cached conversations retain both progress and the
 * user's disclosure choice. The provider remains the only source of status. */
export class AgentTodoView {
  readonly element = document.createElement("details");
  private readonly meta = document.createElement("span");
  private readonly list = document.createElement("ul");
  private readonly acceptanceSection = document.createElement("section");
  private readonly acceptanceMeta = document.createElement("span");
  private readonly acceptanceList = document.createElement("ul");
  private items: readonly AgentTodoItem[] = [];
  private acceptance: readonly PlanAcceptanceItem[] = [];
  private running = true;
  private complete = false;
  /** The row the user just clicked, so a re-render returns focus to it instead
   * of dropping a keyboard user back to the top of the panel. */
  private focusAcceptanceId: string | undefined;

  constructor(private readonly onToggleAcceptance?: (itemId: string, checked: boolean) => void) {
    this.element.className = "output-turn-section turn-section agent-todos";
    this.element.hidden = true;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const title = document.createElement("span");
    title.textContent = "Todo";
    this.meta.className = "turn-section-meta disclosure-meta";
    this.meta.setAttribute("role", "status");
    this.meta.setAttribute("aria-live", "polite");
    this.list.className = "turn-section-body agent-todo-list";
    summary.append(chevron, title, this.meta);
    this.acceptanceSection.className = "agent-acceptance";
    this.acceptanceSection.hidden = true;
    const header = document.createElement("div");
    header.className = "agent-acceptance-header";
    const glyph = document.createElement("i");
    glyph.className = "codicon codicon-checklist";
    glyph.setAttribute("aria-hidden", "true");
    const heading = document.createElement("span");
    heading.textContent = "Acceptance";
    this.acceptanceMeta.className = "turn-section-meta";
    header.append(glyph, heading, this.acceptanceMeta);
    this.acceptanceList.className = "agent-acceptance-list";
    this.acceptanceSection.append(header, this.acceptanceList);
    this.element.append(summary, this.list, this.acceptanceSection);
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
    this.list.innerHTML = agentTodoRows(items, this.running);
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
    this.acceptanceList.innerHTML = agentAcceptanceRows(this.acceptance, { interactive: true });
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
