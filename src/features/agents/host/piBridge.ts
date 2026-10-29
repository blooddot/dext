import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { piObject, type PiBridgeConfig, type PiBridgeRequest } from "../contracts/pi.js";

const question = z.object({ id: z.string().min(1).max(128), header: z.string().max(2000).default(""), question: z.string().min(1).max(20000),
  options: z.array(z.object({ label: z.string().min(1).max(2000), description: z.string().max(20000).default("") })).max(200).default([]),
  multiSelect: z.boolean().optional(), isSecret: z.boolean().optional(), detail: z.string().max(20000).optional() });
const requests = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("project_query"), query: z.unknown() }).strict(),
  z.object({ id: z.string(), kind: z.literal("question"), questions: z.array(question).min(1).max(20).refine((items) => new Set(items.map((item) => item.id)).size === items.length) }),
  z.object({ id: z.string(), kind: z.literal("submit_result"), args: z.unknown() }),
  z.object({ id: z.string(), kind: z.literal("fetch"), url: z.string().min(1).max(2048) })
]);

export class PiBridge {
  readonly token = randomBytes(24).toString("hex");
  readonly endpoint = process.platform === "win32" ? `\\\\.\\pipe\\dext-pi-${this.token}` : join(tmpdir(), `dext-pi-${this.token}.sock`);
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private peer: Socket | undefined;
  private readonly readiness: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private disposed = false;
  private readyTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly config: PiBridgeConfig, private readonly handle: (request: PiBridgeRequest) => Promise<unknown>) {
    this.readiness = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.readiness.catch(() => {});
    this.readyTimer = setTimeout(() => this.readyReject(new Error("Pi Dext extension did not become ready within 30000 ms.")), 30000);
    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", () => { this.readyReject(new Error("Unable to open the private Pi bridge.")); this.dispose(); });
    this.server.listen(this.endpoint);
  }
  ready(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.readiness;
    return new Promise((resolve, reject) => {
      const abort = (): void => { cleanup(); reject(signal.reason instanceof Error ? signal.reason : new Error("Pi initialization cancelled.")); };
      const cleanup = (): void => signal.removeEventListener("abort", abort);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      void this.readiness.then(() => { cleanup(); resolve(); }, (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))); });
    });
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new StringDecoder("utf8");
    let buffer = "", authenticated = false;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { this.sockets.delete(socket); if (this.peer === socket) this.peer = undefined; });
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        let frame: Record<string, unknown>;
        try { frame = piObject(JSON.parse(line)); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (frame.token !== this.token || this.peer) { socket.destroy(); return; }
          authenticated = true; this.peer = socket; this.send({ type: "config", config: this.config }); continue;
        }
        if (frame.type === "ready") { clearTimeout(this.readyTimer); this.readyResolve(); continue; }
        const parsed = requests.safeParse(frame);
        if (!parsed.success) { if (typeof frame.id === "string") this.send({ id: frame.id, status: "unavailable" }); continue; }
        const request = parsed.data as PiBridgeRequest;
        void this.handle(request).then((result) => this.send({ ...piObject(result), id: request.id }), () => this.send({ id: request.id, status: "unavailable" }));
      }
    });
  }
  private send(frame: unknown): void { if (!this.disposed && this.peer && !this.peer.destroyed) this.peer.write(`${JSON.stringify(frame)}\n`); }
  beginTurn(): void { this.send({ type: "begin" }); }
  clearTurn(): void { this.send({ type: "clear" }); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.readyTimer); this.readyReject(new Error("Pi bridge closed."));
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); this.server.close();
    if (process.platform !== "win32") { try { unlinkSync(this.endpoint); } catch { /* already closed */ } }
  }
}
