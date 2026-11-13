import type { AgentStreamEvent, AgentTodoItem, PlanExecutionOutcome } from "../../../shared/contracts/types.js";
import { escapeHtml } from "../../../shared/lib/html.js";
import { dextMarkdown } from "../../../shared/lib/markdown.js";

// Live Todo rows and restored history use the same Markdown interpretation.
const todoMarkdown = dextMarkdown();
// Plan tasks end with `verify: <check>`. Splitting on the last marker keeps the
// task readable as a task instead of one long line.
// shortcut: a task whose prose mentions `verify:` also splits there, until
// tasks carry a structured field.
const TASK_VERIFY = /^(.*\S)\s*verify:\s*(\S.*)$/is;

export function planExecutionLabel(events: readonly AgentStreamEvent[], error?: string, outcome?: PlanExecutionOutcome): string {
  if (outcome?.status === "cancelled") return "Stopped";
  if (error) return "Failed";
  if (outcome) return { completed: "Completed", incomplete: "Incomplete", blocked: "Blocked", cancelled: "Stopped" }[outcome.status];
  const items = latestAgentTodos(events);
  return items.length && items.every((item) => item.status === "completed") ? "Completed" : "Incomplete";
}

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
  const rows: string[] = [];
  for (let index = 0; index < items.length;) {
    const group = items[index]!.group;
    if (group === undefined) {
      rows.push(todoRow(items[index]!, running));
      index++;
      continue;
    }
    let end = index + 1;
    while (end < items.length && items[end]!.group === group) end++;
    rows.push(phaseRow(group, items.slice(index, end), running));
    index = end;
  }
  return rows.join("");
}

/** A plan phase shows how many of its steps are done and keeps the steps one
 * click away, so a failure is visible without scanning every task up front. */
function phaseRow(group: string, steps: readonly AgentTodoItem[], running: boolean): string {
  const done = steps.filter((step) => step.status === "completed").length;
  const state = done === steps.length ? "completed" : steps.some((step) => step.status === "in_progress") ? "in_progress" : "pending";
  const active = state === "in_progress" && running;
  return `<li class="agent-todo-group" data-status="${state}"><details><summary class="agent-todo-item${active ? " active" : ""}" data-status="${state}"><i class="disclosure-chevron codicon codicon-chevron-right" aria-hidden="true"></i><div class="agent-todo-text markdown-body">${todoMarkdown.render(group)}</div><span class="agent-todo-status">${done}/${steps.length}</span></summary><ul class="agent-todo-list">${steps.map((step) => todoRow(step, running)).join("")}</ul></details></li>`;
}

function todoRow(item: AgentTodoItem, running: boolean): string {
  const verify = TASK_VERIFY.exec(item.text);
  const task = verify?.[1] ?? item.text;
  const active = item.status === "in_progress" && running;
  const label = item.status === "completed" ? "Completed" : active ? "In progress"
    : item.status === "in_progress" ? "Paused" : "Pending";
  const icon = item.status === "completed" ? "check" : active ? "loading codicon-modifier-spin"
    : item.status === "in_progress" ? "debug-pause" : "circle-large-outline";
  return `<li class="agent-todo-item${active ? " active" : ""}" data-status="${item.status}"><i class="codicon codicon-${icon}" aria-hidden="true"></i><div class="agent-todo-text markdown-body">${todoMarkdown.render(task)}${verify ? `<div class="agent-todo-verify">verify: ${escapeHtml(verify[2]!)}</div>` : ""}</div><span class="agent-todo-status">${label}</span></li>`;
}

export function renderAgentTodos(items: readonly AgentTodoItem[]): string {
  if (!items.length) return "";
  const progress = agentTodoProgress(items, false);
  return `<details class="turn-section agent-todos"${progress.complete ? "" : " open"}><summary><i class="disclosure-chevron codicon codicon-chevron-right"></i><span>Todo</span><span class="turn-section-meta disclosure-meta">${progress.label}</span></summary><ul class="turn-section-body agent-todo-list">${agentTodoRows(items, false)}</ul></details>`;
}
