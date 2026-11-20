import type { AgentStreamEvent, AgentTodoItem, PlanAcceptanceItem, PlanExecutionOutcome } from "../../../shared/contracts/types.js";
import {
  Badge, Markdown, Spinner, Trace, TraceChevron, TraceCollapsible, TraceCollapsibleContent,
  TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle
} from "../../../shared/lib/ui/traceComponents.js";
import type { MarkupAdapter } from "../../../shared/lib/ui/renderAdapter.js";
import { htmlUiAdapter } from "../../../shared/lib/ui/htmlUiAdapter.js";
import { Checkbox } from "../../../shared/lib/ui/nativeControls.js";

// Plan tasks end with `verify: <check>`. Splitting on the last marker keeps the
// task readable as a task instead of one long line.
// shortcut: a task whose prose mentions `verify:` also splits there, until
// tasks carry a structured field.
const TASK_VERIFY = /^(.*\S)\s*verify:\s*(\S.*)$/is;

export function planExecutionLabel(
  events: readonly AgentStreamEvent[],
  error?: string,
  outcome?: PlanExecutionOutcome,
  acceptance: readonly PlanAcceptanceItem[] = []
): string {
  if (outcome?.status === "cancelled") return "Stopped";
  if (error) return "Failed";
  // Acceptance qualifies a finished run, never a failed one: unfinished work and
  // failed checks must not read as "waiting for the user".
  if (outcome) return outcome.status === "completed"
    ? acceptanceLabel(acceptance)
    : { completed: "Completed", incomplete: "Incomplete", blocked: "Blocked", cancelled: "Stopped" }[outcome.status];
  const items = latestAgentTodos(events);
  return items.length && items.every((item) => item.status === "completed") ? acceptanceLabel(acceptance) : "Incomplete";
}

/** The run itself is over either way; only the user's own confirmation differs. */
function acceptanceLabel(acceptance: readonly PlanAcceptanceItem[]): string {
  if (!acceptance.length) return "Completed";
  return acceptance.every((item) => item.checked) ? "Completed · acceptance complete" : "Completed · awaiting acceptance";
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
  return buildAgentTodoRows(htmlUiAdapter, items, running).map((row) => row.html).join("");
}

export function buildAgentTodoRows<E>(
  adapter: MarkupAdapter<E>, items: readonly AgentTodoItem[], running: boolean
): E[] {
  const rows: E[] = [];
  for (let index = 0; index < items.length;) {
    const group = items[index]!.group;
    if (group === undefined) {
      rows.push(todoRow(adapter, items[index]!, running));
      index++;
      continue;
    }
    let end = index + 1;
    while (end < items.length && items[end]!.group === group) end++;
    rows.push(phaseRow(adapter, group, items.slice(index, end), running));
    index = end;
  }
  return rows;
}

/** A plan phase shows how many of its steps are done and keeps the steps one
 * click away, so a failure is visible without scanning every task up front. */
function phaseRow<E>(adapter: MarkupAdapter<E>, group: string, steps: readonly AgentTodoItem[], running: boolean): E {
  const done = steps.filter((step) => step.status === "completed").length;
  const state = done === steps.length ? "completed" : steps.some((step) => step.status === "in_progress") ? "in_progress" : "pending";
  const active = state === "in_progress" && running;
  const summary = TraceCollapsibleTrigger(adapter, [
    TraceChevron(adapter),
    Markdown(adapter, group, { trustedLinks: true, attributes: { class: "agent-todo-text markdown-body" } }),
    TraceDescription(adapter, [`${done}/${steps.length}`], { class: "agent-todo-status" })
  ], { class: `agent-todo-item${active ? " active" : ""}`, "data-status": state });
  const content = TraceCollapsibleContent(adapter, [
    Trace(adapter, steps.map((step) => todoRow(adapter, step, running)), { class: "agent-todo-list" })
  ]);
  return TraceLine(adapter, [TraceCollapsible(adapter, summary, content)], { class: "agent-todo-group", "data-status": state });
}

