import { describe, expect, it, vi } from "vitest";
import { runCompletionEvaluation, evaluationSampleCount, evaluationSequenceContext, type CompletionQualityCase } from "../src/core/completionEvaluation.js";
import { normalizeCompletionSettings } from "../src/core/completionProvider.js";
import type { CompletionBackend, CompletionResult } from "../src/core/completionBackend.js";

const settings = normalizeCompletionSettings({ endpoint: "https://fixture.invalid", model: "fixture" });
const cases: CompletionQualityCase[] = [{ id: "a", category: "field", languageId: "typescript", prefix: "const n = item.", suffix: ";", reply: "total", expected: ["const n = item.total;"] }];
function backend(result: CompletionResult = { outcome: "success", text: "total" }) {
  return { generate: vi.fn(async () => result) } as unknown as CompletionBackend;
}
describe("shared completion evaluation", () => {
  it("scores whole edits and counts every attempted request including failures", async () => {
    const report = await runCompletionEvaluation({ backend: backend(), settings, cases, kind: "quality", repeat: 3 });
    expect(report.attempted).toBe(3); expect(report.summaries[0]?.counts.valid).toBe(3);
    const failed = await runCompletionEvaluation({ backend: backend({ outcome: "error", text: "" }), settings, cases, kind: "quality", repeat: 3 });
    expect(failed.summaries[0]?.counts.failed).toBe(3);
  });
  it.each(["unauthenticated", "rate_limited", "unavailable"] as const)("stops %s without retrying the remaining batch", async (outcome) => {
    const report = await runCompletionEvaluation({ backend: backend({ outcome, text: "" }), settings, cases, kind: "quality", repeat: 3 });
    expect(report.stopReason).toBe(outcome); expect(report.attempted).toBe(1); expect(report.planned).toBe(3);
  });
  it("stops a repeatedly failing endpoint rather than exhausting the full request budget", async () => {
    const report = await runCompletionEvaluation({ backend: backend({ outcome: "error", text: "" }), settings, cases, kind: "performance", repeat: 100 });
    expect(report.attempted).toBe(3); expect(report.planned).toBe(100); expect(report.stopReason).toBe("consecutive_errors");
    expect(report.summaries[0]?.counts.failed).toBe(3);
  });
  it("counts thrown backend failures without exposing their message", async () => {
    const client = backend(); vi.spyOn(client, "generate").mockRejectedValue(new Error("secret-token"));
    const report = await runCompletionEvaluation({ backend: client, settings, cases, kind: "performance", repeat: 100 });
    expect(report.attempted).toBe(3); expect(report.stopReason).toBe("consecutive_errors");
    expect(report.summaries[0]?.counts.failed).toBe(3); expect(JSON.stringify(report)).not.toContain("secret-token");
  });
  it("propagates cancellation and starts no further model requests", async () => {
    const controller = new AbortController(); const client = backend();
    const generate = vi.spyOn(client, "generate").mockImplementation(async (_settings, _request, signal) => {
      expect(signal).toBe(controller.signal); controller.abort(); return { outcome: "cancelled", text: "" };
    });
    const report = await runCompletionEvaluation({ backend: client, settings, cases, kind: "performance", repeat: 100, signal: controller.signal });
    expect(generate).toHaveBeenCalledTimes(1); expect(report.stopReason).toBe("cancelled");
    await runCompletionEvaluation({ backend: client, settings, cases, kind: "quality", repeat: 3, signal: controller.signal });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized or invalid batches before generating", async () => {
    expect(() => evaluationSampleCount({ repeat: 1001, kind: "quality", cases })).toThrow();
    const client = backend();
    const generate = vi.spyOn(client, "generate");
    await expect(runCompletionEvaluation({ backend: client, settings, cases, kind: "adaptation", repeat: 3,
      sequences: [{ id: "bad", root: "r", scope: "s", later: "missing", feedback: [] }] })).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });
  it("rotates independent adaptation modes and retains restart/clear isolation", async () => {
    const report = await runCompletionEvaluation({ backend: backend(), settings, cases, kind: "adaptation", repeat: 3,
      sequences: [{ id: "restart", root: "r", scope: "s", later: "a", feedback: Array<string>(24).fill("retained"), restart: true }] });
    expect(report.attempted).toBe(9);
    expect(report.rows.map((row) => row.mode)).toEqual(["off", "session", "workspace", "session", "workspace", "off", "workspace", "off", "session"]);
    expect(report.limitation).toContain("does not establish learning benefit");
  });
  it("restores saved example references and excludes changed, ignored, cleared or other-project sources", async () => {
    const sequence = { id: "references", root: "project", scope: "http/account", later: "a", feedback: Array<string>(24).fill("retained"), restart: true,
      sources: [{ path: "previous.ts", text: "const oldTotal = item.total;" }] };
    expect((await evaluationSequenceContext(sequence, "workspace", "fixture", cases[0]!)).examples).toHaveLength(1);
    expect((await evaluationSequenceContext(sequence, "session", "fixture", cases[0]!)).examples).toHaveLength(0);
    expect((await evaluationSequenceContext(sequence, "off", "fixture", cases[0]!)).examples).toHaveLength(0);
    for (const changed of [{ ...sequence, clear: true }, { ...sequence, evaluateRoot: "other" },
      { ...sequence, sources: [{ ...sequence.sources[0]!, currentText: "const total = item.amount;" }] },
      { ...sequence, sources: [{ ...sequence.sources[0]!, ignored: true }] }]) {
      expect((await evaluationSequenceContext(changed, "workspace", "fixture", cases[0]!)).examples).toHaveLength(0);
    }
  });
});
