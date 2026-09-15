import { describe, expect, it } from "vitest";
import { editorTabKey, editorTabTitle, isRecoverableEditorTabKey, parseEditorTabKey } from "../src/editorTabTypes.js";
import { createEditorTabState, normalizePage, restoreEditorTabState } from "../src/editorTabState.js";

describe("editor tab keys", () => {
  it("round-trips a stable key with a resource id and scope", () => {
    const key = editorTabKey("api", { resourceId: "Task.Query", scope: "C:/ws" });
    expect(isRecoverableEditorTabKey(key)).toBe(true);
    expect(parseEditorTabKey(key)).toEqual({ kind: "api", scope: "C:/ws", resourceId: "Task.Query" });
  });

  it("rejects unknown kinds and free-form titles", () => {
    expect(parseEditorTabKey("dext.editor:unknown")).toBeUndefined();
    expect(parseEditorTabKey("Dext APIs")).toBeUndefined();
    expect(isRecoverableEditorTabKey("dext.editor:project")).toBe(true);
  });

  it("keeps a resource label in the title", () => {
    expect(editorTabTitle("project")).toBe("Dext Project");
    expect(editorTabTitle("api", "Task.Query")).toBe("Dext APIs: Task.Query");
  });
});

describe("editor tab state", () => {
  it("keeps a valid page and falls back to the kind's first page", () => {
    expect(normalizePage("project", "architecture")).toBe("architecture");
    expect(normalizePage("project", "hooks")).toBe("overview");
    // Project must never expose Hooks, Review, or task log pages.
    expect(createEditorTabState("dext.editor:project", { page: "review" })?.page).toBe("overview");
  });

  it("restores a saved page and filters", () => {
    const state = createEditorTabState("dext.editor:api#Task.Query", { page: "detail", filters: { q: "task" } });
    expect(state).toMatchObject({ key: "dext.editor:api#Task.Query", page: "detail", resourceId: "Task.Query", filters: { q: "task" } });
    const restored = restoreEditorTabState(state);
    expect(restored.state).toEqual(state);
  });

  it("reports an invalid state instead of opening an unrelated page", () => {
    expect(restoreEditorTabState({ key: "nope" })).toEqual({ error: "Unknown editor tab key." });
    expect(restoreEditorTabState({ key: "dext.editor:project", page: 3 }).error).toBe("Invalid editor tab state.");
  });
});
