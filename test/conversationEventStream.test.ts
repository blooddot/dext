import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../src/core/types.js";
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
