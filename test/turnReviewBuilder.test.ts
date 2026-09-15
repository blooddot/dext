import { describe, expect, it } from "vitest";
import { buildTurnReview, reviewCanBeAccepted, reviewChangeKind, reviewChangesFromPatch } from "../src/core/turnReviewBuilder.js";

describe("turn review builder", () => {
  it("classifies created, modified, and deleted files", () => {
    expect(reviewChangeKind({ before: "", after: "new" })).toBe("created");
    expect(reviewChangeKind({ before: "old", after: "" })).toBe("deleted");
    expect(reviewChangeKind({ before: "old", after: "new" })).toBe("modified");
  });

  it("lists each touched file once and keeps a created file created", () => {
    const changes = reviewChangesFromPatch([
      { uri: "src/a.ts", before: "", after: "one" },
      { uri: "src/a.ts", before: "one", after: "two" },
      { uri: "src/b.ts", before: "gone", after: "" },
      { uri: "src/c.ts", before: "same", after: "same" }
    ]);
    expect(changes).toEqual([
      { uri: "src/a.ts", kind: "created" },
      { uri: "src/b.ts", kind: "deleted" }
    ]);
  });

  it("requires acceptance for a development turn but not for Ask", () => {
    expect(buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "agent" }).acceptance).toBe("pending");
    expect(buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "ask" }).acceptance).toBe("not_required");
    expect(buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "code" }).acceptance).toBe("not_required");
  });

  it("refuses acceptance when a fact is missing or a hook failed", () => {
    const review = buildTurnReview({
      runId: "r", sessionId: "s", turnId: "t", mode: "agent",
      changes: [{ uri: "src/a.ts", kind: "modified" }],
      factValidation: [{ kind: "missing", evidence: { path: "src/a.ts" } } as never]
    });
    expect(reviewCanBeAccepted(review)).toBe(false);
    const failed = buildTurnReview({
      runId: "r", sessionId: "s", turnId: "t", mode: "agent",
      hookSummaries: [{ source: "hook", status: "failed" }]
    });
    expect(reviewCanBeAccepted(failed)).toBe(false);
    expect(reviewCanBeAccepted(buildTurnReview({ runId: "r", sessionId: "s", turnId: "t", mode: "agent" }))).toBe(true);
  });
});
