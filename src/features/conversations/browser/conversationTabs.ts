import type { ConversationSummary } from "../contracts/protocol.js";
import { Spinner } from "../../../shared/lib/ui/feedback/feedbackComponents.js";
import { TraceIcon } from "../../../shared/lib/ui/content/traceComponents.js";
import { Button } from "../../../shared/lib/ui/input/nativeControls.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";
import { Tab } from "../../../shared/lib/ui/navigation/navigationComponents.js";

export interface ConversationTabActions {
  select(sessionId: string): void;
  close(sessionId: string): void;
  pin(sessionId: string, pinned: boolean): void;
}

export interface ConversationTabStripOptions {
  document: Document;
  container: HTMLElement;
  panel: HTMLElement;
  actions: ConversationTabActions;
}

function labelPanel(panel: HTMLElement, label: HTMLElement | undefined): void {
  if (label) {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", label.id);
  } else {
    panel.removeAttribute("role");
    panel.removeAttribute("aria-labelledby");
  }
}

/** Renders the conversation tab strip. The caller keeps the drag controller and
 * the strip's scroll-into-view because both operate on the live container. */
export function renderConversationTabs(
  options: ConversationTabStripOptions,
  sessions: readonly ConversationSummary[],
  activeId: string
): HTMLElement | undefined {
  const { document, container, panel, actions } = options;
  const adapter = domUiAdapter(document);
  const row = adapter.element("div", { class: "conversation-tab-row", role: "presentation" }, []);
  container.replaceChildren(row);
  container.hidden = sessions.length === 0;
  let activeTab: HTMLElement | undefined;
  let activeLabel: HTMLElement | undefined;
  for (const conversation of sessions) {
    const active = conversation.id === activeId;
    const tab = adapter.element("div", {
      class: `conversation-tab${active ? " active" : ""}${conversation.pinned ? " pinned" : ""}${conversation.running ? " running" : ""}`,
      "data-session-id": conversation.id, role: "presentation",
      title: conversation.running ? `${conversation.title} — running` : conversation.title
    }, []);
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
    const label = Tab(adapter, active, {
      id: `conversation-tab-${encodeURIComponent(conversation.id)}`,
      class: "conversation-tab-label",
      "aria-controls": panel.id
    }, [conversation.title]);
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
    const activity = Spinner(adapter, {
      class: "conversation-tab-activity codicon codicon-loading codicon-modifier-spin",
      title: "Dext turn running", role: false
    }, "Dext turn running");
    // A pinned tab trades its close button for the pin that releases it, so
    // that pinned conversations are not dismissed by a stray click.
    const action = Button(adapter, {
      class: conversation.pinned ? "conversation-tab-pin" : "conversation-tab-close",
      title: conversation.running ? "Stop the running turn before closing"
        : conversation.pinned ? "Unpin conversation" : "Close conversation",
      disabled: conversation.running,
      "aria-label": `${conversation.pinned ? "Unpin" : "Close"} ${conversation.title}`
    }, [TraceIcon(adapter, conversation.pinned ? "pinned" : "close")]);
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      if (conversation.pinned) actions.pin(conversation.id, false);
      else actions.close(conversation.id);
    });
    tab.append(label, activity, action);
    if (active) {
      activeTab = tab;
      activeLabel = label;
    }
    row.append(tab);
  }
  labelPanel(panel, activeLabel);
  return activeTab;
}

export function selectRenderedConversationTab(container: HTMLElement, panel: HTMLElement, sessionId: string): void {
  let activeLabel: HTMLElement | undefined;
  for (const tab of container.querySelectorAll<HTMLElement>(".conversation-tab")) {
    const active = tab.dataset.sessionId === sessionId;
    tab.classList.toggle("active", active);
    const label = tab.querySelector<HTMLElement>("[role=tab]");
    label?.setAttribute("aria-selected", String(active));
    if (active && label) activeLabel = label;
  }
  labelPanel(panel, activeLabel);
}
