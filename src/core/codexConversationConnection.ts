import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface CodexRpcMessage { id?: string | number | undefined; method: string; params: Record<string, unknown> }

/** Conversation connection uses the user's CLI configuration/login, independently
 * of the isolated completion service. Stdio stays open for server requests. */
export class CodexConversationConnection {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly onMessage: (message: CodexRpcMessage) => void, private readonly onError: (error: Error) => void) {}

  async start(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    // Do not retain stderr: providers may put account/configuration details there.
    child.stderr.resume();
    child.on("error", () => this.fail(new Error("Unable to launch Codex App Server. Check the configured CLI executable.")));
    child.on("exit", () => this.fail(new Error("Codex App Server exited before completing the turn.")));
    child.stdin.on("error", () => this.fail(new Error("Codex App Server input pipe closed.")));
    await this.request("initialize", {
      clientInfo: { name: "dext", title: "Dext", version: "0.1.2" },
      capabilities: { experimentalApi: true }
    });
    this.write({ method: "initialized", params: {} });
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Codex conversation connection is closed."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out. Update the Codex CLI if this method is unsupported.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  reject(id: string | number): void {
    this.write({ id, error: { code: -32601, message: "This request is not supported by Dext." } });
  }

  private write(value: unknown): void {
    if (!this.closed) this.child?.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.method === "string") {
          this.onMessage({ method: value.method, id: value.id as string | number | undefined,
            params: value.params as Record<string, unknown> ?? {} });
        } else if (typeof value.id === "number") {
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          this.pending.delete(value.id); clearTimeout(pending.timer);
          const error = value.error as { message?: string } | undefined;
          if (error) pending.reject(new Error(error.message ?? "Codex rejected the request."));
          else pending.resolve(value.result as Record<string, unknown> ?? {});
        }
      } catch { this.fail(new Error("Invalid Codex App Server message.")); return; }
    }
    if (this.buffer.length > 16 * 1024 * 1024) this.fail(new Error("Codex App Server message exceeded the buffer limit."));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error); this.onError(error);
  }

  close(error = new Error("Codex conversation connection closed.")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.buffer = "";
    const child = this.child;
    if (!child) return;
    child.stdin.end(); child.stdout.destroy(); child.stderr.destroy();
    const kill = setTimeout(() => child.kill(), 500);
    kill.unref(); child.once("exit", () => clearTimeout(kill));
  }
}
