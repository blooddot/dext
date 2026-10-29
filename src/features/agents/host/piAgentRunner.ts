import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentModelOption, AgentProfile } from "../contracts/agent.js";
import { piObject, piText, type PiBridgeRequest, type PiRecord, type PiState } from "../contracts/pi.js";
import { PiEvents } from "../domain/piEvents.js";
import { decodePiSession, encodePiSession, parsePiModelId, piModelId, piModelOptions, piModels, piThinkingLevels } from "../domain/piModels.js";
import { agentTimeout, DEFAULT_AGENT_IDLE_TIMEOUT_MS, DEFAULT_AGENT_TIMEOUT_MS, type AgentTimeout } from "../domain/agentTimeout.js";
import { ExecutionCancelledError } from "../../../shared/protocol/executionErrors.js";
import { formatDiagnostics } from "../../../shared/protocol/resultBoundary.js";
import { resultToolParameters } from "../domain/harnessResultTool.js";
import { agentPayload, bootstrappedConversationInput, type AgentConversationRequest, type AgentExecutionRequest, type AgentRunner } from "./agentRunner.js";
import { piArguments, piCommand, piPermission, piTools, checkPiVersion } from "./piCommand.js";
import { piFetch } from "./piFetch.js";
import { PiBridge } from "./piBridge.js";
import { piQuestion, piUi } from "./piInteractions.js";
import { PiRpcTransport } from "./piRpcTransport.js";

type TurnRequest = AgentConversationRequest & { contract?: AgentExecutionRequest["contract"] };
export interface PiDiscovery { options: AgentModelOption[]; defaults: { model?: string; reasoningEffort?: string } }
export interface PiRunnerOptions {
  extensionPath?: string; sessionDirectory?: string;
  transportFactory?: (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => PiRpcTransport;
  versionProbe?: (command: string, cwd: string, signal?: AbortSignal) => Promise<void>;
}
interface Active {
  request: TurnRequest; controller: AbortController; timeout: AgentTimeout; events: PiEvents;
  submitted?: string; resolve(): void; reject(error: Error): void; done: boolean; retryError?: string;
  uiIds: Set<string>;
}
interface Session { binding: string; transport: PiRpcTransport; bridge: PiBridge; state: PiState; fresh: boolean; active?: Active | undefined }
interface Queued { key: string; controller: AbortController }
const stateFrom = (value: unknown): PiState => {
  const raw = piObject(value);
  return { ...(raw.model ? { model: piModels([raw.model])[0]! } : {}),
    ...(typeof raw.thinkingLevel === "string" ? { thinkingLevel: raw.thinkingLevel } : {}),
    ...(typeof raw.sessionFile === "string" ? { sessionFile: raw.sessionFile } : {}),
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}) };
};

