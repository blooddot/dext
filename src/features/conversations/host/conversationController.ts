import { randomBytes } from "node:crypto";
import type { AgentSelection } from "../../agents/contracts/agent.js";
import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import type { ConversationHistoryStore, DextHistorySession } from "../contracts/history.js";
import type { ConversationLayout, ConversationPreferences } from "../contracts/preferences.js";
import type {
  ConversationSummary,
  ConversationWebviewResponse
} from "../contracts/protocol.js";
import { orderedConversationIds } from "../domain/conversationOrder.js";
import { conversationTitle, historyTurnTitle } from "../presentation/historyRender.js";
import { harnessPresetOrDefault } from "../../agents/domain/harnessPresetDefault.js";
import { withoutSkills } from "../domain/agentSelection.js";
import type { AgentTodoItem } from "../../../shared/contracts/types.js";

/** Everything the controller publishes. The sidebar implements it with the
 * Webview's IPC channel; the controller never touches `vscode` itself. */
export interface ConversationPublisher {
  post: (message: ConversationWebviewResponse) => Promise<void>;
  postWhenReady: (message: ConversationWebviewResponse) => void;
}

/** The application capabilities a conversation controller may use. Composer
 * selection is shared with execution, which is why it is passed in rather than
 * read from a global. */
export interface ConversationApplication {
  currentSelection: () => AgentSelection;
  setAgentSelection: (selection: AgentSelection) => void;
  endAgentSession: (sessionId: string) => void;
}

/** Execution is owned by the coordinator; the controller only asks whether a
 * conversation is running and restores its live row after a tab switch. */
export interface ConversationExecution {
  running: (sessionId: string) => boolean;
  postActiveExecution: (sessionId: string, switchId?: number, hostInitiated?: boolean) => Promise<void>;
}

export interface ConversationControllerOptions {
  history: ConversationHistoryStore;
  preferences: ConversationPreferences;
  publisher: ConversationPublisher;
  application: ConversationApplication;
  execution: ConversationExecution;
  /** Injected so tests do not wait for real timers. */
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

function outputSession(): DextHistorySession {
  const now = Date.now();
  return {
    id: randomBytes(12).toString("hex"),
    createdAt: now,
    updatedAt: now,
    turns: []
  };
}

// New tabs always start in Agent mode with no skills, while keeping the
// provider/model controls the user was using in the tab they came from.
function defaultConversationSelection(previous: AgentSelection): AgentSelection {
  return { ...withoutSkills(previous), mode: "agent", ...(previous.profileId === "deepseek-harness" ? { agentPreset: harnessPresetOrDefault(previous.agentPreset) } : {}) };
}

function sessionSignature(session: DextHistorySession): string {
  const last = session.turns.at(-1);
  return `${session.updatedAt}:${session.turns.length}:${last?.id ?? ""}:${last?.process.length ?? 0}`;
}

/** Owns the in-memory conversation set: which tabs are open, which one is
 * active, the per-tab composer selection and the saved layout. Execution,
 * plan and patch state live in their own controllers. */
export class ConversationController {
  private activeSession = outputSession();
  private readonly sessions = new Map<string, DextHistorySession>();
  // Every composer control belongs to its conversation tab. The application
  // still receives the active tab's selection so execution uses the same
  // runtime path, but no tab can overwrite another tab's controls.
  private readonly conversationSelections = new Map<string, AgentSelection>();
  // Conversations behave like editor tabs: the strip only shows the ones that
  // are open, while every conversation stays reachable through history.
  private openConversations: string[] = [this.activeSession.id];
  private sessionsHydrated = false;
  private readonly postedSessionSignatures = new Map<string, string>();
  private layoutWriteTimer: ReturnType<typeof setTimeout> | undefined;
  private layoutWriteInFlight: Promise<void> | undefined;
  private layoutWritePending = false;
  private disposed = false;
  private static readonly layoutWriteDebounceMs = 750;

  constructor(private readonly options: ConversationControllerOptions) {}

