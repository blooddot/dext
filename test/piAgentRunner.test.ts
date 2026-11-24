import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentConversationRequest, AgentExecutionRequest } from "../src/features/agents/host/agentRunner.js";
import type { AgentStreamEvent, AgentWakeReport } from "../src/shared/contracts/types.js";
import { PiAgentRunner, prunePiSessions, type PiRunnerOptions } from "../src/features/agents/host/piAgentRunner.js";
import { PiRpcTransport } from "../src/features/agents/host/piRpcTransport.js";
import { decodePiSession, encodePiSession } from "../src/features/agents/domain/piModels.js";
import type { NativeConversationBaseline } from "../src/shared/contracts/conversationInstructions.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { AxAdapter } from "../src/features/agents/domain/axAdapter.js";

const roots: string[] = [], runners: PiAgentRunner[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(runners.splice(0).map((runner) => runner.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});
async function setup(flags: string[] = [], version?: string) {
  const root = await mkdtemp(join(tmpdir(), "dext-pi-runner-")); roots.push(root);
  const logPath = join(root, "commands.jsonl");
  const options: PiRunnerOptions = { extensionPath: resolve("media/pi-extension.mjs"), sessionDirectory: join(root, "sessions"), versionProbe: async () => version,
    ...(version ? { plugins: () => [] } : {}),
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
  it("reuses the live baseline and reinstalls it after process restart against the same persisted session", async () => {
    const h = await setup([], "1.5.2");
    vi.stubEnv("PI_CODING_AGENT_DIR", h.root);
    const extra = ["--append-system-prompt", "explicit user appendix"];
    let stored = "", native: NativeConversationBaseline | undefined;
    await h.runner.runConversation(h.request("first", {
      cliArguments: extra, conversationInstructions: { outputLanguage: "zh-CN" },
      metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, id, baseline) => { stored = id; native = baseline; } }
    }));
    expect(native).toEqual({ outputLanguage: "zh-CN", version: 1 });
    expect(stored).toMatch(/^pi1:/);
    await h.runner.runConversation(h.request("second", { cliArguments: extra, conversationInstructions: { outputLanguage: "en" } }));
    expect((await h.log()).filter((entry) => entry.startup)).toHaveLength(1);
    await h.runner.dispose();
    const restarted = h.create();
    await restarted.runConversation(h.request("continued", {
      cliArguments: extra, conversationInstructions: { outputLanguage: null },
      metadata: { agentSessionId: "chat", conversationProviderSessionId: stored, conversationInstructionBaseline: { ...native!, sessionId: stored } }
    }));
    await restarted.runConversation(h.request("branched", {
      cliArguments: extra, conversationInstructions: { outputLanguage: "ja" },
      metadata: { agentSessionId: "branch", conversationForkFrom: stored, conversationContext: "Fork context" }
    }));
    const log = await h.log(), prompts = log.filter((entry) => entry.command === "prompt").map((entry) => String(entry.message));
    const launches = log.filter((entry) => Array.isArray(entry.startup)).map((entry) => entry.startup as string[]);
    const resumed = launches.find((args) => args.includes("--session"))!;
    expect(resumed).toContain(decodePiSession(stored).path);
    expect(resumed.slice(0, 3)).toEqual([...extra, "--append-system-prompt"]);
    expect(resumed[3]).toContain("Simplified Chinese (zh-CN)");
    expect(prompts[0]).toBe("first");
    expect(prompts[1]).toContain("Dext conversation language override: Use English (en)");
    expect(prompts[2]).toContain("Clear Dext's language preference");
    expect(prompts[3]).toContain("Fork context");
    expect(prompts.slice(1).every((prompt) => !prompt.includes("current turn's conversation Skill manifest"))).toBe(true);
    expect(launches.at(-1)?.[3]).toContain("Japanese (ja)");
  });

  it("keeps automatic discovery and sends inline rules when its file cannot be preserved", async () => {
    const h = await setup([], "1.5.2");
    vi.stubEnv("PI_CODING_AGENT_DIR", h.root);
    await mkdir(join(h.root, "APPEND_SYSTEM.md"));
    await h.runner.runConversation(h.request("fallback", { conversationInstructions: { outputLanguage: "en" } }));
    const log = await h.log();
    expect(log[0]?.startup).not.toContain("--append-system-prompt");
    expect(log.find((entry) => entry.command === "prompt")?.message).toContain("Dext instruction source for this turn: inline.");
  });
  it("opens a separate structured Pi process per call and preserves the user's append and result tool", async () => {
    const h = await setup([], "1.5.2");
    vi.stubEnv("PI_CODING_AGENT_DIR", h.root);
    const method = { ...BUILTIN_METHODS.find((item) => item.id === "ask")!, source: "builtin" as const };
    const request: AgentExecutionRequest = { profile: h.request("").profile, cwd: h.root, method, structuredApi: true, metadata: {},
      contract: new AxAdapter().compile(method), workspaceTrusted: true,
      resolved: { method, arguments: { input: "structured" }, context: [], metadata: {},
        invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] } },
      cliArguments: ["--append-system-prompt", "User appendix"]
    };
    for (const instruction of ["First call rule", "Second call rule"]) {
      const reply = await h.runner.run({ ...request, metadata: { agentSessionId: "no-reuse", instruction } });
      expect(JSON.parse(reply as string)).toEqual({ kind: "ask", text: "fixture answer" });
    }
    const log = await h.log();
    expect(log.filter((entry) => entry.startup)).toHaveLength(2);
    for (const record of log.filter((entry) => entry.startup)) {
      const args = record.startup as string[];
      expect(args.slice(0, 3)).toEqual(["--append-system-prompt", "User appendix", "--append-system-prompt"]);
      expect(args[3]?.split("Read the labeled Dext JSON payload")).toHaveLength(2);
      expect(args).toContain("--no-session");
      expect(args[args.indexOf("--tools") + 1]).toContain("dext_submit_result");
    }
    const prompts = log.filter((entry) => entry.command === "prompt").map((entry) => String(entry.message));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("First call rule");
    expect(prompts[1]).toContain("Second call rule");
    expect(prompts[1]).not.toContain("First call rule");
    expect(prompts.every((prompt) => !prompt.includes("Read the labeled Dext JSON payload"))).toBe(true);
  });
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
    const failure = await h.runner.runConversation(h.request("fixture:retry-fail")).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/503/);
    expect((failure as Error).message).not.toContain("refresh the model catalog");
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
  it("accepts a submitted result even when Pi settles on a tool-use stop", async () => {
    const h = await setup(), output = z.object({ value: z.string() });
    const request = { ...h.request("fixture:submit-tool-use"), contract: { outputSchema: output, outputJsonSchema: z.toJSONSchema(output) } } as unknown as AgentConversationRequest;
    await expect(h.runner.runConversation(request)).resolves.toBe(JSON.stringify({ value: "fixture answer" }));
  });
  it("still rejects a tool-use stop when nothing was submitted", async () => {
    const h = await setup();
    await expect(h.runner.runConversation(h.request("fixture:tool-use"))).rejects.toThrow("Pi stopped before producing a final response.");
  });
  it("rejects unsupported permissions before starting a process", async () => {
    const h = await setup();
    await expect(h.runner.runConversation(h.request("write", { allowWorkspaceWrite: true, permission: "workspace-write" }))).rejects.toThrow("Explicitly select Full access");
    expect(await h.log()).toEqual([]);
  });
  it("reports a run Pi starts after the turn settled instead of dropping it", async () => {
    const h = await setup(), reports: AgentWakeReport[] = [];
    await h.runner.runConversation(h.request("fixture:wake", { metadata: { agentSessionId: "chat", onAgentWake: (report) => reports.push(report) } }));
    await vi.waitFor(() => expect(reports.filter((report) => report.state === "end")).toHaveLength(1), { timeout: 10000 });
    expect(reports.find((report) => report.state === "notice")).toMatchObject({ text: expect.stringContaining("Background task completed: **worker**") });
    expect(reports.flatMap((report) => report.state === "event" ? [report.event.text] : [])).toContain("background analysis done");
    expect(reports.at(-1)).toMatchObject({ state: "end", text: "background analysis done" });
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
  it("refuses a session whose recorded workspace moved, without starting Pi", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const { binding } = decodePiSession(stored), directory = join(h.root, "sessions");
    const moved = join(h.root, "renamed-away"), path = join(directory, "moved.jsonl");
    await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "moved", timestamp: "2026-01-01T00:00:00.000Z", cwd: moved })}\n`);
    await h.runner.dispose();
    const runner = h.create(), before = (await h.log()).length;
    const failure = await runner.runConversation(h.request("next", { metadata: { agentSessionId: "moved", conversationProviderSessionId: encodePiSession({ binding, path }) } })).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`The workspace recorded by this Pi session no longer exists (${moved})`);
    expect((failure as Error).message).toContain("It was moved or deleted.");
    expect((failure as Error).message).toContain("Start a new conversation, or start again in the new location.");
    expect(await h.log()).toHaveLength(before);
  });
  it("refuses a session whose recorded workspace is a file rather than a directory", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const { binding } = decodePiSession(stored), file = join(h.root, "workspace.txt"), path = join(h.root, "sessions", "file.jsonl");
    await writeFile(file, "not a directory");
    await writeFile(path, JSON.stringify({ type: "session", cwd: file }));
    await h.runner.dispose();
    const runner = h.create(), before = (await h.log()).length;
    await expect(runner.runConversation(h.request("next", { metadata: { agentSessionId: "file", conversationProviderSessionId: encodePiSession({ binding, path }) } }))).rejects.toThrow(/no longer exists/);
    expect(await h.log()).toHaveLength(before);
  });
  it("resumes a session whose recorded workspace still exists", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const { binding } = decodePiSession(stored), path = join(h.root, "sessions", "kept.jsonl");
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "kept", timestamp: "2026-01-01T00:00:00.000Z", cwd: h.root,
      model: { provider: "test", id: "flash", reasoning: true, contextWindow: 1000 }, thinkingLevel: "high", input: 0, output: 0 }));
    await h.runner.dispose();
    const runner = h.create();
    expect(await runner.runConversation(h.request("next", { metadata: { agentSessionId: "kept", conversationProviderSessionId: encodePiSession({ binding, path }) } }))).toBe("next");
    expect((await h.log()).some((entry) => Array.isArray(entry.startup) && entry.startup.includes("--session"))).toBe(true);
  });
  it("points at the model catalog when a stored model is no longer offered", async () => {
    const h = await setup(), catalog = "refresh the model catalog in Dext: Configure Agent";
    const turn = await h.runner.runConversation(h.request("hello", { model: "gone/model" })).then(() => undefined, (error: unknown) => error);
    expect(turn).toBeInstanceOf(Error);
    expect((turn as Error).message).toContain("Pi set_model failed: Model not found");
    expect((turn as Error).message).toContain(catalog);
    const discovery = await h.runner.discoverModels(h.request("").profile, h.root, [], "gone/model", true).then(() => undefined, (error: unknown) => error);
    expect(discovery).toBeInstanceOf(Error);
    expect((discovery as Error).message).toContain("Pi set_model failed: Model not found");
    expect((discovery as Error).message).toContain(catalog);
  });
  it("rejects a missing or external stored session rather than silently resuming latest", async () => {
    const h = await setup(); let stored = "";
    await h.runner.runConversation(h.request("original", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const binding = decodePiSession(stored).binding;
    await expect(h.runner.runConversation(h.request("missing", { metadata: { agentSessionId: "missing", conversationProviderSessionId: encodePiSession({ binding, path: join(h.root, "missing.jsonl") }) } }))).rejects.toThrow("missing");
    const outside = join(h.root, "external.jsonl"); await writeFile(outside, "{}");
    await expect(h.runner.runConversation(h.request("outside", { metadata: { agentSessionId: "outside", conversationProviderSessionId: encodePiSession({ binding, path: outside }) } }))).rejects.toThrow("outside Dext");
  });
  it("closes an idle process and resumes its session file on the next turn", async () => {
    const h = await setup(); let stored = "";
    h.runner.setSessionRecycleMs(50);
    await h.runner.runConversation(h.request("first", { metadata: { agentSessionId: "chat", onAgentSessionId: (_provider, value) => { stored = value; } } }));
    const pid = (await h.log()).find((entry) => entry.pid)?.pid as number;
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10000 });
    expect(await h.runner.runConversation(h.request("second", { metadata: { agentSessionId: "chat", conversationProviderSessionId: stored } }))).toBe("second");
    const log = await h.log();
    expect(log.filter((entry) => entry.startup)).toHaveLength(2);
    expect(log.some((entry) => Array.isArray(entry.startup) && entry.startup.includes("--session"))).toBe(true);
  });
  it("drops only the oldest session files beyond the size cap", async () => {
    const h = await setup(), directory = join(h.root, "sessions");
    await mkdir(directory, { recursive: true });
    const create = async (name: string, seconds: number) => {
      const path = join(directory, name); await writeFile(path, "0123456789"); await utimes(path, seconds, seconds); return path;
    };
    const oldest = await create("oldest.jsonl", 1000), middle = await create("middle.jsonl", 2000), newest = await create("newest.jsonl", 3000);
    await mkdir(join(directory, "subagent-artifacts"));
    await prunePiSessions(directory, 25);
    await expect(readFile(oldest)).rejects.toThrow();
    expect(await readFile(middle, "utf8")).toHaveLength(10);
    expect(await readFile(newest, "utf8")).toHaveLength(10);
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
    const runner = h.create(), before = (await h.log()).length;
    const failure = await runner.runConversation(h.request("resume", { metadata: { agentSessionId: "resume", conversationProviderSessionId: stored } })).then(() => undefined, (error: unknown) => error);
    // No workspace can be read from a broken header, so Pi keeps deciding.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/exited|closed/);
    expect((failure as Error).message).not.toContain("workspace recorded by this Pi session");
    expect((await h.log()).length).toBeGreaterThan(before);
    expect(await runner.runConversation(h.request("fresh", { metadata: { agentSessionId: "fresh" } }))).toBe("fresh");
  });
});
