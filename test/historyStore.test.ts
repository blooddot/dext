import { uiCallForm } from "../src/core/uiForm.js";
import { describe, expect, it } from "vitest";
import { DextHistoryStore } from "../src/historyStore.js";

class MemoryState {
  constructor(private value?: unknown) {}
  get<T>(_: string, fallback: T): T { return (this.value as T | undefined) ?? fallback; }
  async update(_: string, value: unknown): Promise<void> { this.value = value; }
}

class DelayedMemoryState extends MemoryState {
  override async update(key: string, value: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await super.update(key, value);
  }
}

describe("DextHistoryStore", () => {
  it("persists a round checkpoint before a final turn exists, without losing native session bindings", async () => {
    const state = new MemoryState(); const store = new DextHistoryStore(state as never);
    const todos = [{ id: "plan-1", text: "Implement", status: "in_progress" as const }];
    await store.updatePlanProgress("plan", "plans/build.plan.md", todos);
    await store.setProviderSession("plan", "codex", "native-session");
    const restored = new DextHistoryStore(state as never).list()[0]!;
    expect(restored.turns).toEqual([]);
    expect(restored.planProgress).toEqual({ path: "plans/build.plan.md", todos });
    expect(restored.providerSessions).toEqual({ codex: "native-session" });
    await store.addSuccess("build", [], { kind: "workflow", executions: [] }, "plan", "plan", "turn", {
      executePlan: true, planPath: "plans/build.plan.md", planOutcome: { status: "incomplete", reason: "No progress", rounds: 3 }
    });
    expect(new DextHistoryStore(state as never).list()[0]?.turns[0]?.planOutcome?.status).toBe("incomplete");
  });
  it("retains Plan execution identity after success, cancellation and reload without changing the input", async () => {
    const state = new MemoryState();
    const store = new DextHistoryStore(state as never);
    const context = { executePlan: true, planPath: "plans/build.plan.md" };
    await store.addSuccess("internal build prompt", [], { kind: "workflow", executions: [] }, "plan", "plan", "success", context);
    await store.addFailure("internal build prompt", [], new Error("Cancelled"), "plan", "plan", "cancelled", context);
    await store.addSuccess("Write a plan", [], { kind: "workflow", executions: [] }, "plan", "plan", "draft");
    const turns = new DextHistoryStore(state as never).list()[0]!.turns;
    expect(turns.slice(0, 2)).toEqual([
      expect.objectContaining({ ...context, id: "success", input: "internal build prompt" }),
      expect.objectContaining({ ...context, id: "cancelled", input: "internal build prompt", error: "Cancelled" })
    ]);
    expect(turns[2]?.executePlan).toBeUndefined();
  });

  it("keeps CLI bindings after deleting the final Dext record and reloading", async () => {
    const state = new MemoryState();
    const store = new DextHistoryStore(state as never);
    await store.addSuccess("only turn", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    await store.setProviderSession("session-1", "claude", "claude-thread");
    await store.setProviderSession("session-1", "deepseek-harness", "dsh-binding");
    expect(await store.removeTurn("session-1", "turn-1", { codex: "codex-thread" })).toBe(true);
    const restarted = new DextHistoryStore(state as never);
    expect(restarted.list()[0]).toMatchObject({
      id: "session-1", turns: [], providerSessions: { codex: "codex-thread", claude: "claude-thread", "deepseek-harness": "dsh-binding" }
    });
    await restarted.addSuccess("continue", [], { kind: "workflow", executions: [] }, "session-1");
    expect(restarted.list()[0]?.providerSessions).toEqual({ codex: "codex-thread", claude: "claude-thread", "deepseek-harness": "dsh-binding" });
  });

  it("does not count retained empty CLI sessions as turns when enforcing history limits", async () => {
    const store = new DextHistoryStore(new MemoryState() as never, () => ({ maxTurns: 1, maxOutputLength: 1000 }));
    await store.addSuccess("only turn", [], { kind: "workflow", executions: [] }, "empty", "ask", "turn-1");
    await store.removeTurn("empty", "turn-1", { codex: "thread" });
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "active");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "active");
    expect(store.list().flatMap((session) => session.turns.map((turn) => turn.input))).toEqual(["second"]);
    expect(store.list().find((session) => session.id === "empty")?.providerSessions).toEqual({ codex: "thread" });
  });

  it("persists a turn title independently of its input, sibling turns and parent conversation", async () => {
    const state = new MemoryState();
    const store = new DextHistoryStore(state as never);
    await store.addSuccess("original input", [], { kind: "workflow", executions: [] }, "session-1", "agent", "turn-1");
    await store.addFailure("second input", [], "failed", "session-1", "agent", "turn-2");
    const before = store.list()[0]!;
    expect(await store.renameTurn("session-1", "turn-1", "  New title  ")).toBe(true);
    const restored = new DextHistoryStore(state as never).list()[0]!;
    expect(restored).toEqual({ ...before, turns: [{ ...before.turns[0]!, title: "New title" }, before.turns[1]!] });
    expect(await store.renameTurn("session-1", "turn-1", "   ")).toBe(true);
    expect(store.list()[0]).toEqual(before);
    expect(await store.renameTurn("missing", "turn-1", "wrong")).toBe(false);
    expect(await store.renameTurn("session-1", "missing", "wrong")).toBe(false);
  });

  it("keeps turn names during concurrent writes and forks them independently", async () => {
    const store = new DextHistoryStore(new DelayedMemoryState() as never);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
    await Promise.all([
      store.renameTurn("session-1", "turn-1", "renamed"),
      store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1")
    ]);
    const source = store.list()[0]!;
    expect(source.turns).toHaveLength(2);
    expect(source.turns[0]?.title).toBe("renamed");
    const forked = await store.fork(source.turns.slice(0, 1));
    expect(forked.turns[0]?.title).toBe("renamed");
    await store.renameTurn(forked.id, forked.turns[0]!.id, "fork title");
    expect(store.list()[0]?.turns[0]?.title).toBe("renamed");
  });

  it("persists successful and failed execution records", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("ask(input=\"hello\")", [{ phase: "status", text: "started" }], {
      kind: "workflow",
      executions: []
    }, "session-1");
    await store.addFailure("terminal(command=\"git status\")", [], new Error("cancelled"), "session-1");
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    const records = sessions[0]!.turns;
    expect(records.map((record) => record.input)).toEqual([
      'ask(input="hello")',
      'terminal(command="git status")'
    ]);
    expect(records[0]?.output).toContain("workflow");
    expect(records[0]?.response).toEqual({ kind: "workflow", executions: [] });
    expect(records[1]?.error).toBe("cancelled");
  });

  it("keeps the execution id when persisting a cancelled turn", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);

    await store.addFailure("unfinished request", [], new Error("cancelled"), "session-1", "agent", "turn-running");

    expect(store.list()[0]?.turns[0]?.id).toBe("turn-running");
    expect(await store.removeTurn("session-1", "turn-running")).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("does not lose turns when separate conversations finish together", async () => {
    const store = new DextHistoryStore(new DelayedMemoryState() as never);
    await Promise.all([
      store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1"),
      store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-2")
    ]);

    expect(store.list().map((session) => [session.id, session.turns[0]?.input])).toEqual([
      ["session-1", "first"],
      ["session-2", "second"]
    ]);
  });

  it("honours the configured turn and output limits on every write", async () => {
    const limits = { maxTurns: 2, maxOutputLength: 12 };
    const store = new DextHistoryStore(new MemoryState() as never, () => limits);
    for (const input of ["first", "second", "third"]) {
      await store.addSuccess(input, [], { kind: "workflow", executions: [] }, "session-1");
    }
    // The oldest turn is what goes when the cap is reached.
    expect(store.list()[0]?.turns.map((turn) => turn.input)).toEqual(["second", "third"]);

    await store.addSuccess("a".repeat(40), [{ phase: "status", text: "b".repeat(40) }], {
      kind: "workflow",
      executions: []
    }, "session-2");
    const turn = store.list().at(-1)?.turns.at(-1);
    expect(turn?.input).toBe(`${"a".repeat(12)}\n... output truncated ...`);
    expect(turn?.process[0]?.text).toBe(`${"b".repeat(12)}\n... output truncated ...`);

    // Raising the limit takes effect on the next write, not the next window.
    limits.maxTurns = 10;
    limits.maxOutputLength = 100;
    await store.addSuccess("c".repeat(40), [], { kind: "workflow", executions: [] }, "session-2");
    expect(store.list().at(-1)?.turns.at(-1)?.input).toBe("c".repeat(40));
  });

  it("falls back to the built-in limits when a setting is nonsense", async () => {
    const store = new DextHistoryStore(
      new MemoryState() as never,
      () => ({ maxTurns: 0, maxOutputLength: -5 })
    );
    await store.addSuccess("kept", [], { kind: "workflow", executions: [] }, "session-1");
    expect(store.list()[0]?.turns.map((turn) => turn.input)).toEqual(["kept"]);
  });

  it("forks selected turns into a conversation of their own", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    const original = store.list()[0]!;

    await store.setProviderSession("session-1", "codex", "thread-1");
    const sourceWithProvider = store.list()[0]!;
    const forked = await store.fork(sourceWithProvider.turns.slice(0, 1), sourceWithProvider.providerSessions);

    expect(forked.turns.map((turn) => turn.input)).toEqual(["first"]);
    // A fork must not share turn identity with the conversation it came from.
    expect(forked.turns[0]?.id).not.toBe(original.turns[0]?.id);
    expect(forked.forkProviderSessions).toEqual({ codex: "thread-1" });
    expect(store.list().map((session) => session.id)).toEqual([original.id, forked.id]);
    expect(store.list()[0]?.turns).toHaveLength(2);
  });

  it("removes a single conversation and keeps the rest", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("kept", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("dropped", [], { kind: "workflow", executions: [] }, "session-2");

    await store.remove("session-2");

    expect(store.list().map((session) => session.id)).toEqual(["session-1"]);
  });

  it("removes one turn and drops an empty conversation", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    const turns = store.list()[0]!.turns;

    expect(await store.removeTurn("session-1", turns[0]!.id)).toBe(true);
    expect(store.list()[0]?.turns.map((turn) => turn.input)).toEqual(["second"]);
    expect(await store.removeTurn("session-1", turns[1]!.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(await store.removeTurn("session-1", "missing")).toBe(false);
  });

  it("migrates each legacy flat record into a one-turn conversation", () => {
    const legacy = [{
      id: "old-1",
      createdAt: 100,
      input: 'ask(input="old")',
      process: [],
      output: '{"kind":"workflow","executions":[]}'
    }];
    const store = new DextHistoryStore(new MemoryState(legacy) as never);

    expect(store.list()).toEqual([expect.objectContaining({
      id: "legacy-old-1",
      turns: [expect.objectContaining({ id: "old-1", input: 'ask(input="old")' })]
    })]);
  });

  it("normalizes legacy inline reference storage before history presentation", () => {
    const marker = "\uE000eyJraW5kIjoiZmlsZSIsInBheWxvYWQiOiJzcmMvYS50cyJ9\uE001";
    const stored = [{
      id: "old-ref",
      createdAt: 100,
      input: 'ask(input="Read ' + marker + '")',
      process: [],
      output: ""
    }];
    const store = new DextHistoryStore(new MemoryState(stored) as never);

    expect(store.list()[0]?.turns[0]?.input).toBe('ask(input="Read @src/a.ts")');
  });
});

