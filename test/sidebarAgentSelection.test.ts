import { describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/agentProfiles.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
}));

import { DextSidebarProvider } from "../src/sidebarProvider.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const discovery = deferred();
  const storage = deferred();
  let selection: AgentSelection = { profileId: "codex" };
  let models = ["cached-model"];
  const discoverHarnessModels = vi.fn(async () => {
    await discovery.promise;
    models = ["discovered-model"];
  });
  const application = {
    state: () => ({ agentSelection: { ...selection }, agentProfiles: [{ id: "deepseek-harness", models: [...models] }] }),
    setAgentSelection: (next: AgentSelection) => { selection = next; },
    agentProfiles: () => [{ id: "deepseek-harness" }],
    discoverHarnessModels
  };
  const messages: WebviewResponse[] = [];
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  const selections = new Map<string, AgentSelection>([["one", selection]]);
  const setConversationSelection = vi.fn(() => storage.promise);
  Object.assign(sidebar, {
    application,
    activeSession: { id: "one", turns: [] },
    activeExecutions: new Map(),
    conversationSelections: selections,
    preferences: { setConversationSelection },
    updateRunningContext: vi.fn(),
    post: async (message: WebviewResponse) => { messages.push(message); }
  });
  const select = (profileId: string) => (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive({
    type: "agentSelection",
    selection: { profileId, mode: "agent", permission: "workspace-write", model: "", reasoningEffort: "", speed: "", serviceTier: "" }
  });
  const states = () => messages.filter((message) => message.type === "state").map((message) => message.state);
  return { sidebar, application, discovery, storage, discoverHarnessModels, select, states, selections };
}

describe("sidebar agent selection synchronization", () => {
  it("publishes and commits DeepSeek before storage and model discovery complete", async () => {
    const h = harness();
    const request = h.select("deepseek-harness");
    expect(h.application.state().agentSelection.profileId).toBe("deepseek-harness");
    expect(h.states()[0]?.agentSelection.profileId).toBe("deepseek-harness");
    expect(h.states()[0]?.agentProfiles[0]?.models).toEqual(["cached-model"]);
    h.storage.resolve();
    await request;
    // The handler is done even though ACP has not returned a model list.
    expect(h.discoverHarnessModels).toHaveBeenCalledOnce();
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states().at(-1)?.agentProfiles[0]?.models).toEqual(["discovered-model"]));
  });

  it("keeps the latest selection when discovery completes after switching away", async () => {
    const h = harness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    await h.select("claude");
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states()).toHaveLength(3));
    expect(h.states().at(-1)?.agentSelection.profileId).toBe("claude");
    expect(h.selections.get("one")?.profileId).toBe("claude");
  });

  it("shares pending discovery across rapid switches back to DeepSeek", async () => {
    const h = harness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    await h.select("codex");
    await h.select("deepseek-harness");
    expect(h.discoverHarnessModels).toHaveBeenCalledOnce();
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states().at(-1)?.agentProfiles[0]?.models).toEqual(["discovered-model"]));
  });

  it("keeps cached models and the accepted selection when discovery fails", async () => {
    const h = harness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    h.discovery.reject(new Error("ACP unavailable"));
    await vi.waitFor(() => expect(
      (h.sidebar as unknown as { harnessModelDiscovery?: Promise<void> }).harnessModelDiscovery
    ).toBeUndefined());
    expect(h.states()).toHaveLength(1);
    expect(h.states()[0]?.agentSelection.profileId).toBe("deepseek-harness");
    expect(h.states()[0]?.agentProfiles[0]?.models).toEqual(["cached-model"]);
  });
});
