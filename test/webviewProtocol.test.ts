import { describe, expect, it } from "vitest";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

describe("Webview protocol", () => {
  it("accepts history requests", () => {
    expect(webviewRequestSchema.safeParse({ type: "viewHistory" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "clearOutput" }).success).toBe(true);
  });

  it("accepts code and normal conversation input requests", () => {
    expect(webviewRequestSchema.parse({
      type: "executeInput",
      mode: "code",
      source: "Review this"
    })).toMatchObject({ type: "executeInput", mode: "code", source: "Review this" });
    expect(webviewRequestSchema.safeParse({
      type: "executeInput",
      mode: "agent",
      source: "Inspect this feature"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "executeInput",
      mode: "ask",
      source: "What does this module do?"
    }).success).toBe(true);
    expect(webviewRequestSchema.parse({
      type: "stopExecution",
      turnId: "turn-1"
    })).toMatchObject({ type: "stopExecution", turnId: "turn-1" });
    expect(webviewRequestSchema.safeParse({
      type: "clipboardWrite",
      requestId: 3,
      text: "selection"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "clipboardRead",
      requestId: 4,
      purpose: "code"
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
      type: "openFileReference",
      reference: "src/review.ts#L1,1-L1,2"
    }).success).toBe(true);
  });

  it("rejects old mode-specific execution shapes", () => {
    expect(webviewRequestSchema.safeParse({ type: "executeChat", message: "hello" }).success)
      .toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "executeCode",
      source: "ask(input=\"hello\")"
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "executeInput", source: "hello" }).success)
      .toBe(false);
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
