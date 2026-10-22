import type { AgentStreamEvent, AgentToolKind, PatchChange, WorkflowStepResponse } from "../../../shared/contracts/types.js";
import { agentMessageCopyText, presentAgentMessage } from "../presentation/agentMessagePresentation.js";
import { renderTurnMessage } from "../presentation/turnComponents.js";
import { turnDomAdapter } from "./turnDomAdapter.js";

export interface AgentToolCommand {
  body: HTMLElement;
  label: string;
  summaryLabel: HTMLElement;
  group?: AgentToolGroup;
}

export interface AgentToolGroup {
  disclosure: HTMLDetailsElement;
  label: HTMLElement;
  body: HTMLElement;
  commands: AgentToolCommand[];
  /** Set when the agent named the group itself, which wins over a counted label. */
  labelText?: string;
}

interface AgentFileChanges {
  disclosure: HTMLDetailsElement;
  body: HTMLElement;
  label: HTMLElement;
}

export interface AgentTraceHost {
  document: Document;
  markdown(text: string): string;
  codeBlock(text: string): HTMLElement;
  patch(change: PatchChange): HTMLElement;
  terminal(text: string): DocumentFragment;
  /** The Process timeline the trace is currently painted into. */
  panel(): HTMLElement;
  progressState(): string;
  updateProgress(label: string): void;
  revealResult(): void;
  syncResultToggle(): void;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export interface AgentTraceSnapshot {
  eventItems: Map<string, HTMLElement>;
  toolItems: Map<string, AgentToolCommand>;
  toolGroups: Map<string, AgentToolGroup>;
  group: AgentToolGroup | undefined;
  fileChanges: AgentFileChanges | undefined;
  editedUris: Set<string>;
  commandIds: Set<string>;
  pendingRenders: Set<HTMLElement>;
  renderFrame: number | undefined;
  copyTexts: Map<string, string>;
  copySequence: number;
}

/**
 * Owns the streaming Agent DOM: messages, tool groups, edited-file disclosures
 * and the deferred Markdown queue. Live turns and replayed history share it, and
 * a history replay isolates the trace so its event ids cannot overwrite a live
 * turn. The host supplies progress and result-pane hooks; this module only
 * renders events it is given.
 */
export class AgentTraceView {
  private eventItems = new Map<string, HTMLElement>();
  private toolItems = new Map<string, AgentToolCommand>();
  private toolGroups = new Map<string, AgentToolGroup>();
  private group: AgentToolGroup | undefined;
  private fileChanges: AgentFileChanges | undefined;
  private editedUris = new Set<string>();
  private commandIds = new Set<string>();
  private pendingRenders = new Set<HTMLElement>();
  private renderFrame: number | undefined;
  /** Copy payloads in rendered order, so the Process title bar can copy the
   * timeline even while it is still streaming. */
  private copyTexts = new Map<string, string>();
  private copySequence = 0;

  constructor(private readonly host: AgentTraceHost) {}

  commandCount(): number {
    return this.commandIds.size;
  }

  editedFileCount(): number {
    return this.editedUris.size;
  }

  /** The whole Process timeline as plain text, in the order it was rendered. */
  copyText(): string {
    return [...this.copyTexts.values()].filter(Boolean).join("\n\n");
  }

  /** Detaches queued message renders so they cannot paint into a cached page. */
  takePendingItems(): HTMLElement[] {
    const pending = [...this.pendingRenders].filter((item) => item.isConnected);
    this.pendingRenders.clear();
    if (this.renderFrame !== undefined) this.host.cancelFrame(this.renderFrame);
    this.renderFrame = undefined;
    return pending;
  }

  /** Swaps the live trace for an isolated one and returns the previous state. */
  isolate(): AgentTraceSnapshot {
    const previous = this.capture();
    this.eventItems = new Map();
    this.toolItems = new Map();
    this.toolGroups = new Map();
    this.group = undefined;
    this.fileChanges = undefined;
    this.editedUris = new Set();
    this.commandIds = new Set();
    this.pendingRenders = new Set();
    this.renderFrame = undefined;
    this.copyTexts = new Map();
    this.copySequence = 0;
    return previous;
  }

