import type { DextHistoryRecord } from "../contracts/history.js";
import {
  contextReferenceLabel,
  inputReferenceDisplayParts,
  inputReferenceDisplayText,
  normalizeInputReferenceSource,
  type ContextReferenceOccurrence
} from "../../../core/fileReference.js";
import { colorizeSource } from "../../../webview/sourceHighlight.js";
import { createFileReferenceChip, fileReferenceChipDescriptor } from "../../../webview/fileReferenceChip.js";
import type { AgentInputView } from "../../../webview/agentInputView.js";
import type { AgentTodoView } from "../../../webview/agentTodoView.js";
import {
  TURN_COPY_ACTION,
  TURN_DELETE_ACTION,
  TURN_EDIT_ACTION,
  TURN_FORK_ACTION,
  TURN_RENAME_ACTION,
  TURN_RETRY_ACTION,
  presentTurn,
  type TurnSectionPresentation
} from "../presentation/turnPresentation.js";
import { renderTurnInput, renderTurnSection } from "../presentation/turnComponents.js";
import { TurnTitle } from "./turnTitle.js";
import { turnDomAdapter } from "./turnDomAdapter.js";

export type InputMode = "agent" | "ask" | "plan" | "code";

export interface OutputTurnElements {
  disclosure: HTMLDetailsElement;
  title: TurnTitle;
  planExecutionStatus?: HTMLElement;
  input?: HTMLElement;
  process: HTMLElement;
  processDisclosure: HTMLDetailsElement;
  processMeta?: HTMLElement;
  todos: AgentTodoView;
  questions: AgentInputView;
  output: HTMLElement;
  outputDisclosure: HTMLDetailsElement;
  hydrated?: boolean;
  hydrate?: () => void;
}

export interface TranscriptTurnOptions {
  executePlan?: boolean;
  planPath?: string;
  lazy?: boolean;
  open?: boolean;
  title?: string;
  sessionId?: string;
  mode?: DextHistoryRecord["mode"];
}

export interface TranscriptHost {
  document: Document;
  /** The conversation result container that receives the new turn row. */
  result: HTMLElement;
  activeSessionId(): string | undefined;
  isExecuting(): boolean;
  activeTurnId(): string | undefined;
  activeExecutionSessionId(): string | undefined;
  copy(source: string): HTMLButtonElement;
  edit(source: string): void;
  openInput(): void;
  retryTurn(sessionId: string, turnId: string): void;
  renameTurn(sessionId: string, turnId: string): void;
  forkFromTurn(sessionId: string, turnId: string): void;
  copyTurn(sessionId: string, turnId: string): void;
  deleteTurn(sessionId: string, turnId: string): void;
  createTodos(): AgentTodoView;
  createQuestions(turnId: string, sessionId: string | undefined): AgentInputView;
  openReference(reference: ContextReferenceOccurrence): void;
  syncResultToggle(): void;
}

/**
 * Owns the conversation transcript rows: creation, selection and the single map
 * of visible turns. History restoration reuses the same rows, so a cached page
 * and a live one can never keep separate copies of the same turn.
 */
export class TranscriptView {
  private readonly turns = new Map<string, OutputTurnElements>();
  active: OutputTurnElements | undefined;

  constructor(private readonly host: TranscriptHost) {}

  get size(): number {
    return this.turns.size;
  }

  keys(): IterableIterator<string> {
    return this.turns.keys();
  }

  values(): IterableIterator<OutputTurnElements> {
    return this.turns.values();
  }

  entries(): IterableIterator<[string, OutputTurnElements]> {
    return this.turns.entries();
  }

  get(turnId: string): OutputTurnElements | undefined {
    return this.turns.get(turnId);
  }

  set(turnId: string, turn: OutputTurnElements): void {
    this.turns.set(turnId, turn);
  }

  clear(): void {
    this.turns.clear();
    this.active = undefined;
  }

  select(turnId: string): OutputTurnElements | undefined {
    this.active = this.turns.get(turnId);
    return this.active;
  }

