import type { AgentTodoItem } from "../core/types.js";
import { agentTodoProgress, agentTodoRows } from "../agentTodoPresentation.js";

/** Own state per turn so cached conversations retain both progress and the
 * user's disclosure choice. The provider remains the only source of status. */
export class AgentTodoView {
  readonly element = document.createElement("details");
  private readonly meta = document.createElement("span");
  private readonly list = document.createElement("ul");
  private items: readonly AgentTodoItem[] = [];
  private running = true;
  private complete = false;

  constructor() {
    this.element.className = "output-turn-section execution-disclosure agent-todos";
    this.element.hidden = true;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const title = document.createElement("span");
    title.textContent = "Todo";
    this.meta.className = "disclosure-meta";
    this.meta.setAttribute("role", "status");
    this.meta.setAttribute("aria-live", "polite");
    this.list.className = "agent-todo-list";
    summary.append(chevron, title, this.meta);
    this.element.append(summary, this.list);
  }

  update(items: readonly AgentTodoItem[]): void {
    const first = this.items.length === 0;
    this.items = items;
    const progress = agentTodoProgress(items, this.running);
    this.element.hidden = items.length === 0;
    this.meta.textContent = progress.label;
    this.list.innerHTML = agentTodoRows(items, this.running);
    if (first || progress.complete !== this.complete) this.element.open = !progress.complete;
    this.complete = progress.complete;
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.update(this.items);
  }
}
