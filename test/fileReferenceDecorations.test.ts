import { describe, expect, it } from "vitest";
import { fileReferenceOccurrences } from "../src/webview/fileReferenceDecorations.js";

describe("CodeMirror file reference decorations", () => {
  it("finds complete file references and preserves their full document ranges", () => {
    const first = 'ref.file("src/a.ts#L3,1-L4,2")';
    const second = 'ref.file ( "src/b.ts" )';
    const source = 'ask(input=f"Review {' + first + '} and {' + second + '}")';
    expect(fileReferenceOccurrences(source)).toEqual([
      {
        start: source.indexOf(first),
        end: source.indexOf(first) + first.length,
        expression: first,
        payload: "src/a.ts#L3,1-L4,2"
      },
      {
        start: source.indexOf(second),
        end: source.indexOf(second) + second.length,
        expression: second,
        payload: "src/b.ts"
      }
    ]);
  });

  it("ignores incomplete, empty, and invalid string references", () => {
    expect(fileReferenceOccurrences('ref.file("") ref.file("open" ref.file("bad\\q")')).toEqual([]);
  });

  it("unescapes payloads while retaining the original expression", () => {
    const expression = 'ref.file("src/a\\\\b\\"c.ts")';
    expect(fileReferenceOccurrences(expression)).toEqual([{
      start: 0,
      end: expression.length,
      expression,
      payload: 'src/a\\b"c.ts'
    }]);
  });
});
