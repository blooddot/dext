import { randomBytes } from "node:crypto";
import type { AgentStreamEvent } from "../../../shared/contracts/types.js";
import type { ConversationWebviewResponse } from "../contracts/protocol.js";
import { DEFAULT_HISTORY_LIMITS } from "../contracts/history.js";
import { agentEventKey, appendAgentEvent } from "../domain/agentEventLog.js";

export interface AgentEventStreamOptions {
  /** The conversation the Webview currently shows. Background conversations
   * keep their events in the execution snapshot instead of the IPC queue. */
  activeSessionId: () => string;
  disposed: () => boolean;
  post: (event: ConversationWebviewResponse) => void;
  /** Called for every event, including background conversations, so the
   * interaction controller can raise a notification. */
  observe?: (sessionId: string, event: AgentStreamEvent) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  flushDelayMs?: number;
  maxTextLength?: () => number;
}

/** Rows the Webview replaces in place by provider id. */
function streamRow(event: AgentStreamEvent): boolean {
  return event.phase === "tool" || event.phase === "message" || event.phase === "reasoning";
}

function streamKey(sessionId: string, event: AgentStreamEvent): string {
  return `${sessionId}:${agentEventKey(event) ?? randomBytes(8).toString("hex")}`;
}

/** Live streams a batch may still remember. Older ones fall back to one full
 * send per frame, which is what they would have done anyway. */
const MAX_REMEMBERED_STREAMS = 64;

/** Compacts the coordinator's per-turn log and batches its IPC updates. */
export class AgentEventStream {
  private pending = new Map<string, AgentStreamEvent>();
  /** Text already sent for a live stream, so a growing log travels as deltas
   * instead of resending the whole text on every frame. */
  private sent = new Map<string, string>();
  private readonly logPositions = new WeakMap<AgentStreamEvent[], Map<string, number>>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AgentEventStreamOptions) {}

  /** Merges a chunk into the turn's logical event log and publishes it. */
  append(sessionId: string, events: AgentStreamEvent[], event: AgentStreamEvent): AgentStreamEvent {
    let positions = this.logPositions.get(events);
    if (!positions) {
      positions = new Map();
      events.forEach((entry, index) => { const key = agentEventKey(entry); if (key !== undefined) positions!.set(key, index); });
      this.logPositions.set(events, positions);
    }
    const configured = this.options.maxTextLength?.() ?? DEFAULT_HISTORY_LIMITS.maxOutputLength;
    const limit = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_HISTORY_LIMITS.maxOutputLength;
    const update = appendAgentEvent(events, positions, event, limit);
    this.publish(sessionId, update);
    return update;
  }

  publish(sessionId: string, event: AgentStreamEvent): void {
    if (this.options.disposed()) return;
    this.options.observe?.(sessionId, event);
    // Keep collecting events for background conversations so they can be
    // replayed when the user returns, but do not flood the Webview IPC queue
    // while another tab is visible. The active conversation is restored via
    // the coordinator's replay batch.
    if (this.options.activeSessionId() !== sessionId) return;
    const key = streamKey(sessionId, event);
    // Providers report the text so far; send only the part the Webview lacks.
    // `replace` stays meaningful for rewrites, which do not extend the row.
    // The last event of a stream repeats the whole text, so a Webview that
    // missed earlier frames recovers without the host tracking its state.
    const sent = streamRow(event) && event.replace && !event.done ? this.sent.get(key) : undefined;
    const delta = sent !== undefined && event.text.startsWith(sent) ? event.text.slice(sent.length) : undefined;
    if (streamRow(event)) this.remember(key, event.text, event.done);
    const wire = delta === undefined ? event : { ...event, text: delta, replace: false };
    this.enqueue(key, wire);
    if (this.timer === undefined) this.timer = this.schedule(() => this.flush(), this.options.flushDelayMs ?? 16);
  }

  /** Batches one frame's events. An append stays an append only while the frame
   * starts with an append; a leading full replacement stays a replacement. */
  private enqueue(key: string, wire: AgentStreamEvent): void {
    const previous = this.pending.get(key);
    if (!previous || previous.phase !== wire.phase || wire.replace || !streamRow(wire)) {
      this.pending.set(key, wire);
      return;
    }
    const text = `${previous.text}${wire.text}`;
    this.pending.set(key, previous.replace ? { ...wire, text, replace: true } : { ...wire, text, replace: false });
  }

  /** Sends everything buffered. The coordinator calls this before a turn is
   * reported finished so no chunk arrives after the final state. */
  flush(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = new Map();
    for (const [pendingKey, pendingEvent] of pending) {
      const separator = pendingKey.indexOf(":");
      this.options.post({ type: "agentEvent", sessionId: pendingKey.slice(0, separator), event: pendingEvent });
    }
  }

  dispose(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.sent.clear();
  }

  private remember(key: string, text: string, done: boolean | undefined): void {
    this.sent.delete(key);
    if (done) return;
    this.sent.set(key, text);
    while (this.sent.size > MAX_REMEMBERED_STREAMS) {
      const oldest = this.sent.keys().next().value;
      if (oldest === undefined) break;
      this.sent.delete(oldest);
    }
  }

  private schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.options.schedule ? this.options.schedule(callback, delayMs) : setTimeout(callback, delayMs);
  }

  private cancel(handle: ReturnType<typeof setTimeout>): void {
    if (this.options.cancelSchedule) this.options.cancelSchedule(handle);
    else clearTimeout(handle);
  }
}
