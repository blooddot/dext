import { describe, expect, it } from "vitest";
import {
  insertAtSelection,
  parseDroppedFiles,
  parseUriList
} from "../src/webview/chatAttachments.js";

describe("Chat attachment helpers", () => {
  it("parses the standard URI list format and ignores comments and duplicates", () => {
    expect(parseUriList([
      "# copied files",
      "file:///workspace/a.ts",
      "",
      "vscode-remote://ssh-remote+host/workspace/b.ts",
      "file:///workspace/a.ts"
    ].join("\r\n"))).toEqual([
      "file:///workspace/a.ts",
      "vscode-remote://ssh-remote+host/workspace/b.ts"
    ]);
  });

  it("inserts ordinary clipboard text at the selection captured before the host check", () => {
    expect(insertAtSelection("before selected after", "pasted", 7, 15)).toEqual({
      value: "before pasted after",
      cursor: 13
    });
  });

  it("clamps stale selection offsets to the current textarea value", () => {
    expect(insertAtSelection("abc", "!", -3, 99)).toEqual({ value: "!", cursor: 1 });
  });

  it("uses a fully valid plain-text URI list only when the standard type is absent", () => {
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: "",
      plainText: [
        "file:///workspace/a.ts",
        "vscode-remote://ssh-remote+host/workspace/b.ts"
      ].join("\n")
    })).toEqual([
      { kind: "uri", value: "file:///workspace/a.ts" },
      { kind: "uri", value: "vscode-remote://ssh-remote+host/workspace/b.ts" }
    ]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: "",
      plainText: "Review file:///workspace/a.ts please"
    })).toEqual([]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: "",
      plainText: "C:\\workspace\\a.ts\n/workspace/b.ts"
    })).toEqual([]);
  });

  it("prefers standard and Workbench URI-list payloads", () => {
    expect(parseDroppedFiles({
      uriList: "# files\nfile:///workspace/standard.ts",
      codeUriList: "file:///workspace/code.ts",
      resourceUrls: '["file:///workspace/resources.ts"]',
      codeFiles: '["C:\\\\workspace\\\\code.ts"]',
      plainText: "file:///workspace/plain.ts"
    }))
      .toEqual([{ kind: "uri", value: "file:///workspace/standard.ts" }]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "vscode-remote://ssh-remote+host/workspace/code.ts",
      resourceUrls: '["file:///workspace/resources.ts"]',
      codeFiles: "",
      plainText: "file:///workspace/plain.ts"
    }))
      .toEqual([{ kind: "uri", value: "vscode-remote://ssh-remote+host/workspace/code.ts" }]);
  });

  it("parses ResourceURLs JSON without accepting CodeEditors or display paths", () => {
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: JSON.stringify([
        "file:///workspace/a.ts",
        "vscode-remote://ssh-remote+host/workspace/b.ts"
      ]),
      codeFiles: "",
      plainText: "C:\\workspace\\a.ts"
    })).toEqual([
      { kind: "uri", value: "file:///workspace/a.ts" },
      { kind: "uri", value: "vscode-remote://ssh-remote+host/workspace/b.ts" }
    ]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: '{"not":"an array"}',
      codeFiles: "",
      plainText: "C:\\workspace\\a.ts"
    }))
      .toEqual([]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: "",
      plainText: "CodeEditors"
    }))
      .toEqual([]);
  });

  it("filters malformed entries from a standard URI-list payload", () => {
    expect(parseDroppedFiles({
      uriList: "# files\nnot-a-uri\nfile:///workspace/a.ts",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: "",
      plainText: ""
    }))
      .toEqual([{ kind: "uri", value: "file:///workspace/a.ts" }]);
  });

  it("parses only absolute local paths from CodeFiles JSON", () => {
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: JSON.stringify(["C:\\workspace\\a.ts", "D:/workspace/b.ts"]),
      plainText: "C:\\workspace\\a.ts"
    })).toEqual([
      { kind: "path", value: "C:\\workspace\\a.ts" },
      { kind: "path", value: "D:/workspace/b.ts" }
    ]);
    expect(parseDroppedFiles({
      uriList: "",
      codeUriList: "",
      resourceUrls: "",
      codeFiles: JSON.stringify(["relative/a.ts"]),
      plainText: "C:\\workspace\\display-only.ts"
    })).toEqual([]);
  });
});
