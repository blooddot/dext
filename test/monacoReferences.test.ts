import { describe, expect, it } from "vitest";
import { ReferenceProjection } from "../src/webview/monacoReferences.js";

describe("Monaco reference source mapping", () => {
  it("projects mixed @ and # tokens atomically without expanding Project knowledge", () => {
    const source = 'agent(input="修改 #TaskQuery[module%3Aone]，参考 @src/a.ts#L2,1-L3,2")';
    const projection = new ReferenceProjection();
    const view = projection.encode(source);
    const references = projection.references(view);
    expect(references.map((item) => item.reference.kind)).toEqual(["project", "file"]);
    expect(references[0]?.reference).toMatchObject({ payload: "module:one", label: "#TaskQuery" });
    expect(projection.decode(view)).toBe(source);
    const first = references[0]!;
    expect(projection.decode(view.slice(0, first.viewFrom) + view.slice(first.viewTo))).toBe(source.replace("#TaskQuery[module%3Aone]", ""));
    expect(projection.decode(view)).toBe(source); // Native undo restores the original token.
  });
  const source = 'agent(input="中😀 @src/界面/main.ts#L12,5-L20,6 和 @other/main.ts\n@.dext-global/attachments/test.png")';
  it("round trips Unicode, ranges and identical filenames without persisting view markers", () => {
    const projection = new ReferenceProjection(); const view = projection.encode(source);
    expect(projection.decode(view)).toBe(source);
    const refs = projection.references(view);
    expect(refs).toHaveLength(3);
    expect(refs.map(ref => ref.reference.payload)).toEqual(["src/界面/main.ts#L12,5-L20,6", "other/main.ts", ".dext-global/attachments/test.png"]);
    for (let i = 0; i <= view.length; i++) expect(projection.toView(view, projection.toSource(view, i))).toBe(i);
    for (const ref of refs) {
      expect(ref.viewTo - ref.viewFrom).toBe(1);
      expect(projection.toView(view, ref.sourceFrom + 3, "left")).toBe(ref.viewFrom);
      expect(projection.toView(view, ref.sourceFrom + 3, "right")).toBe(ref.viewTo);
    }
  });
  it("retains identities when native undo restores old characters after another reference is inserted", () => {
    const projection = new ReferenceProjection(); const original = projection.encode(source);
    const replacement = projection.encode("@new/main.ts");
    const first = projection.references(original)[0]!;
    const edited = original.slice(0, first.viewFrom) + replacement + original.slice(first.viewTo);
    expect(projection.decode(edited)).toBe(source.slice(0, first.sourceFrom) + "@new/main.ts" + source.slice(first.sourceTo));
    expect(projection.decode(original)).toBe(source);
  });
  it("treats user private-use characters as literal text, including previously allocated markers", () => {
    const projection = new ReferenceProjection(); const marker = projection.encode("@src/a.ts");
    const literal = `literal ${marker} @src/b.ts`;
    expect(projection.decode(projection.encode(literal))).toBe(literal);
    expect(projection.decode(marker)).toBe("@src/a.ts");
  });
  it("keeps native multi-range and find replacement operations reversible", () => {
    const projection = new ReferenceProjection(); const original = projection.encode(source);
    let edited = original;
    for (const ref of projection.references(original).reverse()) edited = edited.slice(0, ref.viewFrom) + "replacement" + edited.slice(ref.viewTo);
    expect(projection.decode(edited)).toBe('agent(input="中😀 replacement 和 replacement\nreplacement")');
    expect(projection.decode(original)).toBe(source);
  });
});
