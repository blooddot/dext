import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DextStorage } from "../src/dextStorage.js";

const mock = vi.hoisted(() => {
  class Uri {
    readonly scheme = "file";
    constructor(readonly fsPath: string) {}
    static file(path: string) { return new Uri(path); }
    static parse(value: string) {
      if (!value.startsWith("file:")) throw new Error("Not a URI");
      return new Uri(decodeURIComponent(new URL(value).pathname));
    }
    static joinPath(base: Uri, ...parts: string[]) { return new Uri([base.fsPath, ...parts].join("/")); }
  }
  return { Uri, commands: { executeCommand: vi.fn() },
    workspace: { openTextDocument: vi.fn(), getWorkspaceFolder: vi.fn(), workspaceFolders: [{ uri: new Uri("C:/repo") }] },
    window: { showTextDocument: vi.fn() }, ViewColumn: { Active: 1 }
  };
});
vi.mock("vscode", () => mock);
import { openDextFileReference, openWorkspaceDocument } from "../src/vscodeContextHost.js";
import { outputLinkReference } from "../src/webview/outputLink.js";

beforeEach(() => {
  vi.clearAllMocks();
  mock.commands.executeCommand.mockResolvedValue(undefined);
  mock.workspace.getWorkspaceFolder.mockReturnValue({});
});

describe("opening image links from output", () => {
  it.each([
    "/C:/repo/.tmp-tb/todo-style-dark.png", "C:/repo/preview.PNG", "/home/user/project/preview.webp",
    "file:///C:/repo/image%20preview.png", "file:///c%3A/repo/preview.png", ".tmp-tb/todo-style-dark.png"
  ])("opens %s with the image editor instead of loading it as text", async (path) => {
    const storage = { uriForReference: () => undefined } as unknown as DextStorage;
    await openDextFileReference(outputLinkReference(path)!, storage);
    expect(mock.commands.executeCommand).toHaveBeenCalledWith("vscode.open", expect.objectContaining({ fsPath: expect.stringMatching(/\.(png|webp)$/i) }));
    expect(mock.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(mock.window.showTextDocument).not.toHaveBeenCalled();
  });

  it("continues opening text files in the text editor", async () => {
    const doc = { getText: () => "hello" };
    mock.workspace.openTextDocument.mockResolvedValue(doc);
    await openDextFileReference("C:/repo/file.ts", { uriForReference: () => undefined } as unknown as DextStorage);
    expect(mock.workspace.openTextDocument).toHaveBeenCalledOnce();
    expect(mock.window.showTextDocument).toHaveBeenCalledWith(doc, { preview: false, viewColumn: 1 });
    expect(mock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("preserves workspace validation for callers that require it", async () => {
    mock.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    await expect(openWorkspaceDocument(mock.Uri.file("C:/outside/picture.png") as never)).rejects.toThrow("inside the current workspace");
    expect(mock.commands.executeCommand).not.toHaveBeenCalled();
  });

  it("surfaces image editor errors without attempting to read binary content", async () => {
    mock.commands.executeCommand.mockRejectedValueOnce(new Error("Missing image"));
    await expect(openDextFileReference("file:///C:/repo/missing.png", { uriForReference: () => undefined } as unknown as DextStorage))
      .rejects.toThrow("Missing image");
    expect(mock.workspace.openTextDocument).not.toHaveBeenCalled();
  });
});
