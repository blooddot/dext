import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiBridge } from "../src/features/agents/host/piBridge.js";
const bridges: PiBridge[] = [], sockets: Socket[] = [];
afterEach(() => { sockets.splice(0).forEach((socket) => socket.destroy()); bridges.splice(0).forEach((bridge) => bridge.dispose()); });
function peer(bridge: PiBridge, token = bridge.token) {
  const socket = connect(bridge.endpoint), frames: Record<string, unknown>[] = [];
  sockets.push(socket); let buffer = "";
  socket.on("error", () => {});
  socket.on("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
  socket.on("data", (chunk: Buffer) => { buffer += chunk.toString("utf8"); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) frames.push(JSON.parse(line) as Record<string, unknown>); });
  return { socket, frames, send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`) };
}
describe("Pi private bridge", () => {
  it("authenticates before configuration, gates readiness and validates question batches", async () => {
    const handle = vi.fn(async (request: unknown) => { expect(request).toBeDefined(); return { status: "answered", answers: { q: { answers: ["A", "custom"] } } }; });
    const bridge = new PiBridge({ permission: "read-only", tools: [], mcpServers: [] }, handle); bridges.push(bridge);
    const client = peer(bridge); await vi.waitFor(() => expect(client.frames[0]?.type).toBe("config"));
    client.send({ type: "ready" }); await bridge.ready();
    client.send({ id: "q", kind: "question", questions: [{ id: "q", question: "Choose", multiSelect: true, options: [{ label: "A" }] }] });
    await vi.waitFor(() => expect(client.frames[1]?.status).toBe("answered"));
    expect(handle.mock.calls[0]?.[0]).toMatchObject({ questions: [{ header: "", multiSelect: true, options: [{ label: "A", description: "" }] }] });
    client.send({ id: "bad", kind: "question", questions: [] });
    await vi.waitFor(() => expect(client.frames.at(-1)).toMatchObject({ id: "bad", status: "unavailable" }));
    expect(handle).toHaveBeenCalledOnce();
  });
  it("refuses an unauthenticated client and cancels initialization", async () => {
    const bridge = new PiBridge({ permission: "read-only", tools: [], mcpServers: [] }, async () => ({})); bridges.push(bridge);
    const client = peer(bridge, "wrong"); await vi.waitFor(() => expect(client.socket.destroyed).toBe(true));
    expect(client.frames).toEqual([]);
    const controller = new AbortController(); const waiting = bridge.ready(controller.signal); controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
});
