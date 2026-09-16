import { guardPlanDocumentEvents } from "./planDocumentStream.js";
import type { AgentStreamEvent } from "./types.js";

/** Traces persisted before the runtime guard may still carry a Plan document.
 * Replaying them through the live guard keeps every historical renderer honest
 * without duplicating the document rule per provider. */
function visibleTrace(events: readonly AgentStreamEvent[]): AgentStreamEvent[] {
  const visible: AgentStreamEvent[] = [];
  const guard = guardPlanDocumentEvents((event) => visible.push(event));
  for (const event of events) guard(event);
  return visible;
}

/** Prepare a persisted trace for either historical renderer. Stable provider
 * ids are the boundary for deltas; anonymous events remain separate rows. */
export function prepareHistoryTrace(events: readonly AgentStreamEvent[]): AgentStreamEvent[] {
  const rows: AgentStreamEvent[] = [];
  const positions = new Map<string, number>();
  for (const event of visibleTrace(events)) {
    const stream = event.phase === "tool" ? "tool" : event.phase === "message" || event.phase === "reasoning" ? "prose" : undefined;
    const key = stream && event.id ? `${stream}:${event.id}` : undefined;
    const position = key === undefined ? undefined : positions.get(key);
    if (position === undefined) {
      if (key !== undefined) positions.set(key, rows.length);
      rows.push({ ...event });
      continue;
    }
    const previous = rows[position]!;
    rows[position] = { ...previous, ...event, text: event.replace ? event.text : previous.text + event.text, replace: true };
  }
  return rows;
}
