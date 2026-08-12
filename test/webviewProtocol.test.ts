import { describe, expect, it } from "vitest";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

describe("Webview protocol", () => {
  it("accepts attachment-aware chat and clipboard requests", () => {
    expect(webviewRequestSchema.parse({
      type: "executeChat",
      message: "Review this",
      attachmentIds: ["attachment-1"]
    })).toMatchObject({ type: "executeChat", attachmentIds: ["attachment-1"] });
    expect(webviewRequestSchema.safeParse({
      type: "clipboardWrite",
      requestId: 3,
      text: "selection"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "clipboardRead",
      requestId: 4,
      purpose: "chat"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "dropFiles",
      items: [
        { kind: "uri", value: "vscode-remote://ssh-remote+host/workspace/a.ts" },
        { kind: "path", value: "C:\\workspace\\b.ts" }
      ]
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "chooseFiles" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "openAttachment",
      attachmentId: "attachment-1"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "openFileReference",
      reference: "src/review.ts#L1,1-L1,2"
    }).success).toBe(true);
  });

  it("rejects the old chat shape and attachment lists beyond the host limit", () => {
    expect(webviewRequestSchema.safeParse({ type: "executeChat", message: "hello" }).success)
      .toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "executeChat",
      message: "hello",
      attachmentIds: Array.from({ length: 9 }, (_, index) => `attachment-${index}`)
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "dropFiles",
      items: [{ kind: "unknown", value: "file:///a.ts" }]
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "openFileReference",
      reference: ""
    }).success).toBe(false);
  });
});
