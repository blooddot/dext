import { describe, expect, it } from "vitest";
import { projectIntentSchema, validateProjectIntent } from "../src/features/project/contracts/projectIntent.js";

const brief = { name: "Example", summary: "An example project", evidence: [{ path: "README.md", line: 1, contentHash: "readme-hash" }] };

describe("project intent", () => {
  it("parses a versioned semantic model with defaults", () => {
    const intent = projectIntentSchema.parse({ schemaVersion: 1, brief, updatedAt: 1 });
    expect(intent.brief.origin).toBe("inferred");
    expect(intent.brief.review).toBe("draft");
    expect(intent.capabilities).toEqual([]);
    expect(intent.brief.evidence).toEqual(brief.evidence);
  });

  it("keeps provenance, review and freshness independent", () => {
    const value = projectIntentSchema.parse({
      schemaVersion: 1,
      brief: { ...brief, origin: "declared", review: "accepted", freshness: "needs_verification", confidence: 1 },
      updatedAt: 4
    });
    expect(value.brief).toMatchObject({ origin: "declared", review: "accepted", freshness: "needs_verification" });
  });

  it("validates context references and flow step references", () => {
    const value = projectIntentSchema.parse({
      schemaVersion: 1,
      brief,
      contexts: [{ id: "api", canonicalName: "Api", dependsOn: ["missing"] }],
      flows: [{ id: "login", canonicalName: "Login", steps: [{ id: "start", label: "Start", nextStepIds: ["end"] }] }],
      updatedAt: 1
    });
    const errors = validateProjectIntent(value);
    expect(errors.map((error) => error.message).join(" ")).toContain("missing intent id 'missing'");
    expect(errors.map((error) => error.message).join(" ")).toContain("missing flow step 'end'");

  });

  it("allows module references that are owned by the separate knowledge model", () => {
    expect(() => projectIntentSchema.parse({
      schemaVersion: 1,
      brief,
      capabilities: [{ id: "search", canonicalName: "Search", moduleIds: ["knowledge-module"] }],
      contexts: [{ id: "core", canonicalName: "Core", moduleIds: ["knowledge-module"] }],
      updatedAt: 1
    })).not.toThrow();
  });

  it("rejects invalid confidence and unknown fields", () => {
    expect(() => projectIntentSchema.parse({ schemaVersion: 1, brief: { ...brief, confidence: 2 }, updatedAt: 1 })).toThrow();
    expect(() => projectIntentSchema.parse({ schemaVersion: 1, brief, updatedAt: 1, unknown: true })).toThrow();
  });
});
