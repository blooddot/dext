import type { AgentStreamEvent, AgentTodoItem, PlanExecutionOutcome } from "./core/types.js";

export function planExecutionLabel(events: readonly AgentStreamEvent[], error?: string, outcome?: PlanExecutionOutcome): string {
  if (outcome?.status === "cancelled") return "Stopped";
  if (error) return "Failed";
  if (outcome) return { completed: "Completed", incomplete: "Incomplete", blocked: "Blocked", cancelled: "Stopped" }[outcome.status];
  const items = latestAgentTodos(events);
  return items.length && items.every((item) => item.status === "completed") ? "Completed" : "Incomplete";
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]!);

export function latestAgentTodos(events: readonly AgentStreamEvent[]): readonly AgentTodoItem[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.phase === "todo" && event.todos) return event.todos;
  }
  return [];
}

export function agentTodoProgress(items: readonly AgentTodoItem[], running: boolean): { label: string; complete: boolean } {
  const completed = items.filter((item) => item.status === "completed").length;
  const current = items.filter((item) => item.status === "in_progress");
  const complete = items.length > 0 && completed === items.length;
  const state = complete ? "" : !running ? " · Incomplete"
    : current.length ? ` · ${current.length} in progress` : "";
  return { label: `${completed}/${items.length} completed${state}`, complete };
}

export function agentTodoRows(items: readonly AgentTodoItem[], running: boolean): string {
  return items.map((item) => {
    const active = item.status === "in_progress" && running;
    const label = item.status === "completed" ? "Completed" : active ? "In progress"
      : item.status === "in_progress" ? "Paused" : "Pending";
    const icon = item.status === "completed" ? "check" : active ? "loading codicon-modifier-spin"
      : item.status === "in_progress" ? "debug-pause" : "circle-large-outline";
    return `<li class="agent-todo-item${active ? " active" : ""}" data-status="${item.status}"><i class="codicon codicon-${icon}" aria-hidden="true"></i><span class="agent-todo-text">${escape(item.text)}</span><span class="agent-todo-status">${label}</span></li>`;
  }).join("");
}

export function renderAgentTodos(items: readonly AgentTodoItem[]): string {
  if (!items.length) return "";
  const progress = agentTodoProgress(items, false);
  return `<details class="history-disclosure agent-todos"${progress.complete ? "" : " open"}><summary><i class="disclosure-chevron codicon codicon-chevron-right"></i><span>Todo</span><span class="disclosure-meta">${progress.label}</span></summary><ul class="agent-todo-list">${agentTodoRows(items, false)}</ul></details>`;
}
