import { PLAN_DOCUMENT_END, PLAN_DOCUMENT_START, stripPlanDocument } from "./planResponse.js";
import type { AgentStreamEvent } from "./types.js";

interface MessageStream {
  /** Raw provider text, including the document that must stay hidden. */
  raw: string;
  /** Text currently rendered for this message, mirroring the sink's state. */
  shown: string;
  /** True once the closing delimiter has streamed. */
  closed: boolean;
  /** True once text after the document has been shown. */
  tail: boolean;
}

export interface PlanDocumentUpdate {
  text: string;
  replace: boolean;
}

/** Keeps one streamed message free of the Plan document it carries. Provider
 * chunks split the delimiters, so the filter accumulates raw text per message
 * id instead of stripping chunks on their own. */
export class PlanDocumentFilter {
  private readonly messages = new Map<string, MessageStream>();

  /** Resets a message to an authoritative snapshot and returns its visible text. */
  start(id: string, snapshot = ""): string {
    const state = this.visible(snapshot);
    this.messages.set(id, { raw: snapshot, shown: state.text, closed: state.closed, tail: state.tail });
    return state.text;
  }

  /** Consumes one chunk. Returns the Process update to render, or undefined
   * while the chunk only extends the hidden document. */
  push(id: string, chunk: string): PlanDocumentUpdate | undefined {
    if (!chunk) return undefined;
    const message = this.messages.get(id) ?? { raw: "", shown: "", closed: false, tail: false };
    this.messages.set(id, message);
    message.raw += chunk;
    // Text after the closing delimiter is ordinary conversation again. Add
    // the separator once, then append chunks without resending the prefix.
    if (message.closed) {
      const prefix = message.tail ? "" : "\n\n";
      message.tail = true;
      message.shown += prefix + chunk;
      return { text: prefix + chunk, replace: false };
    }
    if (!message.raw.includes(PLAN_DOCUMENT_START)) {
      message.shown += chunk;
      return { text: chunk, replace: false };
    }
    const state = this.visible(message.raw);
    message.closed = state.closed;
    message.tail = state.tail;
    if (state.text === message.shown) return undefined;
    message.shown = state.text;
    return { text: state.text, replace: true };
  }

  /** Ends a message with its authoritative text; nothing stays hidden. */
  complete(id: string, text: string): string {
    this.messages.delete(id);
    return stripPlanDocument(text, true);
  }

  private visible(raw: string): { text: string; closed: boolean; tail: boolean } {
    const start = raw.indexOf(PLAN_DOCUMENT_START);
    if (start < 0) return { text: raw, closed: false, tail: false };
    const end = raw.indexOf(PLAN_DOCUMENT_END, start + PLAN_DOCUMENT_START.length);
    const before = raw.slice(0, start).trim();
    if (end < 0) return { text: before, closed: false, tail: false };
    const after = raw.slice(end + PLAN_DOCUMENT_END.length).trim();
    return { text: [before, after].filter(Boolean).join("\n\n"), closed: true, tail: after.length > 0 };
  }
}

/** Applies the Plan document protocol to one provider's event stream. Every
 * runner delivers AgentStreamEvents through its `onEvent` callback, so
 * guarding that callback at the runtime boundary keeps the rule identical for
 * Codex app-server, the Codex JSONL CLI, Claude, and the DeepSeek Harness
 * instead of teaching each provider mapper about Plan documents. */
export function guardPlanDocumentEvents(sink: (event: AgentStreamEvent) => void): (event: AgentStreamEvent) => void {
  const documents = new PlanDocumentFilter();
  return (event) => {
    if (event.phase !== "message") {
      sink(event);
      return;
    }
    const text = event.text ?? "";
    // Anonymous events have no stream identity to accumulate on; strip what
    // is complete and leave the rest to the provider snapshot.
    if (!event.id) {
      const visible = stripPlanDocument(text, true);
      sink(visible === text ? event : { ...event, text: visible });
      return;
    }
    // `replace` marks an authoritative snapshot: started/updated snapshots
    // reset the stream, completed snapshots already contain the whole reply.
    if (event.replace) {
      sink({ ...event, text: event.done ? documents.complete(event.id, text) : documents.start(event.id, text) });
      return;
    }
    const update = documents.push(event.id, text);
    if (!update) return;
    sink({ ...event, text: update.text, ...(update.replace ? { replace: true } : {}) });
  };
}
