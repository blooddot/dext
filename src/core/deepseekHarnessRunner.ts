import { uiCallForm } from "./uiForm.js";
import { randomUUID } from "node:crypto";
import type { CreateElicitationRequest, CreateElicitationResponse, SessionConfigOption, SessionNotification, RequestPermissionRequest, RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AgentModelOption, AgentPermission, AgentProfile } from "../agentProfiles.js";
import { agentPayload, bootstrappedConversationInput, type AgentRunner, type AgentConversationRequest, type AgentExecutionRequest } from "./agentRunner.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import { createHarnessPolicy, decodeHarnessSession, encodeHarnessSession, harnessBinding, readHarnessLaunchSettings, type HarnessLaunchSettings } from "./deepseekHarnessPolicy.js";
import { DeepSeekHarnessTransport } from "./deepseekHarnessTransport.js";
import { agentTodoEvent, normalizeAgentTodos } from "./agentTodoTracking.js";
import { elicitationQuestions, elicitationResponse, harnessInputQuestions, harnessQuestionAnswer, type HarnessQuestionOutcome, type HarnessQuestionRequest } from "./harnessQuestions.js";
import { harnessPresetPatch } from "./harnessPresets.js";
import { harnessResultEnvelope } from "./harnessPresetDefault.js";
import { agentTimeout, DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_AGENT_IDLE_TIMEOUT_MS } from "./agentTimeout.js";
import type { AgentInputAnswers, AgentInputQuestion, AgentInputRequest, AgentInputState } from "./types.js";

type Request = AgentConversationRequest;
interface Session {
  id: string; binding: string; transport: DeepSeekHarnessTransport;
  policy: Awaited<ReturnType<typeof createHarnessPolicy>>;
  options: SessionConfigOption[]; defaults: Map<string, string>;
  request?: Request | undefined; messages: Map<string, string>; tools: Map<string, ToolCallUpdate>; fresh: boolean;
  timeout?: ReturnType<typeof agentTimeout> | undefined;
}

export function harnessChoices(options: readonly SessionConfigOption[], id: string): { value: string; name: string; group?: string }[] {
  const option = options.find((item) => item.id === id);
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((item) => "group" in item
    ? item.options.map((choice) => ({ value: choice.value, name: choice.name, group: item.name }))
    : [{ value: item.value, name: item.name }]);
}

export function harnessModelOptions(options: readonly SessionConfigOption[], defaultModel?: string, defaultEffort?: string): AgentModelOption[] {
  const current = options.find((item) => item.id === "model")?.currentValue;
  const effort = defaultEffort ?? options.find((item) => item.id === "reasoning_effort")?.currentValue;
  return harnessChoices(options, "model").map((item) => ({ id: item.value, label: item.name,
    ...(item.group ? { group: item.group } : {}),
    ...(defaultModel ? { isDefault: item.value === defaultModel } : {}),
    ...(item.value === current && typeof effort === "string" && effort ? { defaultReasoningEffort: effort } : {}),
    reasoningEfforts: item.value === current ? harnessChoices(options, "reasoning_effort").map((choice) => choice.value).filter(Boolean) : [],
    speedTiers: [], serviceTiers: [] }));
}

/**
 * ACP capability gap: `PromptRequest` (`@agentclientprotocol/sdk`
 * `types.gen.d.ts:5140-5169`) has no output-schema field, so the harness cannot
 * be constrained natively the way claude/codex are with `--json-schema` /
 * `--output-schema`. Dext therefore relies on prompt hardening plus the shared
 * result boundary (and, for claude/codex only, the bounded repair predictor).
 * To re-probe after an upstream upgrade, inspect `session.options` from
 * newSession/resumeSession for a new output-format config option; this round
 * deliberately does not send a `_meta` experiment.
 */
