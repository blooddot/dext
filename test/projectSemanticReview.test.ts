import { describe, expect, it } from "vitest";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";
import { mergeProjectIntentItems, refreshSemanticFreshness, reviewProjectDiagramItem, reviewProjectIntentItem, createSemanticReviewRecord } from "../src/core/projectSemanticReview.js";
import type { ProjectIntent } from "../src/core/projectIntent.js";

const intent = (): ProjectIntent => ({
  schemaVersion: 1,
  brief: { name: "Demo", summary: "Demo app", goals: [], runtime: [], audiences: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.7, evidence: [{ path: "README.md", line: 1 }] },
  capabilities: [
    { id: "auth", canonicalName: "Authentication", description: "Login", outcomes: [], contextIds: ["web"], moduleIds: ["auth.ts"], origin: "inferred", review: "draft", freshness: "current", confidence: 0.7, evidence: [{ path: "src/auth.ts", line: 1 }] },
    { id: "session", canonicalName: "Session", description: "Sessions", outcomes: [], contextIds: ["web"], moduleIds: ["session.ts"], origin: "inferred", review: "draft", freshness: "current", confidence: 0.6, evidence: [{ path: "src/session.ts", line: 1 }] }
  ],
  contexts: [{ id: "web", canonicalName: "Web", purpose: "Web boundary", responsibilities: [], moduleIds: [], entryPoints: [], dependsOn: [], relatedContextIds: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.7, evidence: [{ path: "src/web.ts", line: 1 }] }],
  flows: [], terms: [], constraints: [], decisions: [], updatedAt: 1
});

const diagram = (): ProjectDiagram => ({ schemaVersion: 1, id: "architecture", title: "Architecture", kind: "architecture", nodes: [
  { id: "web", label: "Web", role: "context", semanticIds: ["web"], evidence: [{ path: "src/web.ts", line: 1 }] },
  { id: "auth", label: "Auth", role: "module", semanticIds: ["auth"], evidence: [{ path: "src/auth.ts", line: 1 }] }
], relations: [{ id: "web-auth", from: "web", to: "auth", kind: "calls", evidence: [{ path: "src/web.ts", line: 1 }] }], version: 1, updatedAt: 1 });

describe("Project semantic review", () => {
  it("reviews and edits individual Intent items without changing stable ids", () => {
    const updated = reviewProjectIntentItem(intent(), "capabilities", "auth", "accepted", { description: "User sign in" }, 5);
    expect(updated.capabilities[0]).toMatchObject({ id: "auth", description: "User sign in", review: "accepted", freshness: "current" });
    expect(updated.updatedAt).toBe(5);
  });

  it("reviews diagrams, nodes and relations by stable ids", () => {
    const updated = reviewProjectDiagramItem(diagram(), "auth", "accepted", { label: "Authentication" }, 8);
    expect(updated.nodes.find((node) => node.id === "auth")).toMatchObject({ label: "Authentication", review: "accepted" });
    expect(reviewProjectDiagramItem(updated, "web-auth", "rejected", {}, 9).relations[0]!.review).toBe("rejected");
  });

  it("merges semantic items and combines aliases/evidence", () => {
    const updated = mergeProjectIntentItems(intent(), "capabilities", ["auth", "session"], "identity", { canonicalName: "Identity", aliases: ["login"] }, 10);
    expect(updated.capabilities).toHaveLength(1);
    expect(updated.capabilities[0]).toMatchObject({ id: "identity", canonicalName: "Identity", review: "edited" });
    expect(updated.capabilities[0]!.evidence).toHaveLength(2);
  });

  it("marks only evidence-dependent items for verification and preserves review", () => {
    const accepted = reviewProjectIntentItem(intent(), "capabilities", "auth", "accepted", {}, 3);
    const result = refreshSemanticFreshness(accepted, [diagram()], ["src/auth.ts"], 20);
    expect(result.affectedIds).toContain("auth");
    expect(result.intent.capabilities[0]).toMatchObject({ review: "accepted", freshness: "needs_verification" });
    expect(result.proposals).toHaveLength(3); // Intent capability + diagram node + affected diagram.
    expect(result.proposals[0]).toMatchObject({ status: "needs_verification", baseVersion: 3, changedPaths: ["src/auth.ts"] });
    expect(result.intent.brief.freshness).toBe("current");
  });

  it("creates versioned review records for optimistic concurrency", () => {
    expect(createSemanticReviewRecord("auth", "capabilities", "edited", 3, { description: "Updated" }, 4)).toMatchObject({ itemId: "auth", baseVersion: 3, decidedAt: 4, decision: "edited" });
  });
});
