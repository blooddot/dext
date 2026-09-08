import type { AgentStreamEvent, AgentTodoItem } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function status(value: unknown): AgentTodoItem["status"] | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
}

/** Reject incomplete snapshots instead of accidentally deleting earlier tasks. */
export function normalizeAgentTodos(value: unknown, format: "codex" | "claude" | "acp"): AgentTodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: AgentTodoItem[] = [];
  for (const [index, raw] of value.entries()) {
    const item = record(raw);
    const text = format === "codex" ? item?.text : item?.content;
    const state = format === "codex"
      ? typeof item?.completed === "boolean" ? item.completed ? "completed" : "pending" : undefined
      : status(item?.status);
    if (typeof text !== "string" || !text.trim() || !state) return undefined;
    items.push({ id: typeof item?.id === "string" ? item.id : String(index), text, status: state });
  }
  return items;
}

export function agentTodoEvent(todos: readonly AgentTodoItem[]): AgentStreamEvent {
  return { phase: "todo", text: "", replace: true, todos: todos.map((item) => ({ ...item })) };
}

export function isClaudeTodoTool(name: unknown): boolean {
  return typeof name === "string" && ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(name);
}

/** One tracker per CLI turn. Correlate task results by tool-use ID, never by
 * counting creates: failed calls and other sessions can have different IDs. */
export class ClaudeTodoTracker {
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private tasks = new Map<string, AgentTodoItem>();

  ownsCall(id: unknown): boolean { return typeof id === "string" && this.calls.has(id); }

  /** null means a task event with no committed change, undefined is unrelated. */
  consume(event: Record<string, unknown>): AgentStreamEvent | null | undefined {
    // Subagent task IDs live in another namespace and must not replace the
    // conversation's own plan.
    if (event.parent_tool_use_id) return undefined;
    const message = record(event.message);
    const blocks = Array.isArray(message?.content) ? message.content.map(record) : [];
    let handled = false;
    let changed = false;
    if (event.type === "assistant") {
      for (const block of blocks) {
        if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        if (!isClaudeTodoTool(block.name)) continue;
        handled = true;
        const input = record(block.input);
        if (input) this.calls.set(block.id, { name: block.name, input });
      }
    } else if (event.type === "user") {
      for (const block of blocks) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const call = this.calls.get(block.tool_use_id);
        if (!call) continue;
        handled = true;
        this.calls.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        const output = record(event.tool_use_result);
        if (call.name === "TodoWrite") {
          const todos = normalizeAgentTodos(call.input.todos, "claude");
          if (!todos) continue;
          this.tasks = new Map(todos.map((item) => [item.id, item]));
          changed = true;
        } else if (call.name === "TaskCreate" || call.name === "TaskGet") {
          const task = record(output?.task);
          if (typeof task?.id !== "string") continue;
          const text = task.subject ?? call.input.subject;
          const state = call.name === "TaskCreate" ? "pending" : status(task.status);
          if (typeof text !== "string" || !state) continue;
          this.tasks.set(task.id, { id: task.id, text, status: state });
          changed = true;
        } else if (call.name === "TaskUpdate") {
          if (output?.success === false) continue;
          const id = call.input.taskId ?? call.input.id ?? call.input.task_id;
          if (typeof id !== "string") continue;
          if (call.input.status === "deleted") { changed = this.tasks.delete(id) || changed; continue; }
          const task = this.tasks.get(id);
          if (!task) continue;
          const state = status(call.input.status) ?? task.status;
          const text = typeof call.input.subject === "string" ? call.input.subject : task.text;
          this.tasks.set(id, { id, text, status: state });
          changed = true;
        } else if (call.name === "TaskList" && Array.isArray(output?.tasks)) {
          const tasks = output.tasks.map(record);
          if (tasks.some((task) => typeof task?.id !== "string" || typeof task.subject !== "string" || !status(task.status))) continue;
          this.tasks = new Map(tasks.map((task) => {
            const item = { id: task!.id as string, text: task!.subject as string, status: status(task!.status)! };
            return [item.id, item];
          }));
          changed = true;
        }
      }
    }
    return changed ? agentTodoEvent([...this.tasks.values()]) : handled ? null : undefined;
  }
}