export class DeepSeekHarnessRunner implements AgentRunner {
  private readonly sessions = new Map<string, Session>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private disposed = false;
  private readonly controllers = new Set<AbortController>();
  private settingsLoad?: Promise<HarnessLaunchSettings | undefined>;
  onModels?: (profile: AgentProfile, options: AgentModelOption[]) => void;
  constructor(
    private timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
    private readonly transportFactory = (command: string, args: readonly string[], cwd: string, client: ConstructorParameters<typeof DeepSeekHarnessTransport>[3]) => new DeepSeekHarnessTransport(command, args, cwd, client),
    private readonly settingsLoader: () => Promise<HarnessLaunchSettings | undefined> = readHarnessLaunchSettings,
    private idleTimeoutMs = DEFAULT_AGENT_IDLE_TIMEOUT_MS
  ) {}
  setTimeoutMs(value: number): void { this.timeoutMs = value; }
  setIdleTimeoutMs(value: number): void { this.idleTimeoutMs = value; }
  private launchSettings(): Promise<HarnessLaunchSettings | undefined> { return this.settingsLoad ??= this.settingsLoader(); }
  async preloadSettings(): Promise<void> { await this.launchSettings(); }
  async refreshSettings(): Promise<void> { this.settingsLoad = this.settingsLoader(); await this.settingsLoad; }

