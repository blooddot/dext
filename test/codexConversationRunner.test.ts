import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexConversation, codexAppServerArguments } from "../src/core/codexConversationRunner.js";
import { CodexConversationConnection } from "../src/core/codexConversationConnection.js";
import type { AgentConversationRequest } from "../src/core/agentRunner.js";
import type { AgentInputRequest, AgentStreamEvent, ExecutionMetadata } from "../src/core/types.js";

// Preserve the real transport while substituting a deterministic child process.
// eslint-disable-next-line @typescript-eslint/unbound-method
const start = CodexConversationConnection.prototype.start;
afterEach(() => vi.restoreAllMocks());

function setup(scenario = "blocking", overrides: Partial<AgentConversationRequest> = {}) {
  vi.spyOn(CodexConversationConnection.prototype, "start").mockImplementation(function (this: CodexConversationConnection, _command, _args, cwd, env) {
    return start.call(this, process.execPath, [resolve("test/fixtures/codexConversationServer.mjs")], cwd, env);
  });
  const events: AgentStreamEvent[] = [];
  const metadata: ExecutionMetadata = {
    agentSessionId: "dext-tab", requestAgentInput: vi.fn(async (input: AgentInputRequest) => Object.fromEntries(input.questions.map((q) => [q.id, { answers: ["No"] }])))
  };
  const request: Omit<AgentConversationRequest, "metadata"> & { metadata: ExecutionMetadata } = {
    profile: { provider: "codex", command: "codex", label: "Codex" } as AgentConversationRequest["profile"], mode: "agent", cwd: process.cwd(),
    input: "Fix drag and drop", allowWorkspaceWrite: true,
    metadata,
    onEvent: (event: AgentStreamEvent) => events.push(event), ...overrides
  };
  const onThread = vi.fn();
  const run = (options = {}) => runCodexConversation(request, {
    command: "codex", env: { ...process.env, DEXT_QUESTION_TEST: scenario }, timeoutMs: 10000, idleTimeoutMs: 5000, onThread, ...options
  });
  return { request, events, run, onThread };
}

describe("Codex interactive conversations over stdio", () => {
  it("returns a choice to the native request and completes the same turn", async () => {
    const { run, events, onThread } = setup();
    expect(await run()).toBe("Received: No");
    expect(onThread).toHaveBeenCalledWith("thread-1");
    expect(events.filter((e) => e.userInput).map((e) => e.userInput!.status)).toEqual(["waiting", "answered"]);
  });
  it("steers asynchronous answers without duplicating the plain Process question", async () => {
    const { run, events, request } = setup("async");
    expect(await run()).toContain("Does it highlight?\nNo");
    expect(request.metadata.requestAgentInput).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.text === "Question in plain text")).toBe(false);
    expect(events.find((e) => e.userInput)?.userInput?.blocking).toBe(false);
  });
  it("closes outstanding asynchronous cards when the turn completes", async () => {
    const { run, events, request } = setup("expires");
    let signal: AbortSignal | undefined;
    request.metadata.requestAgentInput = (_input, current) => new Promise((resolve) => {
      signal = current; current.addEventListener("abort", () => resolve(null));
    });
    expect(await run()).toBe("Received: expired");
    expect(signal?.aborted).toBe(true);
    expect(events.filter((e) => e.userInput).map((e) => e.userInput!.status)).toEqual(["waiting", "dismissed"]);
  });
  it("cancels blocking questions without reporting completion", async () => {
    const controller = new AbortController();
    const { run, events, request } = setup("blocking", { signal: controller.signal });
    request.metadata.requestAgentInput = (_input, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null)); setTimeout(() => controller.abort(), 30);
    });
    await expect(run()).rejects.toThrow(/cancel/i);
    expect(events.at(-1)?.userInput?.status).toBe("dismissed");
  });
  it("does not idle-timeout while the user is answering a blocking question", async () => {
    const { run, request } = setup();
    request.metadata.requestAgentInput = () => new Promise((resolve) => setTimeout(() => resolve({ q1: { answers: ["Custom answer"] } }), 650));
    expect(await run({ idleTimeoutMs: 500 })).toBe("Received: Custom answer");
  });
  it("honors provider-side resolution", async () => {
    const { run, events, request } = setup("resolved");
    request.metadata.requestAgentInput = (_input, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null)));
    expect(await run()).toBe("Received: resolved");
    expect(events.filter((e) => e.userInput).map((e) => e.userInput!.status)).toEqual(["waiting", "dismissed"]);
  });
  it("reports failed answer delivery and expires the card", async () => {
    const { run, events } = setup("steer-fails");
    await expect(run()).rejects.toThrow("no longer accepts answers");
    expect(events.at(-1)?.userInput?.status).toBe("dismissed");
  });
  it("skips without choosing an option for the user", async () => {
    const { run, request } = setup(); request.metadata.requestAgentInput = async () => null;
    expect(await run()).toBe("Received: skipped");
  });
  it("does not put secret answers into persisted input events", async () => {
    const { run, events } = setup("secret"); await run();
    expect(events.find((e) => e.userInput?.status === "answered")?.userInput?.answers).toEqual({});
  });
  it("preserves model, permission gate, native resume/fork and context", async () => {
    const { run } = setup("config", { allowWorkspaceWrite: false, permission: "full-access", model: "configured-model", reasoningEffort: "high" });
    const reply = JSON.parse((await run({ resumeId: "prior-thread", serviceTier: "priority" })).slice("Received: ".length)) as { config: unknown };
    expect(reply.config).toMatchObject({ method: "thread/resume", threadId: "prior-thread", sandbox: "read-only", model: "configured-model", approvalPolicy: "never", serviceTier: "priority" });
  });
  it("surfaces process failure instead of leaving an empty Output", async () => {
    await expect(setup("exit").run()).rejects.toThrow(/exited/);
  });
  it("allows config flags but rejects flags that would break the stdio connection", () => {
    expect(codexAppServerArguments(["-c", 'foo="bar"', "--enable", "feature"])).toEqual(["app-server", "-c", 'foo="bar"', "--enable", "feature"]);
    expect(() => codexAppServerArguments(["--listen", "ws://localhost:9000"])).toThrow("do not support");
  });
});