export class PiAgentRunner implements AgentRunner {
  private options: PiRunnerOptions;
  private timeoutMs = DEFAULT_AGENT_TIMEOUT_MS;
  private idleTimeoutMs = DEFAULT_AGENT_IDLE_TIMEOUT_MS;
  private disposed = false;
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Set<Queued>();
  private readonly defaults = new Map<string, PiState>();
  private readonly modelDefaults = new Map<string, string>();
  private readonly discoveries = new Map<string, Promise<PiDiscovery>>();
  private readonly cleanups = new Set<Promise<void>>();
  onModels?: ((profile: AgentProfile, discovery: PiDiscovery, discoveryKey: string) => void) | undefined;
  constructor(options: PiRunnerOptions = {}) { this.options = options; }
  configure(options: PiRunnerOptions): void { this.options = { ...this.options, ...options }; }
  setTimeoutMs(value: number): void { this.timeoutMs = value; }
  setIdleTimeoutMs(value: number): void { this.idleTimeoutMs = value; }
  private resources(): { extensionPath: string; sessionDirectory: string } {
    const { extensionPath, sessionDirectory } = this.options;
    if (!extensionPath || !sessionDirectory) throw new Error("Pi runtime resources are not configured by the Dext host.");
    return { extensionPath, sessionDirectory };
  }
  private async binding(request: TurnRequest, command: string): Promise<string> {
    const root = await realpath(request.cwd), home = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
    const files = [this.resources().extensionPath, ...["settings.json", "models.json", "mcp.json", "AGENTS.md"].map((name) => join(home, name))];
    for (let directory = root; ; directory = dirname(directory)) {
      files.push(...["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"].map((name) => join(directory, name)));
      files.push(...["settings.json", "mcp.json"].map((name) => join(directory, ".pi", name)));
      if (dirname(directory) === directory) break;
    }
    const digest = createHash("sha256");
    digest.update(JSON.stringify({ projectQuery: Boolean(request.projectQuery) }));
    digest.update(JSON.stringify([root, request.workspaceTrusted === true, piPermission(request.allowWorkspaceWrite, request.permission, request.workspaceTrusted), command, request.cliArguments ?? [], request.mcpServers ?? [], home]));
    const identity = await stat(command); digest.update(`${identity.size}:${identity.mtimeMs}`);
    for (const file of files) { try { digest.update(file).update(await readFile(file)); } catch { /* Optional Pi configuration or text context. */ } }
    return digest.digest("hex");
  }
  private async validateSession(path: string): Promise<string> {
    const root = await realpath(this.resources().sessionDirectory);
    const canonical = await realpath(path).catch(() => { throw new Error("The stored Pi session is missing. Start a new conversation."); });
    const child = relative(root, canonical);
    if (!child || child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) throw new Error("The stored Pi session is outside Dext's session directory.");
    return canonical;
  }
  private async open(request: TurnRequest, command: string, binding: string, signal: AbortSignal, resume?: string, ephemeral = false): Promise<Session> {
    const resources = this.resources(); await mkdir(resources.sessionDirectory, { recursive: true });
    const permission = piPermission(request.allowWorkspaceWrite, request.permission, request.workspaceTrusted);
    let session: Session | undefined;
    const bridge = new PiBridge({ permission, tools: piTools(permission, Boolean(request.contract), process.platform, request.workspaceTrusted === true, Boolean(request.projectQuery)), mcpServers: request.mcpServers ?? [], projectQuery: request.workspaceTrusted === true && Boolean(request.projectQuery),
      ...(request.contract ? { resultSchema: resultToolParameters(request.contract.outputJsonSchema) } : {}) }, (frame) => this.bridgeRequest(session, frame));
    let transport: PiRpcTransport | undefined;
    try {
      const args = piArguments({ ...resources, trusted: request.workspaceTrusted === true, permission, result: Boolean(request.contract), ephemeral, projectQuery: Boolean(request.projectQuery),
        ...(resume ? { sessionPath: resume } : {}), ...(request.cliArguments ? { extra: request.cliArguments } : {}) });
      transport = (this.options.transportFactory ?? ((program, argv, cwd, env) => new PiRpcTransport(program, argv, cwd, env)))(command, args, request.cwd,
        { ...process.env, DEXT_PI_BRIDGE: bridge.endpoint, DEXT_PI_BRIDGE_TOKEN: bridge.token });
      session = { binding, transport, bridge, state: {}, fresh: !resume };
      const current = session;
      transport.onRecord = (frame) => this.record(current, frame);
      transport.onFailure = (error) => current.active?.reject(error);
      const [state] = await Promise.all([transport.request("get_state", {}, 30000, signal), bridge.ready(signal)]);
      session.state = stateFrom(state);
      return session;
    } catch (error) { bridge.dispose(); await transport?.close(); throw error; }
  }
  private async bridgeRequest(session: Session | undefined, frame: PiBridgeRequest): Promise<unknown> {
    const active = session?.active;
    if (!active || active.done || active.controller.signal.aborted) return { status: "unavailable" };
    if (frame.kind === "question") return piQuestion(active.request, frame.id, frame.questions, active.controller.signal, active.timeout);
    if (frame.kind === "fetch") return piFetch(frame.url, active.controller.signal);
    if (frame.kind === "project_query") {
      if (!active.request.workspaceTrusted || !active.request.projectQuery) return { status: "unavailable" };
      const value = await active.request.projectQuery(frame.query);
      if (session?.active !== active || active.done || active.controller.signal.aborted) return { status: "unavailable" };
      return { status: "accepted", value };
    }
    const parsed = active.request.contract?.outputSchema.safeParse(frame.args);
    if (!parsed) return { status: "unavailable" };
    if (!parsed.success) return { status: "rejected", diagnostics: formatDiagnostics(parsed.error) };
    active.submitted = JSON.stringify(parsed.data); return { status: "accepted" };
  }
  private emit(active: Active, frame: PiRecord): void {
    for (const event of active.events.consume(frame)) {
      if (event.phase === "tool" && event.id) { if (event.done) active.timeout.toolFinished(event.id); else active.timeout.toolStarted(event.id); }
      active.request.onEvent?.(event);
    }
  }
  private record(session: Session, frame: PiRecord): void {
    const active = session.active;
    if (!active || active.done || active.controller.signal.aborted) return;
    active.timeout.activity();
    if (frame.type === "extension_ui_request" && typeof frame.id === "string" && typeof frame.method === "string") {
      if (active.uiIds.has(frame.id)) return; active.uiIds.add(frame.id);
      void piUi(active.request, { ...frame, type: "extension_ui_request", id: frame.id, method: frame.method }, active.controller.signal, active.timeout).then(async (reply) => {
        if (reply && session.active === active && !active.done && !active.controller.signal.aborted) await session.transport.write(reply);
      }).catch((error: unknown) => active.reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    if (frame.type === "message_start") delete active.retryError;
    if (frame.type === "auto_retry_end" && frame.success === false) active.retryError = piText(frame.finalError, "Pi retries exhausted.");
    this.emit(active, frame);
    if (frame.type === "agent_settled") {
      active.done = true;
      if (frame.aborted === true) active.reject(new ExecutionCancelledError());
      else if (active.events.error || active.retryError) active.reject(new Error(active.events.error ?? active.retryError));
      else if (["toolUse", "pending"].includes(active.events.stopReason)) active.reject(new Error("Pi stopped before producing a final response."));
      else active.resolve();
    }
  }
  private async stop(session: Session): Promise<void> {
    for (const command of ["clear_queue", "abort_retry", "abort"]) {
      if (!session.transport.alive) break;
      try { await session.transport.request(command, {}, 250); } catch { /* Force-close below if the CLI does not cooperate. */ }
    }
    await this.close(session);
  }
  private async close(session: Session): Promise<void> { session.bridge.dispose(); await session.transport.close(); }
  private async select(session: Session, request: TurnRequest, defaults: PiState, signal: AbortSignal): Promise<void> {
    const model = request.model ? parsePiModelId(request.model) : defaults.model;
    if (!model) throw new Error("No Pi model is configured. Configure a model and authentication in Pi, then refresh Dext.");
    const selected = stateFrom({ model: await session.transport.request("set_model", { provider: model.provider, modelId: model.id }, 30000, signal) }).model;
    if (!selected || piModelId(selected) !== piModelId(model)) throw new Error("Pi did not select the requested model.");
    const levels = piThinkingLevels(piObject(await session.transport.request("get_available_thinking_levels", {}, 30000, signal)).levels);
    const modelKey = `${session.binding}:${piModelId(model)}`;
    const before = stateFrom(await session.transport.request("get_state", {}, 30000, signal));
    if (!this.modelDefaults.has(modelKey) && before.thinkingLevel) this.modelDefaults.set(modelKey, before.thinkingLevel);
    const effort = request.reasoningEffort || (defaults.model && piModelId(defaults.model) === piModelId(model) ? defaults.thinkingLevel : this.modelDefaults.get(modelKey));
    if (effort && !levels.includes(effort)) throw new Error("The selected Pi model does not support the requested reasoning effort.");
    if (effort) await session.transport.request("set_thinking_level", { level: effort }, 30000, signal);
    session.state = stateFrom(await session.transport.request("get_state", {}, 30000, signal));
    if (effort && session.state.thinkingLevel !== effort) throw new Error("Pi silently changed the requested reasoning effort.");
    const models = piModels(piObject(await session.transport.request("get_available_models", {}, 30000, signal)).models);
    this.onModels?.(request.profile, { options: piModelOptions(models, defaults, new Map([[piModelId(model), levels]])), defaults: this.presentDefaults(defaults) }, piDiscoveryIdentity(request.cwd, request.workspaceTrusted === true, request.profile.command, request.cliArguments ?? []));
  }
  private presentDefaults(state: PiState): PiDiscovery["defaults"] {
    return { ...(state.model ? { model: piModelId(state.model) } : {}), ...(state.thinkingLevel ? { reasoningEffort: state.thinkingLevel } : {}) };
  }
  discoverModels(profile: AgentProfile, cwd: string, args: readonly string[] = [], model?: string, trusted = false): Promise<PiDiscovery> {
    const key = JSON.stringify([profile.command, cwd, args, model, trusted]);
    const prior = this.discoveries.get(key); if (prior) return prior;
    const operation = this.discover(profile, cwd, args, model, trusted);
    this.discoveries.set(key, operation);
    void operation.finally(() => { if (this.discoveries.get(key) === operation) this.discoveries.delete(key); }).catch(() => {});
    return operation;
  }
  private async discover(profile: AgentProfile, cwd: string, args: readonly string[], model: string | undefined, trusted: boolean): Promise<PiDiscovery> {
    if (this.disposed) throw new ExecutionCancelledError();
    const controller = new AbortController(), queued = { key: randomUUID(), controller }; this.controllers.add(queued);
    let session: Session | undefined;
    try {
      const request: TurnRequest = { profile, cwd, mode: "ask", input: "", metadata: {}, allowWorkspaceWrite: false, workspaceTrusted: trusted, cliArguments: args };
      const command = piCommand(profile); await (this.options.versionProbe ?? checkPiVersion)(command, cwd, controller.signal);
      const binding = await this.binding(request, command);
      session = await this.open(request, command, binding, controller.signal, undefined, true);
      const defaults = session.state; this.defaults.set(binding, defaults);
      const models = piModels(piObject(await session.transport.request("get_available_models", {}, 30000, controller.signal)).models);
      const levels = new Map<string, string[]>();
      if (model) { const selected = parsePiModelId(model); await session.transport.request("set_model", { provider: selected.provider, modelId: selected.id }, 30000, controller.signal); }
      const current = model || (defaults.model ? piModelId(defaults.model) : undefined);
      if (current) levels.set(current, piThinkingLevels(piObject(await session.transport.request("get_available_thinking_levels", {}, 30000, controller.signal)).levels));
      const result = { options: piModelOptions(models, defaults, levels), defaults: this.presentDefaults(defaults) };
      return result;
    } finally { this.controllers.delete(queued); if (session) await this.close(session); }
  }
  run(request: AgentExecutionRequest): Promise<unknown> {
    const metadata = { ...request.metadata };
    delete metadata.agentSessionId; delete metadata.conversationProviderSessionId; delete metadata.conversationForkFrom; delete metadata.onAgentSessionId;
    const write = request.allowWorkspaceWrite === true;
    const patch = request.includePatch === false ? "Do not include a patch; report conclusions in text only." : write ? "Include an auditable patch when possible." : "Return a complete applicable patch for requested edits without editing files.";
    const input = `Submit the final result through dext_submit_result. Fix validation errors in this same turn.\n${write ? "Execute the requested task with the granted write scope." : "This is a read-only API call."} ${patch}\nDext payload:\n${agentPayload(request)}\nIf the result tool is unavailable, return only JSON matching this schema: ${JSON.stringify(request.contract.outputJsonSchema)}`;
    return this.runConversation({ ...request, input, metadata, mode: "ask", allowWorkspaceWrite: write });
  }
  runConversation(request: TurnRequest): Promise<string> {
    if (this.disposed) return Promise.reject(new ExecutionCancelledError());
    const key = request.metadata.agentSessionId ?? randomUUID(), controller = new AbortController(), queued = { key, controller };
    const cancel = (): void => controller.abort(new ExecutionCancelledError());
    request.signal?.addEventListener("abort", cancel, { once: true }); if (request.signal?.aborted) cancel();
    this.controllers.add(queued);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => {}).then(() => this.execute(key, request, controller));
    this.queues.set(key, operation);
    void operation.finally(() => { request.signal?.removeEventListener("abort", cancel); this.controllers.delete(queued); if (this.queues.get(key) === operation) this.queues.delete(key); }).catch(() => {});
    return operation;
  }
  private async execute(key: string, request: TurnRequest, controller: AbortController): Promise<string> {
    if (this.disposed || controller.signal.aborted) throw new ExecutionCancelledError();
    piPermission(request.allowWorkspaceWrite, request.permission, request.workspaceTrusted);
    if (request.speed || request.serviceTier) throw new Error("Pi does not support Dext speed or service-tier overrides.");
    const timeout = agentTimeout(controller, this.timeoutMs, this.idleTimeoutMs); timeout.toolStarted("startup");
    let session: Session | undefined;
    let active: Active | undefined;
    const onAbort = (): void => active?.reject(controller.signal.reason instanceof Error ? controller.signal.reason : new ExecutionCancelledError());
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const command = piCommand(request.profile); await (this.options.versionProbe ?? checkPiVersion)(command, request.cwd, controller.signal);
      const binding = await this.binding(request, command);
      session = this.sessions.get(key);
      if (session && (session.binding !== binding || !session.transport.alive)) { await this.close(session); this.sessions.delete(key); session = undefined; }
      let resume: string | undefined;
      if (!session && !request.metadata.conversationForkFrom && request.metadata.conversationProviderSessionId) {
        const stored = decodePiSession(request.metadata.conversationProviderSessionId);
        if (stored.binding === binding) resume = await this.validateSession(stored.path);
      }
      if (resume && !this.defaults.has(binding)) {
        const clean = await this.open(request, command, binding, controller.signal, undefined, true);
        try { this.defaults.set(binding, clean.state); await this.select(clean, request, clean.state, controller.signal); }
        finally { await this.close(clean); }
      }
      session ??= await this.open(request, command, binding, controller.signal, resume);
      this.sessions.set(key, session);
      const defaults = this.defaults.get(binding) ?? session.state; this.defaults.set(binding, defaults);
      await this.select(session, request, defaults, controller.signal);
      let resolveTurn!: () => void, rejectTurn!: (error: Error) => void;
      const completed = new Promise<void>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; }); void completed.catch(() => {});
      active = { request, controller, timeout, events: new PiEvents(`${key}:${randomUUID()}`), resolve: resolveTurn, reject: rejectTurn, done: false, uiIds: new Set() };
      session.active = active; session.transport.onActivity = timeout.activity; session.bridge.beginTurn();
      if (!request.allowWorkspaceWrite && request.mcpServers?.length) request.onEvent?.({ phase: "status", text: "Pi native MCP is disabled for this read-only turn. Code MCP calls remain available through Dext." });
      try { active.events.setBaseline(await session.transport.request("get_session_stats", {}, 1000, controller.signal)); } catch { /* Message-level usage remains available. */ }
      if (controller.signal.aborted) throw controller.signal.reason;
      const input = session.fresh ? bootstrappedConversationInput(request.metadata.conversationContext, request.input) : request.input;
      session.fresh = false; timeout.toolFinished("startup");
      const accepted = piObject(await session.transport.request("prompt", { message: input }, 30000, controller.signal));
      if (accepted.disposition === "handled") { active.done = true; throw new Error("Pi handled this input without starting a Dext conversation turn."); }
      if (accepted.disposition !== "started") throw new Error("Pi unexpectedly queued this Dext turn.");
      await completed;
      try { active.events.setStats(await session.transport.request("get_session_stats", {}, 1000, controller.signal)); } catch { /* Do not lose a completed answer because optional statistics failed. */ }
      session.state = stateFrom(await session.transport.request("get_state", {}, 1000, controller.signal));
      const usage = active.events.usage(); if (usage) request.onEvent?.({ phase: "status", text: "", usage });
      const text = active.submitted ?? active.events.finalText;
      if (!text.trim()) throw new Error("Pi returned no final response.");
      if (session.state.sessionFile && request.metadata.agentSessionId) request.metadata.onAgentSessionId?.("pi", encodePiSession({ path: await this.validateSession(session.state.sessionFile), binding }));
      return text;
    } catch (error) {
      if (session) { this.sessions.delete(key); await this.stop(session); }
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      if (active) active.done = true;
      timeout.dispose(); controller.signal.removeEventListener("abort", onAbort); controller.abort(new ExecutionCancelledError());
      if (session) { session.active = undefined; session.transport.onActivity = undefined; session.bridge.clearTurn(); }
      if (session && !request.metadata.agentSessionId) { this.sessions.delete(key); await this.close(session); }
    }
  }
  endSession(key: string): void {
    for (const queued of this.controllers) if (queued.key === key) queued.controller.abort(new ExecutionCancelledError());
    const session = this.sessions.get(key);
    if (session) {
      this.sessions.delete(key);
      const cleanup = this.stop(session); this.cleanups.add(cleanup);
      void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const queued of this.controllers) queued.controller.abort(new ExecutionCancelledError());
    await Promise.allSettled([...this.queues.values(), ...this.discoveries.values()]);
    await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session))); this.sessions.clear();
    await Promise.allSettled(this.cleanups);
  }
}

export function piDiscoveryIdentity(cwd: string, trusted: boolean, command: string | undefined, args: readonly string[]): string {
  return JSON.stringify([cwd, trusted, command, args, process.env.PI_CODING_AGENT_DIR ?? ""]);
}
