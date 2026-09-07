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
  it("inserts copied files as separate refs with a typing boundary", () => {
    const files: ClipboardReadResult = {
      text: "C:\\repo\\index.html\r\nC:\\repo\\image.png",
      contextAttached: false,
      fileReferences: [
        { expression: "@index.html", payload: "index.html" },
        { expression: "@image.png", payload: "image.png" }
      ]
    };
    expect(codeReferencePasteText("Review", 6, 6, files)).toBe(" @index.html @image.png ");
    expect(codeReferencePasteText("Review these later", 7, 12, files)).toBe("@index.html @image.png");
  });

  it("pastes a single copied file path into an existing ref.file argument", () => {
    const source = 'ref.file("")';
    expect(codeReferencePasteText(source, 10, 10, {
      text: "C:\\repo\\index.html",
      contextAttached: false,
      fileReferences: [{ expression: "@index.html", payload: "index.html" }]
    })).toBe("index.html");
  });

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

  it("leaves a separator after a pasted terminal reference", () => {
    const terminalReference: ClipboardReadResult = {
      text: "copied terminal output",
      contextAttached: false,
      codeReference: {
        expression: "@.dext-global/attachments/terminal-1234567890abcdef.log",
        payload: ".dext-global/attachments/terminal-1234567890abcdef.log"
      }
    };
    expect(codeReferencePasteText("", 0, 0, terminalReference))
      .toBe("@.dext-global/attachments/terminal-1234567890abcdef.log ");
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
