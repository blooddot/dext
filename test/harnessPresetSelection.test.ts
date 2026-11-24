import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarnessRunner } from "../src/features/agents/host/deepseekHarnessRunner.js";
import { DeepSeekHarnessTransport } from "../src/features/agents/host/deepseekHarnessTransport.js";
import type { AgentConversationRequest, AgentExecutionRequest } from "../src/features/agents/host/agentRunner.js";
import type { NativeConversationBaseline } from "../src/shared/contracts/conversationInstructions.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { AxAdapter } from "../src/features/agents/domain/axAdapter.js";
import { AgentProfileStore } from "../src/features/agents/host/agentProfiles.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { createHarnessPolicy, harnessBinding } from "../src/features/agents/host/deepseekHarnessPolicy.js";
import { DEFAULT_HARNESS_PRESET, harnessPresetOrDefault } from "../src/features/agents/domain/harnessPresetDefault.js";
import { webviewRequestSchema } from "../src/platform/webviewProtocol.js";

describe("Harness preset selection", () => {
  it.skipIf(!process.env.DEXT_TEST_DSH)("merges the final ACP persona on an installed Harness using a local model endpoint", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-harness-persona-"));
    const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        if (req.method !== "POST" || !body) { res.writeHead(404).end(); return; }
        const message = JSON.parse(body) as typeof requests[number];
        requests.push(message);
        const submit = message.tools?.find((tool) => tool.function.name === "dext_submit_result");
        const sendResult = submit && body.includes("LOCAL_HARNESS_STRUCTURED") && !message.messages.some((item) => item.role === "tool");
        const toolCall = { tool_calls: [{ index: 0, id: "local-submit", type: "function",
          function: { name: "dext_submit_result", arguments: '{"kind":"ask","text":"LOCAL_TYPED_RESULT"}' } }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, reason] of [[{ role: "assistant" }, null], [sendResult ? toolCall : { content: "LOCAL_HARNESS_REPLY" }, null], [{}, sendResult ? "tool_calls" : "stop"]] as const) {
          res.write(`data: ${JSON.stringify({ id: "local-answer", object: "chat.completion.chunk", created: 1, model: "local-flash", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local endpoint.");
    vi.stubEnv("DSH_HOME", root);
    vi.stubEnv("DEXT_TEST_HARNESS_KEY", "local-test-key");
    const settings = {
      defaultModel: { provider: "local", model: "local-flash" },
      piAiProviders: { local: { api: "openai-completions", apiKeyEnv: "DEXT_TEST_HARNESS_KEY",
        baseURL: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "local-flash", name: "Local Flash" }] } }
    };
    const create = () => new DeepSeekHarnessRunner(15000, (command, args, cwd, client) =>
      new DeepSeekHarnessTransport(command, args, cwd, client), async () => settings);
    const patch = join(root, "user.json");
    await writeFile(patch, JSON.stringify([{ id: "system-prompt", config: { personaSuffix: "LOCAL_USER_PERSONA" } }]));
    try {
      for (const preset of [undefined, "standard", "ptc"]) {
        let id = "", baseline: NativeConversationBaseline | undefined;
        const request: AgentConversationRequest = {
          profile: { id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: process.env.DEXT_TEST_DSH!, models: [] },
          mode: "ask", cwd: root, allowWorkspaceWrite: false, input: "LOCAL_HARNESS_USER", cliArguments: ["--patch", patch],
          ...(preset ? { agentPreset: preset } : {}), conversationInstructions: { outputLanguage: "zh-CN" },
          metadata: { agentSessionId: "persona", onAgentSessionId: (_provider, current, applied) => { id = current; baseline = applied; } }
        };
        const first = create();
        try { expect(await first.runConversation(request)).toBe("LOCAL_HARNESS_REPLY"); }
        finally { await first.dispose(); }
        expect(baseline).toMatchObject({ outputLanguage: "zh-CN" });
        const initial = requests.at(-1)!;
        const system = JSON.stringify(initial.messages.filter((message) => message.role === "system"));
        expect(system.split("Simplified Chinese (zh-CN)")).toHaveLength(2);
        if (!preset) expect(system).toContain("LOCAL_USER_PERSONA");
        expect(JSON.stringify(initial.messages.filter((message) => message.role === "user"))).not.toContain("Simplified Chinese (zh-CN)");
        const next = create(), priorId = id;
        try {
          const lifecycle: string[] = [];
          await next.runConversation({ ...request, input: "LOCAL_HARNESS_RESUMED", conversationInstructions: { outputLanguage: null },
            onEvent: (event) => { if (event.id?.startsWith("harness-session:")) lifecycle.push(event.text); },
            metadata: { ...request.metadata, conversationProviderSessionId: priorId, conversationInstructionBaseline: { ...baseline!, sessionId: priorId } } });
          expect(id, `${preset ?? "default"}: ${lifecycle.join("\n")}`).toBe(priorId);
          expect(JSON.stringify(requests.at(-1)?.messages)).toContain("Clear Dext's language preference");
        } finally { await next.dispose(); }
      }
      const method = { ...BUILTIN_METHODS.find((item) => item.id === "ask")!, source: "builtin" as const };
      const structured: AgentExecutionRequest = {
        profile: { id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: process.env.DEXT_TEST_DSH!, models: [] },
        cwd: root, method, allowWorkspaceWrite: false, structuredApi: true, contract: new AxAdapter().compile(method), metadata: {},
        cliArguments: ["--patch", patch],
        resolved: { method, arguments: { input: "LOCAL_HARNESS_STRUCTURED" }, context: [], metadata: {},
          invocation: { kind: "invocation", method: "ask", source: "code", arguments: [] } }
      };
      const typed = create();
      try { expect(JSON.parse(await typed.run(structured) as string)).toEqual({ kind: "ask", text: "LOCAL_TYPED_RESULT" }); }
      finally { await typed.dispose(); }
      const firstStructured = requests.find((item) => JSON.stringify(item.messages).includes("LOCAL_HARNESS_STRUCTURED"))!;
      expect(JSON.stringify(firstStructured.messages.filter((message) => message.role === "system"))).toContain("Read the labeled Dext JSON payload");
      expect(JSON.stringify(firstStructured.messages.filter((message) => message.role === "system"))).toContain("LOCAL_USER_PERSONA");
      expect(JSON.stringify(firstStructured.messages.filter((message) => message.role === "user"))).not.toContain("Read the labeled Dext JSON payload");
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("preserves each conversation's preset and reads an unset one as the Harness default", async () => {
    const values = new Map<string, unknown>();
    const state = { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
      update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); } };
    const profiles = new AgentProfileStore(state as never);
    profiles.setSelection({ profileId: "deepseek-harness", agentPreset: "ptc" });
    expect(new AgentProfileStore(state as never).currentSelection().agentPreset).toBe("ptc");
    const preferences = new DextConversationPreferences(state as never);
    await preferences.setConversationSelection("one", { profileId: "deepseek-harness", agentPreset: "ptc" });
    await preferences.setConversationSelection("two", { profileId: "deepseek-harness", agentPreset: "" });
    const restored = new DextConversationPreferences(state as never);
    expect(restored.conversationSelection("one")?.agentPreset).toBe("ptc");
    // A selection persisted before presets were mandatory still round-trips as
    // empty; every reader resolves it to the Harness default.
    expect(restored.conversationSelection("two")?.agentPreset).toBe("");
    expect(harnessPresetOrDefault(restored.conversationSelection("two")?.agentPreset)).toBe(DEFAULT_HARNESS_PRESET);
    expect(harnessPresetOrDefault(undefined)).toBe("standard");
    expect(harnessPresetOrDefault("ptc")).toBe("ptc");
  });

  it("accepts bounded preset selections and only supported management actions", () => {
    const selection = { mode: "agent", permission: "workspace-write", profileId: "deepseek-harness", model: "", reasoningEffort: "", speed: "", serviceTier: "", agentPreset: "ptc" };
    expect(webviewRequestSchema.parse({ type: "agentSelection", selection })).toMatchObject({ selection: { agentPreset: "ptc" } });
    expect(webviewRequestSchema.safeParse({ type: "agentSelection", selection: { ...selection, agentPreset: "x".repeat(129) } }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "harnessPresetAction", action: "copy" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "harnessPresetAction", action: "delete-all" }).success).toBe(false);
  });

  it("binds native sessions to their preset without changing legacy bindings", async () => {
    const cwd = process.cwd();
    const baseline = await harnessBinding(cwd, "read-only", "dsh", []);
    expect(await harnessBinding(cwd, "read-only", "dsh", [], undefined, "")).toBe(baseline);
    const standard = await harnessBinding(cwd, "read-only", "dsh", [], undefined, "standard");
    expect(standard).not.toBe(baseline);
    expect(await harnessBinding(cwd, "read-only", "dsh", [], undefined, "ptc")).not.toBe(standard);
  });

  it("keeps final permission policy after preset composition and keeps the ACP adapter", async () => {
    const adapter = { insert: [{ id: "dext-acp-presets", name: "file:///adapter.mjs", config: { preset: "standard" } }] };
    const policy = await createHarnessPolicy("read-only", process.cwd(), { defaultModel: { provider: "test", model: "test-model" } }, [{ id: "acp", disabled: true }, adapter]);
    try {
      const rows = JSON.parse(await readFile(policy.path, "utf8")) as { id: string; config: unknown }[];
      expect(rows[0]).toEqual({ id: "acp", disabled: true });
      expect(rows[1]).toEqual(adapter);
      expect(rows.filter((row) => row.id === "acp").at(-1)).toMatchObject({ config: { provider: "test", model: "test-model" } });
      expect(rows.at(-1)).toMatchObject({ id: "permission", config: { defaultPreset: "read-only" } });
      expect(rows.find((row) => row.id === "sandbox-policy")).toMatchObject({ config: { mode: "read-only" } });
    } finally { await policy.dispose(); }
  });
});
