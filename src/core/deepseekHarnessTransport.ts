import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type InitializeResponse } from "@agentclientprotocol/sdk";
import { resolveCliCommand } from "./agentRunner.js";

/** Resolve npm's Windows shim to its Node entry; never put model input through cmd.exe. */
export function harnessSpawnCommand(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (/\.(?:m?js)$/i.test(command)) return { command: "node", args: [command, ...args] };
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args: [...args] };
  const script = readFileSync(command, "utf8");
  // Volta's bin directory deliberately contains a tiny `dsh.cmd` dispatcher.
  // Unlike an npm shim it has no Node entry itself, but its installed package
  // has the ordinary npm shim we can launch without invoking cmd.exe.
  if (/\bvolta\s+run\s+%~n0\b/i.test(script)) {
    const packageShim = join(
      dirname(dirname(command)), "tools", "image", "packages", "@deepseek-ai", "dsh", "dsh.cmd"
    );
    if (existsSync(packageShim)) return harnessSpawnCommand(packageShim, args);
    return { command: "volta", args: ["run", command.replace(/^.*[\\/]/, "").replace(/\.(cmd|bat)$/i, ""), ...args] };
  }
  const relative = /["']?%[~]?dp0%?[\\/]([^"\r\n]*?\.(?:m?js))["']/i.exec(script)?.[1]
    ?? /["']?%dp0%[\\/]([^"\r\n]*?\.(?:m?js))["']/i.exec(script)?.[1];
  // Shim paths use Windows separators even when inspected on another platform.
  const entry = relative ? join(dirname(command), ...relative.split(/[\\/]/)) : join(dirname(command), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!existsSync(entry)) throw new Error("Cannot resolve this Harness command shim. Configure the dsh Node entry or executable path.");
  const node = join(dirname(command), "node.exe");
  return { command: existsSync(node) ? node : "node", args: [entry, ...args] };
}

export class DeepSeekHarnessTransport {
  readonly connection: ClientSideConnection;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private stopped = false;
  private readonly failure: Promise<never>;
  private readonly exited: Promise<void>;
  private closing?: Promise<void>;
  capabilities?: InitializeResponse;
  onActivity?: (() => void) | undefined;

  constructor(command: string, args: readonly string[], cwd: string, client: Client) {
    const resolved = resolveCliCommand(command, "deepseek-harness");
    if (!resolved) throw new Error(`DeepSeek Harness command '${command}' was not found. Install @deepseek-ai/dsh or configure its executable path.`);
    const invocation = harnessSpawnCommand(resolved, args);
    this.child = spawn(invocation.command, invocation.args, { cwd, windowsHide: true, stdio: "pipe", shell: false });
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) this.onActivity?.();
      this.stderr = (this.stderr + chunk.toString()).slice(-16000);
    });
    this.exited = new Promise((resolve) => { this.child.once("exit", () => resolve()); this.child.once("error", () => resolve()); });
    this.connection = new ClientSideConnection(() => client, ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    ));
    this.failure = new Promise((_, reject) => {
      const fail = (detail: string): void => reject(new Error(`DeepSeek Harness ${detail}${this.stderr ? `: ${this.stderr}` : ""}`));
      // The SDK tolerates malformed lines. A process backend must fail visibly
      // when a plugin pollutes stdout instead of silently dropping protocol data.
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      this.child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.length) this.onActivity?.();
        buffer += decoder.write(chunk);
        if (buffer.length > 16 * 1024 * 1024) { fail("ACP protocol frame exceeds 16 MiB"); return; }
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line) as { jsonrpc?: unknown };
            if (!frame || frame.jsonrpc !== "2.0") throw new Error();
          } catch { fail("ACP protocol contains invalid JSON-RPC"); }
        }
      });
      this.child.once("error", (error) => fail(error.message));
      this.child.once("exit", (code) => fail(`exited (${code ?? "signal"})`));
      void this.connection.closed.then(() => fail("ACP connection closed"), () => fail("ACP protocol failed"));
    });
    void this.failure.catch(() => undefined);
  }

  get alive(): boolean { return !this.stopped && !this.connection.signal.aborted && this.child.exitCode === null; }

  async wait<T>(operation: Promise<T>, timeoutMs = 30000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, this.failure, new Promise<never>((_, reject) => {
      if (timeoutMs > 0) timer = setTimeout(() => reject(new Error("DeepSeek Harness operation timed out.")), timeoutMs);
    })]); } finally { if (timer) clearTimeout(timer); }
  }

  async initialize(): Promise<void> {
    this.capabilities = await this.wait(this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "dext", version: "1" }, clientCapabilities: {} }));
    if (this.capabilities.protocolVersion !== PROTOCOL_VERSION || !this.capabilities.agentCapabilities?.sessionCapabilities?.resume) {
      throw new Error("This Harness version lacks the required ACP session capabilities. Use 0.1.2-rc.1.");
    }
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); })]);
    if (timer) clearTimeout(timer);
    if (this.child.exitCode === null && this.child.pid) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const kill = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true, timeout: 2000 });
          kill.on("error", () => resolve()); kill.on("exit", () => resolve());
        });
      } else this.child.kill("SIGKILL");
    }
    this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy();
  }
}
