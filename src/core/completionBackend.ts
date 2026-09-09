import type { CompletionClient, CompletionRequest, CompletionSettings } from "./completionProvider.js";

export type CompletionOutcome = "success" | "empty" | "cancelled" | "truncated" | "unauthenticated" | "rate_limited" | "unavailable" | "error";
export interface CompletionResult {
  outcome: CompletionOutcome;
  text: string;
  reason?: string;
  retryAfterMs?: number;
}
export interface CompletionBackend {
  generate(settings: CompletionSettings, request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  dispose(): void;
}

/** Identity deliberately excludes the cursor's compatible typed-forward version. */
export function completionIdentity(request: CompletionRequest): string {
  return JSON.stringify([request.workspace ?? "", request.uri ?? "", request.languageId ?? "",
    request.backendScope ?? "", request.dependency ?? ""]);
}

export class HttpCompletionBackend implements CompletionBackend {
  private readonly active = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly client: Pick<CompletionClient, "completeResult">, private readonly key: () => Promise<string | undefined>) {}
  async generate(settings: CompletionSettings, request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    if (this.disposed) return { outcome: "unavailable", text: "" };
    if (signal?.aborted) return { outcome: "cancelled", text: "" };
    const controller = new AbortController(); this.active.add(controller);
    const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
    try { return await this.client.completeResult(settings, request, await this.key(), controller.signal); }
    catch { return { outcome: "error", text: "", reason: "Unable to prepare HTTP completion credentials." }; }
    finally { signal?.removeEventListener("abort", cancel); this.active.delete(controller); }
  }
  dispose(): void { this.disposed = true; for (const controller of this.active) controller.abort(); this.active.clear(); }
}
