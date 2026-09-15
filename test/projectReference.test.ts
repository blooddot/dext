import { describe, expect, it } from "vitest";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";
import {
  createProjectObjectReference,
  formatProjectReference,
  projectReferenceOccurrences,
  referencesAfterRename,
  renameProjectObject,
  resolveProjectObjectReference,
  searchProjectObjects
} from "../src/core/projectReference.js";

const object = (id: string, canonicalName: string, extra: Record<string, unknown> = {}) => projectObjectSchema.parse({
  id, canonicalName, kind: "module", source: "user", confirmation: "accepted", ...extra
});

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
  it("searches the English canonical name, the Chinese display name, and aliases together", () => {
    const query = object("one", "TaskQuery", { displayName: "任务查询", aliases: ["task-lookup", "查询任务"] });
    const stats = object("two", "TaskStats", { displayName: "任务统计" });
    expect(searchProjectObjects([query, stats], "taskquery").map((item) => item.object.id)).toEqual(["one"]);
    expect(searchProjectObjects([query, stats], "任务查询").map((item) => item.object.id)).toEqual(["one"]);
    expect(searchProjectObjects([query, stats], "task-lookup").map((item) => item.object.id)).toEqual(["one"]);
    expect(searchProjectObjects([query, stats], "任务").map((item) => item.object.id).sort()).toEqual(["one", "two"]);
  });

  it("keeps the stable id and old conversation references valid after a rename", () => {
    const before = object("one", "TaskQuery", { displayName: "任务查询" });
    const reference = createProjectObjectReference(before);
    expect(reference.objectId).toBe("one");
    const after = renameProjectObject(before, { canonicalName: "TaskSearch", displayName: "任务检索" });
    expect(after.id).toBe("one");
    expect(after.canonicalName).toBe("TaskSearch");
    const objects = [after];
    expect(resolveProjectObjectReference(reference, objects)?.id).toBe("one");
    expect(referencesAfterRename([reference], objects).resolved).toBe(1);
    // The previous names stay searchable so existing Input text still resolves.
    expect(searchProjectObjects(objects, "TaskQuery").map((item) => item.object.id)).toEqual(["one"]);
  });

  it("reports references that no longer resolve instead of silently dropping them", () => {
    const reference = createProjectObjectReference(object("gone", "LegacyThing"));
    const result = referencesAfterRename([reference], [object("kept", "KeptThing")]);
    expect(result.resolved).toBe(0);
    expect(result.unresolved).toEqual([reference]);
  });
});
