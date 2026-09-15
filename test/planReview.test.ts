import { describe, expect, it } from "vitest";
import {
  aggregatePlanChanges,
  appendPlanReviewRun,
  associatePlanChanges,
  buildPlanReview,
  canFinalizePlanReview,
  finalizePlanReview,
  pendingAcceptanceCount,
  planReviewSummary,
  type PlanTaskAssociation
} from "../src/core/planReview.js";
import { buildTurnReview } from "../src/core/turnReviewBuilder.js";
import { renderPlanReview } from "../src/webview/planReviewView.js";

const turn = (runId: string, uris: string[]) => buildTurnReview({
  runId, sessionId: "s", turnId: `t-${runId}`, mode: "plan",
  changes: uris.map((uri) => ({ uri, kind: "modified" as const }))
});

describe("plan review", () => {
  it("summarizes reviews without forcing shared changes into a task", () => {
    const review = buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "plan", changes: [{ uri: "a.ts", kind: "modified" }] });
    expect(planReviewSummary(buildPlanReview("r", "v1", [review], ["shared.ts"]))).toEqual({ changedFiles: 1, failedHooks: 0, pendingAcceptance: 1 });
  });

  it("accumulates multiple rounds of the same Build", () => {
    let review = buildPlanReview("build-1", "plan-v2", [turn("r1", ["a.ts"])], [], { attempt: 1 });
    review = appendPlanReviewRun(review, turn("r2", ["b.ts"]));
    expect(review.reviews).toHaveLength(2);
    expect(aggregatePlanChanges(review).map((change) => change.uri)).toEqual(["a.ts", "b.ts"]);
    expect(review.runId).toBe("build-1");
  });

  it("separates shared and unattributed changes from proven task groups", () => {
    const associations: PlanTaskAssociation[] = [
      { taskId: "plan-1", taskText: "A", changes: [{ uri: "shared.ts", kind: "modified" }, { uri: "only-a.ts", kind: "modified" }] },
      { taskId: "plan-2", taskText: "B", changes: [{ uri: "shared.ts", kind: "modified" }, { uri: "only-b.ts", kind: "created" }] }
    ];
    const review = associatePlanChanges(buildPlanReview("build-1", "v1", [turn("r1", ["shared.ts", "only-a.ts", "only-b.ts", "orphan.ts"])]), associations);
    expect(review.taskGroups.map((group) => group.taskId)).toEqual(["plan-1", "plan-2"]);
    expect(review.sharedChanges.map((change) => change.uri)).toEqual(["shared.ts"]);
    expect(review.noTaskIdChanges.map((change) => change.uri)).toEqual(["orphan.ts"]);
  });

  it("finalizes once a round produced a review and records pending acceptance", () => {
    const review = buildPlanReview("build-1", "v1", [turn("r1", ["a.ts"])]);
    expect(canFinalizePlanReview(review)).toBe(true);
    expect(pendingAcceptanceCount(review)).toBe(1);
    const finalized = finalizePlanReview(review, "accepted", 7);
    expect(finalized).toMatchObject({ acceptance: "accepted", finalizedAt: 7 });
    expect(canFinalizePlanReview(buildPlanReview("build-2", "v1", []))).toBe(false);
  });

  it("renders task groups with shared and unattributed changes separate", () => {
    const associations: PlanTaskAssociation[] = [
      { taskId: "plan-1", taskText: "A", changes: [{ uri: "shared.ts", kind: "modified" }] },
      { taskId: "plan-2", taskText: "B", changes: [{ uri: "shared.ts", kind: "modified" }] }
    ];
    const review = associatePlanChanges(buildPlanReview("build-1", "v9", [turn("r1", ["shared.ts", "orphan.ts"])]), associations);
    const html = renderPlanReview(review, { expanded: true });
    expect(html).toContain('data-plan-version="v9"');
    expect(html).toContain('data-build-run="build-1"');
    expect(html).toContain('data-task-id="plan-1"');
    expect(html).toContain("Shared across tasks");
    expect(html).toContain("Unattributed changes");
    expect(html).toContain("data-plan-review-accept=");
  });
});
