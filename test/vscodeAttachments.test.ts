import { describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => ({
  FileType: { Directory: 2 },
  Uri: {
    parse: vi.fn((value: string) => ({ scheme: value.split(":")[0], toString: () => value })),
    file: vi.fn((path: string) => ({ scheme: "file", toString: () => `file:///${path.replaceAll("\\", "/")}` }))
  },
  workspace: {
    getWorkspaceFolder: vi.fn(),
    asRelativePath: vi.fn(),
    fs: { stat: vi.fn() },
    workspaceFolders: [{ uri: {} }]
  }
}));

vi.mock("vscode", () => vscode);

import { attachmentFileReference, clipboardFileReference, directoryAttachment, fileAttachment } from "../src/platform/vscode/attachments.js";

describe("file attachments", () => {
  it("creates a workspace file reference without reading or size-limiting the file", async () => {
    const uri = { scheme: "file" };
    vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: {} });
    vscode.workspace.fs.stat.mockResolvedValue({ type: 1, size: 50 * 1024 * 1024 });
    vscode.workspace.asRelativePath.mockReturnValue("src/large-fixture.bin");

    await expect(fileAttachment(uri as never)).resolves.toEqual({
      payload: "src/large-fixture.bin",
      expression: "@src/large-fixture.bin"
    });
    expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(uri);
  });

  it("keeps an explicitly selected external file as a file URI reference", async () => {
    const uri = { scheme: "file", toString: () => "file:///C:/outside/My%20File.ts" };
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscode.workspace.fs.stat.mockResolvedValue({ type: 1 });

    await expect(fileAttachment(uri as never)).resolves.toEqual({
      payload: "file:///C:/outside/My%20File.ts",
      expression: "@file:///C:/outside/My%20File.ts"
    });
  });

  it("keeps an external selection and file chip on the file URI with its range", async () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    const reference = {
      kind: "codeRef" as const,
      uri: "file:///C:/outside/My%20File.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } },
      documentVersion: 1,
      contentHash: "hash",
      content: "content"
    };
    const expected = {
      payload: "file:///C:/outside/My%20File.ts#L1,1-L3,5",
      expression: "@file:///C:/outside/My%20File.ts#L1,1-L3,5"
    };
    expect(clipboardFileReference(reference)).toEqual(expected);
    expect(attachmentFileReference({ reference, text: "content" })).toEqual(expected);
  });

  it("chips a user-data document by the file it names", async () => {
    // Dext's plans and attachments live in the user data directory, which VS Code
    // opens as `vscode-userdata:`; its fsPath is still the file an agent reads.
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscode.workspace.fs.stat.mockResolvedValue({ type: 1 });
    const uri = {
      scheme: "vscode-userdata",
      fsPath: "C:/Users/TU/AppData/Roaming/Code/User/globalStorage/blooddot.dext/plans/a.plan.md",
      toString: () => "vscode-userdata:/c%3A/Users/TU/plans/a.plan.md"
    };

    await expect(fileAttachment(uri as never)).resolves.toEqual({
      payload: "file:///C:/Users/TU/AppData/Roaming/Code/User/globalStorage/blooddot.dext/plans/a.plan.md",
      expression: "@file:///C:/Users/TU/AppData/Roaming/Code/User/globalStorage/blooddot.dext/plans/a.plan.md"
    });
  });

  it("leaves a resource with no openable path to the caller, which keeps plain text", async () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscode.workspace.fs.stat.mockResolvedValue({ type: 1 });

    await expect(fileAttachment({ scheme: "git", toString: () => "git:/c%3A/repo/a.ts?%7B%7D" } as never))
      .resolves.toBeUndefined();
    expect(attachmentFileReference({
      reference: {
        kind: "codeRef" as const,
        uri: "git:/c%3A/repo/a.ts?%7B%7D",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
        documentVersion: 1,
        contentHash: "hash",
        content: "a"
      },
      text: "a"
    })).toBeUndefined();
  });

  it("keeps an external directory as a file URI reference", async () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    vscode.workspace.fs.stat.mockResolvedValue({ type: 2 });

    await expect(directoryAttachment({ scheme: "file", toString: () => "file:///C:/outside/src" } as never))
      .resolves.toEqual({ payload: "file:///C:/outside/src", expression: "@file:///C:/outside/src/" });
  });
});
