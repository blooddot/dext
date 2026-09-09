import { describe, expect, it, vi } from "vitest";
import { bindFileDropTarget, droppedFilePaths, isFileDrag } from "../src/webview/fileDrop.js";
import { FileDropClient } from "../src/webview/fileDropClient.js";

function transfer(values: Record<string, string>): DataTransfer {
  return { types: Object.keys(values), getData: (type: string) => values[type] ?? "", files: [] } as unknown as DataTransfer;
}

describe("composer file drop listeners", () => {
  function harness() {
    const window = new EventTarget();
    const child = new EventTarget();
    const target = Object.assign(new EventTarget(), {
      ownerDocument: { defaultView: window }, contains: (node: unknown) => node === child
    });
    const dragover = vi.fn(() => true);
    const drop = vi.fn(() => true);
    const leave = vi.fn();
    const listen = vi.spyOn(target, "addEventListener");
    const dispose = bindFileDropTarget(target as unknown as HTMLElement, { dragover, drop, leave });
    return { target, window, child, dragover, drop, leave, dispose, listen };
  }

  it("captures drops at the composer boundary even if another handler prevented the default", () => {
    const { target, drop, listen, dispose } = harness();
    expect(listen).toHaveBeenCalledWith("drop", expect.any(Function), true);
    expect(listen).toHaveBeenCalledWith("dragover", expect.any(Function), true);
    const event = new Event("drop", { cancelable: true, bubbles: true });
    event.preventDefault();
    const stop = vi.spyOn(event, "stopPropagation");
    target.dispatchEvent(event);
    expect(drop).toHaveBeenCalledWith(event);
    expect(stop).toHaveBeenCalledOnce();
    dispose();
  });

  it("keeps highlight while crossing children and clears it when leaving the composer", () => {
    const { target, child, leave, dispose } = harness();
    target.dispatchEvent(Object.assign(new Event("dragleave"), { relatedTarget: child }));
    expect(leave).not.toHaveBeenCalled();
    target.dispatchEvent(Object.assign(new Event("dragleave"), { relatedTarget: null }));
    expect(leave).toHaveBeenCalledOnce();
    dispose();
  });

  it("removes all listeners when the editor is destroyed", () => {
    const { target, window, dragover, drop, leave, dispose } = harness();
    window.dispatchEvent(new Event("dragend"));
    expect(leave).toHaveBeenCalledOnce();
    dispose();
    leave.mockClear();
    target.dispatchEvent(new Event("dragover"));
    target.dispatchEvent(new Event("drop"));
    window.dispatchEvent(new Event("blur"));
    expect(dragover).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });
});

describe("file drag payloads", () => {
  it("reads URIs with empty DataTransfer.files, ignoring comments and duplicates", () => {
    expect(droppedFilePaths(transfer({ "text/uri-list": "# files\r\nfile:///C:/repo/%E4%B8%AD%20%E6%96%87.ts\r\nfile:///C:/repo/a.ts\r\nfile:///C:/repo/a.ts\r\n" })))
      .toEqual(["file:///C:/repo/%E4%B8%AD%20%E6%96%87.ts", "file:///C:/repo/a.ts"]);
  });
  it("prefers the complete internal list over VS Code's single standard URI", () => {
    expect(droppedFilePaths(transfer({
      "application/vnd.code.uri-list": "vscode-remote://ssh-remote+dev/repo/a.ts\r\nvscode-remote://ssh-remote+dev/repo/b.ts",
      "text/uri-list": "file:///wrong/a.ts"
    }))).toEqual(["vscode-remote://ssh-remote+dev/repo/a.ts", "vscode-remote://ssh-remote+dev/repo/b.ts"]);
  });
  it("accepts resource URLs with case-insensitive MIME matching", () => {
    expect(droppedFilePaths(transfer({ ResourceURLs: JSON.stringify(["file:///repo/a.ts", "file:///repo/b.ts"]), "text/uri-list": "file:///repo/a.ts" })))
      .toEqual(["file:///repo/a.ts", "file:///repo/b.ts"]);
  });
  it("falls back from malformed resource data to absolute plain-text paths", () => {
    expect(droppedFilePaths(transfer({ ResourceURLs: "{", "TEXT/PLAIN": '"C:\\repo\\a b.ts"\r\nC:\\repo\\c.ts' })))
      .toEqual(["C:\\repo\\a b.ts", "C:\\repo\\c.ts"]);
  });
  it.each(["explain this", "src/a.ts", "https://example.com", "C:\\repo\\a.ts\nexplain this"])("preserves ordinary text and links: %s", (text) => {
    expect(droppedFilePaths(transfer({ "text/plain": text }))).toEqual([]);
  });
  it("reads only types during Shift dragover while payloads are protected", () => {
    const data = transfer({ "text/uri-list": "file:///repo/a.ts" });
    const getData = vi.fn(() => { throw new Error("protected"); });
    data.getData = getData;
    expect(isFileDrag({ shiftKey: true, dataTransfer: data })).toBe(true);
    expect(isFileDrag({ shiftKey: false, dataTransfer: data })).toBe(false);
    expect(getData).not.toHaveBeenCalled();
  });
});

describe("file drop requests", () => {
  it("matches out-of-order replies to their own drop", async () => {
    const client = new FileDropClient(() => {});
    const first = client.resolve(["/repo/a.ts"]);
    const second = client.resolve(["/repo/b.ts"]);
    client.accept({ type: "resolveDroppedFilesResult", requestId: 2, expressions: ["@b.ts"] });
    client.accept({ type: "resolveDroppedFilesResult", requestId: 1, expressions: ["@a.ts"] });
    await expect(first).resolves.toEqual(["@a.ts"]);
    await expect(second).resolves.toEqual(["@b.ts"]);
  });
  it("reports lookup errors and settles pending drops on disposal", async () => {
    const client = new FileDropClient(() => {});
    const failed = client.resolve(["/repo/missing.ts"]);
    client.accept({ type: "resolveDroppedFilesResult", requestId: 1, expressions: [], error: "missing" });
    await expect(failed).rejects.toThrow("missing");
    const pending = client.resolve(["/repo/a.ts"]);
    client.dispose();
    await expect(pending).resolves.toEqual([]);
  });
  it("times out if the host never replies", async () => {
    vi.useFakeTimers();
    try {
      const client = new FileDropClient(() => {});
      const pending = expect(client.resolve(["/repo/a.ts"])).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(15000);
      await pending;
    } finally { vi.useRealTimers(); }
  });
});
