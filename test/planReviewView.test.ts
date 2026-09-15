import { describe, expect, it } from "vitest";
import { aggregatePlanChanges, appendPlanReviewRun, associatePlanChanges, buildPlanReview, finalizePlanReview, type PlanTaskAssociation } from "../src/core/planReview.js";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";
import { renderPlanReview } from "../src/webview/planReviewView.js";

const turn = (runId: string, uris: string[]) => buildTurnReview({
  runId, sessionId: "s", turnId: `t-${runId}`, mode: "plan",
  changes: uris.map((uri) => ({ uri, kind: "modified" as const }))
});

describe("plan review view", () => {
  it("groups changes by proven task and keeps untied changes separate", () => {
    const associations: PlanTaskAssociation[] = [
      { taskId: "plan-1", taskText: "Implement storage", changes: [{ uri: "src/store.ts", kind: "created" }] },
      { taskId: "plan-2", taskText: "Wire the UI", changes: [{ uri: "src/ui.ts", kind: "modified" }] }
    ];
    const review = associatePlanChanges(
      buildPlanReview("build-1", "v1", [turn("r1", ["src/store.ts", "src/ui.ts", "orphan.ts"])]),
      associations
    );
    const html = renderPlanReview(review);
    expect(html).toContain('data-task-id="plan-1"');
    expect(html).toContain("Implement storage");
    expect(html).toContain('data-task-id="plan-2"');
    expect(html).toContain("Wire the UI");
    expect(html).toContain('data-plan-review-group="Unattributed changes"');
    expect(html).toContain("orphan.ts");
  });

  it("lists a change two tasks genuinely share instead of assigning it to one", () => {
    const shared: PlanTaskAssociation[] = [
      { taskId: "plan-1", taskText: "A", changes: [{ uri: "shared.ts", kind: "modified" }] },
      { taskId: "plan-2", taskText: "B", changes: [{ uri: "shared.ts", kind: "modified" }] }
    ];
    const review = associatePlanChanges(buildPlanReview("build-1", "v1", [turn("r1", ["shared.ts"])]), shared);
    const html = renderPlanReview(review);
    expect(html).toContain('data-plan-review-group="Shared across tasks"');
    expect(html).toContain("shared.ts");
    expect(html).not.toContain('data-plan-review-group="Unattributed changes"');
  });

  it("accumulates every round of one Build into a single summary", () => {
    let review = buildPlanReview("build-1", "v2", [turn("r1", ["a.ts"])]);
    review = appendPlanReviewRun(review, turn("r2", ["b.ts", "a.ts"]));
    const html = renderPlanReview(review, { expanded: true });
    expect(aggregatePlanChanges(review).map((change) => change.uri)).toEqual(["a.ts", "b.ts"]);
    expect(html).toContain("2 rounds");
    expect(html).toContain("2 changed files");
    expect(html).toContain('data-build-run="build-1"');
    expect(html).toContain('data-plan-version="v2"');
  });

  it("offers one build decision while pending and none after it is recorded", () => {
    const pending = renderPlanReview(buildPlanReview("build-1", "v1", [turn("r1", ["a.ts"])]));
    expect(pending).toContain("data-plan-review-accept=");
    expect(pending).toContain("data-plan-review-reject=");
    expect(pending).toContain("awaiting acceptance");
    const decided = renderPlanReview(finalizePlanReview(buildPlanReview("build-1", "v1", [turn("r1", ["a.ts"])]), "accepted", 7));
    expect(decided).not.toContain("data-plan-review-accept=");
    expect(decided).toContain("Decision: accepted");
  });

  it("reports a Build with no traceable task owner instead of inventing one", () => {
    const html = renderPlanReview(buildPlanReview("build-1", "v1", [turn("r1", ["a.ts"])]));
    expect(html).toContain("No change could be reliably tied to a task.");
    expect(html).not.toContain("data-task-id=");
  });
});
