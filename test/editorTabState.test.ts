import { describe, expect, it } from "vitest";
import { EDITOR_TAB_RESTORE_VERSION, editorTabKey, editorTabTitle, parseEditorTabKey } from "../src/platform/editor-tabs/editorTabTypes.js";
import { createEditorTabState, normalizePage, restoreEditorTabState } from "../src/platform/editor-tabs/editorTabState.js";

describe("editor tab keys", () => {
  it("round-trips a stable key with a resource id and scope", () => {
    const key = editorTabKey("globalResources", { resourceId: "Task.Query", scope: "C:/ws" });

    expect(parseEditorTabKey(key)).toEqual({ kind: "globalResources", scope: "C:/ws", resourceId: "Task.Query" });
  });

  it("rejects unknown kinds and free-form titles", () => {
    expect(parseEditorTabKey("dext.editor:unknown")).toBeUndefined();
    expect(parseEditorTabKey("Dext APIs")).toBeUndefined();
    expect(parseEditorTabKey("dext.editor:globalResources")).toEqual({ kind: "globalResources" });
  });

  it("keeps a resource label in the title", () => {
    expect(editorTabTitle("globalResources")).toBe("Dext Resources");
    expect(editorTabTitle("globalResources", "Task.Query")).toBe("Dext Resources: Task.Query");
  });
});

describe("editor tab state", () => {
  it("keeps a valid page and falls back to the kind's first page", () => {
    expect(normalizePage("globalResources", "detail")).toBe("detail");
    expect(normalizePage("globalResources", "unknown")).toBe("list");
    expect(restoreEditorTabState({ key: "dext.editor:globalResources", page: "detail", filters: { kind: "api" }, restoreVersion: 1 }).state)
      .toMatchObject({ page: "detail", filters: { kind: "api" } });
    expect(createEditorTabState("dext.editor:globalResources", { page: "unknown" })?.page).toBe("list");
  });

  it("restores a saved page and filters", () => {
    const state = createEditorTabState("dext.editor:globalResources#Task.Query", { page: "detail", filters: { q: "task" } });
    expect(state).toMatchObject({ key: "dext.editor:globalResources#Task.Query", page: "detail", resourceId: "Task.Query", filters: { q: "task" } });
    const restored = restoreEditorTabState(state);
    expect(restored.state).toEqual(state);
  });

  it("reports an invalid state instead of opening an unrelated page", () => {
    expect(restoreEditorTabState({ key: "nope" })).toEqual({ error: "Unknown editor tab key." });
    expect(restoreEditorTabState({ key: "dext.editor:globalResources", page: 3 }).error).toBe("Invalid editor tab state.");
  });

  it("records the on-screen target of a tab that holds several of them", () => {
    // The Resources browser keeps one key for the list and every definition, so the shown resource has to
    // be part of the persisted state.
    const state = createEditorTabState("dext.editor:globalResources", { page: "detail", resourceId: "Task.Query" });
    expect(state).toMatchObject({ key: "dext.editor:globalResources", page: "detail", resourceId: "Task.Query" });
    expect(restoreEditorTabState(state).state?.resourceId).toBe("Task.Query");

    const list = createEditorTabState("dext.editor:globalResources", { page: "list" });
    expect(list).not.toHaveProperty("resourceId");
    expect(list?.page).toBe("list");
  });

  it("skips a state written by a newer build instead of treating it as the current format", () => {
    const future = restoreEditorTabState({ key: "dext.editor:globalResources", page: "list", restoreVersion: EDITOR_TAB_RESTORE_VERSION + 1 });
    expect(future.state).toBeUndefined();
    expect(future.error).toContain("newer");
    // An older state stays readable: missing fields keep their defaults.
    expect(restoreEditorTabState({ key: "dext.editor:globalResources", page: "detail", restoreVersion: 1 }).state)
      .toMatchObject({ key: "dext.editor:globalResources", page: "detail", filters: {} });
  });
});
