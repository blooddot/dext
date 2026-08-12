import { describe, expect, it } from "vitest";
import type { ClipboardReadResult } from "../src/webview/clipboardClient.js";
import { codeReferencePasteText } from "../src/webview/codeReferencePaste.js";

const reference: ClipboardReadResult = {
  text: '@file("src/review.ts#L3,5-L4,8")',
  contextAttached: false,
  codeReference: {
    payload: "src/review.ts#L3,5-L4,8",
    expression: '@file("src/review.ts#L3,5-L4,8")'
  }
};

describe("Code reference paste", () => {
  it("inserts the full reference expression into ordinary code", () => {
    expect(codeReferencePasteText("core.code.review(target: )", 25, 25, reference))
      .toBe(reference.codeReference?.expression);
  });

  it("inserts only the payload when the cursor is inside an existing file string", () => {
    const source = 'core.code.review(target: @file(""))';
    const cursor = source.indexOf('""') + 1;
    expect(codeReferencePasteText(source, cursor, cursor, reference))
      .toBe(reference.codeReference?.payload);
  });

  it("inserts a quoted payload after an incomplete file call", () => {
    const source = "core.code.review(target: @file()";
    const cursor = source.indexOf(")");
    expect(codeReferencePasteText(source, cursor, cursor, reference))
      .toBe(`"${reference.codeReference?.payload}"`);
  });

  it("keeps ordinary unmatched clipboard text unchanged", () => {
    expect(codeReferencePasteText("", 0, 0, {
      text: "ordinary",
      contextAttached: false
    })).toBe("ordinary");
  });
});
