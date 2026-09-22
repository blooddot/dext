import { describe, expect, it, vi } from "vitest";
// Load the application during test collection. Its dependency graph can take
// longer than a hook's timeout to transform while the whole suite runs in parallel.
import { DextApplication } from "../src/application.js";
import type { ProjectAiActivityEvent, ProjectAiProvider, ProjectAiRequest } from "../src/core/projectAiGeneration.js";
import type { AgentStreamEvent } from "../src/core/types.js";

vi.mock("vscode", () => ({
  Uri: { file: (path: string) => ({ scheme: "file", fsPath: path, toString: () => path }) },
  workspace: {
    workspaceFolders: undefined,
    isTrusted: true,
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback })
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: () => Promise.resolve() },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
}));

type Provider = "codex" | "claude" | "deepseek-harness";
type Metadata = Record<string, unknown>;

function projectRequest(overrides: Partial<ProjectAiRequest> = {}): ProjectAiRequest {
  return {
    prompt: "Generate the Project model.",
    responseSchema: { type: "object", properties: { title: { type: "string" } } },
    inputHash: "hash",
    promptVersion: "project-knowledge-5",
    attempt: 1,
    maxOutputTokens: 32_000,
    ...overrides
  };
}

/** `projectAiProvider` touches only the profile store and the runtime, so the
 * instance is built from the prototype and those two collaborators are stubbed
 * rather than constructing a whole extension host. */
function build(options: {
  provider: Provider;
  structured?: (input: string, schema: object, metadata: Metadata) => Promise<{ text: string; model?: string }>;
  conversation?: (mode: string, prompt: string, metadata: Metadata) => Promise<unknown>;
}) {
  const application = Object.create(DextApplication.prototype) as DextApplication;
  const executeStructuredJson = vi.fn(options.structured ?? (async () => ({ text: '{"title":"Native"}' })));
  const executeConversation = vi.fn(options.conversation ?? (async () => ({ result: { kind: "ask", text: "conversation" } })));
  Object.assign(application as unknown as Record<string, unknown>, {
    agents: {
      list: () => [{ id: options.provider, label: "Selected", provider: options.provider, command: "cmd", models: [], defaults: { model: "default-model" } }],
      currentSelection: () => ({ profileId: options.provider, model: "selected-model" })
    },
    runtime: { executeStructuredJson, executeConversation }
  });
  return { provider: application.projectAiProvider(), executeStructuredJson, executeConversation };
}

describe("Project AI transport routing", () => {
  it("runs a Codex Project turn on the provider's own output schema", async () => {
    const { provider, executeStructuredJson, executeConversation } = build({ provider: "codex" });

    const response = await provider.generate(projectRequest(), new AbortController().signal);

    expect(response).toEqual({ text: '{"title":"Native"}', model: "selected-model" });
    expect(executeStructuredJson).toHaveBeenCalledTimes(1);
    expect(executeStructuredJson.mock.calls[0]?.[1]).toEqual({ type: "object", properties: { title: { type: "string" } } });
    expect(executeStructuredJson.mock.calls[0]?.[2]).toEqual({ signal: expect.any(AbortSignal) });
    // The conversation transport is what the schema path replaces, so it must
    // not also run.
    expect(executeConversation).not.toHaveBeenCalled();
  });

  it("uses the same native channel for Claude", async () => {
    const { provider, executeStructuredJson } = build({ provider: "claude" });

    await provider.generate(projectRequest(), new AbortController().signal);

    expect(executeStructuredJson).toHaveBeenCalledTimes(1);
  });

  it("keeps the conversation transport for a provider with no schema channel", async () => {
    const { provider, executeStructuredJson, executeConversation } = build({ provider: "deepseek-harness" });

    const response = await provider.generate(projectRequest(), new AbortController().signal);

    expect(response.text).toBe("conversation");
    expect(executeStructuredJson).not.toHaveBeenCalled();
    expect(executeConversation).toHaveBeenCalledTimes(1);
  });

  it("falls back to the conversation transport when the native call fails", async () => {
    const events: ProjectAiActivityEvent[] = [];
    const { provider, executeConversation } = build({
      provider: "codex",
      structured: async () => { throw new Error("Unknown schema keyword: $schema"); }
    });

    const response = await provider.generate(
      projectRequest({ onEvent: (event) => events.push(event) }),
      new AbortController().signal
    );

    expect(response.text).toBe("conversation");
    expect(executeConversation).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.title)).toEqual(["Native output schema unavailable"]);
    expect(events[0]?.text).toContain("Unknown schema keyword");
  });

  it("propagates a cancellation instead of downgrading the transport", async () => {
    const controller = new AbortController();
    const { provider, executeConversation } = build({
      provider: "codex",
      structured: async () => { controller.abort(); throw new Error("Project generation was cancelled."); }
    });

    await expect(provider.generate(projectRequest(), controller.signal)).rejects.toThrow("cancelled");
    expect(executeConversation).not.toHaveBeenCalled();
  });

  it("forwards only the public Project activity phases", async () => {
    const events: ProjectAiActivityEvent[] = [];
    const { provider } = build({
      provider: "codex",
      structured: async (_input, _schema, metadata) => {
        const sink = metadata.onAgentEvent as (event: AgentStreamEvent) => void;
        // Private reasoning and todo snapshots never reach the Project panel.
        sink({ phase: "reasoning", text: "hidden chain of thought" });
        sink({ phase: "todo", text: "internal plan" });
        sink({ phase: "status", text: "working", id: "s1", title: "Working" });
        return { text: "{}" };
      }
    });

    await provider.generate(projectRequest({ onEvent: (event) => events.push(event) }), new AbortController().signal);

    expect(events).toEqual([{ phase: "status", text: "working", id: "s1", title: "Working" }]);
  });

  it("records the model the Project panel would show", async () => {
    const { provider } = build({ provider: "codex" });

    // An explicitly selected CLI keeps its own default model rather than
    // inheriting the active conversation's override.
    const response = await provider.generate(projectRequest({ agent: "codex" }), new AbortController().signal);

    expect(response.model).toBe("default-model");
  });
});

describe("Project AI provider contract", () => {
  it("exposes one provider id for the generation metadata", () => {
    const { provider } = build({ provider: "codex" });
    const typed: ProjectAiProvider = provider;
    expect(typed.id).toBe("selected-agent");
  });
});
