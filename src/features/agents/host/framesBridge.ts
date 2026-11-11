import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { MAX_CAPTURED_FRAMES, type VideoFrameCapture } from "../../conversations/contracts/videoFrames.js";
import type { AgentMcpServer } from "../contracts/agent.js";

/** One request is a path and a dozen numbers; one answer carries a dozen stills. */
const MAX_REQUEST_BYTES = 64 * 1024;

/** The frame tool runs as the provider's own child process, where no Webview
 * exists: it asks this private pipe, and Dext answers from a tab that can decode. */
export class FramesBridge {
  private readonly token = randomBytes(24).toString("hex");
  private readonly endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\dext-frames-${this.token}`
    : join(tmpdir(), `dext-frames-${this.token}.sock`);
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private disposed = false;

  /** What a provider is told to launch. The endpoint travels through the
   * environment so no shell ever has to quote it. */
  readonly mcpServer: AgentMcpServer;

  constructor(
    scriptPath: string,
    private readonly capture: (path: string, timesSeconds: readonly number[]) => Promise<VideoFrameCapture>
  ) {
    this.mcpServer = {
      name: "dext_frames",
      command: process.execPath,
      args: [scriptPath],
      env: { ELECTRON_RUN_AS_NODE: "1", DEXT_FRAMES_ENDPOINT: this.endpoint }
    };
    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", () => this.dispose());
    // A conversation starts long after this listen completes; nothing waits on it.
    this.server.listen(this.endpoint);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      const end = buffer.indexOf("\n");
      if (end < 0) {
        // One request per connection, so anything past a single line is a mistake.
        if (buffer.length > MAX_REQUEST_BYTES) socket.destroy();
        return;
      }
      let request: { path?: unknown; times?: unknown };
      try {
        request = JSON.parse(buffer.slice(0, end)) as typeof request;
      } catch {
        socket.destroy();
        return;
      }
      const path = typeof request.path === "string" ? request.path.trim() : "";
      const times = Array.isArray(request.times) ? request.times : [];
      if (!path || times.length > MAX_CAPTURED_FRAMES
        || !times.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)) {
        this.reply(socket, { error: `Send a video path and at most ${MAX_CAPTURED_FRAMES} non-negative times in seconds.` });
        return;
      }
      void this.capture(path, times as number[]).then(
        (capture) => this.reply(socket, { capture }),
        (failure: unknown) => this.reply(socket, { error: failure instanceof Error ? failure.message : String(failure) })
      );
    });
  }

  private reply(socket: Socket, frame: unknown): void {
    if (!this.disposed && !socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.close();
    // A named pipe disappears with its server; a socket file does not.
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.endpoint);
      } catch {
        // Already gone.
      }
    }
  }
}