  last(): OutputTurnElements | undefined {
    return [...this.turns.values()].at(-1);
  }

  create(
    turnId: string,
    source: string,
    createdAt = Date.now(),
    options: TranscriptTurnOptions = {}
  ): OutputTurnElements {
    const { document } = this.host;
    source = normalizeInputReferenceSource(source);
    const lazy = options.lazy === true;
    const turnPresentation = presentTurn({ source, mode: options.mode, hideInput: options.executePlan });
    for (const turn of this.turns.values()) turn.disclosure.open = false;
    const disclosure = document.createElement("details");
    disclosure.className = "output-turn";
    disclosure.open = options.open ?? !lazy;
    disclosure.dataset.turnId = turnId;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const time = document.createElement("span");
    time.className = "output-turn-time";
    time.textContent = new Date(createdAt).toLocaleTimeString();
    const title = document.createElement("span");
    title.className = "output-turn-title";
    const defaultTitle = options.executePlan && options.planPath
      ? `Plan: ${options.planPath.split("/").pop() ?? options.planPath}`
      : inputReferenceDisplayText(source).split(/\r?\n/, 1)[0]?.slice(0, 140) || "Dext turn";
    const turnTitle = new TurnTitle(title, defaultTitle, options.title);
    const sessionId = options.sessionId ?? this.host.activeSessionId();
    // Scope native actions to this title only, leaving selection menus in the
    // Input, Process and Output bodies intact. Refresh at invocation so cached
    // rows and completed executions cannot retain stale running-state flags.
    const updateContext = (): void => {
      summary.dataset.vscodeContext = JSON.stringify({
        webviewSection: "conversationTurn",
        sessionId,
        turnId,
        dextTurnRunning: this.host.isExecuting() && this.host.activeExecutionSessionId() === sessionId && this.host.activeTurnId() === turnId,
        dextConversationRunning: this.host.isExecuting() && this.host.activeExecutionSessionId() === sessionId,
        preventDefaultContextMenuItems: true
      });
    };
    updateContext();
    summary.addEventListener("contextmenu", updateContext);
    const body = document.createElement("div");
    body.className = "output-turn-body";
    const actions = document.createElement("span");
    actions.className = "output-turn-actions";
    actions.append(
      this.actionButton(TURN_EDIT_ACTION.icon, TURN_EDIT_ACTION.label, () => {
        this.host.edit(source);
        this.host.openInput();
      }),
      this.actionButton(TURN_RETRY_ACTION.icon, TURN_RETRY_ACTION.label, () => {
        if (sessionId) this.host.retryTurn(sessionId, turnId);
      }, true),
      this.actionButton(TURN_RENAME_ACTION.icon, TURN_RENAME_ACTION.label, () => {
        if (sessionId) this.host.renameTurn(sessionId, turnId);
      }, true),
      this.actionButton(TURN_FORK_ACTION.icon, TURN_FORK_ACTION.label, () => {
        if (sessionId) this.host.forkFromTurn(sessionId, turnId);
      }, true),
      this.actionButton(TURN_COPY_ACTION.icon, TURN_COPY_ACTION.label, () => {
        if (sessionId) this.host.copyTurn(sessionId, turnId);
      }, true),
      this.actionButton(TURN_DELETE_ACTION.icon, TURN_DELETE_ACTION.label, () => {
        if (sessionId) this.host.deleteTurn(sessionId, turnId);
      }, true)
    );
    // Keep the turn title as the primary row label, matching the history view;
    // metadata belongs at the trailing edge of the row rather than before it.
    const planExecutionStatus = document.createElement("span");
    planExecutionStatus.className = "plan-status";
    planExecutionStatus.hidden = !options.executePlan;
    planExecutionStatus.textContent = "Running";
    summary.append(chevron, title, planExecutionStatus, time, actions);
    let inputBody: HTMLElement | undefined;
    if (turnPresentation.input) {
      const input = this.section(turnPresentation.input, true);
      input.disclosure.open = !lazy;
      inputBody = input.body;
      if (!lazy) {
        const inputText = this.renderInputSource(source, options.mode);
        const inputCopy = renderTurnInput(turnDomAdapter(document), inputText, this.host.copy(source));
        input.body.append(inputCopy);
      }
      body.append(input.disclosure);
    }
    // Process is a timeline the reader opens on demand, never the default view
    // of a new turn. While the turn runs, its summary still carries the live
    // "Worked for" duration and event count, and expanding it mid-run keeps
    // appending events at the live end.
    const process = this.section(turnPresentation.process, false);
    const todos = this.host.createTodos();
    const questions = this.host.createQuestions(turnId, this.host.activeSessionId());
    const output = this.section(turnPresentation.output, !lazy);
    body.append(todos.element, questions.element, process.disclosure, output.disclosure);
    disclosure.append(summary, body);
    this.host.result.append(disclosure);
    const turn: OutputTurnElements = {
      disclosure,
      title: turnTitle,
      planExecutionStatus,
      ...(inputBody ? { input: inputBody } : {}),
      process: process.body,
      processDisclosure: process.disclosure,
      processMeta: process.meta,
      todos,
      questions,
      output: output.body,
      outputDisclosure: output.disclosure,
      hydrated: !lazy
    };
    this.turns.set(turnId, turn);
    this.active = turn;
    this.host.syncResultToggle();
    return turn;
  }

