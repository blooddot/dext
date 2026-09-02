import { describe, expect, it } from "vitest";
import { PLAN_DOCUMENT_END, PLAN_DOCUMENT_START, splitPlanResponse } from "../src/core/planResponse.js";

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
});
