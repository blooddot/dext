import { describe, expect, it } from "vitest";
import { agentTodoEvent, ClaudeTodoTracker, normalizeAgentTodos } from "../src/core/agentTodoTracking.js";
import { CliAgentRunner, parseClaudeStreamEvents, parseCodexStreamLine } from "../src/core/agentRunner.js";
import type { AgentStreamEvent } from "../src/core/types.js";
import { agentTodoProgress, agentTodoRows, latestAgentTodos, renderAgentTodos } from "../src/agentTodoPresentation.js";
import { DextHistoryStore } from "../src/historyStore.js";
import { renderHistoryRecord } from "../src/historyRender.js";

function claudeHarness() {
  const tracker = new ClaudeTodoTracker();
  const call = (name: string, input: unknown, id = "call") => parseClaudeStreamEvents(JSON.stringify({
    type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }
  }), tracker)[0];
  const result = (output: unknown = {}, id = "call", error = false) => parseClaudeStreamEvents(JSON.stringify({
    type: "user", tool_use_result: output, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] }
  }), tracker)[0];
  return { call, result };
}

describe("agent task progress", () => {
  it("delivers Claude snapshots through fragmented CLI stdout and keeps ordinary process blocks", async () => {
    const events: AgentStreamEvent[] = [];
    const runner = new CliAgentRunner(5000, async (_command, _args, _input, _cwd, _signal, onStdout, env) => {
      expect(env?.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
      const lines = [
        { type: "assistant", message: { content: [
          { type: "tool_use", id: "tasks", name: "TodoWrite", input: { todos: [{ content: "Build", status: "in_progress" }] } },
          { type: "tool_use", id: "shell", name: "Bash", input: { command: "npm test" } }
        ] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tasks", content: "Updated" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
        { type: "result", result: "Done", is_error: false }
      ].map((line) => JSON.stringify(line)).join("\n");
      for (let i = 0; i < lines.length; i += 13) onStdout?.(lines.slice(i, i + 13));
      return { stdout: lines, stderr: "", code: 0 };
    });
    await runner.runConversation({ profile: { id: "claude", provider: "claude", label: "Claude", command: "claude", models: [] },
      cwd: process.cwd(), mode: "plan", input: "Build", allowWorkspaceWrite: false, metadata: {}, onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.phase === "tool")?.text).toContain("npm test");
    expect(events.filter((event) => event.phase === "todo").flatMap((event) => event.todos ?? []))
      .toEqual([{ id: "0", text: "Build", status: "in_progress" }]);
    expect(events.filter((event) => event.phase === "tool")).toHaveLength(1);
  });
  it("consumes Codex snapshots without inventing the active task or completing tasks when a turn ends", () => {
    const parse = (type: string, items: unknown) => parseCodexStreamLine(JSON.stringify({ type, item: { id: "todo", type: "todo_list", items } }));
    const first = parse("item.started", [{ text: "Inspect", completed: false }, { text: "Build", completed: false }])!;
    expect(first.todos?.map((item) => item.status)).toEqual(["pending", "pending"]);
    const next = parse("item.updated", [{ text: "Inspect", completed: true }, { text: "Build", completed: false }])!;
    expect(next.todos?.map((item) => item.status)).toEqual(["completed", "pending"]);
    expect(parse("item.completed", [{ text: "Build", completed: false }])?.todos?.[0]?.status).toBe("pending");
    expect(latestAgentTodos([first, next])).toEqual(next.todos);
    expect(first.todos?.[0]?.status).toBe("pending");
    expect(parse("item.updated", [{ text: "bad", completed: "true" }])).toBeUndefined();
  });

  it("keeps explicit ACP statuses and accepts clearing the whole list", () => {
    expect(normalizeAgentTodos([{ content: "Build", status: "in_progress", priority: "high" }], "acp"))
      .toEqual([{ id: "0", text: "Build", status: "in_progress" }]);
    expect(normalizeAgentTodos([{ content: "Build", status: "unknown" }], "acp")).toBeUndefined();
    expect(normalizeAgentTodos(undefined, "acp")).toBeUndefined();
    expect(latestAgentTodos([agentTodoEvent([{ id: "a", text: "Build", status: "pending" }]), agentTodoEvent([])]))
      .toEqual([]);
  });

  it("commits Claude TodoWrite only after a successful tool result and preserves the preceding snapshot on errors", () => {
    const h = claudeHarness();
    expect(h.call("TodoWrite", { todos: [{ content: "Inspect", status: "in_progress" }] })).toBeUndefined();
    const first = h.result()!;
    expect(first.todos?.[0]).toMatchObject({ text: "Inspect", status: "in_progress" });
    h.call("TodoWrite", { todos: [{ content: "Inspect", status: "completed" }] });
    expect(h.result({}, "call", true)).toBeUndefined();
    expect(first.todos?.[0]?.status).toBe("in_progress");
    h.call("TodoWrite", { todos: [] });
    expect(h.result()?.todos).toEqual([]);
  });

  it("correlates out-of-order task creation results by the assigned ID and updates or deletes the right task", () => {
    const h = claudeHarness();
    h.call("TaskCreate", { subject: "Inspect" }, "inspect");
    h.call("TaskCreate", { subject: "Build" }, "build");
    h.result({ task: { id: "9", subject: "Build" } }, "build");
    h.result({ task: { id: "4", subject: "Inspect" } }, "inspect");
    h.call("TaskUpdate", { task_id: "4", status: "in_progress" });
    expect(h.result()?.todos).toEqual([
      { id: "9", text: "Build", status: "pending" }, { id: "4", text: "Inspect", status: "in_progress" }
    ]);
    h.call("TaskUpdate", { taskId: "9", status: "completed" });
    expect(h.result({ success: false })).toBeUndefined();
    h.call("TaskUpdate", { taskId: "9", status: "deleted" });
    expect(h.result()?.todos?.map((item) => item.id)).toEqual(["4"]);
  });

  it("restores Claude TaskList snapshots, including tasks created in an earlier turn", () => {
    const h = claudeHarness();
    h.call("TaskList", {});
    expect(h.result({ tasks: [{ id: "2", subject: "Build", status: "in_progress" }] })?.todos)
      .toEqual([{ id: "2", text: "Build", status: "in_progress" }]);
    h.call("TaskUpdate", { id: "2", status: "completed" });
    expect(h.result()?.todos?.[0]?.status).toBe("completed");
  });

  it("isolates concurrent CLI turns and does not accept another turn's tool results", () => {
    const first = claudeHarness(), second = claudeHarness();
    first.call("TaskCreate", { subject: "First" });
    second.call("TaskCreate", { subject: "Second" });
    expect(first.result({ task: { id: "1" } })?.todos?.[0]?.text).toBe("First");
    expect(second.result({ task: { id: "1" } })?.todos?.[0]?.text).toBe("Second");
  });

  it("keeps paused work incomplete, escapes task titles, and removes spinners in history", () => {
    const items = [{ id: "1", text: '<script>alert("x")</script>', status: "in_progress" as const }];
    expect(agentTodoProgress(items, true).label).toContain("1 in progress");
    expect(agentTodoRows(items, true)).toContain("codicon-modifier-spin");
    expect(agentTodoRows(items, false)).toContain("Paused");
    expect(agentTodoRows(items, false)).not.toContain("codicon-modifier-spin");
    expect(agentTodoRows(items, false)).not.toContain("<script>");
    expect(agentTodoProgress(items, false)).toEqual({ label: "0/1 completed · Incomplete", complete: false });
  });

  it("renders Todo Markdown consistently in live rows and restored history", () => {
    const items = [{ id: "markdown", status: "in_progress" as const,
      text: '**验证源码一致性。** 检查 `DextCodeEditor` 和 [文档](https://example.com/docs)。\n保留换行。\n\n- 覆盖选择\n- 验证撤销\n\n```ts\nconst ready = true;\n```' }];
    for (const html of [agentTodoRows(items, true), renderAgentTodos(items)]) {
      expect(html).toContain('<div class="agent-todo-text markdown-body">');
      expect(html).toContain("<strong>验证源码一致性。</strong>");
      expect(html).toContain("<code>DextCodeEditor</code>");
      expect(html).toContain('<a href="https://example.com/docs">文档</a>');
      expect(html).toContain("<br>\n保留换行。");
      expect(html).toContain("<li>覆盖选择</li>");
      expect(html).toContain('<pre><code class="language-ts">const ready = true;');
      expect(html).not.toContain("**验证源码一致性。**");
    }
  });

  it("keeps raw HTML and executable links inert in Todo Markdown", () => {
    const html = agentTodoRows([{ id: "untrusted", status: "pending",
      text: '<img src=x onerror="alert(1)"> [unsafe](javascript:alert(1)) **Safe bold**' }], true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>Safe bold</strong>");
  });

  it("persists interrupted progress and renders the last snapshot above Process after reloading", async () => {
    let stored: unknown;
    const state = { get: <T>(_: string, fallback: T): T => (stored as T) ?? fallback, update: async (_: string, value: unknown) => { stored = value; } };
    const history = new DextHistoryStore(state as never);
    const initial = agentTodoEvent([{ id: "1", text: "Old title", status: "pending" }]);
    const latest = agentTodoEvent([{ id: "1", text: "New title", status: "in_progress" }]);
    await history.addFailure("Build", [initial, latest, { phase: "tool", text: "npm test" }], new Error("Cancelled"), "session", "plan");
    const turn = new DextHistoryStore(state as never).list()[0]!.turns[0]!;
    expect(latestAgentTodos(turn.process)).toEqual(latest.todos);
    const html = renderHistoryRecord(turn);
    expect(html).toContain("New title");
    expect(html).not.toContain("Old title");
    expect(html.indexOf(">Todo</span>")).toBeLessThan(html.indexOf(">Process</span>"));
    expect(html).toContain("Paused");
    expect(html).not.toContain("codicon-modifier-spin");
    expect(renderHistoryRecord({ ...turn, process: [agentTodoEvent([])] })).not.toContain(">Todo</span>");
  });
});