  private get history(): ConversationHistoryStore {
    return this.options.history;
  }

  private get preferences(): ConversationPreferences {
    return this.options.preferences;
  }

  active(): DextHistorySession {
    return this.activeSession;
  }

  session(sessionId: string): DextHistorySession | undefined {
    return this.sessions.get(sessionId);
  }

  sessionsList(): DextHistorySession[] {
    return [...this.sessions.values()];
  }

  selection(sessionId: string): AgentSelection | undefined {
    return this.conversationSelections.get(sessionId);
  }

  hydrate(): void {
    if (this.sessionsHydrated) return;
    this.sessionsHydrated = true;
    const storedSessions = this.history.list();
    for (const session of storedSessions) {
      if (session.planStatus === "running" && !this.options.execution.running(session.id)) {
        session.planStatus = session.activePlanPath ? "active" : "new";
        void this.history.updatePlanContext(session.id, session.activePlanPath, session.planStatus).catch(() => undefined);
      }
      this.sessions.set(session.id, session);
    }
    if (!this.sessions.has(this.activeSession.id)) this.sessions.set(this.activeSession.id, this.activeSession);
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const layout = this.preferences.conversationLayout();
    const restored = layout.openConversationIds.filter((id) => this.sessions.has(id));
    const previouslyActive = layout.activeConversationId
      ? this.sessions.get(layout.activeConversationId)
      : undefined;
    if (previouslyActive) this.activeSession = previouslyActive;
    else if (latest) this.activeSession = latest;
    const storedSelection = this.preferences.conversationSelection(this.activeSession.id);
    const initialSelection = storedSelection
      ?? { ...withoutSkills(this.options.application.currentSelection()), mode: "agent" as const };
    this.conversationSelections.set(this.activeSession.id, initialSelection);
    this.options.application.setAgentSelection(initialSelection);
    // Keep every tab the user left open, including non-pinned ones. Pins still
    // provide a backwards-compatible fallback for layouts saved before this
    // state was introduced.
    const pinned = this.preferences.pinned().filter((id) => this.sessions.has(id));
    this.openConversations = [...new Set([...restored, ...pinned, this.activeSession.id])];
  }

  layout(): ConversationLayout {
    return {
      openConversationIds: this.openConversations,
      activeConversationId: this.activeSession.id
    };
  }

  async persistLayout(): Promise<void> {
    await this.preferences.setConversationLayout(this.layout());
  }

  scheduleLayoutPersist(): void {
    if (this.disposed) return;
    this.layoutWritePending = true;
    if (this.layoutWriteTimer) this.cancelTimer(this.layoutWriteTimer);
    this.layoutWriteTimer = this.scheduleTimer(() => {
      this.layoutWriteTimer = undefined;
      void this.flushScheduledLayout();
    }, ConversationController.layoutWriteDebounceMs);
  }

  private scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.options.schedule ? this.options.schedule(callback, delayMs) : setTimeout(callback, delayMs);
  }

  private cancelTimer(handle: ReturnType<typeof setTimeout>): void {
    if (this.options.cancelSchedule) this.options.cancelSchedule(handle);
    else clearTimeout(handle);
  }

  async flushScheduledLayout(): Promise<void> {
    if (this.layoutWriteInFlight || !this.layoutWritePending) return;
    this.layoutWritePending = false;
    const write = this.persistLayout();
    this.layoutWriteInFlight = write;
    try {
      await write;
    } catch {
      // persistLayout already records the error. A deferred UI write must not
      // turn a tab click into an unhandled rejection.
    } finally {
      this.layoutWriteInFlight = undefined;
      // If another switch happened while the write was in flight, give the
      // user another idle window instead of immediately issuing a second
      // globalState write.
      if (this.layoutWritePending) {
        if (this.disposed) {
          this.layoutWritePending = false;
          void this.persistLayout().catch(() => undefined);
        } else {
          this.scheduleLayoutPersist();
        }
      }
    }
  }

