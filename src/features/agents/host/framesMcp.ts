import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { FRAMES_TOOL, MAX_CAPTURED_FRAMES, type VideoFrameCapture } from "../../conversations/contracts/videoFrames.js";

export { FRAMES_TOOL };

/** The host opens a tab, decodes the video and closes it again; a minute is more
 * than one capture needs and less than a stuck tool can afford. */
const CAPTURE_TIMEOUT_MS = 90_000;

export type CaptureFrames = (path: string, timesSeconds: readonly number[]) => Promise<VideoFrameCapture>;

const DESCRIPTION = `Capture still frames from a video file so you can look at them. Dext decodes the video inside the editor, so no ffmpeg is needed. Call it with an empty "times" list first to learn the video's duration and size, then again with the moments you want as pictures.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "The video: the attachment reference Dext showed you (like .dext/attachments/<name>.mp4) or a path relative to the workspace root."
    },
    times: {
      type: "array",
      items: { type: "number" },
      maxItems: MAX_CAPTURED_FRAMES,
      description: "Moments to capture, in seconds from the start. Empty means: report the duration only."
    }
  },
  required: ["path"],
  additionalProperties: false
} as const;

/** One JSON-RPC frame in, one out: the whole of this tool's MCP surface. */
export async function framesResponse(message: unknown, capture: CaptureFrames): Promise<unknown> {
  const record = message as Record<string, unknown> | undefined;
  // A notification, or an answer to something this process never asked, is silence.
  if (typeof record?.method !== "string" || !("id" in record)) return undefined;
  const id = record.id;
  const reply = (result: unknown): unknown => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, text: string): unknown => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (record.method) {
    case "initialize": {
      const params = record.params as { protocolVersion?: unknown } | undefined;
      const protocolVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "dext_frames", version: "1.0.0" } });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [{ name: FRAMES_TOOL, description: DESCRIPTION, inputSchema: INPUT_SCHEMA }] });
    case "tools/call": {
      const params = record.params as { name?: unknown; arguments?: { path?: unknown; times?: unknown } } | undefined;
      if (params?.name !== FRAMES_TOOL) return fail(-32602, `Unknown tool '${String(params?.name)}'.`);
      const path = typeof params.arguments?.path === "string" ? params.arguments.path.trim() : "";
      if (!path) return fail(-32602, "A video path is required.");
      const requested = Array.isArray(params.arguments?.times) ? params.arguments.times : [];
      const times = requested
        .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time >= 0)
        .slice(0, MAX_CAPTURED_FRAMES);
      try {
        return reply({ content: frameContent(path, await capture(path, times)) });
      } catch (failure) {
        return reply({
          content: [{ type: "text", text: failure instanceof Error ? failure.message : String(failure) }],
          isError: true
        });
      }
    }
    default:
      return fail(-32601, `Unknown method '${record.method}'.`);
  }
}

/** A text line per still followed by the still itself: MCP clients render image
 * content next to the text that names the moment. */
function frameContent(path: string, captured: VideoFrameCapture): unknown[] {
  const content: unknown[] = [{
    type: "text",
    text: `@${path} is ${(captured.durationMs / 1000).toFixed(1)}s long, ${captured.width}\u00d7${captured.height}.`
  }];
  if (!captured.frames.length) {
    content.push({ type: "text", text: "Call again with the times (in seconds) you want as stills." });
    return content;
  }
  for (const frame of captured.frames) {
    content.push({ type: "text", text: `Frame at ${(frame.timeMs / 1000).toFixed(1)}s:` });
    content.push({ type: "image", data: frame.data, mimeType: "image/jpeg" });
  }
  return content;
}

/** The host answers over its own private pipe; there is no other channel from a
 * provider's child process to a Webview. */
function bridgeCapture(endpoint: string, path: string, timesSeconds: readonly number[]): Promise<VideoFrameCapture> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Dext did not answer the frame request in time."))),
      CAPTURE_TIMEOUT_MS
    );
    socket.on("connect", () => socket.write(`${JSON.stringify({ path, times: timesSeconds })}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let answer: { capture?: VideoFrameCapture; error?: string };
      try {
        answer = JSON.parse(buffer.slice(0, end)) as typeof answer;
      } catch {
        finish(() => reject(new Error("Dext sent a frame answer that could not be read.")));
        return;
      }
      finish(() => answer.capture
        ? resolve(answer.capture)
        : reject(new Error(answer.error ?? "Dext could not capture the frames.")));
    });
    socket.on("error", (failure) => finish(() => reject(new Error(`Dext is not reachable for video frames: ${failure.message}`))));
  });
}

function main(endpoint: string): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void framesResponse(message, (path, times) => bridgeCapture(endpoint, path, times)).then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}

// Only the spawned tool process has an endpoint; a test that imports this file
// stays a library instead of becoming a second server on stdout.
const endpoint = process.env.DEXT_FRAMES_ENDPOINT;
if (endpoint) void main(endpoint);
