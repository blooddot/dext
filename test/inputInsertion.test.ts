import { describe, expect, it } from "vitest";
import {
  coreInputReferenceInsertion,
  inlineInsertion,
  invocationInsertion,
  normalizeCoreInputStrings
} from "../src/webview/inputInsertion.js";

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
    const source = "ask(input=)";
    const cursor = source.indexOf(")");
    expect(inlineInsertion(source, cursor, cursor, 'ref.file("src/a.ts")')).toEqual({
      text: 'ref.file("src/a.ts")',
      cursorOffset: 20
    });
  });

  it("places method-list invocations on line boundaries", () => {
    const source = "ask(input=\"first\")";
    expect(invocationInsertion(source, source.length, source.length, "ask(input=\"next\")"))
      .toEqual({ text: "\nask(input=\"next\")", cursorOffset: 18 });
  });

  it("upgrades ask and agent input strings to f-strings when a reference is inserted", () => {
    const source = 'agent(input="Implement this: ")';
    const cursor = source.indexOf('"', source.indexOf("input")) + 1 + "Implement this: ".length;
    expect(coreInputReferenceInsertion(source, cursor, cursor, ['ref.file("docs/drag-drop.md")'])).toEqual({
      from: source.indexOf('"', source.indexOf("input")),
      to: source.lastIndexOf('"') + 1,
      text: 'f"Implement this: {ref.file("docs/drag-drop.md")}"',
      cursorOffset: 49
    });
    expect(coreInputReferenceInsertion('ask(input="ref.file(\\"literal.ts\\")")', 15, 15, ['ref.file("x.ts")']))
      .toEqual({
        from: 10,
        to: 36,
        text: 'f"ref. {ref.file("x.ts")} file(\\"literal.ts\\")"',
        cursorOffset: 25
      });
  });

  it("keeps existing f-string references in place and restores a normal string after the last reference is removed", () => {
    const source = 'ask(input=f"Explain {ref.file(\'src/a.ts\')} now")';
    const cursor = source.indexOf(" now");
    expect(coreInputReferenceInsertion(source, cursor, cursor, ['ref.dir("docs")'])?.text)
      .toBe('f"Explain {ref.file(\'src/a.ts\')} {ref.dir("docs")} now"');
    expect(normalizeCoreInputStrings('ask(input=f"Explain {{literal}}")'))
      .toBe('ask(input="Explain {literal}")');
    expect(normalizeCoreInputStrings(source)).toBe(source);
  });
});
