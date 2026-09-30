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
    },
    commands: { executeCommand: vi.fn() },
    env: { clipboard: { readText: vi.fn() } },
    window: { activeTextEditor: undefined }
  };
});

vi.mock("vscode", () => vscode);
import { AttachmentStore } from "../src/attachmentStore.js";
import { clipboardFileReferences, copyFilePathKeepingFiles, copyFilePathKeepingLine } from "../src/vscodeClipboardFiles.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { FileDropClient } from "../src/webview/fileDropClient.js";

beforeEach(() => {
  vi.clearAllMocks();
  vscode.workspace.workspaceFolders = [];
  vscode.workspace.getWorkspaceFolder.mockReturnValue({ uri: {} });
  vscode.workspace.asRelativePath.mockImplementation((uri: { path: string }) => uri.path.replace(/^\/C:\/repo\/|^\/repo\//, ""));
  vscode.workspace.fs.stat.mockResolvedValue({ type: 1 });
  vscode.commands.executeCommand.mockResolvedValue(undefined);
  vscode.env.clipboard.readText.mockResolvedValue("");
});

describe("clipboard file paths", () => {
  it("resolves dropped paths through the webview client and host into file references", async () => {
    const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
    const client = new FileDropClient((request) => {
      void (sidebar as unknown as { receive(request: unknown): Promise<void> }).receive(request);
    });
    Object.assign(sidebar, { post: async (response: Parameters<FileDropClient["accept"]>[0]) => client.accept(response) });
    await expect(client.resolve(["file:///C:/repo/a.ts", "file:///C:/repo/My%20File.ts"]))
      .resolves.toEqual(["@a.ts", "@file:///C:/repo/My%20File.ts"]);
    vscode.workspace.fs.stat.mockRejectedValueOnce(new Error("missing"));
    await expect(client.resolve(["file:///C:/repo/missing.ts"])).rejects.toThrow("Could not reference");
    client.dispose();
  });

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

describe("Explorer Copy Path and VS Code's file list", () => {
  function sidebarWithClipboard(): {
    sidebar: DextSidebarProvider;
    post: ReturnType<typeof vi.fn>;
    attachments: AttachmentStore;
  } {
    const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
    const post = vi.fn().mockResolvedValue(undefined);
    const attachments = new AttachmentStore();
    Object.assign(sidebar, { attachments, post });
    return { sidebar, post, attachments };
  }

  async function paste(sidebar: DextSidebarProvider, purpose: "code" | "text"): Promise<void> {
    await (sidebar as unknown as { receive(request: unknown): Promise<void> })
      .receive({ type: "clipboardRead", requestId: 7, purpose });
  }

  it("reads the path text first and restores the file list last", async () => {
    vscode.env.clipboard.readText.mockResolvedValue("C:\\repo\\index.html");
    await expect(copyFilePathKeepingFiles()).resolves.toBe("C:\\repo\\index.html");
    expect(vscode.commands.executeCommand.mock.calls)
      .toEqual([["copyFilePath"], ["filesExplorer.copy"]]);
  });

  it("keeps the path text when VS Code has no file-list command to run", async () => {
    vscode.env.clipboard.readText.mockResolvedValue("/repo/index.html");
    vscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === "filesExplorer.copy") throw new Error("command not found");
    });
    await expect(copyFilePathKeepingFiles()).resolves.toBe("/repo/index.html");
  });

  it("returns the line VS Code left behind for a copy with nothing selected", async () => {
    vscode.env.clipboard.readText
      .mockResolvedValueOnce("C:\\repo\\index.html")
      .mockResolvedValueOnce("const value = 1;");
    await expect(copyFilePathKeepingLine()).resolves.toEqual({
      path: "C:\\repo\\index.html", clipboardText: "const value = 1;"
    });
    expect(vscode.commands.executeCommand.mock.calls)
      .toEqual([["copyFilePath"], ["editor.action.clipboardCopyAction"]]);
  });

  it("keeps the path text when VS Code cannot run the copy-line action", async () => {
    vscode.env.clipboard.readText.mockResolvedValue("/repo/index.html");
    vscode.commands.executeCommand.mockImplementation(async (command: string) => {
      if (command === "editor.action.clipboardCopyAction") throw new Error("command not found");
    });
    await expect(copyFilePathKeepingLine()).resolves.toEqual({
      path: "/repo/index.html", clipboardText: "/repo/index.html"
    });
  });

  it("turns a staged Copy Path into references after VS Code copied the line", async () => {
    const { sidebar, post, attachments } = sidebarWithClipboard();
    attachments.stageFileCopy("C:\\repo\\index.html", "const value = 1;");
    vscode.env.clipboard.readText.mockResolvedValue("const value = 1;");
    await paste(sidebar, "code");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 7, success: true,
      text: "@index.html", contextAttached: false,
      fileReferences: [{ expression: "@index.html", payload: "index.html" }]
    });
  });

  it("turns a staged Copy Path into references for a reference paste", async () => {
    const { sidebar, post, attachments } = sidebarWithClipboard();
    attachments.stageFileCopy("C:\\repo\\index.html");
    await paste(sidebar, "code");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 7, success: true,
      text: "@index.html", contextAttached: false,
      fileReferences: [{ expression: "@index.html", payload: "index.html" }]
    });
  });

  it("pastes a staged Copy Path as plain text for a raw paste", async () => {
    const { sidebar, post, attachments } = sidebarWithClipboard();
    attachments.stageFileCopy("C:\\repo\\index.html");
    await paste(sidebar, "text");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 7, success: true,
      text: "C:\\repo\\index.html", contextAttached: false
    });
  });

  it("pastes the staged path text as-is when its file no longer resolves", async () => {
    const { sidebar, post, attachments } = sidebarWithClipboard();
    attachments.stageFileCopy("C:\\repo\\missing.html");
    vscode.workspace.fs.stat.mockRejectedValueOnce(new Error("missing"));
    await paste(sidebar, "code");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 7, success: true,
      text: "C:\\repo\\missing.html", contextAttached: false
    });
  });

  it("leaves other clipboard text alone", async () => {
    const { sidebar, post, attachments } = sidebarWithClipboard();
    attachments.stageFileCopy("C:\\repo\\index.html");
    vscode.env.clipboard.readText.mockResolvedValue("copied text");
    await paste(sidebar, "code");
    expect(post).toHaveBeenCalledExactlyOnceWith({
      type: "clipboardReadResult", requestId: 7, success: true,
      text: "copied text", contextAttached: false
    });
    expect(vscode.workspace.fs.stat).not.toHaveBeenCalled();
  });
});