  restore(snapshot: AgentTraceSnapshot): void {
    this.eventItems = snapshot.eventItems;
    this.toolItems = snapshot.toolItems;
    this.toolGroups = snapshot.toolGroups;
    this.group = snapshot.group;
    this.fileChanges = snapshot.fileChanges;
    this.editedUris = snapshot.editedUris;
    this.commandIds = snapshot.commandIds;
    this.pendingRenders = snapshot.pendingRenders;
    this.renderFrame = snapshot.renderFrame;
    this.copyTexts = snapshot.copyTexts;
    this.copySequence = snapshot.copySequence;
  }

  private capture(): AgentTraceSnapshot {
    return {
      eventItems: this.eventItems,
      toolItems: this.toolItems,
      toolGroups: this.toolGroups,
      group: this.group,
      fileChanges: this.fileChanges,
      editedUris: this.editedUris,
      commandIds: this.commandIds,
      pendingRenders: this.pendingRenders,
      renderFrame: this.renderFrame,
      copyTexts: this.copyTexts,
      copySequence: this.copySequence
    };
  }

  reset(): void {
    this.pendingRenders.clear();
    if (this.renderFrame !== undefined) this.host.cancelFrame(this.renderFrame);
    this.renderFrame = undefined;
    this.eventItems.clear();
    this.toolItems.clear();
    this.toolGroups.clear();
    this.group = undefined;
    this.fileChanges = undefined;
    this.editedUris = new Set();
    this.commandIds = new Set();
    this.copyTexts.clear();
    this.copySequence = 0;
  }

  /** Renders a reasoning, message or tool event into the current panel. */
  renderEvent(event: AgentStreamEvent): void {
    if (event.usage) this.host.updateProgress(this.host.progressState());
    if (event.phase === "reasoning" || event.phase === "message") this.host.updateProgress("Thinking");
    const panel = this.host.panel();
    // An adjacency group may only keep collecting while it is the newest entry,
    // otherwise a later command would be back-dated into an earlier point.
    const trailingGroup = (group: AgentToolGroup | undefined): AgentToolGroup | undefined =>
      group?.disclosure.isConnected && group.disclosure === panel.lastElementChild ? group : undefined;
    if (event.phase === "tool") {
      // The header counts commands, so steps the agent reported as file or image
      // work must not inflate it.
      if ((event.toolKind ?? "command") === "command") this.commandIds.add(event.id ?? event.title ?? event.text);
      this.host.updateProgress(this.host.progressState());
      let command = event.id ? this.toolItems.get(event.id) : undefined;
      if (command) {
        this.group = event.groupId || event.solo ? undefined : trailingGroup(command.group);
        if (command.group && event.groupLabel) command.group.labelText = event.groupLabel;
      } else {
        const group = this.groupFor(event, trailingGroup, panel);
        command = this.createToolCommand(event, group?.body ?? panel, group);
        if (event.id) this.toolItems.set(event.id, command);
      }
      const raw = event.replace ? event.text : `${command.body.textContent ?? ""}${event.text}`;
      const code = command.body.querySelector("code");
      if (code) code.replaceChildren(this.host.terminal(raw));
      else command.body.textContent = raw;
      const copyKey = event.id ? `id:${event.id}` : `event:${this.copySequence++}`;
      this.copyTexts.set(copyKey, raw);
      command.label = event.title ?? command.label;
      command.summaryLabel.textContent = command.label;
      if (command.group) this.updateGroupLabel(command.group);
      this.host.revealResult();
      return;
    }
    let item = event.id ? this.eventItems.get(event.id) : undefined;
    if (!item) {
      // Only a newly appended message breaks the run of commands; replacing the text
      // of an earlier message leaves the trailing group open for more commands.
      this.group = undefined;
      item = this.createEventItem(event);
      item.dataset.copyKey = event.id ? `id:${event.id}` : `event:${this.copySequence++}`;
      if (event.id) this.eventItems.set(event.id, item);
      panel.append(item);
    }
    const copyKey = item.dataset.copyKey ?? `event:${this.copySequence++}`;
    const body = item.querySelector<HTMLElement>(".agent-stream-text");
    if (body) {
      const raw = event.replace ? event.text : `${body.dataset.raw ?? ""}${event.text}`;
      body.dataset.raw = raw;
      this.copyTexts.set(copyKey, agentMessageCopyText(presentAgentMessage(raw)));
      this.scheduleMessageRender(item);
    }
    this.host.revealResult();
    this.host.syncResultToggle();
  }

