import { describe, expect, it } from "vitest";
import { DextHistoryStore } from "../src/historyStore.js";

class MemoryState {
  constructor(private value?: unknown) {}
  get<T>(_: string, fallback: T): T { return (this.value as T | undefined) ?? fallback; }
  async update(_: string, value: unknown): Promise<void> { this.value = value; }
}

describe("DextHistoryStore", () => {
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

  it("forks selected turns into a conversation of their own", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("first", [], { kind: "workflow", executions: [] }, "session-1");
    await store.addSuccess("second", [], { kind: "workflow", executions: [] }, "session-1");
    const original = store.list()[0]!;

    const forked = await store.fork(original.turns.slice(0, 1));

    expect(forked.turns.map((turn) => turn.input)).toEqual(["first"]);
    // A fork must not share turn identity with the conversation it came from.
    expect(forked.turns[0]?.id).not.toBe(original.turns[0]?.id);
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
