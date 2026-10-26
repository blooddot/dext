import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "node:http";
import { once } from "node:events";
import { PiAgentRunner } from "../src/features/agents/host/piAgentRunner.js";
import { PiRpcTransport } from "../src/features/agents/host/piRpcTransport.js";
import type { AgentExecutionRequest } from "../src/features/agents/host/agentRunner.js";

describe("Pi structured result parity", { timeout: 30000 }, () => {
  it.skipIf(!process.env.DEXT_PI_SMOKE_COMMAND)("connects an explicitly supplied installed Pi to a local model endpoint", { timeout: 60000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-pi-real-"));
    const requests: Record<string, unknown>[] = [];
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; requests.push(body);
        const messages = body.messages as { role: string; content: unknown }[];
        const tools = (body.tools ?? []) as { function: { name: string; parameters: unknown } }[];
        const submit = tools.find((tool) => tool.function.name === "dext_submit_result");
        const question = tools.find((tool) => tool.function.name === "dext_request_user_input");
        const mcp = tools.find((tool) => tool.function.name.includes("ping"));
        const input = JSON.stringify(messages.filter((message) => message.role === "user").at(-1)?.content);
        const selected = submit ?? (input.includes("QUESTION_SMOKE") ? question : input.includes("MCP_SMOKE") ? mcp : undefined);
        const answered = messages.some((message) => message.role === "tool");
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: unknown, finish_reason: string | null = null) => outgoing.write(`data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", created: 1, model: "flash", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        frame({ role: "assistant" });
        if (selected && !answered) {
          const args = submit ? { kind: "ask", text: "REAL_PI_RESULT" } : input.includes("QUESTION_SMOKE") ? { questions: [{ id: "q", question: "Choose", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] } : {};
          frame({ tool_calls: [{ index: 0, id: "local-result", type: "function", function: { name: selected.function.name, arguments: JSON.stringify(args) } }] });
          frame({}, "tool_calls");
        } else { frame({ content: "REAL_PI_TEXT" }); frame({}, "stop"); }
        outgoing.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No local endpoint.");
    await writeFile(join(root, "models.json"), JSON.stringify({ providers: { local: { api: "openai-completions", apiKey: "local-test-key", baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "flash", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(join(root, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "flash", defaultThinkingLevel: "off" }));
    const runner = new PiAgentRunner({ extensionPath: resolve("media/pi-extension.mjs"), sessionDirectory: join(root, "sessions"),
      transportFactory: (command, args, cwd, env) => new PiRpcTransport(command, args, cwd, { ...env, PI_CODING_AGENT_DIR: root }) });
    try {
      const profile = { id: "pi", provider: "pi" as const, label: "Pi", command: process.env.DEXT_PI_SMOKE_COMMAND!, models: [] };
      const discovery = await runner.discoverModels(profile, root);
      expect(discovery.options.some((model) => model.id === "local/flash")).toBe(true);
      expect(requests).toHaveLength(0);
      expect(await runner.runConversation({ profile, cwd: root, input: "Return a short answer", mode: "ask", metadata: { agentSessionId: "real" }, allowWorkspaceWrite: false, workspaceTrusted: false })).toBe("REAL_PI_TEXT");
      const output = z.object({ kind: z.literal("ask"), text: z.string() }).strict();
      const request = { profile, cwd: root, method: { id: "ask", input: [], description: "Explain" }, resolved: { arguments: { input: "Explain" }, context: [] },
        contract: { outputJsonSchema: z.toJSONSchema(output), outputSchema: output }, metadata: {}, allowWorkspaceWrite: false, workspaceTrusted: false } as unknown as AgentExecutionRequest;
      expect(JSON.parse(await runner.run(request) as string)).toEqual({ kind: "ask", text: "REAL_PI_RESULT" });
      const events: unknown[] = [];
      let questions = 0;
      expect(await runner.runConversation({ profile, cwd: root, input: "QUESTION_SMOKE", mode: "ask", metadata: { requestAgentInput: async () => { questions++; return { q: { answers: ["A", "custom"] } }; } }, onEvent: (event) => events.push(event), allowWorkspaceWrite: false, workspaceTrusted: false })).toBe("REAL_PI_TEXT");
      expect(questions).toBe(1); expect(JSON.stringify(events)).toContain('"status":"answered"');
      expect(JSON.stringify(requests)).toContain("custom");
      const mcpScript = `const rl = require('node:readline').createInterface({input:process.stdin}); rl.on('line', line => { const q = JSON.parse(line); if (q.id === undefined) return; const result = q.method === 'initialize' ? {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}} : q.method === 'tools/list' ? {tools:[{name:'ping',description:'Local ping',inputSchema:{type:'object',properties:{}}}]} : q.method === 'tools/call' ? {content:[{type:'text',text:'MCP_REAL_' + process.env.DEXT_TEST_ENV}]} : {}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'); });`;
      expect(await runner.runConversation({ profile, cwd: root, input: "MCP_SMOKE", mode: "agent", metadata: {}, allowWorkspaceWrite: true, permission: "full-access", workspaceTrusted: true,
        mcpServers: [{ name: "local", command: process.execPath, args: ["-e", mcpScript], env: { DEXT_TEST_ENV: "ENV", ELECTRON_RUN_AS_NODE: "1" } }] })).toBe("REAL_PI_TEXT");
      expect(JSON.stringify(requests).includes("MCP_REAL_ENV")).toBe(true);
      expect(requests.length).toBeGreaterThanOrEqual(3);
    } finally {
      await runner.dispose(); server.closeAllConnections(); await new Promise<void>((done) => { server.close(() => done()); });
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 });
    }
  });
  it("validates submissions in the same turn and prefers the accepted object over final prose", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-pi-parity-")), log = join(root, "log.jsonl");
    const runner = new PiAgentRunner({ extensionPath: resolve("media/pi-extension.mjs"), sessionDirectory: join(root, "sessions"), versionProbe: async () => {},
      transportFactory: (_command, args, cwd, env) => new PiRpcTransport(process.execPath, [resolve("test/fixtures/piAgent.mjs"), ...args], cwd, { ...env, PI_FIXTURE_LOG: log }) });
    try {
      const output = z.object({ kind: z.literal("ask"), text: z.string() }).strict();
      const request = { profile: { id: "pi", provider: "pi", label: "Pi", command: process.execPath, models: [] }, cwd: root,
        method: { id: "ask", input: [], description: "Analyze" }, resolved: { arguments: { input: "check" }, context: [] },
        contract: { outputJsonSchema: z.toJSONSchema(output), outputSchema: output }, metadata: { agentSessionId: "must not reuse", conversationContext: "explicitly supplied context" },
        allowWorkspaceWrite: false, workspaceTrusted: true, includePatch: false } as unknown as AgentExecutionRequest;
      expect(JSON.parse(await runner.run(request) as string)).toEqual({ kind: "ask", text: "fixture answer" });
      const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.some((record) => (record.rejected as { status?: string } | undefined)?.status === "rejected")).toBe(true);
      expect(records.some((record) => (record.accepted as { status?: string } | undefined)?.status === "accepted")).toBe(true);
      expect(records.filter((record) => record.command === "prompt")).toHaveLength(1);
      expect(records[0]?.startup).toContain("--no-session");
      expect(String(records.find((record) => record.command === "prompt")?.message)).toContain("Do not include a patch");
      expect(String(records.find((record) => record.command === "prompt")?.message).split("explicitly supplied context")).toHaveLength(2);
    } finally { await runner.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
