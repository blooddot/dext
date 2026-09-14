import { describe, expect, it, vi } from "vitest";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { DextHistoryStore, type DextHistorySession } from "../src/historyStore.js";
import { conversationTitle } from "../src/historyRender.js";
import type { ResourceDocument, ResourceSession } from "../src/resourceSession.js";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";

vi.mock("vscode", () => ({}));

function harness() {
  const session: DextHistorySession = { id: "resource", createdAt: 1, updatedAt: 1, turns: [], resource: { type: "rule", scope: "global" } };
  let stored: unknown = structuredClone([session]);
  const history = new DextHistoryStore({ get: () => structuredClone(stored), update: async (_key: string, value: unknown) => { stored = structuredClone(value); } } as never);
  const messages: WebviewResponse[] = [];
  const draftResource = vi.fn<(resource: ResourceSession, input: string, metadata: ExecutionMetadata) => Promise<{ draft: ResourceDocument; response: InputExecutionResponse }>>(async () => ({
    draft: { name: "review", content: "Review carefully" },
    response: { kind: "workflow", executions: [{
      invocation: { kind: "invocation", method: "ask", arguments: [], source: "chat" },
      method: { id: "ask", title: "Ask", kind: "command", source: "builtin" }, durationMs: 1,
      result: { kind: "ask", text: "Review carefully" }
    }] }
  }));
  const saveResource = vi.fn(async (resource: ResourceSession) => ({ ...resource.draft!, path: "review.md" }));
  const application = {
    state: () => ({ agentSelection: { profileId: "codex", mode: "agent" }, resourceRoots: { global: "/global", project: "/project" } }),
    agentProfiles: () => [], draftResource, saveResource, reload: vi.fn(), setAgentSelection: vi.fn()
  };
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  Object.assign(sidebar, {
    activeSession: session, activeExecutions: new Map(), resourceOperations: new Set(), conversationSelections: new Map(),
    sessions: new Map([[session.id, session]]), pendingPatches: new Map(), openConversations: [session.id],
    application, history, postAgentEvent: vi.fn(), post: async (message: WebviewResponse) => { messages.push(structuredClone(message)); },
    postConversationState: vi.fn(), refresh: vi.fn(), updateRunningContext: vi.fn(),
    persistProviderSessions: vi.fn(), flushAttachmentDeletes: vi.fn(), uiInteraction: vi.fn(), hydrateSessions: vi.fn(),
    persistConversationLayout: vi.fn(), preferences: { setConversationSelection: vi.fn() }
  });
  const host = sidebar as unknown as {
    activeSession: DextHistorySession;
    activeExecutions: Map<string, { controller: AbortController }>;
    run(mode: string, source: string): Promise<void>;
    receive(message: unknown): Promise<void>;
  };
  return { session, sidebar, host, history, messages, draftResource, saveResource };
}

describe("resource conversations", () => {
  it("opens and persists a new dedicated tab with read-only generation", async () => {
    const h = harness();
    await h.host.receive({ type: "openResourceCreator" });
    expect(h.host.activeSession.id).not.toBe(h.session.id);
    expect(h.host.activeSession.resource).toEqual({ type: "api", scope: "project" });
    expect(conversationTitle(h.host.activeSession)).toBe("New resource");
    expect(h.history.list().find((item) => item.id === h.host.activeSession.id)?.resource).toEqual({ type: "api", scope: "project" });
  });

  it("keeps rapid new-tab requests separate while history is being persisted", async () => {
    const h = harness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(h.sidebar, { preferences: { setConversationSelection: () => pending } });
    const first = h.host.receive({ type: "openResourceCreator" });
    const firstId = h.host.activeSession.id;
    const second = h.host.receive({ type: "openResourceCreator" });
    const secondId = h.host.activeSession.id;
    expect(secondId).not.toBe(firstId);
    release();
    await Promise.all([first, second]);
    expect(h.history.list().map((session) => session.id)).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(h.messages.filter((message) => message.type === "outputSession").map((message) => message.session.id)).toEqual([secondId]);
  });

  it("records a resource turn and retains the draft across history reload", async () => {
    const h = harness();
    await h.host.run("agent", "Create a review rule");
    expect(h.draftResource).toHaveBeenCalledOnce();
    expect(h.session.turns[0]?.mode).toBe("ask");
    expect(h.saveResource).not.toHaveBeenCalled();
    expect(h.history.list()[0]?.resource?.draft).toEqual({ name: "review", content: "Review carefully" });
    expect(conversationTitle(h.session)).toBe("review");
    expect(h.messages.some((message) => message.type === "execution" && message.sessionId === "resource")).toBe(true);
  });

  it("keeps background drafts attached to their original tab", async () => {
    const h = harness();
    const other: DextHistorySession = { id: "chat", createdAt: 1, updatedAt: 1, turns: [] };
    const generate = h.draftResource.getMockImplementation()!;
    h.draftResource.mockImplementation(async (...args) => { h.host.activeSession = other; return generate(...args); });
    await h.host.run("agent", "Generate");
    expect(other.resource).toBeUndefined();
    expect(other.turns).toEqual([]);
    expect(h.session.resource?.draft?.name).toBe("review");
  });

  it("preserves the previous draft after cancellation even if the provider returns a result", async () => {
    const h = harness();
    h.session.resource!.draft = { name: "earlier", content: "Keep this draft" };
    const generate = h.draftResource.getMockImplementation()!;
    h.draftResource.mockImplementation(async (...args) => {
      h.host.activeExecutions.get("resource")!.controller.abort();
      return generate(...args);
    });
    await h.host.run("ask", "Revise");
    expect(h.session.resource?.draft?.content).toBe("Keep this draft");
    expect(h.session.turns[0]?.error).toContain("stopped");
  });

  it("saves only on request, keeps the tab open, and uses the saved document for future revisions", async () => {
    const h = harness();
    await h.host.run("ask", "Generate");
    await h.host.receive({ type: "saveResource", sessionId: "resource" });
    expect(h.saveResource).toHaveBeenCalledOnce();
    expect(h.host.activeSession).toBe(h.session);
    expect(h.session.resource).toMatchObject({ saved: true, target: { path: "review.md", content: "Review carefully" } });
    expect(h.session.resource?.draft).toBeUndefined();
    await h.host.run("ask", "Revise the saved rule");
    expect(h.draftResource.mock.calls[1]?.[0].target?.path).toBe("review.md");
  });

  it("makes a scope change a copy and retains the unsaved document", async () => {
    const h = harness();
    h.session.resource!.target = { name: "review", content: "Original", path: "review.md" };
    h.session.resource!.draft = { name: "review", content: "Revised" };
    await h.host.receive({ type: "resourceOptions", sessionId: "resource", resourceType: "rule", scope: "project" });
    expect(h.session.resource).toEqual({ type: "rule", scope: "project", draft: { name: "review", content: "Revised" } });
    expect(h.saveResource).not.toHaveBeenCalled();
  });

  it("keeps drafts on save failure and reports errors to the owning tab", async () => {
    const h = harness();
    await h.host.run("ask", "Generate");
    h.saveResource.mockRejectedValue(new Error("File changed"));
    await h.host.receive({ type: "saveResource", sessionId: "resource" });
    expect(h.session.resource?.draft?.content).toBe("Review carefully");
    expect(h.messages.at(-1)).toEqual({ type: "error", sessionId: "resource", message: "File changed" });
  });
});
