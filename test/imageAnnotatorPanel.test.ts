import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => void) | undefined,
  html: "",
  post: vi.fn(),
  reveal: vi.fn(),
  dispose: vi.fn(),
  onDispose: undefined as (() => void) | undefined
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
      onDidDispose: (listener: () => void) => { state.onDispose = listener; },
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
    // The tab is the annotation editor: no preview step and no button to reach it.
    expect(state.html).not.toContain("image-page-annotate");
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

describe("image annotator tab keeps what one visit did", () => {
  const memory = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, fallback?: T): T => (memory.has(key) ? memory.get(key) as T : fallback as T),
    update: async (key: string, value: unknown) => { memory.set(key, value); }
  };
  const insert = vi.fn();
  const panel = new ImageAnnotatorPanel({ extensionUri: {} as never, storage, state: memento, onInsert: insert });
  const savedMarks = (): unknown => JSON.parse(
    (/name="dext-image-marks" content="([^"]*)"/.exec(state.html)?.[1] ?? "[]").replaceAll("&quot;", '"')
  ) as unknown;

  it("brings the marks back when the attachment is opened again", async () => {
    const marks = [
      { kind: "region", box: { x: 1, y: 2, width: 3, height: 4 }, note: "here" },
      { kind: "point", point: { x: 5, y: 6 }, note: "" }
    ];
    panel.open(".dext-global/attachments/b.png");
    expect(savedMarks()).toEqual([]);
    state.receive?.({ type: "saveAnnotations", marks });
    await vi.waitFor(() => expect(memory.get("dext.imageAnnotations"))
      .toEqual({ ".dext-global/attachments/b.png": { marks } }));
    // Closing the tab is the case the user hits: the next open starts from what was kept.
    state.onDispose?.();
    panel.open(".dext-global/attachments/b.png");
    expect(savedMarks()).toEqual(marks);
  });

  it("keeps one record per attachment and overwrites it with the latest edit", async () => {
    const first = [{ kind: "point", point: { x: 1, y: 1 }, note: "first" }];
    const second = [{ kind: "point", point: { x: 2, y: 2 }, note: "second" }];
    panel.open(".dext-global/attachments/c.png");
    state.receive?.({ type: "saveAnnotations", marks: first });
    state.receive?.({ type: "saveAnnotations", marks: second });
    // Editing the same picture again rewrites its entry instead of adding one.
    await vi.waitFor(() => {
      const all = memory.get("dext.imageAnnotations") as Record<string, unknown>;
      expect(Object.keys(all).filter((path) => path.endsWith("/c.png"))).toEqual([".dext-global/attachments/c.png"]);
      expect(all[".dext-global/attachments/c.png"]).toEqual({ marks: second });
    });
  });

  it("replaces the block it inserted before the tab was closed", async () => {
    panel.open(".dext-global/attachments/b.png");
    state.receive?.({ type: "insertAnnotations", text: "first" });
    await vi.waitFor(() => expect(insert).toHaveBeenLastCalledWith("first", undefined));
    state.onDispose?.();
    panel.open(".dext-global/attachments/b.png");
    state.receive?.({ type: "insertAnnotations", text: "second" });
    await vi.waitFor(() => expect(insert).toHaveBeenLastCalledWith("second", "first"));
  });

  it("drops the least recently used attachment instead of growing forever", () => {
    const keys = () => Object.keys(memory.get("dext.imageAnnotations") as Record<string, unknown>);
    for (let index = 0; index < 201; index++) {
      panel.open(`.dext-global/attachments/s${index}.png`);
      state.receive?.({ type: "saveAnnotations", marks: [] });
    }
    expect(keys()).toHaveLength(200);
    // The two oldest uses go first: the attachment from the tests above, then s0.
    expect(keys()[0]).toBe(".dext-global/attachments/s1.png");
    // Touching an old attachment makes it the newest again, so s1 is what the next one drops.
    panel.open(".dext-global/attachments/s100.png");
    state.receive?.({ type: "saveAnnotations", marks: [] });
    panel.open(".dext-global/attachments/late.png");
    state.receive?.({ type: "saveAnnotations", marks: [] });
    expect(keys()).toHaveLength(200);
    expect(keys()).toContain(".dext-global/attachments/s100.png");
    expect(keys()).not.toContain(".dext-global/attachments/s1.png");
    expect(keys().at(-1)).toBe(".dext-global/attachments/late.png");
  });
});
