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
    await store.addSuccess("chat(message=\"hello\")", [{ phase: "status", text: "started" }], {
      kind: "workflow",
      executions: []
    }, "session-1");
    await store.addFailure("terminal.run(command=\"git status\")", [], new Error("cancelled"), "session-1");
    const sessions = store.list();
    expect(sessions).toHaveLength(1);
    const records = sessions[0]!.turns;
    expect(records.map((record) => record.input)).toEqual([
      'chat(message="hello")',
      'terminal.run(command="git status")'
    ]);
    expect(records[0]?.output).toContain("workflow");
    expect(records[0]?.response).toEqual({ kind: "workflow", executions: [] });
    expect(records[1]?.error).toBe("cancelled");
  });

  it("migrates each legacy flat record into a one-turn conversation", () => {
    const legacy = [{
      id: "old-1",
      createdAt: 100,
      input: 'chat(message="old")',
      process: [],
      output: '{"kind":"workflow","executions":[]}'
    }];
    const store = new DextHistoryStore(new MemoryState(legacy) as never);

    expect(store.list()).toEqual([expect.objectContaining({
      id: "legacy-old-1",
      turns: [expect.objectContaining({ id: "old-1", input: 'chat(message="old")' })]
    })]);
  });
});
