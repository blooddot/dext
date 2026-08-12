import { describe, expect, it } from "vitest";
import {
  fileReferenceChipDescriptor
} from "../src/webview/fileReferenceChip.js";

describe("Shared file reference chip", () => {
  it("uses the same visible and accessible labels for Chat and Code", () => {
    expect(fileReferenceChipDescriptor("review.ts 3-4", "src/review.ts#L3,1-L4,2"))
      .toEqual({
        label: "review.ts 3-4",
        title: "src/review.ts#L3,1-L4,2",
        openLabel: "Open review.ts 3-4",
        removeLabel: "Remove review.ts 3-4"
      });
  });
});
