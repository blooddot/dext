import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationRequest } from "../src/features/agents/host/agentRunner.js";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";
import { PiAgentRunner, type PiRunnerOptions } from "../src/features/agents/host/piAgentRunner.js";
import { PiRpcTransport } from "../src/features/agents/host/piRpcTransport.js";
import { decodePiSession, encodePiSession } from "../src/features/agents/domain/piModels.js";

const roots: string[] = [], runners: PiAgentRunner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});
async function setup(flags: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "dext-pi-runner-")); roots.push(root);
  const logPath = join(root, "commands.jsonl");
  const options: PiRunnerOptions = { extensionPath: resolve("media/pi-extension.mjs"), sessionDirectory: join(root, "sessions"), versionProbe: async () => {},
    transportFactory: (_command, args, cwd, env) => new PiRpcTransport(process.execPath, [resolve("test/fixtures/piAgent.mjs"), ...flags, ...args], cwd, { ...env, PI_FIXTURE_LOG: logPath }) };
  const create = () => { const runner = new PiAgentRunner(options); runners.push(runner); return runner; };
  const request = (input: string, fields: Partial<AgentConversationRequest> = {}): AgentConversationRequest => ({
    profile: { id: "pi", provider: "pi", label: "Pi", command: process.execPath, models: [] }, cwd: root, workspaceTrusted: true,
    input, mode: "ask", allowWorkspaceWrite: false, permission: "read-only", metadata: { agentSessionId: "chat" }, ...fields
  });
  const log = async (): Promise<Record<string, unknown>[]> => { try { return (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>); } catch { return []; } };
  return { root, runner: create(), create, request, log };
}
describe("Pi conversation runner", { timeout: 30000 }, () => {
  it("reuses one process, bootstraps only a fresh session and resets explicit defaults", async () => {
    const h = await setup();
    expect(await h.runner.runConversation(h.request("first", { reasoningEffort: "off", metadata: { agentSessionId: "chat", conversationContext: "older visible context" } }))).toContain("older visible context");
    expect(await h.runner.runConversation(h.request("second"))).toBe("second");
    const log = await h.log(), prompts = log.filter((entry) => entry.command === "prompt");
    expect(log.filter((entry) => entry.startup)).toHaveLength(1);
    expect(prompts.map((entry) => entry.thinkingLevel)).toEqual(["off", "high"]);
  });
  it("waits through automatic retry and reports only this turn's usage", async () => {
    const h = await setup(), events: AgentStreamEvent[] = [];
    await h.runner.runConversation(h.request("first"));
    expect(await h.runner.runConversation(h.request("fixture:retry", { onEvent: (event) => events.push(event) }))).toBe("recovered");
    expect(events.some((event) => event.title === "auto retry start")).toBe(true);
    expect(events.filter((event) => event.usage).at(-1)?.usage?.totalTokens).toBe(10);
  });
  it("rejects exhausted retries and starts a healthy process for the next turn", async () => {
    const h = await setup();
    await expect(h.runner.runConversation(h.request("fixture:retry-fail"))).rejects.toThrow(/503/);
    expect(await h.runner.runConversation(h.request("after failure"))).toBe("after failure");
    expect((await h.log()).filter((entry) => entry.startup)).toHaveLength(2);
  });
  it("includes compaction usage but never counts prior turns again", async () => {
    const h = await setup(), events: AgentStreamEvent[] = [];
    await h.runner.runConversation(h.request("first"));
    expect(await h.runner.runConversation(h.request("fixture:compact", { onEvent: (event) => events.push(event) }))).toBe("compacted");
    expect(events.filter((event) => event.usage).at(-1)?.usage).toMatchObject({ totalTokens: 10, contextTokens: 15 });
  });
  it("pauses idle time for a silent tool and clears queues when cancelled", async () => {
    const h = await setup(), controller = new AbortController(); h.runner.setIdleTimeoutMs(50);
    const waiting = h.runner.runConversation(h.request("fixture:tool-hang", { signal: controller.signal }));
    const outcome = waiting.catch((error: unknown) => error);
    await vi.waitFor(async () => expect((await h.log()).some((entry) => entry.command === "prompt")).toBe(true), { timeout: 10000 });
    await new Promise((done) => setTimeout(done, 100)); controller.abort(); expect(await outcome).toBeInstanceOf(Error);
    const commands = (await h.log()).map((entry) => entry.command);
    expect(commands.indexOf("clear_queue")).toBeLessThan(commands.indexOf("abort"));
    expect(await h.runner.runConversation(h.request("after stop"))).toBe("after stop");
  });
  it("rejects unsupported permissions before starting a process", async () => {
    const h = await setup();
    await expect(h.runner.runConversation(h.request("write", { allowWorkspaceWrite: true, permission: "workspace-write" }))).rejects.toThrow("Explicitly select Full access");
    expect(await h.log()).toEqual([]);
  });
  it("discovers models without prompting or persisting a provider session", async () => {
    const h = await setup(), request = h.request("");
    const result = await h.runner.discoverModels(request.profile, h.root, [], "other/plain", true);
    expect(result.defaults).toEqual({ model: "test/flash", reasoningEffort: "high" });
    expect(result.options.find((option) => option.id === "other/plain")?.reasoningEfforts).toEqual(["off"]);
    const log = await h.log(); expect(log.some((entry) => entry.command === "prompt")).toBe(false);
    expect(log[0]?.startup).toContain("--no-session");
  });
  it("restores a validated native session and bootstraps forks separately", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    expect(stored).toMatch(/^pi1:/); await h.runner.dispose();
    const resumed = h.create();
    expect(await resumed.runConversation(h.request("next", { metadata: { agentSessionId: "restored", conversationProviderSessionId: stored, conversationContext: "must not duplicate" } }))).toBe("next");
    expect(await resumed.runConversation(h.request("branch", { metadata: { agentSessionId: "fork", conversationForkFrom: stored, conversationContext: "selected visible history" } }))).toContain("selected visible history");
    expect((await h.log()).some((entry) => Array.isArray(entry.startup) && entry.startup.includes("--session"))).toBe(true);
  });
  it("rejects a missing or external stored session rather than silently resuming latest", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const binding = decodePiSession(stored).binding;
    await expect(h.runner.runConversation(h.request("missing", { metadata: { agentSessionId: "missing", conversationProviderSessionId: encodePiSession({ binding, path: join(h.root, "missing.jsonl") }) } }))).rejects.toThrow("missing");
    const outside = join(h.root, "external.jsonl"); await writeFile(outside, "{}");
    await expect(h.runner.runConversation(h.request("outside", { metadata: { agentSessionId: "outside", conversationProviderSessionId: encodePiSession({ binding, path: outside }) } }))).rejects.toThrow("outside Dext");
  });
  it("cancels active and queued operations together on endSession", async () => {
    const h = await setup();
    const first = h.runner.runConversation(h.request("fixture:hang")), second = h.runner.runConversation(h.request("must not start"));
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(async () => expect((await h.log()).some((entry) => entry.command === "prompt")).toBe(true), { timeout: 10000 });
    h.runner.endSession("chat");
    expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect((await h.log()).filter((entry) => entry.command === "prompt")).toHaveLength(1);
  });
  it("disposes during initialization and rejects future work", async () => {
    const h = await setup(["--no-handshake"]);
    const waiting = h.runner.runConversation(h.request("never")); const outcome = waiting.catch((error: unknown) => error);
    await vi.waitFor(async () => expect((await h.log()).length).toBeGreaterThan(0), { timeout: 10000 });
    await h.runner.dispose(); expect(await outcome).toBeInstanceOf(Error);
    await expect(h.runner.runConversation(h.request("later"))).rejects.toThrow(/cancelled/i);
  });
  it("waits for detached endSession cleanup when disposed immediately afterwards", async () => {
    const h = await setup(["--hang-on-close"]);
    await h.runner.runConversation(h.request("complete"));
    const pid = (await h.log()).find((entry) => entry.pid)?.pid as number;
    h.runner.endSession("chat"); await h.runner.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it.each(["handled", "queued"])("does not treat prompt disposition %s as a completed task", async (disposition) => {
    const h = await setup();
    await expect(h.runner.runConversation(h.request(`fixture:${disposition}`))).rejects.toThrow(disposition === "handled" ? "without starting" : "queued");
  });
  it("rejects corrupt native history and can still start a separate session", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("first", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    await h.runner.dispose(); await writeFile(decodePiSession(stored).path, "broken");
    const runner = h.create();
    await expect(runner.runConversation(h.request("resume", { metadata: { agentSessionId: "resume", conversationProviderSessionId: stored } }))).rejects.toThrow(/exited|closed/);
    expect(await runner.runConversation(h.request("fresh", { metadata: { agentSessionId: "fresh" } }))).toBe("fresh");
  });
});