  ordered(): string[] {
    return orderedConversationIds(this.openConversations, (id) => this.preferences.isPinned(id));
  }

  summarize(session: DextHistorySession): ConversationSummary {
    return {
      id: session.id,
      title: this.preferences.title(session.id) ?? conversationTitle(session),
      updatedAt: session.updatedAt,
      turnCount: session.turns.length,
      pinned: this.preferences.isPinned(session.id),
      running: this.options.execution.running(session.id)
    };
  }

  signature(session: DextHistorySession): string {
    return sessionSignature(session);
  }

  markOutputPosted(session: DextHistorySession): void {
    this.postedSessionSignatures.set(session.id, sessionSignature(session));
  }

  forgetOutputSignature(sessionId: string): void {
    this.postedSessionSignatures.delete(sessionId);
  }

  /** A reloaded Webview document has no cached rows, so every session must be
   * sent in full on the next switch. */
  clearOutputSignatures(): void {
    this.postedSessionSignatures.clear();
  }

  async postConversationState(switchId?: number, hostInitiated = false): Promise<void> {
    const conversationPayload = {
      type: "conversations",
      sessions: this.ordered().flatMap((id) => {
        const session = this.sessions.get(id);
        return session ? [this.summarize(session)] : [];
      }),
      activeId: this.activeSession.id,
      selection: this.conversationSelections.get(this.activeSession.id)
        ?? this.options.application.currentSelection(),
      ...(this.activeSession.activePlanPath ? { planPath: this.activeSession.activePlanPath } : {}),
      planStatus: this.activeSession.planStatus ?? "new",
      ...(this.activeSession.resource ? { resource: this.activeSession.resource } : {}),
      ...(switchId !== undefined ? { switchId } : {}),
      ...(hostInitiated ? { hostInitiated: true as const } : {})
    } satisfies ConversationWebviewResponse;
    await this.options.publisher.post(conversationPayload);
  }

  activate(session: DextHistorySession, switchId?: number, hostInitiated = false): void {
    const wasOpen = this.openConversations.includes(session.id);
    this.activeSession = session;
    const cachedSelection = this.conversationSelections.get(session.id);
    const storedSelection = cachedSelection ? undefined : this.preferences.conversationSelection(session.id);
    const selection = cachedSelection
      ?? storedSelection
      ?? { ...withoutSkills(this.options.application.currentSelection()), mode: "agent" as const };
    this.conversationSelections.set(session.id, selection);
    this.options.application.setAgentSelection(selection);
    if (!wasOpen) this.openConversations.push(session.id);
    // Persistence and UI messages are independent. Do not make the webview
    // wait for global-state I/O before it can paint the selected conversation.
    // Layout persistence is intentionally outside the critical path. Rapid tab
    // changes are coalesced and written once after the UI settles.
    this.scheduleLayoutPersist();
    if (!cachedSelection && !storedSelection) {
      void this.preferences.setConversationSelection(session.id, selection).catch(() => {
        // Selection persistence is best effort and must not block switching.
      });
    }
    const sendActiveConversation = (): Promise<void> => this.options.publisher.post({
      type: "activeConversation",
      activeId: session.id,
      selection,
      ...(session.activePlanPath ? { planPath: session.activePlanPath } : {}),
      planStatus: session.planStatus ?? "new",
      ...(session.resource ? { resource: session.resource } : {}),
      ...(switchId !== undefined ? { switchId } : {}),
      ...(hostInitiated ? { hostInitiated: true as const } : {})
    });
    const sendOutputSession = (): Promise<void> => {
      const signature = sessionSignature(session);
      // A running conversation has no stable cached DOM: its live row and
      // buffered events must be restored after the historical payload. Never
      // take the ref path here, because a stale/evicted cache would require a
      // second request that can race the executing replay and leave the view
      // stuck in its loading state.
      const running = this.options.execution.running(session.id);
      if (!running && this.postedSessionSignatures.get(session.id) === signature) {
        return this.options.publisher.post({ type: "outputSessionRef", sessionId: session.id, signature, ...(switchId !== undefined ? { switchId } : {}), ...(hostInitiated ? { hostInitiated: true as const } : {}) });
      }
      this.postedSessionSignatures.set(session.id, signature);
      return this.options.publisher.post({ type: "outputSession", session, ...(switchId !== undefined ? { switchId } : {}), ...(hostInitiated ? { hostInitiated: true as const } : {}) });
    };
    // Keep the historical payload ahead of the live execution replay. If the
    // two posts race, an `executing` row can be rendered first and then be
    // erased when outputSession rebuilds the result pane.
    const switchMessages = async (): Promise<void> => {
      await sendActiveConversation();
      await sendOutputSession();
      await this.options.execution.postActiveExecution(session.id, switchId, hostInitiated);
      if (!wasOpen) await this.postConversationState(switchId, hostInitiated);
    };
    // The webview paints the selected tab from its local state. Do not make
    // the click handler wait for VS Code's postMessage delivery.
    void switchMessages().catch(() => undefined);
  }

