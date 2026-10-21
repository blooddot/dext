import type { AgentInputAnswers, AgentInputRequest, AgentStreamEvent, UiInteraction } from "../../../core/types.js";
import type { UiFormDefinition, UiFormResult } from "../../../core/uiForm.js";
import { AgentInputBroker } from "./agentInputBroker.js";
import { InputNotifications, type InputNotificationTarget } from "./inputNotifications.js";
import { UiInteractionBroker } from "./uiInteractionBroker.js";
import { publicInteractionState } from "../presentation/uiInteractionPresentation.js";

export interface InteractionControllerOptions {
  /** A toast must never block execution or propagate notification errors. */
  notify: () => PromiseLike<boolean>;
  /** Called after the user accepts the toast. The sidebar decides whether the
   * view can be revealed and which conversation to open. */
  open: (target: InputNotificationTarget) => Promise<void>;
  /** The turn the coordinator is running in a conversation, if any. */
  turnOf: (sessionId: string) => string | undefined;
  activeSessionId: () => string;
  disposed: () => boolean;
}

/** Owns every pending question: provider questions, Dext forms, their
 * notifications and the focus hand-off. Responses are matched by session, turn
 * and request id, so a duplicated or expired answer does nothing. */
export class InteractionController {
  private readonly uiInputs = new UiInteractionBroker();
  private readonly agentInputs = new AgentInputBroker();
  private inputNotifications?: InputNotifications;
  private pendingInputFocus: InputNotificationTarget | undefined;

  constructor(private readonly options: InteractionControllerOptions) {}

  /** The UI capability handed to one turn. The card state is published through
   * the same event path as any other provider event. */
  uiInteraction(
    sessionId: string,
    turnId: string,
    publish: (event: AgentStreamEvent) => void
  ): UiInteraction {
    return {
      form: (form: UiFormDefinition, signal?: AbortSignal): Promise<UiFormResult> => this.uiInputs.request(sessionId, turnId, form, signal, (state) => {
        publish({ phase: "input", id: state.requestId, text: "", uiInteraction: publicInteractionState(state) });
      })
    };
  }

  requestAgentInput(sessionId: string, turnId: string, request: AgentInputRequest, signal: AbortSignal): Promise<AgentInputAnswers | null> {
    return this.agentInputs.request(sessionId, turnId, request, signal);
  }

  respondAgent(sessionId: string, turnId: string, requestId: string, answers: AgentInputAnswers | null): void {
    this.agentInputs.respond(sessionId, turnId, requestId, answers);
  }

  respondUi(sessionId: string, turnId: string, requestId: string, response: unknown): boolean {
    return this.uiInputs.respond(sessionId, turnId, requestId, response);
  }

  /** Tracks whether the shown turn has a request waiting for the reader. */
  observeEvent(sessionId: string, event: AgentStreamEvent): void {
    const turnId = this.options.turnOf(sessionId);
    if (this.options.disposed() || !turnId || !(event.userInput || event.uiInteraction)) return;
    this.inputNotifications ??= new InputNotifications(this.options.notify, this.options.open);
    if (event.userInput) this.inputNotifications.observe({
      sessionId, turnId, requestId: event.userInput.id, kind: "agent"
    }, event.userInput.status === "waiting");
    if (event.uiInteraction && event.uiInteraction.turnId === turnId) this.inputNotifications.observe({
      sessionId, turnId, requestId: event.uiInteraction.requestId, kind: "ui"
    }, event.uiInteraction.status === "waiting");
  }

  isWaiting(target: InputNotificationTarget): boolean {
    return this.inputNotifications?.isWaiting(target) === true;
  }

  /** Records the conversation a revealed question belongs to. The focus message
   * itself is sent by the coordinator once the live row is restored. */
  requestFocus(target: InputNotificationTarget): void {
    this.pendingInputFocus = target;
  }

  pendingFocus(sessionId: string, turnId: string): InputNotificationTarget | undefined {
    const focus = this.pendingInputFocus;
    if (focus?.sessionId !== sessionId || focus.turnId !== turnId) return undefined;
    if (this.options.activeSessionId() !== sessionId) return undefined;
    this.pendingInputFocus = undefined;
    return this.isWaiting(focus) ? focus : undefined;
  }

  clearTurn(sessionId: string, turnId: string): void {
    this.inputNotifications?.clearTurn(sessionId, turnId);
    if (this.pendingInputFocus?.sessionId === sessionId && this.pendingInputFocus.turnId === turnId) {
      this.pendingInputFocus = undefined;
    }
  }

  dispose(): void {
    this.inputNotifications?.dispose();
    this.pendingInputFocus = undefined;
    this.uiInputs.dispose();
    this.agentInputs.dispose();
  }
}
