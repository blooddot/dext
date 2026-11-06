import type { ConversationSummary } from "../contracts/protocol.js";

export interface ConversationTabActions {
  select(sessionId: string): void;
  close(sessionId: string): void;
  pin(sessionId: string, pinned: boolean): void;
}

export interface ConversationTabStripOptions {
  document: Document;
  container: HTMLElement;
  actions: ConversationTabActions;
}

/** Renders the conversation tab strip. The caller keeps the drag controller and
 * the strip's scroll-into-view because both operate on the live container. */
export function renderConversationTabs(
  options: ConversationTabStripOptions,
  sessions: readonly ConversationSummary[],
  activeId: string
): HTMLElement | undefined {
  const { document, container, actions } = options;
  container.replaceChildren();
  container.hidden = sessions.length === 0;
  let activeTab: HTMLElement | undefined;
  for (const conversation of sessions) {
    const active = conversation.id === activeId;
    const tab = document.createElement("div");
    tab.className = `conversation-tab${active ? " active" : ""}${conversation.pinned ? " pinned" : ""}${conversation.running ? " running" : ""}`;
    tab.dataset.sessionId = conversation.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(active));
    tab.title = conversation.running ? `${conversation.title} — running` : conversation.title;
    // VS Code reads this attribute to build the native tab context menu and
    // passes the merged object to the invoked command.
    tab.dataset.vscodeContext = JSON.stringify({
      webviewSection: "conversationTab",
      sessionId: conversation.id,
      dextTabPinned: conversation.pinned,
      // Renaming seeds its input box from the name shown on the tab, which is
      // the only place an unsaved conversation's name exists.
      dextTabTitle: conversation.title,
      preventDefaultContextMenuItems: true
    });
    // Middle-click closes a tab, matching VS Code editor tabs. Prevent the
    // mousedown default as well: Chromium otherwise enables autoscroll on a
    // horizontally overflowing tab strip before `auxclick` is dispatched.
    let middleButtonDown = false;
    tab.addEventListener("mousedown", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      middleButtonDown = true;
      actions.close(conversation.id);
    });
    tab.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep a fallback for environments that do not deliver mousedown for
      // auxiliary buttons, while avoiding a duplicate close request.
      if (!middleButtonDown) actions.close(conversation.id);
      middleButtonDown = false;
    });
    tab.addEventListener("mouseup", (event) => {
      if (event.button === 1) middleButtonDown = false;
    });
    const label = document.createElement("button");
    label.type = "button";
    label.className = "conversation-tab-label";
    label.textContent = conversation.title;
    // Select on press instead of waiting for the browser's click synthesis.
    // In the trace, pointerup/click can arrive 90–180ms after pointerdown
    // while the webview is busy.  The tab highlight and viewport reset are
    // local, so there is no reason to make the visual switch wait for that
    // extra event latency.  Keep click as the keyboard-accessible fallback;
    // selecting the already-active tab is a no-op.
    label.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      actions.select(conversation.id);
    });
    label.addEventListener("click", () => {
      actions.select(conversation.id);
    });
    const activity = document.createElement("i");
    activity.className = "conversation-tab-activity codicon codicon-loading codicon-modifier-spin";
    activity.title = "Dext turn running";
    activity.setAttribute("aria-label", "Dext turn running");
    // A pinned tab trades its close button for the pin that releases it, so
    // that pinned conversations are not dismissed by a stray click.
    const action = document.createElement("button");
    action.type = "button";
    action.className = conversation.pinned ? "conversation-tab-pin" : "conversation-tab-close";
    action.title = conversation.running
      ? "Stop the running turn before closing"
      : conversation.pinned ? "Unpin conversation" : "Close conversation";
    action.disabled = conversation.running;
    action.setAttribute("aria-label", `${conversation.pinned ? "Unpin" : "Close"} ${conversation.title}`);
    const actionIcon = document.createElement("i");
    actionIcon.className = `codicon codicon-${conversation.pinned ? "pinned" : "close"}`;
    action.append(actionIcon);
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      if (conversation.pinned) actions.pin(conversation.id, false);
      else actions.close(conversation.id);
    });
    tab.append(label, activity, action);
    if (active) activeTab = tab;
    container.append(tab);
  }
  return activeTab;
}
