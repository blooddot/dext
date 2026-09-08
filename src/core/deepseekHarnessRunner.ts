import { randomUUID } from "node:crypto";
import type { SessionConfigOption, SessionNotification, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentModelOption, AgentPermission, AgentProfile } from "../agentProfiles.js";
import { agentPayload, bootstrappedConversationInput, type AgentRunner, type AgentConversationRequest, type AgentExecutionRequest } from "./agentRunner.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import { createHarnessPolicy, decodeHarnessSession, encodeHarnessSession, harnessBinding } from "./deepseekHarnessPolicy.js";
import { DeepSeekHarnessTransport } from "./deepseekHarnessTransport.js";
import { agentTodoEvent, normalizeAgentTodos } from "./agentTodoTracking.js";

type Request = AgentConversationRequest;
interface Session {
  id: string; binding: string; transport: DeepSeekHarnessTransport;
  policy: Awaited<ReturnType<typeof createHarnessPolicy>>;
  options: SessionConfigOption[]; defaults: Map<string, string>;
  request?: Request | undefined; messages: Map<string, string>; tools: Map<string, ToolCallUpdate>; fresh: boolean;
}

export function harnessChoices(options: readonly SessionConfigOption[], id: string): { value: string; name: string }[] {
  const option = options.find((item) => item.id === id);
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((item) => "options" in item ? item.options : [item]);
}

export function harnessModelOptions(options: readonly SessionConfigOption[]): AgentModelOption[] {
  const current = options.find((item) => item.id === "model")?.currentValue;
  return harnessChoices(options, "model").map((item) => ({ id: item.value, label: item.name,
    reasoningEfforts: item.value === current ? harnessChoices(options, "reasoning_effort").map((choice) => choice.value).filter(Boolean) : [],
    speedTiers: [], serviceTiers: [] }));
}

export class DeepSeekHarnessRunner implements AgentRunner {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  onModels?: (profile: AgentProfile, options: AgentModelOption[]) => void;
  constructor(private timeoutMs = 3_600_000, private readonly transportFactory = (command: string, args: readonly string[], cwd: string, client: ConstructorParameters<typeof DeepSeekHarnessTransport>[3]) => new DeepSeekHarnessTransport(command, args, cwd, client)) {}
  setTimeoutMs(value: number): void { this.timeoutMs = value; }

