import { describe, expect, it } from "vitest";
import { assembleContext, type CompletionSnippet } from "../src/core/completionContext.js";
describe("context selection", () => {
  it("shares a fixed budget and prefers definitions over unrelated examples", () => {
    const snippets: CompletionSnippet[] = [
      { uri: "a", version: 1, kind: "example", text: "a".repeat(1000), score: 0.8 },
      { uri: "b", version: 1, kind: "definition", text: "interface User { displayName: string }", score: 1.5 }
    ];
    const result = assembleContext({ prefix: "x".repeat(4000), suffix: "y".repeat(1000) }, snippets, { prefixChars: 4000, suffixChars: 1000 });
    expect(result.prefix.length + result.suffix.length + (result.context?.length ?? 0)).toBeLessThanOrEqual(5000);
    expect(result.context).toContain("displayName"); expect(result.prefix.length).toBeGreaterThanOrEqual(3000);
  });
  it("changes dependency identity when a retrieved definition changes", () => {
    const snippet: CompletionSnippet = { uri: "a", version: 1, kind: "definition", text: "type A = number", score: 1 };
    const request = { prefix: "let x:", suffix: "" }; const settings = { prefixChars: 4000, suffixChars: 1000 };
    expect(assembleContext(request, [snippet], settings).dependency).not.toBe(assembleContext(request, [{ ...snippet, version: 2, text: "type A = string" }], settings).dependency);
  });
});