  // A new conversation opens its own tab, while clearing replaces the
  // conversation shown in the tab that is already active.
  async start(replaceActiveTab = false, resource?: ResourceSession): Promise<DextHistorySession> {
    const previousSelection = this.conversationSelections.get(this.activeSession.id) ?? this.options.application.currentSelection();
    const index = replaceActiveTab ? this.openConversations.indexOf(this.activeSession.id) : -1;
    if (replaceActiveTab) this.options.application.endAgentSession(this.activeSession.id);
    const session = outputSession();
    if (resource) session.resource = resource;
    this.activeSession = session;
    this.sessions.set(session.id, session);
    const selection = resource
      ? { ...defaultConversationSelection(previousSelection), mode: "ask" as const, agentPreset: "standard" }
      : defaultConversationSelection(previousSelection);
    this.conversationSelections.set(session.id, selection);
    this.options.application.setAgentSelection(selection);
    if (index === -1) this.openConversations.push(session.id);
    else this.openConversations[index] = session.id;
    await this.preferences.setConversationSelection(session.id, selection);
    if (resource) await this.history.updateResourceContext(session.id, resource);
    await this.persistLayout();
    // Another tab can be opened while preferences are being written.
    if (this.activeSession.id !== session.id) return session;
    await this.postConversationState(undefined, true);
    return session;
  }

  /** Replaces a conversation's composer controls and makes them the ones the
   * application will execute with. */
  setSelection(sessionId: string, selection: AgentSelection): void {
    this.conversationSelections.set(sessionId, selection);
    this.options.application.setAgentSelection(selection);
  }

  /** Explicit resource removal also clears saved checkboxes, so re-importing a
   * package does not silently re-enable it in an older conversation. */
  async reconcileInstalledSkills(installed: ReadonlySet<string>): Promise<void> {
    this.hydrate();
    for (const sessionId of this.sessions.keys()) {
      const previous = this.conversationSelections.get(sessionId) ?? this.preferences.conversationSelection(sessionId);
      if (!previous?.skills?.length) continue;
      const skills = previous.skills.filter((id) => installed.has(id));
      if (skills.length === previous.skills.length) continue;
      const selection = skills.length ? { ...previous, skills } : withoutSkills(previous);
      this.conversationSelections.set(sessionId, selection);
      if (sessionId === this.activeSession.id) this.options.application.setAgentSelection(selection);
      await this.preferences.setConversationSelection(sessionId, selection);
    }
  }

  // History hands over its own copy of a conversation; an already open one
  // keeps the in-memory instance so that a running turn stays attached to it.
  async open(session: DextHistorySession): Promise<void> {
    this.hydrate();
    const existing = this.sessions.get(session.id) ?? session;
    this.sessions.set(existing.id, existing);
    // Preserve the asynchronous command contract used by history actions;
    // the actual tab activation itself is deliberately detached from IPC.
    await Promise.resolve();
    this.activate(existing, undefined, true);
  }

