import { randomBytes } from "node:crypto";
import type { AgentSelection } from "../../agents/contracts/agent.js";
import type {
  AgentInputAnswers,
  AgentInputRequest,
  AgentStreamEvent,
  InputExecutionResponse,
  McpProcessEvent,
  PlanExecutionOutcome,
  UiInteraction
} from "../../../shared/contracts/types.js";
import type { DextReplayEntry } from "../../../runner/dextResumeCache.js";
import type {
  ConversationHistoryStore,
  DextHistoryRecord,
  DextHistorySession,
  ResourceSourceKind,
  TurnCommandSnapshot,
  TurnRecordContext
} from "../contracts/history.js";
import { splitCommandInput } from "../../workflow/contracts/skill.js";
import type {
  ActiveExecution,
  ConversationSessionPort,
  TurnExecutionHost,
  TurnInteractionPort,
  TurnNotifier
} from "../contracts/execution.js";
import { readHistoryResponse } from "../domain/historyResponse.js";
import type { AgentEventStream } from "./agentEventStream.js";
import type { InteractionController } from "./interactionController.js";
import type { PlanController, PlanRunContext } from "./planController.js";
import { planTodoInstruction, stripPlanTodoProgress } from "../domain/planTodoProgress.js";
import { harnessPresetOrDefault } from "../../agents/domain/harnessPresetDefault.js";

/** Turns copied into a fork are only UI history until they are sent to a new
 * provider task. Keep a readable, bounded transcript that can bootstrap that
 * task without exposing Dext's internal JSON envelope as the conversation. */
function conversationContext(turns: readonly DextHistoryRecord[]): string | undefined {
  if (!turns.length) return undefined;
  const sections: string[] = [];
  let length = 0;
  // Keep the branch point (the most recent turns) when the stored history is
  // larger than a provider's practical prompt window.
  for (const turn of [...turns].reverse()) {
    const responseText = readHistoryResponse(turn)?.executions
      .map((execution) => execution.result.kind === "ask" || execution.result.kind === "plan" || execution.result.kind === "skill" || execution.result.kind === "agent" || execution.result.kind === "template"
        ? execution.result.text
        : JSON.stringify(execution.result))
      .filter(Boolean)
      .join("\n") || turn.output || (turn.error ? `[error] ${turn.error}` : "");
    const section = `User: ${turn.input}\nAssistant: ${responseText}`;
    if (length + section.length > 120_000) break;
    sections.unshift(section);
    length += section.length;
  }
  if (!sections.length) return undefined;
  return [
    "The following is the prior Dext conversation. Treat it as conversation history, not as a new user request:",
    "---",
    sections.join("\n\n"),
    "---",
    "Continue from that context and answer the new user message."
  ].join("\n");
}

export interface TurnExecutionCoordinatorOptions {
  history: ConversationHistoryStore;
  host: TurnExecutionHost;
  sessions: ConversationSessionPort;
  interactions: InteractionController;
  plans: PlanController;
  events: AgentEventStream;
  notifier: TurnNotifier;
  /** The composer controls this conversation will run with, captured once. */
  selection: (sessionId: string) => AgentSelection;
  /** A resource operation in flight blocks a turn for that conversation. */
  resourceBusy: (sessionId: string) => boolean;
  /** Called when no conversation is running any more. */
  onIdle?: () => Promise<void>;
}

export interface ExecuteTurnOptions {
  planPath?: string;
  executePlan?: boolean;
  codeContinuation?: readonly DextReplayEntry[];
  /** Creation mode a resource draft was requested from. Defaults to describe. */
  resourceSource?: ResourceSourceKind;
}

/** Owns running turns: the active execution per conversation, its abort
 * controller, buffered events, plan rounds, saving, provider sessions, forks
 * and Code continuations. One conversation runs at most one turn; different
 * conversations run concurrently. */
export class TurnExecutionCoordinator implements TurnInteractionPort {
  private readonly activeExecutions = new Map<string, ActiveExecution>();
  /** Live Code continuations. They intentionally stay in memory because they
   * carry the runtime environment produced by earlier steps. */
  private readonly codeContinuations = new Map<string, readonly DextReplayEntry[]>();

  constructor(private readonly options: TurnExecutionCoordinatorOptions) {}

  running(sessionId: string): boolean {
    return this.activeExecutions.has(sessionId);
  }

  anyRunning(): boolean {
    return this.activeExecutions.size > 0;
  }

  active(sessionId: string): ActiveExecution | undefined {
    return this.activeExecutions.get(sessionId);
  }

  /** The turn id a conversation is running, used to attribute interactions. */
  turnOf(sessionId: string): string | undefined {
    return this.activeExecutions.get(sessionId)?.turnId;
  }

