import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { client as createClient, methods, ndJsonStream, PROTOCOL_VERSION, type Client, type ClientConnection, type ClientContext, type CreateElicitationRequest, type CreateElicitationResponse, type InitializeRequest, type InitializeResponse, type NewSessionRequest, type NewSessionResponse, type ResumeSessionRequest, type ResumeSessionResponse, type CloseSessionRequest, type CloseSessionResponse, type SetSessionConfigOptionRequest, type SetSessionConfigOptionResponse, type PromptRequest, type PromptResponse, type CancelNotification } from "@agentclientprotocol/sdk";
import { harnessSpawnCommand } from "./harnessCommand.js";
import { HARNESS_BRIDGE_ENV, HARNESS_BRIDGE_TOKEN_ENV, HarnessBridge } from "./harnessBridge.js";
import type { HarnessQuestionOutcome, HarnessQuestionRequest } from "./harnessQuestions.js";
import { HARNESS_VERSION } from "./deepseekHarnessPolicy.js";
export { harnessSpawnCommand } from "./harnessCommand.js";

/** The client surface Dext gives the Harness: ACP callbacks that arrive over
 * stdio, plus the private question channel that fills the `user-questions` gap. */
export interface HarnessClient extends Client {
  createElicitation?(params: CreateElicitationRequest): CreateElicitationResponse | Promise<CreateElicitationResponse>;
  harnessQuestion?(request: HarnessQuestionRequest): Promise<HarnessQuestionOutcome>;
}

function boundedText(value: string, limit = 2000): string | undefined {
  const text = value.trim();
  return !text || text === "{}" ? undefined : text.length > limit ? `…${text.slice(-limit)}` : text;
}

/** A Harness handler that throws answers with the protocol's generic `-32603 Internal
 * error` and parks the real cause in the error's `data`. Read that payload, since the
 * message alone never names the failure the model backend or a plugin actually hit. */
function harnessCause(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const acp = error as Error & { code?: unknown; data?: unknown };
  if (typeof acp.data === "string") return boundedText(acp.data);
  const details = typeof acp.data === "object" && acp.data !== null ? (acp.data as { details?: unknown }).details : undefined;
  if (typeof details === "string" && details.trim()) return boundedText(details);
  // Only the generic internal error needs its whole payload: an ACP message carrying any
  // other code already names its own problem.
  if (acp.code !== -32603) return undefined;
  try { return boundedText(JSON.stringify(acp.data) ?? ""); } catch { return undefined; }
}

/** Keep the received message — a placeholder stays recognizable in reports — and append
 * the cause plus the diagnostics the process printed while failing. A rejection that
 * already explains itself, or carries no cause at all, passes through untouched. */
function describeHarnessError(error: unknown, stderr: string): unknown {
  const cause = harnessCause(error);
  if (!cause || !(error instanceof Error) || cause === error.message) return error;
  const diagnostics = boundedText(stderr);
  return new Error(`DeepSeek Harness ${error.message}: ${cause}${diagnostics ? `\nHarness stderr:\n${diagnostics}` : ""}`, { cause: error });
}

export class DeepSeekHarnessTransport {
  readonly connection: HarnessConnection;
  private readonly clientConnection: ClientConnection;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly bridge: HarnessBridge;
  private stderr = "";
  private stopped = false;
  private readonly failure: Promise<never>;
  private readonly exited: Promise<void>;
  private closing?: Promise<void>;
  capabilities?: InitializeResponse;
  onActivity?: (() => void) | undefined;

  constructor(command: string, args: readonly string[], cwd: string, private readonly client: HarnessClient) {
    const invocation = harnessSpawnCommand(command, args, { cwd });
    // Dext's private question channel listens before the spawn, so the Harness
    // overlay plugin can connect as soon as it loads. stdout stays JSON-RPC only.
    this.bridge = new HarnessBridge((request) => client.harnessQuestion?.(request) ?? Promise.resolve({ status: "unavailable" as const }));
    try {
      this.child = spawn(invocation.command, invocation.args, {
        cwd, windowsHide: true, stdio: "pipe", shell: false,
        env: { ...process.env, [HARNESS_BRIDGE_ENV]: this.bridge.endpoint, [HARNESS_BRIDGE_TOKEN_ENV]: this.bridge.token }
      });
    } catch (error) {
      this.bridge.dispose();
      throw error;
    }
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (chunk.length) this.onActivity?.();
      this.stderr = (this.stderr + chunk.toString()).slice(-16000);
    });
    this.exited = new Promise((resolve) => { this.child.once("exit", () => resolve()); this.child.once("error", () => resolve()); });
    // The SDK dispatches inbound frames concurrently, each handler chain costing
    // one await per earlier registration. Registering the notification first keeps
    // an agent's `session/update` applied before any request that follows it —
    // which is what the Harness guarantees when it drains updates before asking.
    const app = createClient({ name: "dext" })
      .onNotification(methods.client.session.update, ({ params }) => client.sessionUpdate(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => client.requestPermission(params))
      .onRequest(methods.client.elicitation.create, ({ params }) => client.createElicitation?.(params) ?? { action: "decline" });
    this.clientConnection = app.connect(ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    ));
    this.connection = new HarnessConnection(this.clientConnection.agent, this.clientConnection);
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
    try { return await Promise.race([
      // Only the request's own rejection is rewritten: a transport failure and the
      // watchdog already describe themselves.
      operation.catch((error: unknown): never => { throw describeHarnessError(error, this.stderr); }),
      this.failure,
      new Promise<never>((_, reject) => {
        if (timeoutMs > 0) timer = setTimeout(() => reject(new Error("DeepSeek Harness operation timed out.")), timeoutMs);
      })
    ]); } finally { if (timer) clearTimeout(timer); }
  }

  async initialize(): Promise<void> {
    this.capabilities = await this.wait(this.connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "dext", version: "1" },
      clientCapabilities: { ...(this.client.createElicitation ? { elicitation: { form: {} } } : {}) } }));
    if (this.capabilities.protocolVersion !== PROTOCOL_VERSION || !this.capabilities.agentCapabilities?.sessionCapabilities?.resume) {
      throw new Error(`This Harness version lacks the required ACP session capabilities. Use ${HARNESS_VERSION}.`);
    }
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    this.bridge.dispose();
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

/** Small compatibility facade over SDK 1.4's ClientContext. Keeping this
 * facade lets the runner retain explicit lifecycle calls while all wire access
 * uses the typed client context API. */
export class HarnessConnection {
  constructor(private readonly agent: ClientContext, private readonly owner: ClientConnection) {}
  get signal(): AbortSignal { return this.owner.signal; }
  get closed(): Promise<void> { return this.owner.closed; }
  close(error?: unknown): void { this.owner.close(error); }
  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.agent.request(methods.agent.initialize, params);
  }
  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.agent.request(methods.agent.session.new, params);
  }
  loadSession(params: Parameters<ClientContext["request"]>[1]): ReturnType<ClientContext["request"]> {
    return this.agent.request(methods.agent.session.load, params as never);
  }
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return this.agent.request(methods.agent.session.resume, params);
  }
  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return this.agent.request(methods.agent.session.close, params);
  }
  setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return this.agent.request(methods.agent.session.setConfigOption, params);
  }
  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.agent.request(methods.agent.session.prompt, params);
  }
  cancel(params: CancelNotification): Promise<void> {
    return this.agent.notify(methods.agent.session.cancel, params);
  }
}