  // Closing a tab only hides the conversation; history keeps it so that the
  // conversation list can reopen it later.
  async close(sessionId: string): Promise<void> {
    const visible = this.ordered();
    const index = visible.indexOf(sessionId);
    if (index === -1) return;
    if (this.options.execution.running(sessionId)) {
      throw new Error("Stop this Dext turn before closing its conversation.");
    }
    this.options.application.endAgentSession(sessionId);
    this.openConversations = this.openConversations.filter((id) => id !== sessionId);
    // Closing is an explicit dismissal, so a pinned conversation must not come
    // back on the next reload.
    if (this.preferences.isPinned(sessionId)) await this.preferences.setPinned(sessionId, false);
    if (sessionId !== this.activeSession.id) {
      await this.persistLayout();
      await this.postConversationState();
      return;
    }
    const remaining = visible.filter((id) => id !== sessionId);
    const neighbour = remaining[index] ?? remaining[index - 1];
    const session = neighbour ? this.sessions.get(neighbour) : undefined;
    if (!session) {
      await this.start();
      return;
    }
    this.activeSession = session;
    const selection = this.conversationSelections.get(session.id)
      ?? this.preferences.conversationSelection(session.id)
      ?? { ...withoutSkills(this.options.application.currentSelection()), mode: "agent" as const };
    this.conversationSelections.set(session.id, selection);
    this.options.application.setAgentSelection(selection);
    await this.preferences.setConversationSelection(session.id, selection);
    await this.persistLayout();
    await this.postConversationState(undefined, true);
    await this.options.publisher.post({ type: "outputSession", session: this.activeSession, hostInitiated: true });
    await this.options.execution.postActiveExecution(session.id, undefined, true);
  }

  async move(sessionId: string, beforeSessionId: string | null): Promise<void> {
    this.hydrate();
    const ordered = this.ordered();
    if (!ordered.includes(sessionId) || sessionId === beforeSessionId) return;
    const pinned = this.preferences.isPinned(sessionId);
    const group = ordered.filter((id) => this.preferences.isPinned(id) === pinned && id !== sessionId);
    // Resolve against current tabs, so a late drop cannot reopen a closed tab
    // or move a tab across the pinned boundary.
    if (beforeSessionId !== null && !group.includes(beforeSessionId)) return;
    group.splice(beforeSessionId === null ? group.length : group.indexOf(beforeSessionId), 0, sessionId);
    const other = ordered.filter((id) => this.preferences.isPinned(id) !== pinned);
    this.openConversations = pinned ? [...group, ...other] : [...other, ...group];
    this.scheduleLayoutPersist();
    await this.postConversationState();
  }

  async pin(sessionId: string, pinned: boolean): Promise<void> {
    this.hydrate();
    await this.preferences.setPinned(sessionId, pinned);
    await this.persistLayout();
    await this.postConversationState();
  }

  // Renaming only replaces the label a conversation is listed under. The agent
  // runners key their provider sessions on the conversation id, which the
  // rename never touches, so a renamed conversation keeps answering in the same
  // agent session it always did.
  async rename(sessionId: string, title: string): Promise<void> {
    await this.preferences.setTitle(sessionId, title);
    await this.postConversationState();
  }

  async forget(sessionId: string): Promise<void> {
    if (this.options.execution.running(sessionId)) {
      throw new Error("Stop this Dext turn before deleting its conversation.");
    }
    this.hydrate();
    this.sessions.delete(sessionId);
    this.conversationSelections.delete(sessionId);
    await this.preferences.forgetConversationSelection(sessionId);
    if (this.openConversations.includes(sessionId)) {
      await this.close(sessionId);
      return;
    }
    if (sessionId === this.activeSession.id) await this.start();
    else await this.persistLayout();
  }