  private section(section: TurnSectionPresentation, open: boolean): {
    disclosure: HTMLDetailsElement;
    body: HTMLElement;
    meta: HTMLElement;
  } {
    const view = renderTurnSection(turnDomAdapter(this.host.document), section, [], open);
    // Legacy hooks still identify cached turns and scope patch-review interactions.
    view.disclosure.classList.add("output-turn-section");
    return { ...view, disclosure: view.disclosure as HTMLDetailsElement };
  }

  private referenceIcon(kind: ContextReferenceOccurrence["kind"]): string {
    if (kind === "project") return "symbol-module";
    if (kind === "dir") return "folder";
    if (kind === "symbol") return "symbol-method";
    return "file";
  }

  /** Renders readable @path tokens as the same chips used by the editor.
   * The source remains unchanged for copy and history replay. A Code turn's text is
   * colorized with the composer's own grammar and theme; the chips stay where they are. */
  renderInputSource(source: string, mode?: InputMode): HTMLPreElement {
    const { document } = this.host;
    const pre = document.createElement("pre");
    pre.className = "dext-source";
    for (const part of inputReferenceDisplayParts(source)) {
      pre.append(part.kind === "ref" ? this.inputReferenceChipElement(part.reference) : document.createTextNode(part.value));
    }
    if (mode === "code") colorizeSource(pre);
    return pre;
  }

  private inputReferenceChipElement(reference: ContextReferenceOccurrence): HTMLElement {
    const descriptor = fileReferenceChipDescriptor(
      contextReferenceLabel(reference),
      reference.payload
    );
    return createFileReferenceChip({
      document: this.host.document,
      ...descriptor,
      modifierClass: "output-file-reference",
      icon: this.referenceIcon(reference.kind),
      ...(reference.kind === "file" || reference.kind === "project"
        ? { onOpen: () => this.host.openReference(reference) }
        : {})
    });
  }

  /** Turn actions live in the summary, which is a click target of its own, so
   * every one of them has to stop the click from folding the turn. */
  private actionButton(icon: string, label: string, activate: () => void, disableWhileRunning = false): HTMLButtonElement {
    const button = this.host.document.createElement("button");
    button.type = "button";
    button.className = "output-turn-action icon-button compact";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = disableWhileRunning && this.host.isExecuting();
    if (disableWhileRunning) button.dataset.disableWhileRunning = "true";
    const glyph = this.host.document.createElement("i");
    glyph.className = `codicon codicon-${icon}`;
    button.append(glyph);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    return button;
  }
}
