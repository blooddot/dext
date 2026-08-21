import { describe, expect, it } from "vitest";
import { inputReferenceProjections } from "../src/core/fileReference.js";
import {
  coreInputReferenceInsertion,
  fileReferenceInsertion,
  inlineInsertion,
  invocationInsertion
} from "../src/webview/inputInsertion.js";

describe("@ reference insertion", () => {
  it("keeps ordinary references inline outside input values", () => {
    expect(inlineInsertion("target=value", 12, 12, 'ref.file("src/a.ts")')).toEqual({
      text: ' ref.file("src/a.ts")', cursorOffset: 21
    });
    expect(invocationInsertion('ask(input="first")', 18, 18, 'ask(input="next")'))
      .toEqual({ text: '\nask(input="next")', cursorOffset: 18 });
  });

  it("stores a dragged input reference as a readable @ token", () => {
    const source = 'agent(input="Implement this: ")';
    const cursor = source.indexOf('"', source.indexOf("input")) + 1 + "Implement this: ".length;
    const edit = coreInputReferenceInsertion(source, cursor, cursor, ['@docs/drag-drop.md']);
    expect(edit?.text).toMatch(/^"Implement this: /);
    expect(edit?.text).not.toContain('f"');
    expect(edit?.text).not.toContain("ref.file(");
    expect(edit?.text).toContain("@docs/drag-drop.md");
    expect(inputReferenceProjections(edit?.text ?? "")).toMatchObject([
      { reference: { kind: "file", payload: "docs/drag-drop.md" } }
    ]);
  });

  it("inserts at the cursor in an external triple-quoted input variable", () => {
    const source = 'input = """Explain this code\n"""\nagent(input=input)';
    const cursor = source.indexOf("\n");
    const edit = fileReferenceInsertion(source, cursor, cursor, ['@src/pathx.py#L55,1-L66,32']);
    const finalSource = `${source.slice(0, edit.from)}${edit.text}${source.slice(edit.to)}`;
    expect(edit.from).toBe(cursor);
    expect(finalSource).toContain('input = """Explain this code @src/pathx.py#L55,1-L66,32\n"""');
    expect(finalSource).toContain("agent(input=input)");
    expect(finalSource).not.toContain('f"');
    expect(finalSource).not.toContain("ref.file(");
    expect(inputReferenceProjections(finalSource)[0]?.reference.payload).toBe("src/pathx.py#L55,1-L66,32");
  });

  it("creates a normal quoted input for an unfinished ask/agent call", () => {
    const edit = coreInputReferenceInsertion("ask(input=)", 10, 10, ['@a.ts']);
    expect(edit?.text).toMatch(/^"/);
    expect(edit?.text).not.toContain('f"');
    expect(inputReferenceProjections(edit?.text ?? "")[0]?.reference.payload).toBe("a.ts");
    expect(edit?.text).toContain("@a.ts ");
  });

  it("leaves a separator after an attachment inserted at the end of chat input", () => {
    const edit = fileReferenceInsertion("", 0, 0, ["@.dext/attachments/screenshot.png"]);
    expect(edit).toMatchObject({ text: "@.dext/attachments/screenshot.png ", cursorOffset: 34 });
    expect(inputReferenceProjections(edit.text)).toEqual([{
      reference: {
        kind: "file",
        start: 0,
        end: 33,
        expression: "@.dext/attachments/screenshot.png",
        payload: ".dext/attachments/screenshot.png"
      },
      interpolationStart: 0,
      interpolationEnd: 33
    }]);
  });
});
