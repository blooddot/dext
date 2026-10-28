import type { AgentStreamEvent } from "../../../shared/contracts/types.js";

export function agentEventKey(event: AgentStreamEvent): string | undefined {
  if (event.phase === "status" || event.phase === "todo") return event.phase;
  return event.id && (event.phase === "tool" || event.phase === "message" || event.phase === "reasoning")
    ? `${event.phase}:${event.id}` : undefined;
}

/** Provider snapshots update a row even when usage or another tool intervenes.
 * Status/usage and todos are current state, rather than transcript chunks. */
export function appendAgentEvent(
  events: AgentStreamEvent[], positions: Map<string, number>, event: AgentStreamEvent,
  maxTextLength = Infinity
): AgentStreamEvent {
  const key = agentEventKey(event);
  const position = key === undefined ? undefined : positions.get(key);
  const previous = position === undefined ? undefined : events[position];
  let update = event;
  if (previous) {
    update = event.phase === "status"
      ? { ...previous, ...event, text: event.text || previous.text,
        ...(previous.usage || event.usage ? { usage: { ...previous.usage, ...event.usage } } : {}) }
      : event.phase === "todo" ? event
        : { ...previous, ...event, text: event.replace ? event.text : previous.text + event.text, replace: true };
  }
  if (update.text.length > maxTextLength) {
    update = { ...update, text: `${update.text.slice(0, maxTextLength)}\n... output truncated ...`, replace: true };
  }
  if (position !== undefined) events[position] = update;
  else {
    if (key !== undefined) positions.set(key, events.length);
    events.push(update);
  }
  return update;
}

/** Also repairs histories written before row compaction was introduced. */
export function compactAgentEvents(events: readonly AgentStreamEvent[], maxTextLength = Infinity): AgentStreamEvent[] {
  const rows: AgentStreamEvent[] = [];
  const positions = new Map<string, number>();
  for (const event of events) appendAgentEvent(rows, positions, event, maxTextLength);
  return rows;
}
