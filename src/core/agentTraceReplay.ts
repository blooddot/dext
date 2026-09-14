import type { AgentStreamEvent } from "./types.js";

/** Reduce persisted stream deltas to the final state of each tool invocation. */
export function replayableHistoryEvents(events: readonly AgentStreamEvent[]): AgentStreamEvent[] {
  const first = new Map<string, number>();
  const final = new Map<string, AgentStreamEvent>();
  const text = new Map<string, string>();
  for (const [index, event] of events.entries()) {
    if (event.phase !== "tool" || !event.id) continue;
    if (!first.has(event.id)) first.set(event.id, index);
    text.set(event.id, event.replace ? event.text : `${text.get(event.id) ?? ""}${event.text}`);
    final.set(event.id, event);
  }
  return events.flatMap((event, index) => {
    if (event.phase !== "tool" || !event.id) return [event];
    if (first.get(event.id) !== index) return [];
    const lastEvent = final.get(event.id)!;
    return [{ ...event, ...lastEvent, text: text.get(event.id) ?? event.text, replace: true }];
  });
}

export function mergeAgentMessageDeltas(events: readonly AgentStreamEvent[]): AgentStreamEvent[] {
  const merged: AgentStreamEvent[] = [];
  for (const event of events) {
    const previous = merged.at(-1);
    if (previous?.phase === "message" && event.phase === "message" && !previous.userInput && !previous.uiInteraction && !event.userInput && !event.uiInteraction) {
      merged[merged.length - 1] = { ...previous, text: previous.text + event.text, ...(event.done === undefined ? {} : { done: event.done }) };
    } else merged.push(event);
  }
  return merged;
}