function todoRow<E>(adapter: MarkupAdapter<E>, item: AgentTodoItem, running: boolean): E {
  const verify = TASK_VERIFY.exec(item.text);
  const task = verify?.[1] ?? item.text;
  const active = item.status === "in_progress" && running;
  const label = item.status === "completed" ? "Completed" : active ? "In progress"
    : item.status === "in_progress" ? "Paused" : "Pending";
  const icon = item.status === "completed" ? "check"
    : item.status === "in_progress" ? "debug-pause" : "circle-large-outline";
  const verification = verify ? [TraceDescription(adapter, [`verify: ${verify[2]}`], { class: "agent-todo-verify" }, "div")] : [];
  return TraceLine(adapter, [
    active ? Spinner(adapter) : TraceIcon(adapter, icon),
    Markdown(adapter, task, { trustedLinks: true, attributes: { class: "agent-todo-text markdown-body" } }, verification),
    Badge(adapter, label, { class: "agent-todo-status" })
  ], { class: `agent-todo-item${active ? " active" : ""}`, "data-status": item.status });
}

export function renderAgentTodos(items: readonly AgentTodoItem[], acceptance: readonly PlanAcceptanceItem[] = []): string {
  if (!items.length && !acceptance.length) return "";
  return buildAgentTodoSection(htmlUiAdapter, items, acceptance, { interactive: false }).element.html;
}

export function buildAgentTodoSection<E>(
  adapter: MarkupAdapter<E>, items: readonly AgentTodoItem[], acceptance: readonly PlanAcceptanceItem[],
  options: { interactive: boolean }
): { element: E; meta: E; list: E; acceptanceSection: E; acceptanceMeta: E; acceptanceList: E } {
  const { interactive } = options;
  const progress = agentTodoProgress(items, false);
  const acceptanceLabel = agentAcceptanceProgressLabel(acceptance);
  const meta = TraceDescription(adapter, [progress.label], {
    class: "turn-section-meta disclosure-meta", ...(interactive ? { role: "status", "aria-live": "polite" } : {})
  });
  const summary = TraceCollapsibleTrigger(adapter, [TraceChevron(adapter), TraceTitle(adapter, ["Todo"]), meta]);
  const list = Trace(adapter, buildAgentTodoRows(adapter, items, false), { class: "turn-section-body agent-todo-list" });
  const acceptanceMeta = TraceDescription(adapter, [acceptanceLabel], { class: "turn-section-meta" });
  const acceptanceHeader = adapter.element("div", { class: "agent-acceptance-header" }, [
    TraceIcon(adapter, "checklist"), TraceTitle(adapter, ["Acceptance"]), acceptanceMeta
  ]);
  const acceptanceList = Trace(adapter, buildAgentAcceptanceRows(adapter, acceptance, options), { class: "agent-acceptance-list" });
  const acceptanceSection = adapter.element("section", {
    class: "agent-acceptance",
    ...(interactive ? { hidden: !acceptance.length } : { "data-acceptance-progress": acceptanceLabel })
  }, [acceptanceHeader, acceptanceList]);
  const visible = items.length > 0 || acceptance.length > 0;
  const content = TraceCollapsibleContent(adapter, interactive || acceptance.length ? [list, acceptanceSection] : [list]);
  const element = TraceCollapsible(adapter, summary, content, {
    class: `${interactive ? "output-turn-section " : ""}turn-section agent-todos`,
    hidden: interactive && !visible,
    open: visible && (!progress.complete || acceptance.some((item) => !item.checked))
  });
  return { element, meta, list, acceptanceSection, acceptanceMeta, acceptanceList };
}

/** Each acceptance row pairs a native checkbox with its own label; the `for`
 * attribute and `data-acceptance-id` hook keep the row addressable after a
 * re-render. */
export function agentAcceptanceRows(
  items: readonly PlanAcceptanceItem[],
  options: { interactive: boolean }
): string {
  return buildAgentAcceptanceRows(htmlUiAdapter, items, options).map((row) => row.html).join("");
}

export function buildAgentAcceptanceRows<E>(
  adapter: MarkupAdapter<E>, items: readonly PlanAcceptanceItem[], options: { interactive: boolean }
): E[] {
  return items.map((item) => {
    const elementId = `acceptance-${item.id}`;
    return TraceLine(adapter, [
      Checkbox(adapter, {
        class: "agent-acceptance-check", id: elementId,
        "data-acceptance-id": item.id, checked: item.checked, disabled: !options.interactive
      }),
      Markdown(adapter, item.text, {
        trustedLinks: true, tag: "label", attributes: { class: "agent-acceptance-text markdown-body", for: elementId }
      })
    ], { class: "agent-acceptance-item", "data-status": item.checked ? "completed" : "pending" });
  });
}

/** The acceptance header count is its own denominator: it never moves the
 * development task counts the completion decision reads. */
export function agentAcceptanceProgressLabel(items: readonly PlanAcceptanceItem[]): string {
  const checked = items.filter((item) => item.checked).length;
  return `${checked}/${items.length} accepted`;
}
