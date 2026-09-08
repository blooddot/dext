import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { DeepSeekHarnessRunner } from "../src/core/deepseekHarnessRunner.js";
import { DeepSeekHarnessTransport } from "../src/core/deepseekHarnessTransport.js";
import type { AgentStreamEvent } from "../src/core/types.js";
import { decodeHarnessSession } from "../src/core/deepseekHarnessPolicy.js";
import type { AgentConversationRequest, AgentExecutionRequest } from "../src/core/agentRunner.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";

const runners: DeepSeekHarnessRunner[] = [];
const fixture = resolve("test/fixtures/acpAgent.mjs");
function runner(timeout = 15000) {
  const value = new DeepSeekHarnessRunner(timeout, (_command, _args, cwd, client) => new DeepSeekHarnessTransport(process.execPath, [fixture], cwd, client));
  runners.push(value); return value;
}
function request(input = "hello", key = "conversation"): AgentConversationRequest {
  return { profile: { id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: process.execPath, models: [] }, cwd: process.cwd(), input, mode: "ask", allowWorkspaceWrite: false, metadata: { agentSessionId: key } };
}
afterEach(async () => { await Promise.all(runners.splice(0).map((value) => value.dispose())); });

describe("Harness runner", { timeout: 15000 }, () => {
  it("loads Harness settings once, unless an explicit refresh requests a new snapshot", async () => {
    const loader = vi.fn(async () => undefined);
    const value = new DeepSeekHarnessRunner(15000, (_command, _args, cwd, client) => new DeepSeekHarnessTransport(process.execPath, [fixture], cwd, client), loader);
    runners.push(value);
    await Promise.all([value.preloadSettings(), value.preloadSettings()]);
    expect(loader).toHaveBeenCalledOnce();
    await value.refreshSettings();
    expect(loader).toHaveBeenCalledTimes(2);
  });
  it("disposes model discovery while its handshake is pending", async () => {
    const value = new DeepSeekHarnessRunner(15000, (_command, _args, cwd, client) => new DeepSeekHarnessTransport(process.execPath, [fixture, "--no-handshake"], cwd, client));
    runners.push(value);
    const discovery = expect(value.discoverModels(request().profile, process.cwd())).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await value.dispose();
    await discovery;
  });
  it("streams ACP plan snapshots without marking unfinished work completed at the end of a turn", async () => {
    const events: AgentStreamEvent[] = [];
    await runner().runConversation({ ...request("todo"), onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.phase === "todo").map((event) => event.todos?.map((item) => item.status)))
      .toEqual([["in_progress", "pending"], ["completed", "in_progress"]]);
  });
  it("keeps the final message separate from progress and merges tool lifecycle", async () => {
    const r = runner(), req = request(), onEvent = vi.fn<(event: AgentStreamEvent) => void>();
    expect(await r.runConversation({ ...req, onEvent })).toBe("hello");
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.phase === "tool")).toMatchObject([{ done: false }, { done: true, replace: true, text: "done" }]);
  });
  it("serializes one conversation and isolates concurrent conversations", async () => {
    const r = runner();
    expect(await Promise.all([r.runConversation(request("slow")), r.runConversation(request("second")), r.runConversation(request("other", "other"))])).toEqual(["slow", "second", "other"]);
  });
  it("resumes across runners and creates a new binding when permission changes", async () => {
    const r = runner(), save = vi.fn();
    await r.runConversation({ ...request(), metadata: { agentSessionId: "one", onAgentSessionId: save } });
    const original = save.mock.calls[0]![1] as string;
    await r.dispose();
    const next = runner();
    await next.runConversation({ ...request(), metadata: { agentSessionId: "one", conversationProviderSessionId: original, onAgentSessionId: save } });
    expect(save.mock.calls[1]![1]).toBe(original);
    await next.runConversation({ ...request(), allowWorkspaceWrite: true, permission: "workspace-write", metadata: { agentSessionId: "one", conversationProviderSessionId: original, conversationContext: "previous", onAgentSessionId: save } });
    expect(decodeHarnessSession(save.mock.calls[2]![1] as string).id).not.toBe(decodeHarnessSession(original).id);
  });
  it("forks into a fresh session using Dext context", async () => {
    const text = await runner().runConversation({ ...request("new task"), metadata: { agentSessionId: "fork", conversationForkFrom: "source", conversationContext: "earlier task" } });
    expect(text).toContain("earlier task"); expect(text).toContain("new task");
  });
  it("discovers models and reasoning without submitting prompts", async () => {
    const options = await runner().discoverModels(request().profile, process.cwd());
    expect(options.map((item) => item.id)).toEqual(["model-a", "model-b"]);
    expect(options.map((item) => item.group)).toEqual(["DeepSeek", "openai"]);
      expect(options.every((item) => item.reasoningEfforts.join() === "low,high")).toBe(true);
      expect(options.filter((item) => item.isDefault).map((item) => item.id)).toEqual(["model-a"]);
      expect(options.every((item) => item.defaultReasoningEffort)).toBe(true);
  });
  it("rejects unsupported model settings", async () => {
    await expect(runner().runConversation({ ...request(), model: "missing" })).rejects.toThrow("unavailable");
    await expect(runner().runConversation({ ...request(), reasoningEffort: "invalid" })).rejects.toThrow("reasoning");
  });
  it("rejects escalation in a restricted scope without prompting", async () => {
    expect(await runner().runConversation(request("permission"))).toContain('"optionId":"reject"');
  });
  it("uses the existing UI for known full-access permission requests", async () => {
    const confirm = vi.fn(async () => ({ kind: "ui" as const, type: "confirm" as const, confirmed: true }));
    const req = request("permission");
    const text = await runner().runConversation({ ...req, allowWorkspaceWrite: true, permission: "full-access", metadata: { ...req.metadata, ui: { confirm, choose: vi.fn(), input: vi.fn() } } });
    expect(text).toContain('"optionId":"allow"'); expect(confirm).toHaveBeenCalledOnce();
  });
  it("cancels a running turn and rejects a timed-out turn", async () => {
    const r = runner(), controller = new AbortController(), onEvent = vi.fn();
    await r.runConversation(request());
    const task = r.runConversation({ ...request("hang"), signal: controller.signal, onEvent });
    setTimeout(() => controller.abort(), 100);
    await expect(task).rejects.toThrow(/cancel/i);
    await expect(runner(150).runConversation(request("hang"))).rejects.toThrow(/timed out/i);
  });
  it("fails a crashed turn without retrying", async () => {
    await expect(runner().runConversation(request("crash"))).rejects.toThrow(/exited|closed/i);
  });
  it("parses only final JSON and does not rerun invalid structured output", async () => {
    const method = { ...BUILTIN_METHODS.find((item) => item.id === "ask")!, source: "builtin" as const };
    const req: AgentExecutionRequest = { profile: request().profile, cwd: process.cwd(), method, metadata: {}, contract: new AxAdapter().compile(method), resolved: {
      method, arguments: { input: "hello" }, context: [], metadata: {}, invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] }
    } };
    expect(await runner().run(req)).toEqual({ kind: "chat", text: "typed answer" });
    req.resolved.arguments.input = "bad-json";
    await expect(runner().run(req)).rejects.toThrow("not retried");
  });
});
