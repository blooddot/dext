import { describe, expect, it } from "vitest";
import { inlineInsertion, invocationInsertion } from "../src/webview/inputInsertion.js";

describe("Unified input insertion", () => {
  it("keeps file references inline with workflow values", () => {
    expect(inlineInsertion("target=value", 12, 12, 'ref.file("src/a.ts")')).toEqual({
      text: ' ref.file("src/a.ts")',
      cursorOffset: 21
    });
    expect(inlineInsertion("target=, next=True", 7, 7, 'ref.file("src/a.ts")')).toEqual({
      text: 'ref.file("src/a.ts")',
      cursorOffset: 20
    });
  });

  it("uses existing argument whitespace and avoids padding before terminators", () => {
    const source = "code.review(target=)";
    const cursor = source.indexOf(")");
    expect(inlineInsertion(source, cursor, cursor, 'ref.file("src/a.ts")')).toEqual({
      text: 'ref.file("src/a.ts")',
      cursorOffset: 20
    });
  });

  it("places method-list invocations on line boundaries", () => {
    expect(invocationInsertion("chat(message=\"first\")", 21, 21, "chat(message=\"next\")"))
      .toEqual({ text: "\nchat(message=\"next\")", cursorOffset: 21 });
  });
});