  async renameTurn(sessionId: string, turnId: string, title: string): Promise<void> {
    if (!await this.history.renameTurn(sessionId, turnId, title)) throw new Error("Conversation turn not found.");
    const stored = this.history.list(true).find((session) => session.id === sessionId)?.turns.find((turn) => turn.id === turnId);
    if (!stored) throw new Error("Conversation turn not found.");
    // Open conversations retain their own objects while agents are running.
    // Update only the name so continuing or switching tabs cannot restore it.
    const cached = this.sessions.get(sessionId)?.turns.find((turn) => turn.id === turnId);
    if (cached) {
      if (stored.title) cached.title = stored.title;
      else delete cached.title;
    }
    this.postedSessionSignatures.delete(sessionId);
    this.options.publisher.postWhenReady({
      type: "turnRenamed", sessionId, turnId,
      ...(stored.title ? { title: stored.title } : {}),
      displayTitle: historyTurnTitle(stored)
    });
  }

  async deleteTurn(turnId: string, sessionId = this.activeSession.id): Promise<DextHistorySession | undefined> {
    this.hydrate();
    if (this.options.execution.running(sessionId)) {
      throw new Error("Stop this Dext turn before deleting a conversation turn.");
    }
    const session = this.sessions.get(sessionId) ?? this.history.list(true).find((item) => item.id === sessionId);
    const index = session?.turns.findIndex((turn) => turn.id === turnId) ?? -1;
    if (!session || index === -1) throw new Error("Conversation turn not found.");
    const removed = await this.history.removeTurn(sessionId, turnId, session.providerSessions);
    if (!removed) throw new Error("Conversation turn not found.");
    session.turns.splice(index, 1);
    session.updatedAt = session.turns.at(-1)?.createdAt ?? session.createdAt;
    if (session.turns.length) session.createdAt = session.turns[0]!.createdAt;
    // Deletion only edits Dext history. Keep the provider session bindings and
    // runner state intact, including when this was the final displayed turn.
    this.postedSessionSignatures.delete(sessionId);
    await this.postConversationState();
    await this.options.publisher.post({ type: "outputSession", session });
    return session;
  }

  // ---- Session ownership used by the execution coordinator ----

  recordTurn(sessionId: string, turn: DextHistorySession["turns"][number]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.turns.push(turn);
    session.updatedAt = turn.createdAt;
    this.sessions.set(sessionId, session);
  }

  async saveProviderSessions(session: DextHistorySession): Promise<void> {
    // The CLI can report its ID before the first history record exists. Save
    // it again after the turn is stored so the first turn survives a reload.
    for (const [provider, providerSessionId] of Object.entries(session.providerSessions ?? {})) {
      await this.history.setProviderSession(session.id, provider, providerSessionId);
    }
  }

  async savePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) session.planProgress = { path, todos: todos.map((item) => ({ ...item })) };
    await this.history.updatePlanProgress(sessionId, path, todos);
  }

  async savePlanContext(sessionId: string, path: string | undefined, status: NonNullable<DextHistorySession["planStatus"]>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (path) session.activePlanPath = path;
      else delete session.activePlanPath;
      session.planStatus = status;
    }
    await this.history.updatePlanContext(sessionId, path, status);
  }

  async saveResource(session: DextHistorySession): Promise<void> {
    if (!session.resource) return;
    await this.history.updateResourceContext(session.id, session.resource);
    await this.options.publisher.post({ type: "resourceContext", sessionId: session.id, resource: session.resource });
    await this.postConversationState();
  }

  async postPlanContext(): Promise<void> {
    await this.options.publisher.post({ type: "planContext", ...(this.activeSession.activePlanPath ? { path: this.activeSession.activePlanPath } : {}), status: this.activeSession.planStatus ?? "new" });
  }

  markDisposed(): void {
    this.disposed = true;
  }

  dispose(): void {
    this.markDisposed();
    if (this.layoutWriteTimer) this.cancelTimer(this.layoutWriteTimer);
    this.layoutWriteTimer = undefined;
    // Do not lose the latest tab layout when the extension is disposed during
    // the debounce window. This is a single small global-state write and does
    // not affect the normal tab-switch path.
    void this.flushScheduledLayout();
  }
}