  abort(sessionId: string): boolean {
    const execution = this.activeExecutions.get(sessionId);
    if (!execution) return false;
    execution.controller.abort();
    return true;
  }

  abortTurn(turnId: string): void {
    for (const execution of this.activeExecutions.values()) {
      if (execution.turnId === turnId) execution.controller.abort();
    }
  }

  /** Disposal aborts every live turn. The caller ends provider sessions. */
  abortAll(): void {
    for (const execution of this.activeExecutions.values()) execution.controller.abort();
  }

  takeContinuation(sessionId: string, turnId: string): readonly DextReplayEntry[] | undefined {
    const key = `${sessionId}:${turnId}`;
    const continuation = this.codeContinuations.get(key);
    if (continuation) this.codeContinuations.delete(key);
    return continuation;
  }

  uiInteraction(sessionId: string, turnId: string, events: AgentStreamEvent[]): UiInteraction {
    return this.options.interactions.uiInteraction(sessionId, turnId, (event) => this.options.events.append(sessionId, events, event));
  }

  requestAgentInput(sessionId: string, turnId: string, request: AgentInputRequest, signal: AbortSignal): Promise<AgentInputAnswers | null> {
    return this.options.interactions.requestAgentInput(sessionId, turnId, request, signal);
  }

  async execute(session: DextHistorySession, mode: "agent" | "ask" | "plan" | "code", source: string, options: ExecuteTurnOptions = {}): Promise<void> {
    const { planPath, executePlan = false, codeContinuation, resourceSource = "describe" } = options;
    const sessionId = session.id;
    if (session.resource) {
      mode = "ask";
      if (this.options.resourceBusy(sessionId)) throw new Error("Wait for the resource operation to finish.");
    }
    if (this.activeExecutions.has(sessionId)) {
      throw new Error("Wait for this conversation's current Dext turn to finish before running another one.");
    }
    const selection = this.options.selection(sessionId);
    const profile = this.options.host.profiles().find((candidate) => candidate.id === selection.profileId)
      ?? this.options.host.profiles()[0];
    // Skills and commands belong to a conversation turn, never to Code or a
    // resource draft. Resolve the command once so every Plan round sees the
    // same expanded instruction.
    const selectedSkills = mode === "code" || session.resource ? [] : [...(selection.skills ?? [])];
    let command: TurnCommandSnapshot | undefined;
    let commandInstruction: string | undefined;
    let taskSource = source;
    if (mode !== "code" && !session.resource && this.options.host.resolveSkillCommand) {
      const invocation = splitCommandInput(source);
      if (invocation) {
        const resolved = this.options.host.resolveSkillCommand(invocation.commandId, selectedSkills, invocation.arguments, profile?.provider);
        if (resolved.status === "ok") {
          command = { id: resolved.command.id, skillId: resolved.command.skillId };
          commandInstruction = [
            `The user invoked /${resolved.command.id} from the skill '${resolved.command.skillId}'.`,
            resolved.command.instruction
          ].join("\n\n");
          taskSource = invocation.arguments || source;
        } else if (resolved.status === "inactive") {
          throw new Error(`/${invocation.commandId} requires the skill '${resolved.command.skillId}'. Select it in Skills first.`);
        } else if (resolved.status === "invalid") {
          throw new Error(`/${invocation.commandId} cannot run: ${resolved.reason}`);
        } else {
          throw new Error(`Unknown Dext command '/${invocation.commandId}'.`);
        }
      }
    }
    const events: AgentStreamEvent[] = [];
    const turnId = randomBytes(12).toString("hex");
    const executionPlanPath = executePlan ? planPath ?? session.activePlanPath : planPath;
    const plan: PlanRunContext = this.options.plans.startRun(session, taskSource, executePlan, executionPlanPath);
    const { planRun, todoProgress, planExecution } = plan;
    let codeCallLog: readonly DextReplayEntry[] | undefined;
    const controller = new AbortController();
    const startedAt = Date.now();
    this.activeExecutions.set(sessionId, {
      sessionId, turnId, source, startedAt, mode,
      ...(executionPlanPath ? { planPath: executionPlanPath } : {}),
      ...(executePlan ? { executePlan: true } : {}),
      controller, events
    });
    await this.options.sessions.postConversationState();
    await this.options.notifier.started({ sessionId, turnId, mode, source, startedAt, ...(executionPlanPath ? { planPath: executionPlanPath } : {}), ...(executePlan ? { executePlan: true } : {}) });
    let failed = false;
    let cancelled = false;
    let outcome: PlanExecutionOutcome | undefined = planExecution?.planOutcome;
    const recordContext = (): TurnRecordContext => ({
      ...planExecution,
      ...(selectedSkills.length ? { skills: selectedSkills } : {}),
      ...(command ? { command } : {}),
      ...(session.resource ? { resourceSource } : {})
    });
    try {
      if (todoProgress) {
        const initial = todoProgress.initial();
        this.options.events.append(sessionId, events, initial);
      }
      const priorConversation = conversationContext(session.turns);
      const metadata = {
        agentSessionId: sessionId,
        // Snapshot the conversation's own Agent controls. The application-level
        // selection follows the active tab, so a background plan round or a tab
        // switch must not make this turn run with another conversation's
        // provider/session/model.
        ...(profile ? { agent: profile.id } : {}),
        ...(selection.model ? { model: selection.model } : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(selection.speed ? { speed: selection.speed } : {}),
        ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {}),
        ...(selection.permission ? { agentPermission: selection.permission } : {}),
        ...(selectedSkills.length ? { skills: selectedSkills } : {}),
        ...(commandInstruction ? { commandInstruction } : {}),
        ...(session.resource ? { resourceSource } : {}),
        agentPreset: harnessPresetOrDefault(selection.agentPreset),
        ...(mode === "code" ? { agentPermission: "full-access" as const } : {}),
        ...(priorConversation ? { conversationContext: priorConversation } : {}),
        signal: controller.signal,
        ui: this.uiInteraction(sessionId, turnId, events),
        requestAgentInput: (request: AgentInputRequest, signal: AbortSignal) =>
          this.requestAgentInput(sessionId, turnId, request, signal),
        ...(mode === "plan" && executionPlanPath ? { planPath: executionPlanPath } : {}),
        ...(executePlan ? { executePlan: true } : {}),
        onAgentEvent: (event: AgentStreamEvent) => {
          planRun?.observe(event);
          const scoped = planRun ? { ...event, id: `plan-round-${planRun.rounds}:${event.id ?? "stream"}` } : event;
          for (const update of todoProgress ? todoProgress.consume(scoped) : [event]) {
            this.options.events.append(sessionId, events, { ...update });
          }
        },
        onMcpEvent: (event: McpProcessEvent) => {
          const processEvent: AgentStreamEvent = {
            phase: "tool",
            toolKind: "step",
            solo: true,
            title: `MCP ${event.source}`,
            text: event.text
          };
          this.options.events.append(sessionId, events, processEvent);
        },
        onAgentSessionId: (provider: string, providerSessionId: string) => {
          session.providerSessions = { ...(session.providerSessions ?? {}), [provider]: providerSessionId };
          void this.options.history.setProviderSession(sessionId, provider, providerSessionId);
        }
      };
      let response: InputExecutionResponse;
      let roundSource = todoProgress ? `${taskSource}\n\nCurrent host task state (takes precedence over the document's unchecked boxes):\n${planTodoInstruction(todoProgress.snapshot())}` : taskSource;
      for (;;) {
        if (controller.signal.aborted) throw new Error(session.resource ? "Resource generation stopped by user." : "Plan execution stopped by user.");
        planRun?.beginRound();
        const providerSession = profile ? session.providerSessions?.[profile.provider] : undefined;
        const forkFrom = providerSession ? undefined : profile ? session.forkProviderSessions?.[profile.provider] : undefined;
        let acceptingEvents = true;
        const roundMetadata = { ...metadata,
          onAgentEvent: (event: AgentStreamEvent) => { if (acceptingEvents) metadata.onAgentEvent(event); },
          onMcpEvent: (event: McpProcessEvent) => { if (acceptingEvents) metadata.onMcpEvent(event); },
          onAgentSessionId: (provider: string, id: string) => { if (acceptingEvents) metadata.onAgentSessionId(provider, id); },
          ...(providerSession ? { conversationProviderSessionId: providerSession } : {}),
          ...(forkFrom ? { conversationForkFrom: forkFrom } : {}) };
        if (planRun?.verifying) roundSource = planRun.prompt(taskSource);
        try {
          if (session.resource) {
            const generated = await this.options.host.draftResource(session.resource, roundSource, roundMetadata);
            if (controller.signal.aborted) throw new Error("Resource generation stopped by user.");
            session.resource = { ...session.resource, draft: generated.draft, saved: false };
            await this.options.sessions.saveResource(session);
            response = generated.response;
          } else {
            response = mode === "code"
              ? await this.options.host.executeInput(roundSource, roundMetadata, {
                ...(codeContinuation ? { resume: codeContinuation } : {}),
                onCallLog: (entries) => { codeCallLog = entries; }
              })
              : await this.options.host.executeConversation(mode, roundSource, roundMetadata);
          }
        } finally { acceptingEvents = false; }
        if (controller.signal.aborted) throw new Error(session.resource ? "Resource generation stopped by user." : "Plan execution stopped by user.");
        if (!planRun || !todoProgress || !planExecution) break;
        const answers: string[] = [];
        for (const [index, execution] of response.executions.entries()) {
          if (execution.result.kind !== "plan") continue;
          // Some providers only include the final task report in their return value.
          const report: AgentStreamEvent = { phase: "message", id: `plan-round-${planRun.rounds}:final-${index}`, text: execution.result.text, done: true };
          for (const update of todoProgress.consume(report)) {
            if (update.phase === "todo") this.options.events.append(sessionId, events, update);
          }
          execution.result.text = stripPlanTodoProgress(execution.result.text);
          answers.push(execution.result.text);
        }
        const round = planRun.finishRound();
        if (executionPlanPath) await this.options.plans.saveProgress(session, executionPlanPath, todoProgress.snapshot());
        if (controller.signal.aborted) throw new Error(session.resource ? "Resource generation stopped by user." : "Plan execution stopped by user.");
        if (round) {
          planExecution.planOutcome = round;
          outcome = round;
          for (const execution of response.executions) if (execution.result.kind === "plan") {
            execution.result.planOutcome = round;
            if (round.status !== "completed") execution.result.text += `\n\nDext plan execution: ${round.status}. ${round.reason}`;
          }
          break;
        }
        const notice: AgentStreamEvent = { phase: "message", id: `plan-round-${planRun.rounds}:continuation`, text: planRun.verifying
          ? "Dext: all tasks are reported complete; running final verification."
          : `Dext: ${todoProgress.snapshot().filter((item) => item.status !== "completed").length} tasks remain; continuing the plan.`, done: true };
        this.options.events.append(sessionId, events, notice);
        roundSource = planRun.prompt(taskSource, answers.join("\n"));
      }
      // The webview creates the visible row as soon as execution starts. Keep
      // that id when persisting the result so retry/delete actions still point
      // at the stored turn after success or cancellation.
      const turn = await this.options.history.addSuccess(source, events, response, sessionId, mode, turnId, recordContext());
      await this.options.sessions.saveProviderSessions(session);
      if (mode === "plan" && !executePlan) {
        const savedPath = response.executions.find((execution) => execution.result.kind === "plan" && execution.result.planPath)?.result;
        if (savedPath?.kind === "plan" && savedPath.planPath) await this.options.plans.adoptGeneratedPlan(session, savedPath.planPath);
      }
      this.options.sessions.recordTurn(sessionId, turn);
      await this.options.sessions.postConversationState();
      await this.options.notifier.executed(sessionId, turnId, response);
    } catch (error) {
      failed = true;
      cancelled = controller.signal.aborted;
      if (todoProgress && executionPlanPath) {
        await this.options.plans.saveProgress(session, executionPlanPath, todoProgress.snapshot());
      }
      if (planExecution && controller.signal.aborted) {
        planExecution.planOutcome = { status: "cancelled", reason: "Stopped by user. Plan progress is preserved.", rounds: planRun?.rounds ?? 0 };
        outcome = planExecution.planOutcome;
      }
      const turn = await this.options.history.addFailure(source, events, error, sessionId, mode, turnId, recordContext());
      // A failed Code turn keeps the calls it managed to make, so Continue replays
      // them instead of repeating work that already succeeded. A stop is not a
      // failure to continue from: the user asked for it to end.
      if (mode === "code" && !controller.signal.aborted && codeCallLog?.length) {
        this.codeContinuations.set(`${sessionId}:${turnId}`, codeCallLog);
      }
      await this.options.sessions.saveProviderSessions(session);
      this.options.sessions.recordTurn(sessionId, turn);
      await this.options.sessions.postConversationState();
      await this.options.notifier.failed(sessionId, turnId, error instanceof Error ? error.message : String(error), planExecution?.planOutcome);
    } finally {
      this.options.events.flush();
      const active = this.activeExecutions.get(sessionId);
      if (active?.turnId === turnId) this.activeExecutions.delete(sessionId);
      this.options.interactions.clearTurn(sessionId, turnId);
      if (mode === "plan") {
        await this.options.plans.settle(session, { ...(outcome ? { outcome } : {}), cancelled, failed });
      }
      // The tab strip derives its running spinner from this summary, and the
      // success/failure posts above still saw this execution in the map. Publish
      // again now that it is gone so a finished turn cannot leave a spinning tab.
      try {
        await this.options.sessions.postConversationState();
        if (!this.activeExecutions.size) await this.options.onIdle?.();
      } finally {
        await this.options.notifier.finished(sessionId, turnId);
      }
    }
  }
}
