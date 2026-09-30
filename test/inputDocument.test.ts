import { describe, expect, it } from "vitest";
import { inputReferenceProjections } from "../src/core/fileReference.js";
import { coreInputReferenceInsertion, fileReferenceInsertion } from "../src/webview/inputInsertion.js";

describe("Dext input document", () => {
  it("does not treat free text as a semantic ask/agent input", () => {
    const source = "Please explain this";
    const cursor = "Please".length;
    expect(coreInputReferenceInsertion(source, cursor, cursor, ["@src/a.ts"])).toBeUndefined();
    // Outside an input value the drop stays a plain inline token.
    expect(fileReferenceInsertion(source, cursor, cursor, ["@src/a.ts"]))
      .toMatchObject({ from: cursor, to: cursor, text: " @src/a.ts" });
  });

  it("accepts an explicit ask(input=...) value as the semantic input", () => {
    const source = 'ask(input="Please explain this")';
    const cursor = source.indexOf("Please") + "Please".length;
    const edit = coreInputReferenceInsertion(source, cursor, cursor, ["@src/a.ts"]);
    expect(edit).toBeDefined();
    const finalSource = `${source.slice(0, edit!.from)}${edit!.text}${source.slice(edit!.to)}`;
    expect(finalSource).toBe('ask(input="Please @src/a.ts explain this")');
    expect(inputReferenceProjections(finalSource).map((reference) => reference.reference.payload)).toEqual(["src/a.ts"]);
  });

  it("keeps the cursor after an inserted reference token", () => {
    const source = 'agent(input="")';
    const cursor = source.indexOf('""') + 1;
    const edit = fileReferenceInsertion(source, cursor, cursor, ["@src/a.ts"]);
    expect(edit.text).toContain("@src/a.ts");
    expect(edit.cursorOffset).toBeGreaterThan("@src/a.ts".length);
    expect(inputReferenceProjections(edit.text)[0]?.reference.payload).toBe("src/a.ts");
  });
});
