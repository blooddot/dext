import { describe, expect, it } from "vitest";
import { PLAN_DOCUMENT_END, PLAN_DOCUMENT_START, PLAN_FALLBACK_CONVERSATION, splitPlanResponse, stripPlanDocument } from "../src/core/planResponse.js";

describe("plan response splitting", () => {
  it("keeps the conversational explanation out of the saved document", () => {
    const response = [
      "I found two affected modules and added verification for both.",
      PLAN_DOCUMENT_START,
      "# Improve plan output\n\n## Tasks\n\n1. Separate the response.",
      PLAN_DOCUMENT_END
    ].join("\n");

    expect(splitPlanResponse(response)).toEqual({
      conversation: "I found two affected modules and added verification for both.",
      document: "# Improve plan output\n\n## Tasks\n\n1. Separate the response."
    });
  });

  it("rejects responses that do not follow the new envelope", () => {
    expect(() => splitPlanResponse("# Legacy plan\n\n## Tasks")).toThrow(/start delimiter/);
    expect(() => splitPlanResponse(`${PLAN_DOCUMENT_START}\n# Incomplete`)).toThrow(/end delimiter/);
  });

  it("keeps a valid document when the provider omits the conversational reply", () => {
    const response = [PLAN_DOCUMENT_START, "# A plan\n\n## Tasks\n\n1. [ ] Do the work", PLAN_DOCUMENT_END].join("\n");

    expect(splitPlanResponse(response)).toEqual({
      conversation: PLAN_FALLBACK_CONVERSATION,
      document: "# A plan\n\n## Tasks\n\n1. [ ] Do the work"
    });
  });

  it("still rejects an empty delimited document", () => {
    expect(() => splitPlanResponse(`${PLAN_DOCUMENT_START}\n${PLAN_DOCUMENT_END}`)).toThrow(/empty document/);
  });

  it("removes the persisted document from Process text", () => {
    expect(stripPlanDocument(`Summary\n${PLAN_DOCUMENT_START}\n# Full plan\n${PLAN_DOCUMENT_END}`)).toBe("Summary");
    expect(stripPlanDocument(`Summary\n${PLAN_DOCUMENT_START}\n# Streaming plan`, true)).toBe("Summary");
    expect(stripPlanDocument("A normal progress update")).toBe("A normal progress update");
  });
});
