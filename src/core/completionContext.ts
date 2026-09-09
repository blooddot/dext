import { createHash } from "node:crypto";
import type { CompletionRequest, CompletionSettings } from "./completionProvider.js";
import type { ExampleReference } from "./completionMemory.js";

export interface CompletionSnippet {
  uri: string;
  version: number;
  kind: "definition" | "imports" | "recent" | "example";
  text: string;
  score: number;
  revision?: number;
}
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Shared reference validation/relevance used by background collection and evaluation. */
export function completionExampleSnippet(reference: ExampleReference, text: string, request: CompletionRequest, uri: string, version: number): CompletionSnippet | undefined {
  if (fingerprint(text) !== reference.hash) return undefined;
  const tokens = new Set((request.prefix.slice(-800) + request.suffix.slice(0, 200)).match(/[a-zA-Z_]\w{2,}/g));
  const overlap = (text.match(/[a-zA-Z_]\w{2,}/g) ?? []).filter((word) => tokens.has(word)).length;
  return overlap >= 2 ? { uri, version, kind: "example", text, score: Math.min(1.2, 0.6 + overlap / 20) } : undefined;
}

export function assembleContext(request: CompletionRequest, snippets: readonly CompletionSnippet[], settings: Pick<CompletionSettings, "prefixChars" | "suffixChars">): CompletionRequest {
  const limit = settings.prefixChars + settings.suffixChars;
  const suffix = request.suffix.slice(0, settings.suffixChars);
  // Keep the immediate insertion context before allocating any space to retrieval.
  const reserve = Math.min(request.prefix.length, Math.max(256, Math.floor(settings.prefixChars * 0.75)));
  let remaining = Math.max(0, limit - suffix.length - reserve);
  const selected: CompletionSnippet[] = [];
  const seen = new Set<string>();
  for (const snippet of [...snippets].sort((a, b) => b.score - a.score)) {
    const key = fingerprint(snippet.text);
    if (!remaining || seen.has(key)) continue;
    const text = snippet.text.slice(0, Math.min(remaining, 1200));
    if (!text.trim()) continue;
    selected.push({ ...snippet, text });
    seen.add(key);
    remaining -= text.length;
  }
  const context = selected.map((entry) => `[${entry.kind}]\n${entry.text}`).join("\n");
  const prefixBudget = Math.max(reserve, limit - suffix.length - context.length);
  return { ...request, prefix: request.prefix.slice(-prefixBudget), suffix,
    context: context.slice(0, Math.max(0, limit - suffix.length - Math.min(prefixBudget, request.prefix.length))),
    dependency: fingerprint(selected.map((entry) => `${entry.uri}:${entry.version}:${entry.text}`).join("\n")),
    sources: selected.map((entry) => ({ uri: entry.uri, revision: entry.revision ?? 0, kind: entry.kind })) };
}

/** A deadline retires interest, not the underlying provider work or its slot. */
export class CompletionContextQueue {
  private active = 0;
  private disposed = false;
  private readonly waiting = new Map<string, () => Promise<void>>();
  private readonly running = new Set<string>();
  constructor(private readonly concurrency = 2, private readonly capacity = 16) {}
  schedule(key: string, task: () => Promise<void>): void {
    if (this.disposed || this.running.has(key)) return;
    this.waiting.set(key, task);
    while (this.waiting.size > this.capacity) this.waiting.delete(this.waiting.keys().next().value!);
    this.pump();
  }
  private pump(): void {
    while (!this.disposed && this.active < this.concurrency && this.waiting.size) {
      const [key, task] = this.waiting.entries().next().value!;
      this.waiting.delete(key);
      this.running.add(key);
      this.active++;
      void Promise.resolve().then(task).catch(() => undefined).finally(() => {
        this.active--; this.running.delete(key); this.pump();
      });
    }
  }
  report() { return { running: this.active, queued: this.waiting.size }; }
  dispose(): void { this.disposed = true; this.waiting.clear(); }
}
