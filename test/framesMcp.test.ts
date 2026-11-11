import { describe, expect, it } from "vitest";
import { FRAMES_TOOL, framesResponse, type CaptureFrames } from "../src/features/agents/host/framesMcp.js";

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface Answer {
  result?: {
    protocolVersion?: string;
    capabilities?: unknown;
    tools?: Array<{ name: string; inputSchema: { required: string[] } }>;
    content?: Content[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

const capture: CaptureFrames = async (_path, times) => ({
  durationMs: 63_400,
  width: 1280,
  height: 720,
  frames: times.map((seconds) => ({ timeMs: Math.round(seconds * 1000), data: `still-${seconds}` }))
});

const answer = async (message: unknown, run: CaptureFrames = capture): Promise<Answer> =>
  await framesResponse(message, run) as Answer;

const call = (args: Record<string, unknown>): unknown =>
  ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: FRAMES_TOOL, arguments: args } });

describe("the video frame tool", () => {
  it("answers an MCP handshake with the version the client offered", async () => {
    const handshake = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(handshake.result?.protocolVersion).toBe("2024-11-05");
    expect(handshake.result?.capabilities).toEqual({ tools: {} });
  });

  it("stays silent on notifications", async () => {
    expect(await framesResponse({ jsonrpc: "2.0", method: "notifications/initialized" }, capture)).toBeUndefined();
  });

  it("advertises one tool that only needs a path", async () => {
    const listed = await answer({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listed.result?.tools).toHaveLength(1);
    expect(listed.result?.tools?.[0]).toMatchObject({ name: FRAMES_TOOL, inputSchema: { required: ["path"] } });
  });

  it("reports the duration when no moment was asked for, and stills when it was", async () => {
    const shape = await answer(call({ path: ".dext/attachments/a.mp4", times: [] }));
    expect(shape.result?.content).toEqual([
      { type: "text", text: "@.dext/attachments/a.mp4 is 63.4s long, 1280\u00d7720." },
      { type: "text", text: "Call again with the times (in seconds) you want as stills." }
    ]);
    const stills = await answer(call({ path: "a.mp4", times: [12.5] }));
    expect(stills.result?.content).toEqual([
      { type: "text", text: "@a.mp4 is 63.4s long, 1280\u00d7720." },
      { type: "text", text: "Frame at 12.5s:" },
      { type: "image", data: "still-12.5", mimeType: "image/jpeg" }
    ]);
  });

  it("drops a time it cannot seek to instead of failing the whole call", async () => {
    const seen: number[][] = [];
    const stills = await answer(call({ path: "a.mp4", times: [1, "2", -3, 4] }), async (path, times) => {
      seen.push([...times]);
      return await capture(path, times);
    });
    expect(seen).toEqual([[1, 4]]);
    expect(stills.result?.content).toHaveLength(5);
  });

  it("reports a failed capture as an error result the model can read", async () => {
    const failed = await answer(call({ path: "a.mp4", times: [] }), async () => {
      throw new Error("'a.mp4' is not a video Dext can decode (.mp4, .m4v, .mov, .webm).");
    });
    expect(failed.result?.isError).toBe(true);
    expect(failed.result?.content?.[0]?.text).toContain("not a video Dext can decode");
  });

  it("rejects a call with no path or an unknown tool", async () => {
    const missing = await answer(call({ times: [] }));
    expect(missing.error?.code).toBe(-32602);
    const unknown = await answer({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "other" } });
    expect(unknown.error?.message).toContain("other");
  });
});