  private arguments(args: readonly string[], patch: string): string[] {
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] !== "--patch" || !args[i + 1]) throw new Error("Harness extra arguments support only --patch <path> pairs. Dext owns the ACP profile and permission policy.");
    }
    return [...args, "--profile", "acp", "--patch", patch];
  }

  private async open(request: Request, binding: string): Promise<Session> {
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    const permission = request.allowWorkspaceWrite ? request.permission ?? "workspace-write" : "read-only";
    const policy = await createHarnessPolicy(permission, request.cwd);
    let session: Session | undefined;
    let transport: DeepSeekHarnessTransport | undefined;
    const onAbort = (): void => { void transport?.close(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      transport = this.transportFactory(request.profile.command, this.arguments(request.cliArguments ?? [], policy.path), request.cwd, {
        sessionUpdate: (event) => { if (session && event.sessionId === session.id) this.update(session, event); },
        requestPermission: (event) => session ? this.permission(session, event, permission) : Promise.resolve({ outcome: { outcome: "cancelled" } })
      });
      await transport.initialize();
      const saved = request.metadata.conversationProviderSessionId ? decodeHarnessSession(request.metadata.conversationProviderSessionId) : undefined;
      const resume = saved?.binding === binding && !request.metadata.conversationForkFrom ? saved.id : undefined;
      if (request.signal?.aborted) throw new ExecutionCancelledError();
      const response = resume
        ? await transport.wait(transport.connection.resumeSession({ sessionId: resume, cwd: request.cwd, mcpServers: [] }))
        : await transport.wait(transport.connection.newSession({ cwd: request.cwd, mcpServers: [] }));
      const id = resume ?? (response as { sessionId: string }).sessionId;
      session = { id, binding, transport, policy, options: response.configOptions ?? [], defaults: new Map(), messages: new Map(), tools: new Map(), fresh: !resume };
      for (const option of session.options) if (option.type === "select") session.defaults.set(option.id, option.currentValue);
      return session;
    } catch (error) { await transport?.close(); await policy.dispose(); throw error; }
    finally { request.signal?.removeEventListener("abort", onAbort); }
  }

  private update(session: Session, event: SessionNotification): void {
    const update = event.update;
    const request = session.request;
    if (update.sessionUpdate === "config_option_update") { session.options = update.configOptions; return; }
    if (!request) return;
    if (update.sessionUpdate === "plan") {
      const todos = normalizeAgentTodos(update.entries, "acp");
      if (todos) request.onEvent?.(agentTodoEvent(todos));
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type !== "text") return;
      const thought = update.sessionUpdate === "agent_thought_chunk";
      const id = update.messageId ?? (thought ? "thought" : "answer");
      if (!thought) session.messages.set(id, (session.messages.get(id) ?? "") + update.content.text);
      request.onEvent?.({ id: `${session.id}:${id}`, phase: thought ? "reasoning" : "message", text: update.content.text, ...(thought ? {} : { group: "work-log" as const }) });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const tool = { ...session.tools.get(update.toolCallId), ...update };
      session.tools.set(update.toolCallId, tool);
      const details = tool.content?.map((item) => item.type === "content" && item.content.type === "text" ? item.content.text : item.type === "diff" ? `${item.path}\n${item.newText}` : "").filter(Boolean).join("\n");
      request.onEvent?.({ id: `${session.id}:${tool.toolCallId}`, phase: "tool", group: "work-log", title: tool.title ?? "Tool", text: details || tool.title || "Tool", replace: true,
        done: tool.status === "completed" || tool.status === "failed", toolKind: tool.kind === "execute" ? "command" : tool.kind === "edit" || tool.kind === "read" ? "file" : "step" });
    }
    // ACP usage_update describes context occupancy, not per-turn token charges.
  }

  private async permission(session: Session, event: RequestPermissionRequest, permission: AgentPermission): Promise<RequestPermissionResponse> {
    const request = session.request;
    const reject = (): RequestPermissionResponse => {
      const option = event.options.find((item) => item.kind === "reject_once");
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    if (event.sessionId !== session.id || !request || request.signal?.aborted) return { outcome: { outcome: "cancelled" } };
    const tool = session.tools.get(event.toolCall.toolCallId);
    // The wire does not identify escalation scope. Ordinary confined operations
    // need no escalation; unknown scope must never expand a restricted boundary.
    if (permission !== "full-access" || !tool?.title || !request.metadata.ui) return reject();
    const answer = await request.metadata.ui.confirm({ message: tool.title, confirmLabel: "Allow once", cancelLabel: "Reject" });
    if (request.signal?.aborted) return { outcome: { outcome: "cancelled" } };
    const allow = event.options.find((item) => item.kind === "allow_once");
    return answer.confirmed && allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : reject();
  }

  private async select(session: Session, request: Request): Promise<void> {
    const model = request.model || session.defaults.get("model");
    if (model) {
      if (!harnessChoices(session.options, "model").some((option) => option.value === model)) throw new Error("The selected Harness model is unavailable. Refresh models using Configure Agent.");
      session.options = (await session.transport.wait(session.transport.connection.setSessionConfigOption({ sessionId: session.id, configId: "model", value: model }))).configOptions;
    }
    const effort = request.reasoningEffort;
    const efforts = harnessChoices(session.options, "reasoning_effort");
    if (effort && !efforts.some((item) => item.value === effort)) throw new Error("This Harness model does not support the selected reasoning effort.");
    if (!session.defaults.has(`reasoning:${model}`)) {
      const current = session.options.find((option) => option.id === "reasoning_effort");
      if (current?.type === "select") session.defaults.set(`reasoning:${model}`, current.currentValue);
    }
    const target = effort || session.defaults.get(`reasoning:${model}`);
    if (target !== undefined && efforts.some((item) => item.value === target)) {
      session.options = (await session.transport.wait(session.transport.connection.setSessionConfigOption({ sessionId: session.id, configId: "reasoning_effort", value: target }))).configOptions;
    }
    this.onModels?.(request.profile, harnessModelOptions(session.options).filter((item) => item.id === model));
  }

  discoverModels(profile: AgentProfile, cwd: string, args: readonly string[] = []): Promise<AgentModelOption[]> {
    const key = randomUUID();
    const operation = this.discover(profile, cwd, args);
    this.queues.set(key, operation);
    void operation.finally(() => this.queues.delete(key)).catch(() => undefined);
    return operation;
  }

  private async discover(profile: AgentProfile, cwd: string, args: readonly string[]): Promise<AgentModelOption[]> {
    if (this.disposed) throw new ExecutionCancelledError();
    const controller = new AbortController();
    this.controllers.add(controller);
    let session: Session | undefined;
    const onAbort = (): void => { void session?.transport.close(); };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const request: Request = { profile, cwd, cliArguments: args, mode: "ask", input: "", metadata: {}, allowWorkspaceWrite: false, signal: controller.signal };
      const binding = await harnessBinding(cwd, "read-only", profile.command, args);
      session = await this.open(request, binding);
      if (controller.signal.aborted) throw new ExecutionCancelledError();
      const models: AgentModelOption[] = [];
      for (const choice of harnessChoices(session.options, "model")) {
        session.options = (await session.transport.wait(session.transport.connection.setSessionConfigOption({ sessionId: session.id, configId: "model", value: choice.value }))).configOptions;
        models.push(harnessModelOptions(session.options).find((item) => item.id === choice.value)!);
      }
      return models;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
      if (session) await this.close(session);
    }
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    const input = `${request.allowWorkspaceWrite ? "Execute the API within the workspace and include an auditable patch when possible." : "This is a read-only API call. For requested changes return a complete applicable patch without editing files."}\nReturn only a JSON object matching this schema as your final message:\n${JSON.stringify(request.contract.outputJsonSchema)}\nDext JSON payload:\n${agentPayload(request)}`;
    const metadata = { ...request.metadata };
    delete metadata.agentSessionId; delete metadata.conversationProviderSessionId; delete metadata.conversationForkFrom; delete metadata.onAgentSessionId;
    const text = await this.runConversation({ ...request, input, mode: "ask", allowWorkspaceWrite: Boolean(request.allowWorkspaceWrite), metadata });
    try { return JSON.parse(text.trim()); }
    catch { throw new Error("Harness completed the task but returned invalid JSON. The task was not retried; inspect its execution log before retrying."); }
  }

  runConversation(request: Request): Promise<string> {
    const key = request.metadata.agentSessionId ?? randomUUID();
    const prior = this.queues.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.execute(key, request));
    this.queues.set(key, operation);
    void operation.finally(() => { if (this.queues.get(key) === operation) this.queues.delete(key); }).catch(() => undefined);
    return operation;
  }

  private async execute(key: string, request: Request): Promise<string> {
    if (this.disposed || request.signal?.aborted) throw new ExecutionCancelledError();
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancel = (): void => controller.abort(new ExecutionCancelledError());
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("DeepSeek Harness turn timed out.")), this.timeoutMs);
    const active = { ...request, signal: controller.signal };
    let session: Session | undefined;
    let prompting = false;
    const abortTransport = (): void => { if (!prompting) void session?.transport.close(); };
    controller.signal.addEventListener("abort", abortTransport, { once: true });
    try {
      const permission = request.allowWorkspaceWrite ? request.permission ?? "workspace-write" : "read-only";
      const binding = await harnessBinding(request.cwd, permission, request.profile.command, request.cliArguments ?? []);
      session = this.sessions.get(key);
      if (session && (session.binding !== binding || !session.transport.alive)) {
        await this.close(session); this.sessions.delete(key); session = undefined;
      }
      session ??= await this.open(active, binding);
      this.sessions.set(key, session);
      if (controller.signal.aborted) throw controller.signal.reason;
      session.request = active; session.messages.clear(); session.tools.clear();
      await this.select(session, active);
      if (controller.signal.aborted) throw controller.signal.reason;
      request.metadata.onAgentSessionId?.("deepseek-harness", encodeHarnessSession(session.id, binding));
      const input = session.fresh ? bootstrappedConversationInput(request.metadata.conversationContext, request.input) : request.input;
      session.fresh = false;
      const current = session;
      let abortListener: (() => void) | undefined;
      try {
        prompting = true;
        const result = await Promise.race([
          session.transport.wait(session.transport.connection.prompt({ sessionId: session.id, prompt: [{ type: "text", text: input }] }), this.timeoutMs),
          new Promise<never>((_, reject) => {
            abortListener = () => {
              void current.transport.connection.cancel({ sessionId: current.id }).catch(() => undefined);
              reject(controller.signal.reason instanceof Error ? controller.signal.reason : new ExecutionCancelledError());
            };
            controller.signal.addEventListener("abort", abortListener, { once: true });
            if (controller.signal.aborted) abortListener();
          })
        ]);
        if (result.stopReason === "cancelled") throw new ExecutionCancelledError();
        if (result.stopReason !== "end_turn") throw new Error(`Harness stopped before completion: ${result.stopReason}`);
        const text = [...session.messages.values()].at(-1)?.trim();
        if (!text) throw new Error("DeepSeek Harness returned no text response.");
        return text;
      } finally { prompting = false; if (abortListener) controller.signal.removeEventListener("abort", abortListener); }
    } catch (error) {
      if (session) { await this.close(session); this.sessions.delete(key); }
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer); this.controllers.delete(controller); request.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abortTransport);
      if (session) session.request = undefined;
      if (session && !request.metadata.agentSessionId) { await this.close(session); this.sessions.delete(key); }
    }
  }

  private async close(session: Session): Promise<void> {
    try { if (session.transport.alive) await session.transport.wait(session.transport.connection.closeSession({ sessionId: session.id }), 1500); }
    catch { /* Shutdown also cancels work owned by this connection. */ }
    finally { await session.transport.close(); await session.policy.dispose(); }
  }
  endSession(key: string): void {
    const session = this.sessions.get(key);
    if (session) { this.sessions.delete(key); void this.close(session).catch(() => undefined); }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort(new ExecutionCancelledError());
    await Promise.allSettled([...this.queues.values()]);
    await Promise.allSettled([...this.sessions.values()].map((session) => this.close(session)));
    this.sessions.clear();
  }
}
