import { describe, expect, it } from "vitest";
import { PiEvents } from "../src/features/agents/domain/piEvents.js";
describe("Pi event snapshots", () => {
  it("counts an ended native message ID once even when another message intervenes", () => {
    const events = new PiEvents("turn");
    const message = (id: string) => ({ type: "message_end", message: { id, role: "assistant", content: [], usage: { input: 2, output: 3, totalTokens: 5 } } });
    events.consume(message("a")); events.consume(message("b")); events.consume(message("a"));
    expect(events.usage()?.totalTokens).toBe(10);
  });
  it("replaces text blocks and final snapshots instead of duplicating deltas", () => {
    const events = new PiEvents("turn"); events.consume({ type: "message_start", message: { role: "assistant" } });
    const first = events.consume({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" } })[0]!;
    const final = events.consume({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], stopReason: "stop" } })[0]!;
    expect(final).toMatchObject({ id: first.id, text: "Hello world", replace: true, done: true });
    expect(events.finalText).toBe("Hello world");
  });
  it("deduplicates message usage, counts cache once, and uses only this turn's stats delta", () => {
    const events = new PiEvents("turn");
    events.setBaseline({ tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, total: 180 } });
    const record = { type: "message_end", message: { role: "assistant", content: [], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 1, totalTokens: 10 } } };
    events.consume(record); events.consume(record);
    expect(events.usage()).toMatchObject({ inputTokens: 7, cachedInputTokens: 4, outputTokens: 3, totalTokens: 10 });
    events.setStats({ tokens: { input: 105, output: 54, cacheRead: 24, cacheWrite: 11, total: 194 }, contextUsage: { tokens: null, contextWindow: 1000 } });
    expect(events.usage()).toEqual({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 4, totalTokens: 14, contextWindowTokens: 1000 });
    expect(new PiEvents("unknown").usage()).toBeUndefined();
  });
  it("keeps tool identities and retry/compaction status separate from completion", () => {
    const events = new PiEvents("turn");
    const start = events.consume({ type: "tool_execution_start", toolCallId: "a", toolName: "powershell", args: { command: "test" } })[0]!;
    expect(events.consume({ type: "tool_execution_end", toolCallId: "a", toolName: "powershell", result: { content: [{ type: "text", text: "done" }] } })[0]).toMatchObject({ id: start.id, done: true, text: "done" });
    expect(events.consume({ type: "compaction_end", willRetry: true })[0]?.phase).toBe("status");
    expect(events.consume({ type: "agent_end", willRetry: true })).toEqual([]);
  });
});
