import { describe, expect, it } from "vitest";
import { completionIdentity, HttpCompletionBackend } from "../src/core/completionBackend.js";
import { CompletionCache, CompletionClient, normalizeCompletionSettings } from "../src/core/completionProvider.js";
describe("completion backend identity", () => {
  it("preserves failure classes and cancels before fetching credentials", async () => {
    let calls = 0; const settings = normalizeCompletionSettings({ enabled: true, model: "m", endpoint: "http://localhost" });
    const client = new CompletionClient(async () => { calls++; return new Response("unauthorized", { status: 401 }); });
    const backend = new HttpCompletionBackend(client, async () => undefined);
    expect((await backend.generate(settings, { prefix: "x", suffix: "" })).outcome).toBe("unauthenticated");
    const controller = new AbortController(); controller.abort();
    expect((await backend.generate(settings, { prefix: "x", suffix: "" }, controller.signal)).outcome).toBe("cancelled");
    expect(calls).toBe(1); backend.dispose();
    expect((await backend.generate(settings, { prefix: "x", suffix: "" })).outcome).toBe("unavailable");
    expect(calls).toBe(1);
  });
  it("isolates exact and typed-forward caches by document, language, account and dependency", () => {
    const cache = new CompletionCache();
    const request = { prefix: "let x = ", suffix: "", uri: "file:///a.ts", languageId: "typescript", backendScope: "account-a", dependency: "v1" };
    cache.set(request, "items.length");
    expect(cache.get({ ...request, prefix: request.prefix + "i" })).toBe("tems.length");
    for (const patch of [{ uri: "file:///b.ts" }, { languageId: "python" }, { backendScope: "account-b" }, { dependency: "v2" }]) {
      expect(cache.get({ ...request, ...patch })).toBeUndefined();
      expect(completionIdentity({ ...request, ...patch })).not.toBe(completionIdentity(request));
    }
  });
});
