import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => void) | undefined,
  html: "",
  post: vi.fn(),
  reveal: vi.fn(),
  dispose: vi.fn()
}));
vi.mock("vscode", () => ({
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (_: unknown, ...parts: string[]) => ({
      fsPath: parts.join("/"),
      with: () => ({ toString: () => parts.join("/") })
    })
  },
  window: {
    createWebviewPanel: () => ({
      reveal: state.reveal,
      dispose: state.dispose,
      onDidDispose: vi.fn(),
      webview: {
        cspSource: "test:",
        asWebviewUri: (uri: unknown) => uri,
        set html(value: string) { state.html = value; },
        onDidReceiveMessage: (listener: typeof state.receive) => { state.receive = listener; },
        postMessage: state.post
      }
    })
  }
}));
vi.mock("../src/features/conversations/host/attachmentImage.js", () => ({
  attachmentImageDataUrl: async (storage: { uriForReference(): unknown }, path: string) =>
    storage.uriForReference() ? `data:image/png;base64,${path}` : Promise.reject(new Error("That attachment is not a Dext image."))
}));

import { ImageAnnotatorPanel } from "../src/features/conversations/host/imageAnnotatorPanel.js";
import type { DextStorage } from "../src/platform/vscode/dextStorage.js";

const storage = { uriForReference: () => ({}) } as unknown as DextStorage;
const onInsert = vi.fn();

describe("image annotator tab", () => {
  it("opens one tab per attachment and reuses it", () => {
    const panel = new ImageAnnotatorPanel({ extensionUri: {} as never, storage, onInsert });
    panel.open(".dext-global/attachments/a.png");
    panel.open(".dext-global/attachments/a.png");
    expect(state.reveal).toHaveBeenCalledOnce();
    expect(state.html).toContain("imageAnnotator.js");
    expect(state.html).toContain('content=".dext-global/attachments/a.png"');
  });

  it("answers the image request with the attachment bytes", async () => {
    state.receive?.({ type: "imageData" });
    await vi.waitFor(() => expect(state.post).toHaveBeenCalledWith({
      type: "imageDataResult",
      dataUrl: "data:image/png;base64,.dext-global/attachments/a.png"
    }));
  });

  it("replaces the earlier block when the same tab annotates twice", () => {
    state.receive?.({ type: "insertAnnotations", text: "first" });
    state.receive?.({ type: "insertAnnotations", text: "second" });
    expect(onInsert).toHaveBeenNthCalledWith(1, "first", undefined);
    expect(onInsert).toHaveBeenNthCalledWith(2, "second", "first");
  });
});
