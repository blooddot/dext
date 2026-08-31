import { describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => ({
  FileType: { Directory: 2 },
  workspace: {
    getWorkspaceFolder: vi.fn(),
    asRelativePath: vi.fn(),
    fs: { stat: vi.fn() },
    workspaceFolders: [{ uri: {} }]
  }
}));

vi.mock("vscode", () => vscode);

import { fileAttachment, isCodeDocument } from "../src/vscodeAttachments.js";

describe("attachment document classification", () => {
  it("uses workspace references only for code and configuration documents", () => {
    expect(isCodeDocument({ languageId: "typescript" })).toBe(true);
    expect(isCodeDocument({ languageId: "json" })).toBe(true);
    expect(isCodeDocument({ languageId: "shellscript" })).toBe(true);
  });

  it("leaves prose, logs, and tabular text as ordinary pasted text", () => {
    for (const languageId of ["plaintext", "markdown", "log", "output", "csv", "tsv"]) {
      expect(isCodeDocument({ languageId })).toBe(false);
    }
  });

  it("creates a workspace file reference without reading or size-limiting the file", async () => {
    const uri = {};
    vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: {} });
    vscode.workspace.fs.stat.mockResolvedValue({ type: 1, size: 50 * 1024 * 1024 });
    vscode.workspace.asRelativePath.mockReturnValue("src/large-fixture.bin");

    await expect(fileAttachment(uri as never)).resolves.toEqual({
      payload: "src/large-fixture.bin",
      expression: "@src/large-fixture.bin"
    });
    expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(uri);
  });
});
