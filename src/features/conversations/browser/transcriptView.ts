import type { DextHistoryRecord } from "../contracts/history.js";
import { type TurnChange } from "../domain/turnDiff.js";
import {
  contextReferenceLabel,
  inputReferenceDisplayParts,
  inputReferenceDisplayText,
  normalizeInputReferenceSource,
  type ContextReferenceOccurrence
} from "../../workspace/domain/fileReference.js";
import { createFileReferenceChip, fileReferenceChipDescriptor } from "../../../platform/browser/fileReferenceChip.js";
import type { AgentInputView } from "./agentInputView.js";
import type { AgentTodoView } from "./agentTodoView.js";
import {
  TURN_ADD_TO_INPUT_ACTION,
  TURN_COPY_ACTION,
  TURN_COPY_INPUT_ACTION,
  TURN_DELETE_ACTION,
  TURN_EDIT_ACTION,
  TURN_FORK_ACTION,
  TURN_RENAME_ACTION,
  TURN_RETRY_ACTION,
  presentTurn,
  presentTurnMode,
  type TurnRenderModel
} from "../presentation/turnPresentation.js";
import { renderTurnMode, renderTurnOutput, renderTurnSection } from "../presentation/turnComponents.js";
import { TurnTitle } from "./turnTitle.js";
import { turnDomAdapter } from "./turnDomAdapter.js";

export interface OutputTurnElements {
  disclosure: HTMLDetailsElement;
  title: TurnTitle;
  /** The spinner that owns the leading slot while this turn runs. */
  runningIcon: HTMLElement;
  planExecutionStatus?: HTMLElement;
  process: HTMLElement;
  processDisclosure: HTMLDetailsElement;
  processMeta?: HTMLElement;
  todos: AgentTodoView;
  questions: AgentInputView;
  output: HTMLElement;
  /** The changed-file table; filled when the turn's changed files are known. */
  changes: HTMLElement;
  /** Shown once the turn is known to have changed files, which a live turn
   * only learns when it ends. */
  diffAction: HTMLButtonElement;
  /** The whole-section copy controls live in the title bar. Their payloads are
   * filled in as the turn streams or when a stored turn is hydrated. */
  /** Read at click time: a long timeline must not be joined per event. */
  setProcessCopy?: (read: () => string, hasText: boolean) => void;
  setOutputCopy?: (text: string) => void;
  hydrated?: boolean;
  hydrate?: () => void;
  /** Built on request: stored Process rows cost one Markdown parse per event. */
  processPainted?: boolean;
  hydrateProcess?: () => void;
}

export interface TranscriptTurnOptions {
  executePlan?: boolean;
  planPath?: string;
  lazy?: boolean;
  open?: boolean;
  title?: string;
  sessionId?: string;
  mode?: DextHistoryRecord["mode"];
  /** This stored turn has truncated text in an overflow file. */
  spill?: boolean;
  /** This stored turn recorded the files it changed. */
  diff?: boolean;
}