  private arguments(args: readonly string[], patch: string): string[] {
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] !== "--patch" || !args[i + 1]) throw new Error("Harness extra arguments support only --patch <path> pairs. Dext owns the ACP profile and permission policy.");
    }
    return [...args, "--profile", "acp", "--patch", patch];
  }

  private async open(request: Request, binding: string, settings?: HarnessLaunchSettings): Promise<Session> {
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    const permission = request.allowWorkspaceWrite ? request.permission ?? "workspace-write" : "read-only";
    const presetPatch = request.agentPreset
      ? await harnessPresetPatch(request.profile, request.agentPreset, permission, settings?.defaultModel ? { ...settings.defaultModel } : {}, request.cwd) : [];
    const policy = await createHarnessPolicy(permission, request.cwd, settings, presetPatch);
    let session: Session | undefined;
    let transport: DeepSeekHarnessTransport | undefined;
    const onAbort = (): void => { void transport?.close(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      transport = this.transportFactory(request.profile.command, this.arguments(request.cliArguments ?? [], policy.path), request.cwd, {
        sessionUpdate: (event) => { if (session && event.sessionId === session.id) this.update(session, event); },
        requestPermission: (event) => session ? this.permission(session, event, permission) : Promise.resolve({ outcome: { outcome: "cancelled" } }),
        createElicitation: (event) => session ? this.elicitation(session, event) : Promise.resolve({ action: "decline" as const }),
        harnessQuestion: (event) => session ? this.harnessQuestion(session, event) : Promise.resolve({ status: "unavailable" as const })
      });
      await transport.initialize();
      const saved = request.metadata.conversationProviderSessionId ? decodeHarnessSession(request.metadata.conversationProviderSessionId) : undefined;
      const resume = saved?.binding === binding && !request.metadata.conversationForkFrom ? saved.id : undefined;
      if (request.signal?.aborted) throw new ExecutionCancelledError();
      const opened = await this.openSession(transport, request, resume);
      session = { ...opened, binding, transport, policy, defaults: new Map(), messages: new Map(), tools: new Map() };
      for (const option of session.options) if (option.type === "select") session.defaults.set(option.id, option.currentValue);
      return session;
    } catch (error) { await transport?.close(); await policy.dispose(); throw error; }
    finally { request.signal?.removeEventListener("abort", onAbort); }
  }

  /** Restore the stored session when the Harness still holds it, and start a fresh one
   * when it does not. A refusal that fails the turn would strand the conversation on a
   * session the user cannot see or fix; a new session keeps the turn alive, and the
   * `fresh` flag makes its prompt carry Dext's own conversation context instead. */
  private async openSession(transport: DeepSeekHarnessTransport, request: Request, resume: string | undefined):
    Promise<{ id: string; options: SessionConfigOption[]; fresh: boolean }> {
    const create = async (): Promise<{ id: string; options: SessionConfigOption[]; fresh: boolean }> => {
      const response = await transport.wait(transport.connection.newSession({ cwd: request.cwd, mcpServers: [] }));
      return { id: response.sessionId, options: response.configOptions ?? [], fresh: true };
    };
    if (!resume) return create();
    let refused: string;
    try {
      const response = await transport.wait(transport.connection.resumeSession({ sessionId: resume, cwd: request.cwd, mcpServers: [] }));
      return { id: resume, options: response.configOptions ?? [], fresh: false };
    } catch (error) {
      // An aborted turn is a cancellation, not a refusal: keep reporting it as one.
      if (request.signal?.aborted) throw error;
      refused = error instanceof Error ? error.message : String(error);
    }
    const opened = await create();
    request.onEvent?.({ id: `harness-session:${resume}`, phase: "message", group: "work-log",
      text: `Dext could not restore Harness session ${resume} (${refused}). Continuing in a new session with this conversation's context.` });
    return opened;
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
      if (tool.status === "completed" || tool.status === "failed") session.timeout?.toolFinished(tool.toolCallId);
      else session.timeout?.toolStarted(tool.toolCallId);
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
    const answer = await request.metadata.ui.form(uiCallForm("confirm", { message: tool.title, confirm_label: "Allow once", cancel_label: "Reject" }), request.signal);
    if (request.signal?.aborted) return { outcome: { outcome: "cancelled" } };
    const allow = event.options.find((item) => item.kind === "allow_once");
    return answer.status === "submitted" && allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : reject();
  }

  /**
   * ACP elicitation is the protocol's own channel for asking a human, and the
   * Harness does not use it yet: its `user-questions` seam has no answerer under
   * `dsh --profile acp`, so `ask_user_question` fails closed there. Dext already
   * answers the method, so a Harness release that bridges the two needs no
   * change here; `harnessQuestion` below covers the gap until then.
   */
  private async elicitation(session: Session, event: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const request = session.request;
    if (!request || request.signal?.aborted || ("sessionId" in event && event.sessionId !== session.id)) return { action: "cancelled" };
    const questions = elicitationQuestions(event);
    if (!questions) return { action: "decline" };
    const answers = await this.ask(session, request, randomUUID(), questions);
    return answers === undefined ? { action: "decline" } : elicitationResponse(event, answers);
  }

  /** Dext's private bridge carries the Harness `user-questions` seam, which the
   * ACP profile otherwise leaves unanswered. Answers land in the same Dext card
   * Codex App Server questions use. */
  private async harnessQuestion(session: Session, event: HarnessQuestionRequest): Promise<HarnessQuestionOutcome> {
    const request = session.request;
    if (!request || request.signal?.aborted) return { status: "unavailable" };
    const questions = harnessInputQuestions(event.questions);
    if (!questions.length) return { status: "unavailable" };
    const answers = await this.ask(session, request, event.id, questions);
    if (answers === undefined) return { status: "unavailable" };
    const answer = harnessQuestionAnswer(questions, answers);
    return answer ? { status: "answered", answer } : { status: "cancelled" };
  }

  /** Route one question batch through Dext's shared UI. `undefined` reports that
   * no Dext surface owned the card, which the caller answers by delegating
   * rather than by inventing a reply.
   *
   * The card is published as a `waiting` input event and closed with its
   * outcome, the way the Codex runner does. `metadata.requestAgentInput` only
   * carries the answer back, so both halves — the answer callback and the event
   * sink that renders the card — are required; with either missing the question
   * parks the turn with nothing on screen to answer it. */
  private async ask(session: Session, request: Request, id: string, questions: AgentInputQuestion[]): Promise<AgentInputAnswers | null | undefined> {
    const respond = request.metadata.requestAgentInput;
    const emit = request.onEvent;
    // The card IS the pair of input events below: without the sink there is no
    // question on screen, and waiting for an answer nobody can give would park
    // the turn until it is cancelled. Report no Dext surface instead, so the
    // caller fails closed with an error the model can read.
    if (!respond || !emit) return undefined;
    const signal = request.signal ?? new AbortController().signal;
    const input: AgentInputRequest = { id, questions, blocking: true };
    // Secret answers are never echoed back into the transcript.
    const publish = (status: AgentInputState["status"], answers?: AgentInputAnswers): void => {
      const visible = answers ? Object.fromEntries(questions.filter((question) => !question.isSecret && answers[question.id]).map((question) => [question.id, answers[question.id]!])) : undefined;
      emit({ phase: "input", text: "", userInput: { ...input, status, ...(visible ? { answers: visible } : {}) } });
    };
    // The question parks the turn, so idle detection has to pause with it.
    const key = `user-questions:${id}`;
    session.timeout?.toolStarted(key);
    let published = false;
    try {
      // Register the host callback before publishing the card, so fast replies are safe.
      const reply = respond(input, signal);
      published = true;
      publish("waiting");
      const answers = await reply;
      if (signal.aborted) { publish("dismissed"); return undefined; }
      publish(answers ? "answered" : "dismissed", answers ?? undefined);
      return answers;
    } catch { if (published) publish("dismissed"); return undefined; }
    finally { session.timeout?.toolFinished(key); }
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
    const defaultModel = session.defaults.get("model");
    this.onModels?.({ ...request.profile, defaults: {
      ...(defaultModel ? { model: defaultModel } : {}),
      ...(session.defaults.get("reasoning_effort") ? { reasoningEffort: session.defaults.get("reasoning_effort")! } : {})
    } }, harnessModelOptions(session.options, defaultModel, session.defaults.get(`reasoning:${model}`)).filter((item) => item.id === model));
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
      const settings = await this.launchSettings();
      const binding = await harnessBinding(cwd, "read-only", profile.command, args, settings);
      session = await this.open(request, binding, settings);
      if (controller.signal.aborted) throw new ExecutionCancelledError();
      const models: AgentModelOption[] = [];
      for (const choice of harnessChoices(session.options, "model")) {
        session.options = (await session.transport.wait(session.transport.connection.setSessionConfigOption({ sessionId: session.id, configId: "model", value: choice.value }))).configOptions;
        models.push(harnessModelOptions(session.options, session.defaults.get("model")).find((item) => item.id === choice.value)!);
      }
      return models;
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
      if (session) await this.close(session);
    }
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    const includePatch = request.includePatch !== false;
    const patchInstruction = request.allowWorkspaceWrite
      ? includePatch
        ? "Execute the API within the workspace and include an auditable patch when possible."
        : "Execute the API within the workspace. Do not include a patch; report conclusions in text only."
      : includePatch
        ? "This is a read-only API call. For requested changes return a complete applicable patch without editing files."
        : "This is a read-only API call. Do not include a patch; report conclusions in text only.";
    // The JSON-only contract is stated on both sides of the payload. Project
    // rules are carried in the payload's `instruction` field, ahead of it and in
    // a stronger voice, so a trailing-only reminder loses that conflict in a
    // long session and the model answers in Markdown. The shared result boundary
    // still owns tolerant parsing.
    const schema = JSON.stringify(request.contract.outputJsonSchema);
    const input = `${harnessResultEnvelope(request.contract.outputJsonSchema)}\n\n${patchInstruction}\nDext JSON payload:\n${agentPayload(request)}\nReturn only a JSON object matching this schema as your final message: ${schema}\nNo markdown fence, no text before or after the object.`;
    const metadata = { ...request.metadata };
    delete metadata.agentSessionId; delete metadata.conversationProviderSessionId; delete metadata.conversationForkFrom; delete metadata.onAgentSessionId;
    return this.runConversation({ ...request, input, mode: "ask", allowWorkspaceWrite: Boolean(request.allowWorkspaceWrite), metadata });
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
    const timeout = agentTimeout(controller, this.timeoutMs, this.idleTimeoutMs);
    const active = { ...request, signal: controller.signal };
    let session: Session | undefined;
    let prompting = false;
    const abortTransport = (): void => { if (!prompting) void session?.transport.close(); };
    controller.signal.addEventListener("abort", abortTransport, { once: true });
    try {
      const permission = request.allowWorkspaceWrite ? request.permission ?? "workspace-write" : "read-only";
      const settings = await this.launchSettings();
      const binding = await harnessBinding(request.cwd, permission, request.profile.command, request.cliArguments ?? [], settings, request.agentPreset);
      session = this.sessions.get(key);
      if (session && (session.binding !== binding || !session.transport.alive)) {
        await this.close(session); this.sessions.delete(key); session = undefined;
      }
      session ??= await this.open(active, binding, settings);
      this.sessions.set(key, session);
      session.transport.onActivity = timeout.activity;
      session.timeout = timeout;
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
          // The turn watchdog handles total and idle limits. A fixed RPC timer
          // here would still terminate a long turn that is actively streaming.
          session.transport.wait(session.transport.connection.prompt({ sessionId: session.id, prompt: [{ type: "text", text: input }] }), 0),
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
      timeout.dispose(); this.controllers.delete(controller); request.signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", abortTransport);
      if (session) { session.request = undefined; session.transport.onActivity = undefined; session.timeout = undefined; }
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
