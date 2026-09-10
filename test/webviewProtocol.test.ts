import { describe, expect, it } from "vitest";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

describe("Webview protocol", () => {
  it("accepts bounded resource-creation drafts and save confirmations", () => {
    const draft = { type: "draftResource", requestId: "request", sessionId: "session", resourceType: "skill", scope: "global", input: "Add release-check guidance." };
    expect(webviewRequestSchema.parse(draft)).toEqual(draft);
    expect(webviewRequestSchema.safeParse({ ...draft, resourceType: "plugin" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ ...draft, input: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "saveResource", draftId: "draft" }).success).toBe(true);
  });

  it("accepts only well-formed built-in API definition requests", () => {
    expect(webviewRequestSchema.safeParse({ type: "openBuiltinApiDefinition", id: "node.url.parse" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "openBuiltinApiDefinition", id: "node/url/parse" }).success).toBe(false);
  });

  it("requires conversation ownership and bounds agent question answers", () => {
    const request = { type: "agentInputResponse", sessionId: "session", turnId: "turn", requestId: "request", answers: { q: { answers: ["Yes"] } } };
    expect(webviewRequestSchema.parse(request)).toEqual(request);
    expect(webviewRequestSchema.safeParse({ ...request, sessionId: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ ...request, answers: { q: { answers: [] } } }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ ...request, answers: { q: { answers: ["x".repeat(20001)] } } }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ ...request, answers: null }).success).toBe(true);
  });
  it("bounds dropped file requests and rejects embedded line breaks", () => {
    const request = { type: "resolveDroppedFiles", requestId: 1, paths: ["file:///repo/a.ts", "file:///repo/b.ts"] };
    expect(webviewRequestSchema.parse(request)).toEqual(request);
    for (const paths of [[], Array(101).fill("/repo/a.ts"), ["/repo/a.ts\n/repo/b.ts"], ["x".repeat(8193)]]) {
      expect(webviewRequestSchema.safeParse({ ...request, paths }).success).toBe(false);
    }
  });

  it("requires the original conversation and turn for a rename request", () => {
    expect(webviewRequestSchema.parse({ type: "renameTurn", sessionId: "session-1", turnId: "turn-1" }))
      .toEqual({ type: "renameTurn", sessionId: "session-1", turnId: "turn-1" });
    expect(webviewRequestSchema.safeParse({ type: "renameTurn", turnId: "turn-1" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "renameTurn", sessionId: "", turnId: "turn-1" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "renameTurn", sessionId: "session-1", turnId: "" }).success).toBe(false);
  });

  it("accepts conversation tab requests", () => {
    expect(webviewRequestSchema.safeParse({ type: "moveConversation", sessionId: "a", beforeSessionId: "b" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "moveConversation", sessionId: "a", beforeSessionId: null }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "moveConversation", sessionId: "", beforeSessionId: null }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "moveConversation", sessionId: "a" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "moveConversation", sessionId: "a", beforeSessionId: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "selectConversation",
      sessionId: "session-1"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "closeConversation",
      sessionId: "session-1"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "newConversation" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "pinConversation",
      sessionId: "session-1",
      pinned: true
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "pinConversation", sessionId: "session-1" }).success)
      .toBe(false);
  });

  it("rejects conversation requests that remain served by view title commands", () => {
    expect(webviewRequestSchema.safeParse({ type: "clearOutput" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "viewHistory" }).success).toBe(false);
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
    expect(webviewRequestSchema.parse({
      type: "forkFromTurn",
      turnId: "turn-1"
    })).toMatchObject({ type: "forkFromTurn", turnId: "turn-1" });
    expect(webviewRequestSchema.parse({
      type: "deleteTurn",
      turnId: "turn-1"
    })).toMatchObject({ type: "deleteTurn", turnId: "turn-1" });
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
      type: "clipboardRead",
      requestId: 5,
      purpose: "text"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "chooseFiles" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "openFileReference",
      reference: "src/review.ts#L1,1-L1,2"
    }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({
      type: "openExternalLink",
      url: "https://example.com/docs"
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
      type: "openFileReference",
      reference: ""
    }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "openExternalLink", url: "" }).success).toBe(false);
  });
});

it("requires scope and form answers in interaction responses", () => {
  const current = { type: "uiResponse", sessionId: "s", turnId: "t", requestId: "r", response: { kind: "ui", type: "form", status: "submitted", answers: { q: { type: "radio", selected: ["yes"] } } } };
  expect(webviewRequestSchema.safeParse(current).success).toBe(true);
  expect(webviewRequestSchema.safeParse({ ...current, turnId: undefined }).success).toBe(false);
  expect(webviewRequestSchema.safeParse({ ...current, response: { type: "choice", selected: [] } }).success).toBe(false);
  expect(webviewRequestSchema.safeParse({ ...current, response: { ...current.response, status: "cancelled" } }).success).toBe(false);
});
