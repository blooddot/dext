import type { FeedbackKind } from "./completionMemory.js";
import { fingerprint } from "./completionContext.js";

export interface AcceptedCompletion {
  id: string; uri: string; root: string; scope: string; key: string;
  offset: number; text: string; original: string; acceptedAt: number;
}
export class CompletionFeedback {
  private readonly observations = new Map<string, AcceptedCompletion>();
  private readonly seen = new Set<string>();
  private readonly suppressed = new Map<string, number>();
  constructor(private readonly report: (entry: AcceptedCompletion, outcome: FeedbackKind) => void, private readonly now = Date.now) {}
  accept(entry: AcceptedCompletion): void {
    if (this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    while (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.observations.set(entry.id, { ...entry, acceptedAt: this.now() });
    while (this.observations.size > 64) this.finish(this.observations.keys().next().value!, "unknown");
  }
  change(uri: string, changes: readonly { offset: number; length: number; text: string }[], undo: boolean): void {
    for (const entry of [...this.observations.values()]) {
      if (entry.uri !== uri) continue;
      for (const change of [...changes].sort((a, b) => b.offset - a.offset)) {
        const end = change.offset + change.length;
        if (end <= entry.offset && !(change.offset === entry.offset && change.length === 0)) entry.offset += change.text.length - change.length;
        else if (change.offset < entry.offset + entry.text.length && end >= entry.offset) {
          const exactUndo = undo && change.offset === entry.offset && change.length === entry.text.length && change.text === entry.original;
          this.finish(entry.id, exactUndo ? "undone" : undo ? "unknown" : "modified"); break;
        }
      }
    }
  }
  mature(read: (entry: AcceptedCompletion) => { text: string; saved: boolean } | undefined): void {
    for (const entry of [...this.observations.values()]) {
      if (this.now() - entry.acceptedAt < 30_000) continue;
      const current = read(entry);
      this.finish(entry.id, current?.saved && current.text === entry.text ? "retained" : "unknown");
    }
  }
  close(uri: string): void { for (const entry of [...this.observations.values()]) if (entry.uri === uri) this.finish(entry.id, "unknown"); }
  private finish(id: string, outcome: FeedbackKind): void {
    const entry = this.observations.get(id); if (!entry) return;
    this.observations.delete(id);
    if (outcome === "undone") {
      this.suppressed.set(this.suppressionKey(entry.scope, entry.uri, entry.offset, entry.text), this.now() + 60_000);
      while (this.suppressed.size > 64) this.suppressed.delete(this.suppressed.keys().next().value!);
    }
    this.report(entry, outcome);
  }
  isSuppressed(scope: string, uri: string, offset: number, text: string): boolean {
    const key = this.suppressionKey(scope, uri, offset, text);
    const until = this.suppressed.get(key) ?? 0;
    if (until <= this.now()) { this.suppressed.delete(key); return false; }
    return true;
  }
  private suppressionKey(scope: string, uri: string, offset: number, text: string): string { return fingerprint(JSON.stringify([scope, uri, offset, text])); }
  clear(): void { this.observations.clear(); this.suppressed.clear(); this.seen.clear(); }
}
