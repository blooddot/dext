import { describe, expect, it } from "vitest";
import { EDITOR_TAB_RESTORE_VERSION, editorTabKey, editorTabTitle, isRecoverableEditorTabKey, parseEditorTabKey } from "../src/editorTabTypes.js";
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

  it("records the on-screen target of a tab that holds several of them", () => {
    // The API browser keeps one key for the list and every definition, so the shown resource has to
    // be part of the persisted state.
    const state = createEditorTabState("dext.editor:api", { page: "detail", resourceId: "Task.Query" });
    expect(state).toMatchObject({ key: "dext.editor:api", page: "detail", resourceId: "Task.Query" });
    expect(restoreEditorTabState(state).state?.resourceId).toBe("Task.Query");

    const list = createEditorTabState("dext.editor:api", { page: "list" });
    expect(list).not.toHaveProperty("resourceId");
    expect(list?.page).toBe("list");
  });

  it("skips a state written by a newer build instead of treating it as the current format", () => {
    const future = restoreEditorTabState({ key: "dext.editor:project", page: "overview", restoreVersion: EDITOR_TAB_RESTORE_VERSION + 1 });
    expect(future.state).toBeUndefined();
    expect(future.error).toContain("newer");
    // An older state stays readable: missing fields keep their defaults.
    expect(restoreEditorTabState({ key: "dext.editor:project", page: "knowledge", restoreVersion: 1 }).state)
      .toMatchObject({ key: "dext.editor:project", page: "knowledge", filters: {} });
  });
});
