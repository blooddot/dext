import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { afterEach, describe, expect, it } from "vitest";
import { FramesBridge } from "../src/features/agents/host/framesBridge.js";
import type { VideoFrameCapture } from "../src/features/conversations/contracts/videoFrames.js";

interface Answer {
  capture?: VideoFrameCapture;
  error?: string;
}

const bridges: FramesBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
});

function bridge(capture: (path: string, times: readonly number[]) => Promise<VideoFrameCapture>): FramesBridge {
  const started = new FramesBridge("C:\\Dext\\dist\\framesMcp.js", capture);
  bridges.push(started);
  return started;
}

const endpointOf = (started: FramesBridge): string => started.mcpServer.env.DEXT_FRAMES_ENDPOINT ?? "";

/** One request per connection, the same frame the tool process writes. */
async function request(endpoint: string, frame: unknown, attempt = 0): Promise<Answer> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("error", (failure: NodeJS.ErrnoException) => {
      socket.destroy();
      // A freshly opened pipe is not always connectable on the first try.
      if (attempt < 20 && failure.code === "ENOENT") {
        setTimeout(() => void request(endpoint, frame, attempt + 1).then(resolve, reject), 20);
        return;
      }
      reject(failure);
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, end)) as Answer);
    });
  });
}

describe("the video frame bridge", () => {
  it("hands the provider a tool process that talks to a private endpoint", () => {
    const started = bridge(async () => ({ durationMs: 0, width: 0, height: 0, frames: [] }));
    expect(started.mcpServer).toMatchObject({
      name: "dext_frames",
      command: process.execPath,
      args: ["C:\\Dext\\dist\\framesMcp.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    });
    expect(endpointOf(started)).toMatch(/dext-frames-[a-f0-9]{48}/);
  });

  it("answers with the captured stills", async () => {
    const seen: Array<[string, readonly number[]]> = [];
    const started = bridge(async (path, times) => {
      seen.push([path, times]);
      return { durationMs: 2000, width: 640, height: 360, frames: [{ timeMs: 1500, data: "still" }] };
    });
    const answer = await request(endpointOf(started), { path: ".dext/attachments/a.mp4", times: [1.5] });
    expect(seen).toEqual([[".dext/attachments/a.mp4", [1.5]]]);
    expect(answer.capture).toMatchObject({ durationMs: 2000, frames: [{ timeMs: 1500, data: "still" }] });
  });

  it("refuses a request it cannot honour instead of failing silently", async () => {
    const started = bridge(async () => {
      throw new Error("This video's codec cannot be decoded in the editor.");
    });
    const refused = await request(endpointOf(started), { path: "a.mp4", times: [-1] });
    expect(refused.error).toContain("at most 12 non-negative times");
    const failed = await request(endpointOf(started), { path: "a.mp4", times: [] });
    expect(failed.error).toContain("cannot be decoded");
  });
});