export interface TranscriptHost {
  document: Document;
  /** The conversation result container that receives the new turn row. */
  result: HTMLElement;
  activeSessionId(): string | undefined;
  isExecuting(): boolean;
  activeTurnId(): string | undefined;
  activeExecutionSessionId(): string | undefined;
  copyInput(source: string): void;
  /** A copy control whose payload is resolved at click time, for content that is
   * still streaming when the title bar is created. */
  copyLive(read: () => string): HTMLButtonElement;
  edit(source: string): void;
  openInput(): void;
  retryTurn(sessionId: string, turnId: string): void;
  renameTurn(sessionId: string, turnId: string): void;
  forkFromTurn(sessionId: string, turnId: string): void;
  addTurnToInput(sessionId: string, turnId: string): void;
  copyTurn(sessionId: string, turnId: string): void;
  openSpill(sessionId: string, turnId: string): void;
  openTurnDiff(sessionId: string, turnId: string, path?: string): void;
  deleteTurn(sessionId: string, turnId: string): void;
  createTodos(): AgentTodoView;
  createQuestions(turnId: string, sessionId: string | undefined): AgentInputView;
  openReference(reference: ContextReferenceOccurrence): void;
  /** Optional composer grammar highlighter, injected by the browser entry so this
   * module never imports the webview implementation. */
  colorizeSource?(element: HTMLElement): void;
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
    const turnPresentation = presentTurn({});
    for (const turn of this.turns.values()) turn.disclosure.open = false;
    const disclosure = document.createElement("details");
    disclosure.className = "output-turn";
    disclosure.open = options.open ?? !lazy;
    disclosure.dataset.turnId = turnId;
    const summary = document.createElement("summary");
    const runningIcon = document.createElement("i");
    runningIcon.className = "turn-running codicon codicon-loading codicon-modifier-spin";
    runningIcon.hidden = true;
    runningIcon.title = "Dext turn running";
    runningIcon.setAttribute("aria-label", "Dext turn running");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const time = document.createElement("span");
    time.className = "output-turn-time";
    time.textContent = new Date(createdAt).toLocaleTimeString();
    const title = document.createElement("span");
    title.className = "output-turn-title";
    const titleName = document.createElement("span");
    titleName.className = "output-turn-title-name";
    title.append(titleName);
    const sourceLabel = inputReferenceDisplayText(source);
    const defaultTitle = options.executePlan
      ? `Plan: ${options.planPath?.split("/").pop() ?? ""}`.trim() || "Dext turn"
      : sourceLabel.split(/\r?\n/, 1)[0]?.slice(0, 140) || "Dext turn";
    // The prompt is the row label: one clipped line closed, all of it open. It
    // never repeats in the body below.
    let prompt: HTMLSpanElement | undefined;
    if (!options.executePlan && sourceLabel) {
      prompt = document.createElement("span");
      prompt.className = "output-turn-prompt";
      for (const part of inputReferenceDisplayParts(source)) {
        prompt.append(part.kind === "ref" ? this.referenceChip(part.reference) : document.createTextNode(part.value));
      }
      // Code was written by the reader as source, so it keeps the composer's
      // colors; prose stays prose.
      if (options.mode === "code") {
        title.classList.add("code-prompt");
        this.host.colorizeSource?.(prompt);
      }
      title.append(prompt);
    }
    const turnTitle = new TurnTitle(titleName, defaultTitle, options.title, prompt);
    const sessionId = options.sessionId ?? this.host.activeSessionId();
    // Scope native actions to this title only, leaving selection menus in the
    // Process and Output bodies intact. Refresh at invocation so cached
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
    const diffAction = this.actionButton("diff", "Open changed files", () => {
      if (sessionId) this.host.openTurnDiff(sessionId, turnId);
    }, true);
    diffAction.hidden = !options.diff;
    actions.append(
      diffAction,
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
      this.actionButton(TURN_COPY_INPUT_ACTION.icon, TURN_COPY_INPUT_ACTION.label, () => {
        this.host.copyInput(source);
      }),
      this.actionButton(TURN_COPY_ACTION.icon, TURN_COPY_ACTION.label, () => {
        if (sessionId) this.host.copyTurn(sessionId, turnId);
      }, true),
      this.actionButton(TURN_ADD_TO_INPUT_ACTION.icon, TURN_ADD_TO_INPUT_ACTION.label, () => {
        if (sessionId) this.host.addTurnToInput(sessionId, turnId);
      }, true),
      this.actionButton(TURN_DELETE_ACTION.icon, TURN_DELETE_ACTION.label, () => {
        if (sessionId) this.host.deleteTurn(sessionId, turnId);
      }, true)
    );
    if (options.spill) {
      actions.append(this.actionButton("go-to-file", "Open truncated output", () => {
        if (sessionId) this.host.openSpill(sessionId, turnId);
      }, true));
    }
    // Keep the turn title as the primary row label, matching the history view;
    // metadata belongs at the trailing edge of the row rather than before it.
    const planExecutionStatus = document.createElement("span");
    planExecutionStatus.className = "plan-status";
    planExecutionStatus.hidden = !options.executePlan;
    planExecutionStatus.textContent = "Running";
    summary.append(runningIcon, chevron, title,
      ...(options.executePlan ? [] : [renderTurnMode(turnDomAdapter(document), presentTurnMode(options.mode))]),
      planExecutionStatus, time);
    // Process and Output fill in as events stream, so their copy payloads are
    // read when clicked instead of being fixed at row creation.
    let readProcessCopy = (): string => "";
    const processCopy = this.host.copyLive(() => readProcessCopy());
    processCopy.hidden = true;
    const outputCopyText = { value: "" };
    const outputCopy = this.host.copyLive(() => outputCopyText.value);
    outputCopy.hidden = true;
    // Process is a timeline the reader opens on demand, never the default view
    // of a new turn. Its single "Worked" line keeps updating while it runs.
    const process = this.section(turnPresentation.process, false, processCopy);
    const todos = this.host.createTodos();
    const questions = this.host.createQuestions(turnId, this.host.activeSessionId());
    const output = renderTurnOutput(turnDomAdapter(document), [], outputCopy);
    const changes = this.changesTable();
    // The changed-file table closes the turn with what it did; a live turn keeps
    // it hidden until it ends and the record says which files it touched.
    body.append(todos.element, questions.element, process.disclosure, output.section, changes);
    disclosure.append(summary, body);
    // An open turn keeps its actions in the short Worked row instead of covering
    // the prompt, which is the row label now, or the question card above it.
    const hostActions = (): void => { (disclosure.open ? process.summary : summary).append(actions); };
    hostActions();
    disclosure.addEventListener("toggle", hostActions);
    this.host.result.append(disclosure);
    const turn: OutputTurnElements = {
      disclosure,
      title: turnTitle,
      runningIcon,
      planExecutionStatus,
      process: process.body,
      processDisclosure: process.disclosure,
      processMeta: process.meta,
      todos,
      questions,
      output: output.body,
      changes,
      diffAction,
      setProcessCopy: (read: () => string, hasText: boolean) => {
        readProcessCopy = read;
        processCopy.hidden = !hasText;
      },
      setOutputCopy: (text: string) => {
        outputCopyText.value = text;
        outputCopy.hidden = text.length === 0;
      },
      hydrated: !lazy
    };
    this.turns.set(turnId, turn);
    this.active = turn;
    return turn;
  }

  private section(section: TurnRenderModel["process"], open: boolean, action?: HTMLElement): {
    disclosure: HTMLDetailsElement;
    body: HTMLElement;
    meta: HTMLElement;
    summary: HTMLElement;
  } {
    const view = renderTurnSection(turnDomAdapter(this.host.document), section, [], open, action);
    // Legacy hooks still identify cached turns.
    view.disclosure.classList.add("output-turn-section");
    return { ...view, disclosure: view.disclosure as HTMLDetailsElement };
  }

  /** The prompt's @path tokens stay readable chips, at prose size. */
  private referenceChip(reference: ContextReferenceOccurrence): HTMLElement {
    const descriptor = fileReferenceChipDescriptor(contextReferenceLabel(reference), reference.payload);
    return createFileReferenceChip({
      document: this.host.document,
      ...descriptor,
      modifierClass: "turn-prompt-reference",
      icon: reference.kind === "dir" ? "folder" : reference.kind === "symbol" ? "symbol-method" : "file",
      ...(reference.kind === "file" ? { onOpen: () => this.host.openReference(reference) } : {})
    });
  }

  /** Hidden until [setChanges] fills it, so the row order never shifts.
   * The .markdown-body wrapper gives it the answer's own table style. */
  private changesTable(): HTMLElement {
    const wrapper = this.host.document.createElement("div");
    wrapper.className = "markdown-body";
    wrapper.hidden = true;
    const table = this.host.document.createElement("table");
    table.className = "output-turn-changes";
    const head = this.host.document.createElement("thead");
    const row = this.host.document.createElement("tr");
    for (const label of ["File", "Change"]) {
      const cell = this.host.document.createElement("th");
      cell.textContent = label;
      row.append(cell);
    }
    head.append(row);
    table.append(head, this.host.document.createElement("tbody"));
    wrapper.append(table);
    return wrapper;
  }

  /** One clickable row per changed file, plus the answer's own inline mentions of
   * those files opening the same diff. */
  setChanges(turn: OutputTurnElements, sessionId: string | undefined, turnId: string, files: readonly TurnChange[]): void {
    turn.changes.hidden = files.length === 0;
    if (files.length) turn.diffAction.hidden = false;
    const document = this.host.document;
    const open = (path: string) => {
      if (sessionId) this.host.openTurnDiff(sessionId, turnId, path);
    };
    const rows = files.map((file) => {
      const item = document.createElement("tr");
      item.className = "output-turn-change";
      item.tabIndex = 0;
      item.title = `${file.path} — ${file.reason}`;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        open(file.path);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open(file.path);
      });
      const path = document.createElement("td");
      path.className = "output-turn-change-path";
      const glyph = document.createElement("i");
      glyph.className = "codicon codicon-diff";
      const name = document.createElement("code");
      name.textContent = file.path;
      path.append(glyph, name);
      const text = document.createElement("td");
      text.className = "output-turn-change-reason";
      text.textContent = file.reason;
      item.append(path, text);
      return item;
    });
    turn.changes.querySelector("tbody")?.replaceChildren(...rows);
    for (const code of turn.output.querySelectorAll("code")) {
      const path = code.textContent ?? "";
      // A path named by its tail counts too: that is how answers abbreviate it.
      const hits = files.filter((file) => file.path === path || file.path.endsWith(`/${path}`));
      if (hits.length !== 1) continue;
      const [file] = hits as [TurnChange];
      const link = document.createElement("a");
      link.href = "#";
      link.className = "output-turn-change-link";
      link.title = `${file.path} — ${file.reason}`;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (sessionId) this.host.openTurnDiff(sessionId, turnId, file.path);
      });
      code.replaceWith(link);
      link.append(code);
    }
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
