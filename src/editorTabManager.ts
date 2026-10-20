// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { EditorTabManager, createVscodeEditorTabHost, describeEditorTab, wrapVscodeWebviewPanel } from "./platform/editor-tabs/editorTabManager.js";
export type { EditorTabCallbacks, EditorTabDescriptorLike, EditorTabHost, EditorTabHostOptions, EditorTabPanelHandle, OpenEditorTabResult, VscodeWebviewPanelLike, VscodeWindowLike } from "./platform/editor-tabs/editorTabManager.js";
