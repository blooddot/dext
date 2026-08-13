import { describe, expect, it } from "vitest";
import { DextHistoryStore } from "../src/historyStore.js";

class MemoryState {
  private value: unknown;
  get<T>(_: string, fallback: T): T { return (this.value as T | undefined) ?? fallback; }
  async update(_: string, value: unknown): Promise<void> { this.value = value; }
}

describe("DextHistoryStore", () => {
  it("persists successful and failed execution records", async () => {
    const store = new DextHistoryStore(new MemoryState() as never);
    await store.addSuccess("chat(message=\"hello\")", [{ phase: "status", text: "started" }], {
      kind: "workflow",
      executions: []
    });
    await store.addFailure("terminal.run(command=\"git status\")", [], new Error("cancelled"));
    const records = store.list();
    expect(records).toHaveLength(2);
    expect(records[0]?.output).toContain("workflow");
    expect(records[0]?.response).toEqual({ kind: "workflow", executions: [] });
    expect(records[1]?.error).toBe("cancelled");
  });
});
