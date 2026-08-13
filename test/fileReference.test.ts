import { describe, expect, it } from "vitest";
import {
  compactFileReferenceLabel,
  formatDextFileReference,
  parseFileReference
} from "../src/core/fileReference.js";

describe("Dext file references", () => {
  it("formats a workspace-relative selection with one-based coordinates", () => {
    expect(formatDextFileReference("src\\review.ts", {
      start: { line: 2, character: 4 },
      end: { line: 3, character: 7 }
    })).toEqual({
      payload: "src/review.ts#L3,5-L4,8",
      expression: 'ref.file("src/review.ts#L3,5-L4,8")'
    });
  });

  it("splits an optional range fragment while preserving old file paths", () => {
    expect(parseFileReference("src/review.ts#L3,5-L4,8")).toEqual({
      path: "src/review.ts",
      range: {
        start: { line: 2, character: 4 },
        end: { line: 3, character: 7 }
      }
    });
    expect(parseFileReference("src/review.ts")).toEqual({ path: "src/review.ts" });
  });

  it("rejects reversed ranges and treats invalid fragments as a plain path", () => {
    expect(() => parseFileReference("src/review.ts#L4,1-L3,1")).toThrow("range start");
    expect(parseFileReference("src/review.ts#L0,1-L1,1"))
      .toEqual({ path: "src/review.ts#L0,1-L1,1" });
  });

  it("formats compact basename labels with optional line ranges", () => {
    expect(compactFileReferenceLabel("bext/strategy/FundGridStrategy.py#L395,1-L405,2"))
      .toBe("FundGridStrategy.py 395-405");
    expect(compactFileReferenceLabel("bext/strategy/FundGridStrategy.py#L395,1-L395,8"))
      .toBe("FundGridStrategy.py 395");
    expect(compactFileReferenceLabel("bext/strategy/FundGridStrategy.py"))
      .toBe("FundGridStrategy.py");
  });
});
