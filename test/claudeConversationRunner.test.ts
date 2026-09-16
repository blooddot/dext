import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  claudeAnswerMap, claudeAskUserQuestion, claudeControlArguments, claudePermissionMode, runClaudeConversation
} from "../src/core/agentRunner.js";
import type { AgentConversationRequest } from "../src/core/agentRunner.js";
import type { AgentInputRequest, AgentStreamEvent, ExecutionMetadata, UiFormResult } from "../src/core/types.js";
import type { UiFormDefinition } from "../src/core/uiForm.js";

const fixture = resolve("test/fixtures/claudeAgent.mjs");

function setup(overrides: Partial<AgentConversationRequest> = {}, answer: string[] = ["B"], pendingAnswer = false) {
  const events: AgentStreamEvent[] = [];
  const form = vi.fn<(definition: UiFormDefinition) => Promise<UiFormResult>>(async () => ({ kind: "ui", type: "form", status: "submitted", answers: {} }));
  const metadata: ExecutionMetadata = {
    agentSessionId: "dext-tab",
    requestAgentInput: vi.fn(async (input: AgentInputRequest) => pendingAnswer ? new Promise<never>(() => {})
      : Object.fromEntries(input.questions.map((question) => [question.id,
        { answers: question.options.length ? answer : ["typed"] }]))),
    ui: { form }
  };
  const request: Omit<AgentConversationRequest, "metadata"> & { metadata: ExecutionMetadata } = {
    profile: { provider: "claude", command: "claude", label: "Claude" } as AgentConversationRequest["profile"],
    mode: "agent", cwd: process.cwd(), input: "question", allowWorkspaceWrite: false,
    metadata, onEvent: (event: AgentStreamEvent) => events.push(event), ...overrides
  };
  const onSession = vi.fn();
  const run = (input: string) => runClaudeConversation({ ...request, input }, {
    command: process.execPath, args: [fixture], timeoutMs: 10_000, idleTimeoutMs: 5_000, onSession
  });
  return { metadata, form, events, run, onSession, request };
}

describe("Claude control-protocol arguments", () => {
  it("opens the reverse channel and routes every prompt to the host", () => {
    expect(claudeControlArguments({ permission: "read-only" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "plan"
    ]);
    expect(claudeControlArguments({ permission: "full-access", model: "sonnet", reasoningEffort: "high", resumeId: "abc", forkSession: true },
      ["--add-dir", "C:/x"])).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--include-partial-messages", "--permission-prompt-tool", "stdio",
      "--resume", "abc", "--fork-session", "--permission-mode", "bypassPermissions",
      "--model", "sonnet", "--effort", "high", "--add-dir", "C:/x"
    ]);
    expect((["read-only", "workspace-write", "full-access"] as const).map((permission) => claudePermissionMode(permission)))
      .toEqual(["plan", "acceptEdits", "bypassPermissions"]);
  });

  it("gives Claude's questions stable ids while keeping the text its answers are keyed by", () => {
    const asked = claudeAskUserQuestion({ questions: [
      { question: "Which target?", header: "Target", multiSelect: true, options: [{ label: "A", description: "First" }, { label: "B", description: "" }] },
      { question: "Notes?", header: "", multiSelect: false, options: [] }
    ] });
    expect(asked?.questions).toEqual([
      { id: "question-1", header: "Target", question: "Which target?", multiSelect: true,
        options: [{ label: "A", description: "First" }, { label: "B", description: "" }] },
      { id: "question-2", header: "", question: "Notes?", options: [] }
    ]);
    expect(claudeAnswerMap(asked!.questions, asked!.texts, { "question-1": { answers: ["A", "B"] }, "question-2": { answers: ["later"] } }))
      .toEqual({ "Which target?": "A, B", "Notes?": "later" });
    expect(claudeAnswerMap(asked!.questions, asked!.texts, null)).toBeUndefined();
    expect(claudeAskUserQuestion({ questions: [] })).toBeUndefined();
    expect(claudeAskUserQuestion({ questions: [{ question: "   ", options: [] }] })).toBeUndefined();
  });
});

describe("Claude interactive conversations", () => {
  it("answers AskUserQuestion through Dext's card", async () => {
    const { metadata, run, onSession } = setup();
    expect(await run("question")).toBe(`answers=${JSON.stringify({ "Which one?": "B" })}`);
    expect((metadata.requestAgentInput as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      blocking: true, questions: [{ id: "question-1", header: "Confirm", question: "Which one?",
        options: [{ label: "A", description: "The first choice" }, { label: "B", description: "" }] }]
    });
    expect(onSession).toHaveBeenCalledOnce();
  });

  it("joins multi-select answers and keeps free text", async () => {
    const { run } = setup({}, ["A", "B"]);
    expect(await run("question-multi")).toBe(`answers=${JSON.stringify({ "Which targets?": "A, B", "Anything else?": "typed" })}`);
  });

  it("shows an ordinary tool call as a permission card and denies it when dismissed", async () => {
    const { form, run } = setup();
    expect(await run("permission")).toBe("decision=allow");
    expect(form).toHaveBeenCalledOnce();
    expect(form.mock.calls[0]![0]).toMatchObject({ description: "Write\n\nC:/ws/out.txt" });

    const denied = setup();
    denied.request.metadata = { ...denied.request.metadata, ui: { form: vi.fn(async (): Promise<UiFormResult> =>
      ({ kind: "ui", type: "form", status: "cancelled", answers: {} })) } };
    expect(await denied.run("permission")).toBe("decision=deny");
  });

  it("routes MCP elicitation to the same question card", async () => {
    // The card reports the label the user read, so the answer maps back to the
    // value that label stands for.
    const { run } = setup({}, ["Workspace"]);
    expect(await run("elicitation")).toBe(`elicitation=${JSON.stringify({ action: "accept", content: { scope: "workspace", notes: "typed" } })}`);
  });

  it("closes the card when the CLI cancels its own request", async () => {
    const { metadata, run } = setup({}, ["B"], true);
    expect(await run("cancelled")).toBe("cancelled");
    const signal = (metadata.requestAgentInput as ReturnType<typeof vi.fn>).mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  it("fails a crashed turn without retrying", async () => {
    const { run } = setup();
    await expect(run("crash")).rejects.toThrow(/exited with code 7/i);
  });

  it("reports an error result instead of returning it as the answer", async () => {
    const { run } = setup();
    await expect(run("error-result")).rejects.toThrow(/turn limit/i);
  });

  it("cancels a running turn and times out a transport that never answers", async () => {
    const controller = new AbortController();
    const { run } = setup({ signal: controller.signal });
    const pending = run("hang");
    setTimeout(() => controller.abort(), 80);
    await expect(pending).rejects.toThrow(/cancel/i);

    const { run: idle } = setup({ input: "hang" });
    await expect(runClaudeConversation({ profile: { provider: "claude", command: "claude", label: "Claude" } as AgentConversationRequest["profile"],
      mode: "agent", cwd: process.cwd(), input: "hang", allowWorkspaceWrite: false, metadata: {} },
    { command: process.execPath, args: [fixture], timeoutMs: 0, idleTimeoutMs: 300, onSession: () => {} })).rejects.toThrow(/without process activity/i);
    void idle;
  });
});
