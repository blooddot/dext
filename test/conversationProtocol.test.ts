import { describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/features/agents/contracts/agent.js";
import { conversationRequestSchemas } from "../src/features/conversations/contracts/protocol.js";
import { webviewRequestSchema } from "../src/platform/webviewProtocol.js";

describe("conversation protocol", () => {
  it("composes its messages into the host's one request union", () => {
    const types = conversationRequestSchemas.map((schema) => schema.shape.type.value);
    expect(types).toContain("executeInput");
    expect(types).toContain("resolvePatch");
    expect(types).toContain("selectConversation");
    expect(types).toContain("agentSelection");
    expect(types).toHaveLength(21);
    for (const type of types) expect(webviewRequestSchema.options.some((option) => option.shape.type.value === type)).toBe(true);
  });

  it("accepts the conversation, execution, plan and review messages", () => {
    const selection: AgentSelection = {
      mode: "agent", permission: "workspace-write", profileId: "codex", model: "m", reasoningEffort: "", speed: "", serviceTier: ""
    };
    const accepted = [
      { type: "executeInput", mode: "agent", source: "hello" },
      { type: "stopExecution", turnId: "turn" },
      { type: "buildPlan", planPath: ".dext/plans/a.plan.md" },
      { type: "resolvePatch", turnId: "turn", uris: [], accept: true },
      { type: "selectConversation", sessionId: "session" },
      { type: "moveConversation", sessionId: "a", beforeSessionId: null },
      { type: "pinConversation", sessionId: "a", pinned: true },
      { type: "agentSelection", selection },
      { type: "agentSelection", selection: { ...selection, skills: ["ponytail", "ponytail-review"] } },
      { type: "harnessPresetAction", action: "refresh" }
    ];
    for (const request of accepted) expect(webviewRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "agentSelection", selection: { ...selection, skills: Array.from({ length: 65 }, (_, index) => `skill-${index}`) } }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "agentSelection", selection: { ...selection, skills: [1] } }).success).toBe(false);
  });

  it("keeps the older message behavior intact", () => {
    // Retired shapes stay retired.
    expect(webviewRequestSchema.safeParse({ type: "executeChat", message: "hello" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "executeInput", source: "hello" }).success).toBe(false);
    // Ownership and bounds are unchanged.
    expect(webviewRequestSchema.safeParse({ type: "renameTurn", turnId: "turn" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "selectConversation", sessionId: "" }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "resolvePatch", turnId: "turn", uris: [""], accept: true }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({
      type: "agentSelection",
      selection: { ...selectionFields(), permission: "read-only" }
    }).success).toBe(false);
    // Host messages outside the conversation feature still parse.
    expect(webviewRequestSchema.safeParse({ type: "ready" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "searchFiles", requestId: 1, query: "" }).success).toBe(true);
  });
});

function selectionFields() {
  return { mode: "agent", permission: "workspace-write", profileId: "codex", model: "m", reasoningEffort: "", speed: "", serviceTier: "" };
}

// This test file imports no VS Code module: the conversation contract must stay
// usable from the browser bundle.
vi.mock("vscode", () => ({}));
