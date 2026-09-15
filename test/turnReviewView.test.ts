import { describe, expect, it } from "vitest";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";
import { renderTurnReview } from "../src/webview/turnReviewView.js";

const agentReview = (extra: Record<string, unknown> = {}) => buildTurnReview({
  runId: "run-1", sessionId: "s1", turnId: "t1", mode: "agent",
  changes: [{ uri: "src/a.ts", kind: "modified", moduleId: "src/a" }],
  ...extra
});

describe("turn review view", () => {
  it("renders a collapsible review with diff jumps and acceptance controls", () => {
    const html = renderTurnReview(agentReview());
    expect(html).toContain("<details class=\"turn-review\"");
    expect(html).toContain('data-review-diff="src/a.ts"');
    expect(html).toContain("data-review-accept=");
    expect(html).toContain("data-review-reject=");
    expect(html).toContain('data-preset="engineering"');
  });

  it("produces no acceptance card for a pure ask turn", () => {
    const review = buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "ask", changes: [{ uri: "src/a.ts", kind: "modified" }] });
    expect(renderTurnReview(review)).toBe("");
  });

  it("does not render a review when the run produced no file changes", () => {
    const review = buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "agent" });
    expect(renderTurnReview(review)).toBe("");
  });

  it("never turns an unknown or failed hook into a pass", () => {
    const html = renderTurnReview(agentReview({
      hookSummaries: [{ source: "cli", status: "unknown" }, { source: "lint", name: "eslint", status: "failed" }]
    }));
    expect(html).toContain('data-hook-status="unknown"');
    expect(html).toContain('data-hook-status="failed"');
    expect(html).not.toContain("passed");
  });

  it("omits the hook section entirely when no provider exposed hook results", () => {
    expect(renderTurnReview(agentReview())).not.toContain("turn-review-hooks");
  });

  it("switches emphasis between the two presets", () => {
    const engineering = renderTurnReview(agentReview(), { preset: "engineering" });
    const experience = renderTurnReview(agentReview(), { preset: "experience" });
    expect(engineering).toContain("Design decisions");
    expect(experience).toContain("Behavior change");
    expect(experience).toContain('data-preset="experience"');
  });

  it("offers each knowledge draft separately from accepting the code review", () => {
    const html = renderTurnReview(agentReview(), {
      knowledgeSuggestions: [{
        id: "sug-1", kind: "update", proposed: { description: "Owns the queue" },
        evidence: [{ path: "src/a.ts" }], reason: "Module owns queueing", source: "ai"
      }]
    });
    expect(html).toContain('data-adopt-suggestion="sug-1"');
    expect(html).toContain("data-review-accept=");
    // Adopting one draft is a different action from accepting the whole code review.
    expect(html).not.toContain("data-adopt-all");
  });

  it("renders no draft section when the run produced no suggestions", () => {
    expect(renderTurnReview(agentReview())).not.toContain("turn-review-drafts");
  });
});
