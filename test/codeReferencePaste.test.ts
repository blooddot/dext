import { describe, expect, it } from "vitest";
import type { ClipboardReadResult } from "../src/webview/clipboardClient.js";
import { codeReferencePasteText } from "../src/webview/codeReferencePaste.js";

const reference: ClipboardReadResult = {
  text: 'ref.file("src/review.ts#L3,5-L4,8")',
  contextAttached: false,
  codeReference: {
    payload: "src/review.ts#L3,5-L4,8",
    expression: 'ref.file("src/review.ts#L3,5-L4,8")'
  }
};

describe("Code reference paste", () => {
  it("inserts the full reference expression into ordinary code", () => {
    expect(codeReferencePasteText("ask(input=)", 10, 10, reference))
      .toBe(reference.codeReference?.expression);
  });

  it("adds inline boundaries when pasting next to natural language", () => {
    expect(codeReferencePasteText("Review this", 11, 11, reference))
      .toBe(` ${reference.codeReference?.expression}`);
    expect(codeReferencePasteText("Review later", 7, 7, reference))
      .toBe(`${reference.codeReference?.expression} `);
  });

  it("uses existing argument whitespace without adding space before a terminator", () => {
    const source = "ask(input=)";
    const cursor = source.indexOf(")");
    expect(codeReferencePasteText(source, cursor, cursor, reference))
      .toBe(reference.codeReference?.expression);
  });

  it("inserts only the payload when the cursor is inside an existing file string", () => {
    const source = 'ask(input=ref.file(""))';
    const cursor = source.indexOf('""') + 1;
    expect(codeReferencePasteText(source, cursor, cursor, reference))
      .toBe(reference.codeReference?.payload);
  });

  it("inserts a quoted payload after an incomplete file call", () => {
    const source = "ask(input=ref.file()";
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