  /** Paints the edited-file disclosures an Agent result proposes. */
  renderFileChanges(entries: readonly WorkflowStepResponse[]): void {
    // Only an Agent result carries a patch now; `patch` is no longer an API output kind.
    const changes = entries.flatMap((step): PatchChange[] => {
      const result = step.response?.result;
      if (result?.kind === "agent") return result.patch?.changes ?? [];
      return [];
    }).filter((change) => change.before !== change.after);
    for (const change of changes) {
      if (this.editedUris.has(change.uri)) continue;
      this.editedUris.add(change.uri);
      if (!this.fileChanges?.disclosure.isConnected) {
        const { document } = this.host;
        const disclosure = document.createElement("details");
        disclosure.className = "agent-stream-item agent-trace-event agent-trace-files";
        const summary = document.createElement("summary");
        const chevron = document.createElement("i");
        chevron.className = "disclosure-chevron codicon codicon-chevron-right";
        const label = document.createElement("span");
        label.className = "agent-stream-summary-label";
        const body = document.createElement("div");
        body.className = "agent-file-changes";
        summary.append(chevron, label);
        disclosure.append(summary, body);
        this.host.panel().append(disclosure);
        this.fileChanges = { disclosure, body, label };
      }
      this.fileChanges.body.append(this.host.patch(change));
    }
    if (changes.length) {
      if (this.fileChanges) this.fileChanges.label.textContent = `Edited ${this.editedUris.size} file${this.editedUris.size === 1 ? "" : "s"}`;
      this.host.updateProgress(this.host.progressState());
    }
  }

  private eventKind(event: AgentStreamEvent): "reasoning" | "work" | "tool" {
    if (event.phase === "tool") return "tool";
    return event.group === "work-log" ? "work" : "reasoning";
  }

  private createEventItem(event: AgentStreamEvent): HTMLElement {
    const kind = this.eventKind(event);
    const message = this.host.document.createElement("section");
    message.className = `agent-stream-item agent-trace-message agent-trace-${kind}`;
    const body = this.host.document.createElement("div");
    body.className = "agent-stream-text";
    message.append(body);
    return message;
  }

  private toolLabel(event: AgentStreamEvent): string {
    return (event.title ?? event.text.split(/\r?\n/, 1)[0] ?? "Command").slice(0, 180);
  }

  private updateGroupLabel(group: AgentToolGroup): void {
    if (group.labelText) {
      group.label.textContent = group.labelText;
      return;
    }
    const count = group.commands.length;
    group.label.textContent = `Ran ${count} command${count === 1 ? "" : "s"}`;
  }

  private toolGlyph(kind: AgentToolKind = "command"): HTMLElement {
    const glyphs: Record<AgentToolKind, string> = {
      command: "codicon-terminal",
      file: "codicon-diff",
      image: "codicon-file-media",
      step: "codicon-circle-small-filled"
    };
    const icon = this.host.document.createElement("i");
    icon.className = `agent-trace-glyph codicon ${glyphs[kind]}`;
    return icon;
  }

