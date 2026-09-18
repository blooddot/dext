import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHarnessQuestionRequest, type HarnessQuestionOutcome, type HarnessQuestionRequest } from "./harnessQuestions.js";

/** Endpoint the Harness overlay plugin connects to: a named pipe or unix socket. */
export const HARNESS_BRIDGE_ENV = "DEXT_HARNESS_BRIDGE";
/** First line the Harness must present, so only this process may ask. */
export const HARNESS_BRIDGE_TOKEN_ENV = "DEXT_HARNESS_BRIDGE_TOKEN";
const MAX_BUFFER = 1024 * 1024;

interface Peer { authenticated: boolean; buffer: string }

/**
 * Dext's private question channel to the Harness process.
 *
 * The published `dsh-acp` bridge answers `approval/request` but registers no
 * answerer for `user-questions/request`, so `ask_user_question` fails closed
 * there. ACP elicitation is the standard replacement and Dext already answers
 * it, but the Harness does not emit it yet, so this channel carries the gap.
 *
 * Dext listens on a loopback-only endpoint named by a one-time token and the
 * Harness connects to it. Descriptors were the obvious alternative and are not
 * usable: a spawned pipe the child reads on stops delivering its own writes, and
 * a pending read on one blocks `process.exit` in the Harness process.
 */
export class HarnessBridge {
  /** Passed through the environment so the Harness knows where to connect. */
  readonly endpoint: string;
  /** One-time secret; the first frame on the connection must carry it. */
  readonly token = randomBytes(18).toString("hex");
  private readonly server: Server;
  private readonly peers = new Map<Socket, Peer>();
  private disposed = false;

  constructor(private readonly answer: (request: HarnessQuestionRequest) => Promise<HarnessQuestionOutcome>) {
    this.endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\dext-harness-${this.token}`
      : join(tmpdir(), `dext-harness-${this.token}.sock`);
    if (process.platform !== "win32") { try { unlinkSync(this.endpoint); } catch { /* no stale socket */ } }
    this.server = createServer((socket) => this.accept(socket));
    // A listener that cannot start leaves the channel absent, which the Harness
    // plugin reads as "no Dext surface" and answers by delegating.
    this.server.on("error", () => this.dispose());
    this.server.listen(this.endpoint);
  }

  private accept(socket: Socket): void {
    this.peers.set(socket, { authenticated: false, buffer: "" });
    socket.on("data", (chunk: Buffer) => this.consume(socket, chunk.toString("utf8")));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.peers.delete(socket));
  }

  private consume(socket: Socket, chunk: string): void {
    const peer = this.peers.get(socket);
    if (!peer || this.disposed) return;
    peer.buffer += chunk;
    if (peer.buffer.length > MAX_BUFFER) { socket.destroy(); return; }
    const lines = peer.buffer.split("\n");
    peer.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!peer.authenticated) {
        if (parsed && typeof parsed === "object" && (parsed as { token?: unknown }).token === this.token) peer.authenticated = true;
        else socket.destroy();
        continue;
      }
      const request = parseHarnessQuestionRequest(parsed);
      if (!request) {
        // Never swallow a frame. The Harness answerer waits for a reply on this
        // socket, so a request Dext cannot render has to be answered, or
        // `ask_user_question` parks the whole turn with nothing on screen. The
        // echoed id is enough to report "no Dext surface owns this", which the
        // caller turns into its own visible fail-closed error.
        const id = parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
        if (typeof id === "string" && id) this.send(socket, { id, status: "unavailable" });
        continue;
      }
      void this.answer(request).then(
        (outcome) => this.send(socket, { id: request.id, ...outcome }),
        () => this.send(socket, { id: request.id, status: "unavailable" })
      );
    }
  }

  private send(socket: Socket, value: unknown): void {
    if (this.disposed || socket.destroyed) return;
    socket.write(`${JSON.stringify(value)}\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const socket of this.peers.keys()) socket.destroy();
    this.peers.clear();
    this.server.close();
    if (process.platform !== "win32") { try { unlinkSync(this.endpoint); } catch { /* already removed */ } }
  }
}
