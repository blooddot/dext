import { describe, expect, it } from "vitest";
import { formatProjectReference, projectReferenceOccurrences } from "../src/features/project/knowledge/projectReference.js";


describe("project reference", () => {
  it("keeps visible token identities stable through rename and lossless Unicode serialization", () => {
    const original = { objectId: "module:用户/settings", canonicalName: "Account Settings" };
    const token = formatProjectReference(original);
    expect(projectReferenceOccurrences(`请修改 ${token}`)[0]?.reference).toEqual(original);
    expect(projectReferenceOccurrences(`${token} #OldName[other]`).map((item) => item.reference.objectId)).toEqual([original.objectId, "other"]);
  });

  it("leaves Markdown headings, C#, file ranges, URL fragments and malformed tokens as plain text", () => {
    expect(projectReferenceOccurrences("# Heading\nC# #tag @src/a.ts#L1,1-L2,2 https://host/#Module[id] #bad[%ZZ]" )).toEqual([]);
    expect(projectReferenceOccurrences("#Missing #Module[] ##Module[id]")).toEqual([]);
  });
});
