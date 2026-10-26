import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiBridge } from "../src/features/agents/host/piBridge.js";
interface Tool { name: string; parameters: unknown; execute(id: string, args: unknown, signal?: AbortSignal): Promise<{ content: { text: string }[]; isError: boolean }> }
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
    const bridge = new PiBridge({ permission: "read-only", tools: ["read", "dext_submit_result"], mcpServers: [], resultSchema: schema }, async (request) => ({ status: request.kind === "submit_result" && (request.args as { value?: string }).value === "ok" ? "accepted" : "rejected", diagnostics: "value is required" }));
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
  });
});
