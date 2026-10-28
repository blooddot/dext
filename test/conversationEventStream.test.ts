import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";
import { AgentEventStream } from "../src/features/conversations/host/agentEventStream.js";
import type { ConversationWebviewResponse } from "../src/features/conversations/contracts/protocol.js";

function stream(activeSessionId = "session") {
  const posted: ConversationWebviewResponse[] = [];
  const timers: Array<() => void> = [];
  const events = new AgentEventStream({
    activeSessionId: () => activeSessionId,
    disposed: () => false,
    post: (message) => { posted.push(message); },
    schedule: (callback) => { timers.push(callback); return 0 as never; },
    cancelSchedule: () => undefined
  });
  return { events, posted, timers };
}

describe("AgentEventStream", () => {
  it("merges streamed tool chunks into one logical event", () => {
    const { events } = stream();
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "tool", id: "tool-1", title: "Run", text: "a" });
    events.append("session", log, { phase: "tool", id: "tool-1", title: "Run", text: "b" });
    events.append("session", log, { phase: "tool", id: "tool-1", title: "Run", text: "c" });
    expect(log).toHaveLength(1);
    expect(log[0]?.text).toBe("abc");
    expect(log[0]?.replace).toBe(true);
  });

  it("batches the visible conversation and flushes in order", () => {
    const { events, posted, timers } = stream();
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "message", text: "one" });
    events.append("session", log, { phase: "message", text: "two" });
    expect(posted).toEqual([]);
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(posted.map((message) => message.type)).toEqual(["agentEvent", "agentEvent"]);
    expect(posted.map((message) => message.type === "agentEvent" ? message.event.text : "")).toEqual(["one", "two"]);
  });

  it("keeps a background conversation's events out of the IPC queue", () => {
    const { events, posted } = stream("other");
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "message", text: "background" });
    events.flush();
    expect(posted).toEqual([]);
    expect(log.map((event) => event.text)).toEqual(["background"]);
  });

  it("publishes every event for notification observers even when hidden", () => {
    const observed: AgentStreamEvent[] = [];
    const events = new AgentEventStream({
      activeSessionId: () => "other",
      disposed: () => false,
      post: () => undefined,
      observe: (_sessionId, event) => { observed.push(event); }
    });
    events.append("session", [], { phase: "input", text: "", userInput: { id: "q", status: "waiting", blocking: false, questions: [] } });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.userInput?.id).toBe("q");
  });

  it("sends only the appended part of a growing stream", () => {
    const { events, posted } = stream();
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "tool", id: "tool-1", title: "Run", text: "a", replace: true });
    events.flush();
    events.append("session", log, { phase: "tool", id: "tool-1", title: "Run", text: "abc", replace: true });
    events.flush();
    expect(posted.map((message) => message.type === "agentEvent" ? [message.event.text, message.event.replace] : []))
      .toEqual([["a", true], ["bc", false]]);
    expect(log).toHaveLength(1);
    expect(log[0]?.text).toBe("abc");
  });

  it("keeps one log entry per message stream instead of one per chunk", () => {
    const { events, posted } = stream();
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "message", id: "m", text: "Hel", replace: true });
    events.append("session", log, { phase: "message", id: "m", text: "Hello", replace: true });
    events.flush();
    expect(log).toHaveLength(1);
    expect(log[0]?.text).toBe("Hello");
    expect(posted.map((message) => message.type === "agentEvent" ? message.event.text : "")).toEqual(["Hello"]);
  });

  it("compacts Pi snapshots across interleaved usage and parallel tools", () => {
    const { events, posted } = stream();
    const log: AgentStreamEvent[] = [];
    let text = "";
    for (let index = 0; index < 2000; index++) {
      text += "中文";
      events.append("session", log, { phase: "reasoning", id: "thinking", text, replace: true });
      events.append("session", log, { phase: "tool", id: "parallel", text: String(index), replace: true });
      events.append("session", log, { phase: "status", text: "", usage: { outputTokens: index } });
      events.flush();
    }
    expect(log).toHaveLength(3);
    expect(log[0]?.text).toBe(text);
    expect(log[2]?.usage?.outputTokens).toBe(1999);
    const wireText = posted.reduce((sum, message) => sum + (message.type === "agentEvent" ? message.event.text.length : 0), 0);
    expect(wireText).toBeLessThan(15_000);
  });

  it("retains append deltas across interleaved status events and limits live text", () => {
    const { events } = stream();
    const log: AgentStreamEvent[] = [];
    events.append("session", log, { phase: "message", id: "m", text: "first" });
    events.append("session", log, { phase: "status", text: "", usage: { inputTokens: 10 } });
    events.append("session", log, { phase: "message", id: "m", text: " second" });
    events.append("session", log, { phase: "status", text: "", usage: { outputTokens: 20 } });
    expect(log[0]?.text).toBe("first second");
    expect(log[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    events.dispose();
    const bounded = new AgentEventStream({ activeSessionId: () => "other", disposed: () => false, post: () => {}, maxTextLength: () => 12 });
    const boundedLog: AgentStreamEvent[] = [];
    bounded.append("session", boundedLog, { phase: "tool", id: "t", text: "a".repeat(100) });
    bounded.append("session", boundedLog, { phase: "tool", id: "t", text: "b".repeat(100) });
    expect(boundedLog[0]?.text).toBe(`${"a".repeat(12)}\n... output truncated ...`);
  });

  it("cancels its timer and drops buffered events on dispose", () => {
    const cancel = vi.fn();
    const posted: ConversationWebviewResponse[] = [];
    const events = new AgentEventStream({
      activeSessionId: () => "session",
      disposed: () => false,
      post: (message) => { posted.push(message); },
      schedule: () => 7 as never,
      cancelSchedule: cancel
    });
    events.append("session", [], { phase: "message", text: "pending" });
    events.dispose();
    expect(cancel).toHaveBeenCalledWith(7);
    events.flush();
    expect(posted).toEqual([]);
  });
});