it("preserves raw unknown history while bounding new interaction summaries and omitting secrets", async () => {
  const legacy = { id: "old", createdAt: 1, input: 'ui.choose(label="Old", options=["a"])', process: [], output: '{"kind":"ui","type":"choice","selected":["a"]}' };
  const memory = new MemoryState([legacy]); const store = new DextHistoryStore(memory as never, () => ({ maxTurns: 10, maxOutputLength: 500 }));
  expect(store.list()[0]?.turns[0]).toEqual(legacy);
  const form = uiCallForm("input", { label: "Text" });
  await store.addSuccess("Input", [
    { phase: "input", text: "", uiInteraction: { sessionId: "s", turnId: "t", requestId: "r", status: "waiting", form } },
    { phase: "input", text: "", uiInteraction: { sessionId: "s", turnId: "t", requestId: "r", status: "submitted", form, answers: { answer: { type: "input", value: "x".repeat(2000) } } } },
    { phase: "input", text: "", userInput: { id: "native", blocking: true, status: "answered", questions: [{ id: "secret", question: "Secret", header: "", options: [], isSecret: true }], answers: { secret: { answers: ["private-value"] } } } }
  ], { kind: "workflow", executions: [] }, "new", "code", "new-turn");
  const record = store.list().find((session) => session.id === "new")!.turns[0]!;
  expect(record.process).toHaveLength(2);
  expect(record.process[0]?.text.length).toBeLessThan(550);
  expect(JSON.stringify(record)).not.toContain("private-value");
  expect(store.list()[0]?.turns[0]).toEqual(legacy);
});
