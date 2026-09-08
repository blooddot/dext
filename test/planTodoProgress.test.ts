import { describe, expect, it } from "vitest";
import { planTodoItems, planTodoInstruction, PlanTodoProgress, stripPlanTodoProgress } from "../src/core/planTodoProgress.js";
import { latestAgentTodos } from "../src/agentTodoPresentation.js";
import type { AgentStreamEvent } from "../src/core/types.js";

const document = "# Existing plan\n\n## Tasks\n\n1. [ ] Inspect implementation\n2. [x] Confirm dependencies\n3. [ ] Run tests\n\n## Verification\n- [ ] npm run check";
const marker = (id: string, status: string) => `<!-- dext-todo: ${JSON.stringify({ updates: [{ id, status }] })} -->`;

describe("plan task progress without native task tools", () => {
  it("initializes an old plan's task list before receiving any agent events", () => {
    const items = planTodoItems(document);
    expect(items).toEqual([
      { id: "plan-1", text: "Inspect implementation", status: "pending" },
      { id: "plan-2", text: "Confirm dependencies", status: "completed" },
      { id: "plan-3", text: "Run tests", status: "pending" }
    ]);
    expect(new PlanTodoProgress(items).initial().todos).toEqual(items);
    expect(planTodoInstruction(items)).toContain('"id":"plan-1"');
    expect(planTodoInstruction(items)).toContain("even if a native plan/task tool is unavailable");
  });

  it("ignores code examples and non-task sections and supports Chinese headings", () => {
    expect(planTodoItems("## 任务列表\n```md\n1. [ ] Example\n```\n- [ ] Implement\n## Risks\n- Do not count"))
      .toEqual([{ id: "plan-1", text: "Implement", status: "pending" }]);
    expect(planTodoItems("## Goal\n- [ ] A goal\n## Tasks\n1. Implement\n2. Verify").map((item) => item.text))
      .toEqual(["Implement", "Verify"]);
    expect(planTodoItems("No task section")).toEqual([]);
  });

  it("updates explicit status from arbitrarily fragmented progress comments while keeping them out of Process", () => {
    const tracker = new PlanTodoProgress(planTodoItems(document));
    const text = `Inspecting.\n${marker("plan-1", "in_progress")}\nReading files.`;
    const output: AgentStreamEvent[] = [];
    for (const char of text) output.push(...tracker.consume({ id: "message", phase: "message", text: char }));
    expect(latestAgentTodos(output)[0]?.status).toBe("in_progress");
    const messages = output.filter((event) => event.phase === "message");
    expect(messages.at(-1)?.text).toBe("Inspecting.\n\nReading files.");
    expect(messages.some((event) => event.text.includes("dext-todo"))).toBe(false);
    expect(output.filter((event) => event.phase === "todo")).toHaveLength(1);
  });

  it("does not replay an older marker when the provider replaces a message after a newer update", () => {
    const tracker = new PlanTodoProgress(planTodoItems(document));
    tracker.consume({ id: "first", phase: "message", text: marker("plan-1", "in_progress") });
    tracker.consume({ id: "second", phase: "message", text: marker("plan-1", "completed") });
    tracker.consume({ id: "first", phase: "message", text: marker("plan-1", "in_progress") + " Inspected.", replace: true, done: true });
    expect(tracker.initial().todos?.[0]?.status).toBe("completed");
  });

  it("rejects unknown IDs, invalid states and malformed JSON without inferring status from prose", () => {
    const tracker = new PlanTodoProgress(planTodoItems(document));
    for (const text of [marker("wrong-id", "completed"), marker("plan-1", "done"), "<!-- dext-todo: bad JSON -->", "Everything is completed"]) {
      expect(tracker.consume({ phase: "message", text }).some((event) => event.phase === "todo")).toBe(false);
    }
    expect(tracker.initial().todos?.[0]?.status).toBe("pending");
  });

  it("keeps stable plan tasks when a provider emits another native list, without changing snapshots already stored", () => {
    const tracker = new PlanTodoProgress(planTodoItems(document));
    const initial = tracker.initial();
    tracker.consume({ phase: "todo", text: "", todos: [{ id: "0", text: "Different grouping", status: "completed" }] });
    tracker.consume({ phase: "message", text: marker("plan-1", "in_progress") });
    expect(tracker.initial().todos).toHaveLength(3);
    expect(initial.todos?.[0]?.status).toBe("pending");
    expect(new PlanTodoProgress(planTodoItems(document)).initial().todos?.[0]?.status).toBe("pending");
  });

  it("strips progress comments from the final output while retaining unrelated HTML comments", () => {
    expect(stripPlanTodoProgress(`Done ${marker("plan-1", "completed")}<!-- keep -->`)).toBe("Done <!-- keep -->");
    expect(stripPlanTodoProgress("Paused <!-- dext-todo: {" )).toBe("Paused ");
  });
});