  private createToolGroup(parent: HTMLElement): AgentToolGroup {
    const { document } = this.host;
    const disclosure = document.createElement("details");
    disclosure.className = "agent-stream-item agent-trace-event agent-trace-tool";
    disclosure.open = false;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const label = document.createElement("span");
    label.className = "agent-stream-summary-label";
    const body = document.createElement("div");
    body.className = "agent-trace-tool-body";
    summary.append(this.toolGlyph(), label, chevron);
    disclosure.append(summary, body);
    parent.append(disclosure);
    return { disclosure, label, body, commands: [] };
  }

  private createToolCommand(
    event: AgentStreamEvent,
    container: HTMLElement,
    group?: AgentToolGroup
  ): AgentToolCommand {
    const { document } = this.host;
    const command = document.createElement("details");
    command.className = "agent-trace-command";
    command.open = false;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const summaryLabel = document.createElement("span");
    summaryLabel.className = "agent-trace-command-label";
    summary.append(this.toolGlyph(event.toolKind), summaryLabel, chevron);
    command.append(summary);
    const body = document.createElement("pre");
    body.className = "terminal-output agent-trace-command-body";
    const code = document.createElement("code");
    body.append(code);
    const content = document.createElement("div");
    content.className = "agent-trace-command-content";
    content.append(body);
    command.append(content);
    container.append(command);
    const item: AgentToolCommand = {
      body,
      label: this.toolLabel(event),
      summaryLabel,
      ...(group ? { group } : {})
    };
    summaryLabel.textContent = item.label;
    if (group) {
      group.commands.push(item);
      this.updateGroupLabel(group);
    }
    return item;
  }

  /**
   * Agents that report their own step grouping get reproduced exactly, including
   * steps they chose to show on their own row. Agents that only stream a flat list
   * of tool calls keep the older behaviour of folding consecutive calls together.
   */
  private groupFor(
    event: AgentStreamEvent,
    trailingGroup: (group: AgentToolGroup | undefined) => AgentToolGroup | undefined,
    parent: HTMLElement
  ): AgentToolGroup | undefined {
    if (event.solo) {
      this.group = undefined;
      return undefined;
    }
    if (event.groupId) {
      this.group = undefined;
      const existing = this.toolGroups.get(event.groupId);
      const group = existing?.disclosure.isConnected ? existing : this.createToolGroup(parent);
      if (event.groupLabel) group.labelText = event.groupLabel;
      this.toolGroups.set(event.groupId, group);
      return group;
    }
    const group = trailingGroup(this.group) ?? this.createToolGroup(parent);
    this.group = group;
    return group;
  }

  private renderMessageItem(body: HTMLElement): void {
    if (!body.isConnected) return;
    const presentation = presentAgentMessage(body.dataset.raw ?? "");
    body.classList.toggle("agent-stream-result", presentation.structured);
    body.replaceChildren(...renderTurnMessage({
      ...turnDomAdapter(this.host.document),
      prose: (text) => {
        const content = this.host.document.createElement("div");
        content.className = "markdown-body";
        content.innerHTML = this.host.markdown(text);
        return content;
      },
      code: (text) => this.host.codeBlock(text),
      patch: (change) => this.host.patch(change)
    }, presentation));
  }

  scheduleMessageRender(item: HTMLElement): void {
    this.pendingRenders.add(item);
    if (this.renderFrame !== undefined) return;
    this.renderFrame = this.host.requestFrame(() => {
      this.renderFrame = undefined;
      this.flushMessageRenders();
    });
  }

  flushMessageRenders(): void {
    if (this.renderFrame !== undefined) this.host.cancelFrame(this.renderFrame);
    this.renderFrame = undefined;
    const items = [...this.pendingRenders];
    this.pendingRenders.clear();
    for (const queued of items) {
      const queuedBody = queued.querySelector<HTMLElement>(".agent-stream-text");
      if (queuedBody) this.renderMessageItem(queuedBody);
    }
  }
}
