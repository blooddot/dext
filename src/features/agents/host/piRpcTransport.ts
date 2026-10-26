import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { PiRecord } from "../contracts/pi.js";
import { piObject } from "../contracts/pi.js";
import { piInvocation } from "./piCommand.js";

interface Pending { command: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void }
export class PiRpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly exited: Promise<void>;
  private buffer = "";
  private stderr = "";
  private sequence = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private stopped = false;
  onRecord?: ((record: PiRecord) => void) | undefined;
  onFailure?: ((error: Error) => void) | undefined;
  onActivity?: (() => void) | undefined;

  constructor(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    const invocation = piInvocation(command, args);
    this.child = spawn(invocation.command, invocation.args, { cwd, env, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => { this.child.once("close", () => { this.stopped = true; resolve(); }); });
    this.child.stdout.on("data", (chunk: Buffer) => { this.onActivity?.(); this.receive(this.decoder.write(chunk)); });
    this.child.stderr.on("data", (chunk: Buffer) => { this.onActivity?.(); this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4096); });
    this.child.stdin.on("error", () => this.fail(new Error("Pi RPC input pipe closed.")));
    this.child.on("error", (error) => this.fail(new Error(`Unable to launch the associated Pi CLI: ${error.message}`)));
    this.child.once("close", (code) => {
      if (!this.closing) this.fail(new Error(`Pi CLI exited before completing the request (${String(code)}).${this.diagnostics()}`));
    });
  }
  get alive(): boolean { return !this.stopped && !this.failure && !this.closing; }
  private diagnostics(): string {
    const text = this.stderr.replace(/(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[redacted]").trim();
    return text ? `\nPi stderr: ${text}` : "";
  }
  private receive(chunk: string): void {
    if (this.failure || this.closing) return;
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error("Pi RPC frame exceeded the size limit.")); return; }
    const lines = this.buffer.split("\n"); this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try { value = piObject(JSON.parse(line)); } catch { this.fail(new Error("Pi emitted malformed RPC JSON.")); return; }
      if (typeof value.type !== "string") { this.fail(new Error("Pi emitted an invalid RPC record.")); return; }
      if (value.type === "response") {
        const id = typeof value.id === "string" ? value.id : "";
        const pending = this.pending.get(id);
        if (!pending) continue;
        if (value.command !== pending.command) { this.fail(new Error("Pi RPC response command does not match its request.")); return; }
        this.pending.delete(id); pending.cleanup();
        if (value.success === true) pending.resolve(value.data);
        else pending.reject(new Error(`Pi ${pending.command} failed: ${typeof value.error === "string" ? value.error : "invalid response"}`));
      } else {
        try { this.onRecord?.(value as PiRecord); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return; }
      }
    }
  }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear(); this.onFailure?.(error);
    void this.close();
  }
  async write(value: object): Promise<void> {
    if (!this.alive) throw this.failure ?? new Error("Pi RPC connection is closed.");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve());
    });
  }
  request(command: string, fields: Record<string, unknown> = {}, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    if (!this.alive) return Promise.reject(this.failure ?? new Error("Pi RPC connection is closed."));
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Pi request cancelled."));
    const id = `pi-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const finish = (error: Error): void => { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.cleanup(); reject(error); } };
      const abort = (): void => finish(signal?.reason instanceof Error ? signal.reason : new Error("Pi request cancelled."));
      const timer = setTimeout(() => finish(new Error(`Pi ${command} timed out after ${timeoutMs} ms.`)), timeoutMs);
      const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending.set(id, { command, resolve, reject, timer, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      void this.write({ ...fields, id, type: command }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new Error("Pi RPC connection closed.")); }
    this.pending.clear();
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
    if (timer) clearTimeout(timer);
    if (!this.stopped && this.child.pid !== undefined) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { this.child.kill(); resolve(); }); killer.once("close", () => resolve());
        });
      } else { try { process.kill(-this.child.pid, "SIGKILL"); } catch { this.child.kill("SIGKILL"); } }
    }
    await this.exited;
  }
}
