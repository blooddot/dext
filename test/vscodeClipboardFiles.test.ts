import { beforeEach, describe, expect, it, vi } from "vitest";

const vscode = vi.hoisted(() => {
  const uri = (value: string) => ({
    scheme: value.split(":")[0],
    path: decodeURIComponent(new URL(value).pathname),
    toString: () => new URL(value).href,
    with: ({ path }: { path: string }) => uri(`vscode-remote://ssh-remote+dev${path}`)
  });
  return {
    FileType: { Directory: 2 },
    Uri: {
      parse: vi.fn(uri),
      file: vi.fn((path: string) => uri(`file://${path.startsWith("/") ? "" : "/"}${path.replaceAll("\\", "/")}`))
    },
    workspace: {
      workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
      getWorkspaceFolder: vi.fn(),
      asRelativePath: vi.fn(),
      fs: { stat: vi.fn() }
    }
  };
});

vi.mock("vscode", () => vscode);
import { clipboardFileReferences } from "../src/vscodeClipboardFiles.js";

beforeEach(() => {
  vi.clearAllMocks();
  vscode.workspace.workspaceFolders = [];
  vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: {} });
  vscode.workspace.asRelativePath.mockImplementation((uri: { path: string }) => uri.path.replace(/^\/C:\/repo\/|^\/repo\//, ""));
  vscode.workspace.fs.stat.mockResolvedValue({ type: 1 });
});

describe("clipboard file paths", () => {
  it("references multiple original files, including images, without reading their content", async () => {
    await expect(clipboardFileReferences("C:\\repo\\index.html\r\nC:\\repo\\image.png")).resolves.toEqual([
      { expression: "@index.html", payload: "index.html" },
      { expression: "@image.png", payload: "image.png" }
    ]);
  });

  it("supports quoted paths and deduplicates the same file", async () => {
    const result = await clipboardFileReferences('"C:\\repo\\My File.ts"\n"C:\\repo\\My File.ts"');
    expect(result).toHaveLength(1);
    expect(result?.[0]).toEqual({
      expression: "@file:///C:/repo/My%20File.ts", payload: "file:///C:/repo/My%20File.ts"
    });
  });

  it("uses file URIs for external files", async () => {
    vscode.workspace.getWorkspaceFolder.mockReturnValue(undefined);
    await expect(clipboardFileReferences("file:///C:/outside/image.png")).resolves.toEqual([
      { expression: "@file:///C:/outside/image.png", payload: "file:///C:/outside/image.png" }
    ]);
  });

  it("resolves remote Copy Path against the remote workspace", async () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.parse("vscode-remote://ssh-remote+dev/repo") }];
    await expect(clipboardFileReferences("/repo/index.html")).resolves.toEqual([
      { expression: "@index.html", payload: "index.html" }
    ]);
    expect(vscode.workspace.fs.stat).toHaveBeenCalledWith(expect.objectContaining({ scheme: "vscode-remote", path: "/repo/index.html" }));
  });

  it("references workspace directories", async () => {
    vscode.workspace.fs.stat.mockResolvedValue({ type: 2 });
    await expect(clipboardFileReferences("/repo/src")).resolves.toEqual([
      { expression: "@src/", payload: "src" }
    ]);
  });

  it.each(["", "ordinary text", "src/index.ts", "See C:\\repo\\index.html", "/repo/index.html\nexplain this"])(
    "leaves non-path clipboard text unchanged: %s", async (text) => {
      await expect(clipboardFileReferences(text)).resolves.toBeUndefined();
      expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
    }
  );

  it("falls back to the entire original text if any path is missing", async () => {
    vscode.workspace.fs.stat.mockRejectedValueOnce(new Error("missing"));
    await expect(clipboardFileReferences("/repo/missing.ts\n/repo/index.html")).resolves.toBeUndefined();
  });
});
