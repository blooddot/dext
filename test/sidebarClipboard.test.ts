import type * as VSCode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  editor: undefined as VSCode.TextEditor | undefined,
  document: undefined as VSCode.TextDocument | undefined,
  workspace: true,
  clipboard: ""
}));

vi.mock("vscode", () => ({
  window: { get activeTextEditor() { return state.editor; } },
  Uri: { parse: (uri: string) => ({ toString: () => uri }) },
  workspace: {
    getWorkspaceFolder: () => state.workspace ? {} : undefined,
    asRelativePath: (uri: VSCode.Uri) => uri.toString().replace("file:///repo/", ""),
    openTextDocument: async () => state.document,
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback })
  },
  env: { clipboard: {
    readText: async () => state.clipboard,
    writeText: async (text: string) => { state.clipboard = text; }
  } }
}));

import { AttachmentStore } from "../src/attachmentStore.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";

const selectedText = "# 项目说明\n\n保留文本内容。\n";
const payload = "README.md#L2,1-L5,1";
const reference = { expression: `@${payload}`, payload };
let sidebar: DextSidebarProvider;
let post: ReturnType<typeof vi.fn>;
let attachments: AttachmentStore;

beforeEach(() => {
  state.workspace = true;
  state.clipboard = selectedText;
  state.document = {
    uri: { toString: () => "file:///repo/README.md" },
    languageId: "markdown", version: 1, getText: () => selectedText
  } as unknown as VSCode.TextDocument;
  state.editor = {
    document: state.document,
    selection: { isEmpty: false, start: { line: 1, character: 0 }, end: { line: 4, character: 0 } }
  } as VSCode.TextEditor;
  sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  post = vi.fn().mockResolvedValue(undefined);
  attachments = new AttachmentStore();
  Object.assign(sidebar, { attachments, post });
});

async function paste(purpose: "code" | "text" = "code") {
  await (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive({
    type: "clipboardRead", requestId: 1, purpose
  });
}

describe("workspace text selection clipboard references", () => {
  it.each(["markdown", "plaintext", "log", "csv", "tsv", "git-commit", "custom-text", "typescript"])(
    "keeps exact clipboard text and pastes a staged %s reference after editor focus is lost", async (languageId) => {
      Object.assign(state.document!, { languageId });
      await expect(sidebar.copySelectionWithContext()).resolves.toBe(selectedText);
      expect(state.clipboard).toBe(selectedText);
      state.editor = undefined;
      await paste();
      expect(post).toHaveBeenCalledExactlyOnceWith({
        type: "clipboardReadResult", requestId: 1, success: true,
        text: reference.expression, contextAttached: false, codeReference: reference
      });
    }
  );

  it("recovers a Markdown range from a matching selection copied with native copy", async () => {
    await paste();
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 1, success: true,
      text: reference.expression, contextAttached: false, codeReference: reference
    });
  });

  it("pastes raw Markdown text when plain-text paste is requested", async () => {
    await sidebar.copySelectionWithContext();
    await paste("text");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 1, success: true, text: selectedText, contextAttached: false
    });
  });

  it("clears stale workspace references when the matching selection belongs to an external file", async () => {
    attachments.stageClipboard(selectedText, reference);
    state.workspace = false;
    await paste();
    state.editor = undefined;
    await paste();
    expect(post).toHaveBeenCalledTimes(2);
    for (const [message] of post.mock.calls) {
      expect(message).toEqual({
        type: "clipboardReadResult", requestId: 1, success: true, text: selectedText, contextAttached: false
      });
    }
  });

  it("does not stage a reference when copying an external text selection", async () => {
    attachments.stageClipboard(selectedText, reference);
    state.workspace = false;
    await sidebar.copySelectionWithContext();
    expect(state.clipboard).toBe(selectedText);
    expect(attachments.clipboardReference(selectedText)).toBeUndefined();
  });
});
