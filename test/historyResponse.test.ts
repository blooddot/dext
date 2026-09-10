import { describe, expect, it } from "vitest";
import { readHistoryResponse } from "../src/historyResponse.js";
import { DextHistoryStore, type DextHistoryRecord } from "../src/historyStore.js";
import { historyTurnMarkdown, renderHistoryRecord } from "../src/historyRender.js";

function legacyRecord(method = "agent", serialized = false): DextHistoryRecord {
  const execution = {
    invocation: { kind: "invocation", method, source: "chat", arguments: [] },
    method: { id: method, title: method, kind: "command", source: "builtin" },
    result: { kind: "chat", text: "已实现。\n\n**正文**\n\n- 第一项\n- 第二项" }, durationMs: 123
  };
  const response = { kind: "workflow", executions: [execution], steps: [{ method, state: "success", response: execution }] };
  return { id: "legacy", createdAt: 1, input: "实现", mode: "agent", process: [], output: JSON.stringify(response),
    ...(!serialized ? { response } : {}) } as unknown as DextHistoryRecord;
}

describe("historical result compatibility", () => {
  it.each(["agent", "ask", "plan", "skill"])("recovers %s results in both executions and steps without altering stored data", (method) => {
    const record = legacyRecord(method);
    const original = JSON.stringify(record);
    const response = readHistoryResponse(record)!;
    expect(response.executions[0]?.result.kind).toBe(method);
    expect(response.steps?.[0]?.response?.result).toEqual(response.executions[0]?.result);
    expect(JSON.stringify(record)).toBe(original);
    expect(readHistoryResponse({ ...record, response })).toBe(response);
  });

  it.each([false, true])("renders legacy text as Markdown and copies readable output (serialized=%s)", (serialized) => {
    const record = legacyRecord("agent", serialized);
    const html = renderHistoryRecord(record);
    expect(html).toContain("<strong>正文</strong>");
    expect(html).toContain("<li>第一项</li>");
    expect(html).not.toContain("&quot;kind&quot;");
    const markdown = historyTurnMarkdown(record);
    expect(markdown).toContain("**正文**");
    expect(markdown).not.toContain('"kind": "chat"');
  });

  it("restores normalized results when the history store reopens, preserving the saved record", () => {
    const record = legacyRecord();
    const persisted = [{ id: "session", createdAt: 1, updatedAt: 1, turns: [record] }];
    const store = new DextHistoryStore({ get: () => persisted } as never);
    expect(store.list()[0]?.turns[0]?.response?.executions[0]?.result.kind).toBe("agent");
    expect((record.response?.executions[0]?.result as unknown as { kind: string }).kind).toBe("chat");
  });

  it("leaves plain or truncated output available to the fallback renderer", () => {
    for (const output of ["Plain response", '{"kind":"workflow",', "null"]) {
      expect(readHistoryResponse({ output })).toBeUndefined();
    }
  });
});
