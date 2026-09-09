import { describe, expect, it } from "vitest";
import quality from "./fixtures/completionQuality.json";
import sequences from "./fixtures/completionAdaptation.json";
import { completionCandidate, scoreCompletion } from "../src/core/completionCandidate.js";
describe("completion evaluation fixtures", () => {
  it("covers at least thirty distinct complete-edit expectations and six task sequences", () => {
    expect(quality.length).toBeGreaterThanOrEqual(30); expect(new Set(quality.map((c) => c.id)).size).toBe(quality.length);
    expect(sequences.length).toBeGreaterThanOrEqual(6);
    for (const test of quality) expect(["valid", "empty"]).toContain(scoreCompletion(test, completionCandidate(test.reply, test), test.expected));
    for (const sequence of sequences) expect(quality.some((c) => c.id === sequence.later)).toBe(true);
  });
  it("rejects wrong surrounding expressions even when they mention an expected field", () => {
    const test = quality.find((c) => c.id === "line-item-total")!;
    expect(scoreCompletion(test, completionCandidate("quantity + item.unitPrice", test), test.expected)).toBe("wrong");
    expect(scoreCompletion(test, undefined, test.expected)).toBe("missed");
    const empty = quality.find((c) => c.id === "no-completion-statement")!;
    expect(scoreCompletion(empty, completionCandidate("extra()", empty), empty.expected)).toBe("wrong");
  });
});
