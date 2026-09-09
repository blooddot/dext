import { randomUUID } from "node:crypto";
import type { AgentConversationRequest } from "./agentRunner.js";
import type { AgentInputAnswers, AgentInputRequest } from "./types.js";
import { agentTimeout } from "./agentTimeout.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import { CodexConversationConnection, type CodexRpcMessage } from "./codexConversationConnection.js";
import { codexConversationEvent, codexInputQuestions, object } from "./codexConversationEvents.js";
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";

export function codexAppServerArguments(extra: readonly string[]): string[] {
  const args = ["app-server"];
  for (let index = 0; index < extra.length; index++) {
    const arg = extra[index]!;
    if (["-c", "--config", "--enable", "--disable"].includes(arg) && extra[index + 1]) {
      args.push(arg, extra[++index]!);
    } else if (/^--(?:config|enable|disable)=.+/.test(arg)) args.push(arg);
    else throw new Error(`Codex interactive conversations do not support '${arg}' in dext.agentCliArgs. Use --config overrides instead.`);
  }
  return args;
}

export async function runCodexConversation(request: AgentConversationRequest, options: {
  command: string; env?: NodeJS.ProcessEnv | undefined; resumeId?: string | undefined; forkFromId?: string | undefined;
  timeoutMs: number; idleTimeoutMs: number; serviceTier?: string | undefined;
  onThread: (id: string) => void;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = agentTimeout(controller, options.timeoutMs, options.idleTimeoutMs);
  // Initialization/thread loading have their own RPC timeout. Idle detection
  // starts when generation begins, not while a cold CLI is loading config.
  timeout.toolStarted("connection-startup");
  const cancel = (): void => controller.abort(new ExecutionCancelledError());
  request.signal?.addEventListener("abort", cancel, { once: true });
  let threadId = "";
  let turnId = "";
  let finished = false;
  let finalText = "";
  let lastMessage = "";
  const inputs = new Map<string, { controller: AbortController; request: AgentInputRequest }>();
  const seenAsync = new Set<string>();
  const asyncItems = new Set<string>();
  let resolveTurn!: (text: string) => void;
  let rejectTurn!: (error: Error) => void;
  const completed = new Promise<string>((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  // Connection errors can arrive during initialization, before awaiting the turn.
  void completed.catch(() => {});
  const emitInput = (input: AgentInputRequest, status: "waiting" | "answered" | "dismissed", answers?: AgentInputAnswers): void => {
    const visibleAnswers = answers ? Object.fromEntries(input.questions.filter((q) => !q.isSecret && answers[q.id]).map((q) => [q.id, answers[q.id]!])) : undefined;
    request.onEvent?.({ phase: "input", text: "", userInput: { ...input, status, ...(visibleAnswers ? { answers: visibleAnswers } : {}) } });
  };
  const clearInputs = (): void => {
    for (const input of inputs.values()) {
      input.controller.abort(); emitInput(input.request, "dismissed");
    }
    inputs.clear();
  };
  const fail = (error: Error): void => {
    if (finished) return;
    finished = true; clearInputs(); rejectTurn(error);
  };
  const ask = async (key: string, input: AgentInputRequest, rpcId?: string | number): Promise<void> => {
    if (!input.questions.length) { if (rpcId !== undefined) connection.reject(rpcId); return; }
    const pending = { controller: new AbortController(), request: input };
    inputs.set(key, pending);
    if (input.blocking) timeout.toolStarted(`input:${key}`);
    try {
      // Register the host callback before publishing the card, so fast replies are safe.
      const reply = request.metadata.requestAgentInput!(input, pending.controller.signal);
      emitInput(input, "waiting");
      const answers = await reply;
      if (finished || pending.controller.signal.aborted) return;
      if (rpcId !== undefined) connection.respond(rpcId, { answers: answers ?? {} });
      else if (answers) {
        await connection.request("turn/steer", { threadId, expectedTurnId: turnId,
          input: [{ type: "text", text: input.questions.map((q) => `${q.question}\n${answers[q.id]?.answers.join("\n") ?? ""}`).join("\n\n"), text_elements: [] }] });
      }
      if (!finished && !pending.controller.signal.aborted) emitInput(input, answers ? "answered" : "dismissed", answers ?? undefined);
    } catch (error) {
      if (!finished && !pending.controller.signal.aborted) fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      inputs.delete(key); pending.controller.abort();
      if (input.blocking) timeout.toolFinished(`input:${key}`);
    }
  };
  const message = ({ id, method, params }: CodexRpcMessage): void => {
    if (finished) return;
    timeout.activity();
    if (id !== undefined) {
      if ((method === "item/tool/requestUserInput" || method === "tool/requestUserInput") && params.threadId === threadId) {
        void ask(JSON.stringify(id), { id: randomUUID(), questions: codexInputQuestions(params.questions),
          blocking: params.isBlocking !== false }, id);
      } else connection.reject(id);
      return;
    }
    if (params.threadId !== threadId || !threadId) return;
    if (method === "serverRequest/resolved") {
      const input = inputs.get(JSON.stringify(params.requestId));
      if (input) { inputs.delete(JSON.stringify(params.requestId)); input.controller.abort(); emitInput(input.request, "dismissed"); }
      return;
    }
    if (method === "turn/started") turnId = stringValue(object(params.turn).id);
    if (params.turnId && turnId && params.turnId !== turnId) return;
    if (method === "turn/completed") {
      const turn = object(params.turn);
      if (turnId && turn.id !== turnId) return;
      if (turn.status !== "completed") { fail(new Error(stringValue(object(turn.error).message) || `Codex turn ${stringValue(turn.status) || "failed"}.`)); return; }
      finished = true; clearInputs(); resolveTurn(finalText || lastMessage); return;
    }
    if (method === "error" && params.willRetry !== true) { fail(new Error(stringValue(object(params.error).message) || "Codex turn failed.")); return; }
    const item = object(params.item);
    if (item.type === "agentMessage" && item.delivery === "async") asyncItems.add(String(item.id));
    if (method === "item/agentMessage/delta" && asyncItems.has(String(params.itemId))) return;
    if (method === "item/completed" && item.type === "agentMessage") {
      const questions = item.delivery === "async" ? codexInputQuestions(item.questions, true) : [];
      if (questions.length) {
        const key = `async:${String(item.id)}`;
        if (!seenAsync.has(key)) { seenAsync.add(key); void ask(key, { id: randomUUID(), questions, blocking: false }); }
      } else if (typeof item.text === "string") {
        lastMessage = item.text;
        if (item.phase === "final_answer") finalText = item.text;
      }
    }
    const event = codexConversationEvent(method, params);
    if (event) {
      if (event.phase === "tool" && event.id) {
        if (event.done) timeout.toolFinished(event.id);
        else timeout.toolStarted(event.id);
      }
      request.onEvent?.(event);
    }
  };
  const connection = new CodexConversationConnection(message, fail);
  const abort = (): void => {
    const error = controller.signal.reason instanceof Error ? controller.signal.reason : new ExecutionCancelledError();
    fail(error);
    if (threadId && turnId) void connection.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    connection.close(error);
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    if (request.signal?.aborted) cancel();
    if (controller.signal.aborted) throw controller.signal.reason;
    await connection.start(options.command, codexAppServerArguments(request.cliArguments ?? []), request.cwd, options.env);
    const permission = request.allowWorkspaceWrite ? request.permission ?? "workspace-write" : "read-only";
    const config = { cwd: request.cwd, approvalPolicy: "never",
      sandbox: permission === "full-access" ? "danger-full-access" : permission,
      ...(request.model ? { model: request.model } : {}),
      ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
      config: { model_reasoning_summary: "detailed", ...(request.reasoningEffort ? { model_reasoning_effort: request.reasoningEffort } : {}) } };
    const thread = await connection.request(options.resumeId ? "thread/resume" : options.forkFromId ? "thread/fork" : "thread/start", {
      ...config, ...(options.resumeId || options.forkFromId ? { threadId: options.resumeId ?? options.forkFromId } : { ephemeral: !request.metadata.agentSessionId })
    });
    threadId = stringValue(object(thread.thread).id);
    if (!threadId) throw new Error("Codex did not return a conversation ID.");
    options.onThread(threadId);
    const prior = !options.resumeId && !options.forkFromId ? request.metadata.conversationContext?.trim() : undefined;
    const input = prior ? `${prior}\n\nNew user message:\n${request.input}` : request.input;
    const turn = await connection.request("turn/start", { threadId, input: [{ type: "text", text: input, text_elements: [] }],
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}) });
    turnId ||= stringValue(object(turn.turn).id);
    timeout.toolFinished("connection-startup");
    const result = await completed;
    if (!result) throw new Error("Codex returned no response.");
    return result;
  } finally {
    finished = true; clearInputs(); timeout.dispose();
    request.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
    connection.close();
  }
}
