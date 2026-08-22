import { describe, expect, it } from "vitest";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

describe("Webview protocol", () => {
  it("accepts output and conversation tab requests", () => {
    expect(webviewRequestSchema.safeParse({ type: "clearOutput" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "selectConversation",
      sessionId: "session-1"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "closeConversation",
      sessionId: "session-1"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "pinConversation",
      sessionId: "session-1",
      pinned: true
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "pinConversation", sessionId: "session-1" }).success)
      .toBe(false);
  });

  it("rejects conversation requests now served by view title commands", () => {
    expect(webviewRequestSchema.safeParse({ type: "viewHistory" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "newConversation" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "closeConversation", sessionId: "" }).success)
      .toBe(false);
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
    expect(webviewRequestSchema.parse({
      type: "retryTurn",
      turnId: "turn-1"
    })).toMatchObject({ type: "retryTurn", turnId: "turn-1" });
    expect(webviewRequestSchema.safeParse({ type: "retryTurn", turnId: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "executeInput",
      mode: "plan",
      source: "Add a cache"
    }).success).toBe(true);
    expect(webviewRequestSchema.parse({
      type: "buildPlan",
      planPath: ".dext/plans/20260821-103000-add-a-cache.plan.md"
    })).toMatchObject({ type: "buildPlan" });
    expect(webviewRequestSchema.safeParse({ type: "buildPlan", planPath: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "buildPlan", planPath: "x".repeat(513) }).success)
      .toBe(false);
    // An empty uri list is how Accept all asks for every pending file.
    expect(webviewRequestSchema.parse({
      type: "resolvePatch",
      turnId: "turn-1",
      uris: [],
      accept: true
    })).toMatchObject({ type: "resolvePatch", accept: true });
    expect(webviewRequestSchema.safeParse({
      type: "resolvePatch",
      turnId: "turn-1",
      uris: ["file:///a.ts"],
      accept: false
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "resolvePatch",
      turnId: "",
      uris: [],
      accept: true
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "resolvePatch",
      turnId: "turn-1",
      uris: [""],
      accept: true
    }).success).toBe(false);
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

  it("accepts file picker queries including the empty one", () => {
    // An empty query is how the picker asks for a starting list the moment the
    // user types `@`, so it must not be rejected as missing input.
    expect(webviewRequestSchema.safeParse({ type: "searchFiles", requestId: 0, query: "" }).success)
      .toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "searchFiles", requestId: 7, query: "srcrev" }).success)
      .toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "searchFiles",
      requestId: 7,
      query: "x".repeat(121)
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "searchFiles", query: "src" }).success).toBe(false);
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
