import { randomBytes } from "node:crypto";
import type { AgentStreamEvent } from "../../../core/types.js";
import type { ConversationWebviewResponse } from "../contracts/protocol.js";

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
}

/** Attributes, merges and batches streaming agent events. The execution
 * coordinator owns the per-turn event log; this class owns only the IPC side,
 * so a late event can never be delivered as part of another turn. */
export class AgentEventStream {
  private pending = new Map<string, AgentStreamEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: AgentEventStreamOptions) {}

  /** Merges a chunk into the turn's logical event log and publishes it. */
  append(sessionId: string, events: AgentStreamEvent[], event: AgentStreamEvent): AgentStreamEvent {
    const previous = events.at(-1);
    let update = event;
    if (event.phase === "tool" && event.id && previous?.phase === "tool" && previous.id === event.id) {
      update = { ...event, text: event.replace ? event.text : `${previous.text}${event.text}`, replace: true };
      events[events.length - 1] = update;
    } else events.push(event);
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
    const key = event.phase === "tool" && event.id ? `${sessionId}:${event.id}` : `${sessionId}:${randomBytes(8).toString("hex")}`;
    const previous = this.pending.get(key);
    this.pending.set(key, previous && event.phase === "tool"
      ? { ...event, text: event.replace ? event.text : `${previous.text}${event.text}`, replace: true }
      : event);
    if (this.timer === undefined) this.timer = this.schedule(() => this.flush(), this.options.flushDelayMs ?? 16);
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
  }

  private schedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.options.schedule ? this.options.schedule(callback, delayMs) : setTimeout(callback, delayMs);
  }

  private cancel(handle: ReturnType<typeof setTimeout>): void {
    if (this.options.cancelSchedule) this.options.cancelSchedule(handle);
    else clearTimeout(handle);
  }
}
