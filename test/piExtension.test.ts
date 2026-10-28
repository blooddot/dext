import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiBridge } from "../src/features/agents/host/piBridge.js";
interface Tool { name: string; parameters: unknown; execute(id: string, args: unknown, signal?: AbortSignal): Promise<{ content: { text: string }[]; isError: boolean }> }
interface SettleEvent { outcome: string; context: { canContinue: boolean } }
interface Boundary { continue?: boolean; entries?: { type: string; display: boolean }[] }
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));
const bridges: PiBridge[] = [], shutdowns: (() => void)[] = [];
const previous = { endpoint: process.env.DEXT_PI_BRIDGE, token: process.env.DEXT_PI_BRIDGE_TOKEN };
afterEach(() => {
  shutdowns.splice(0).forEach((close) => close()); bridges.splice(0).forEach((bridge) => bridge.dispose());
  if (previous.endpoint === undefined) delete process.env.DEXT_PI_BRIDGE; else process.env.DEXT_PI_BRIDGE = previous.endpoint;
  if (previous.token === undefined) delete process.env.DEXT_PI_BRIDGE_TOKEN; else process.env.DEXT_PI_BRIDGE_TOKEN = previous.token;
});
describe("shipped Pi extension", () => {
  it("registers the real schema, carries structured arguments and guards hidden tools", async () => {
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const requests: unknown[] = [];
    const bridge = new PiBridge({ permission: "read-only", tools: ["read", "dext_submit_result", "dext_fetch"], mcpServers: [], resultSchema: schema }, async (request) => {
      requests.push(request);
      return request.kind === "fetch"
        ? { status: "ok", url: request.url, contentType: "text/plain", text: "body", truncated: false }
        : { status: request.kind === "submit_result" && (request.args as { value?: string }).value === "ok" ? "accepted" : "rejected", diagnostics: "value is required" };
    });
    bridges.push(bridge); process.env.DEXT_PI_BRIDGE = bridge.endpoint; process.env.DEXT_PI_BRIDGE_TOKEN = bridge.token;
    const tools = new Map<string, Tool>(); let guard: ((event: { toolName: string }) => unknown) | undefined;
    const module = await import(pathToFileURL(resolve("media/pi-extension.mjs")).href) as { default(api: object): Promise<void> };
    await module.default({ registerTool: (tool: Tool) => tools.set(tool.name, tool),
      on: (event: string, listener: (event: { toolName: string }) => unknown) => { if (event === "tool_call") guard = listener; else if (event === "session_shutdown") shutdowns.push(() => { listener({ toolName: "" }); }); },
      getActiveTools: () => [...tools.keys()], setActiveTools: () => {}, registerMcpServer: () => { throw new Error("Read-only MCP must stay disabled"); } });
    await bridge.ready();
    expect(tools.get("dext_submit_result")?.parameters).toEqual(schema);
    expect(guard?.({ toolName: "bash" })).toMatchObject({ block: true });
    expect(guard?.({ toolName: "read" })).toBeUndefined();
    expect(await tools.get("dext_submit_result")!.execute("one", { value: "ok" })).toMatchObject({ isError: false });
    expect(await tools.get("dext_submit_result")!.execute("two", {})).toMatchObject({ isError: true });
    expect([...tools.keys()]).toContain("dext_fetch");
    expect(tools.get("dext_fetch")?.parameters).toEqual({ type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false });
    expect(guard?.({ toolName: "dext_fetch" })).toBeUndefined();
    expect(await tools.get("dext_fetch")!.execute("three", { url: "https://example.com/readme.txt" })).toMatchObject({ isError: false });
    expect(requests.at(-1)).toMatchObject({ kind: "fetch", url: "https://example.com/readme.txt" });
  });
  it("nudges one result submission before a typed turn settles without one", async () => {
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const bridge = new PiBridge({ permission: "read-only", tools: ["read", "dext_submit_result"], mcpServers: [], resultSchema: schema }, async () => ({ status: "accepted" }));
    bridges.push(bridge); process.env.DEXT_PI_BRIDGE = bridge.endpoint; process.env.DEXT_PI_BRIDGE_TOKEN = bridge.token;
    const tools = new Map<string, Tool>(); let settle: ((event: SettleEvent) => Boundary | undefined) | undefined;
    const module = await import(pathToFileURL(resolve("media/pi-extension.mjs")).href) as { default(api: object): Promise<void> };
    await module.default({ registerTool: (tool: Tool) => tools.set(tool.name, tool),
      on: (event: string, listener: (payload: unknown) => unknown) => {
        if (event === "agent_before_settle") settle = listener as (event: SettleEvent) => Boundary | undefined;
        else if (event === "session_shutdown") shutdowns.push(() => { listener({}); });
      },
      getActiveTools: () => [...tools.keys()], setActiveTools: () => {}, registerMcpServer: () => {} });
    await bridge.ready();
    const ready = { outcome: "completed", context: { canContinue: true } };
    expect(settle!(ready)).toMatchObject({ continue: true, entries: [{ type: "custom_message", display: false }] });
    expect(settle!(ready)).toBeUndefined();
    bridge.beginTurn(); await tick();
    expect(settle!({ outcome: "completed", context: { canContinue: false } })).toBeUndefined();
    expect(settle!({ outcome: "error", context: { canContinue: true } })).toBeUndefined();
    expect(settle!(ready)).toMatchObject({ continue: true });
    bridge.beginTurn(); await tick();
    expect(await tools.get("dext_submit_result")!.execute("one", { value: "ok" })).toMatchObject({ isError: false });
    expect(settle!(ready)).toBeUndefined();
  });
});
