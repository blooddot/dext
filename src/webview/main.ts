import "../../media/styles.css";
import MarkdownIt from "markdown-it";
import { parser as pythonParser } from "@lezer/python";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type {
  FieldDefinition,
  AgentStreamEvent,
  AgentToolKind,
  AgentTokenUsage,
  DextResult,
  InputExecutionResponse,
  PatchChange,
  RuntimeResponse,
  WorkflowStepResponse
} from "../core/types.js";
import { formatMethodSignature } from "../core/methodSignature.js";
import type { ConversationSummary, SidebarState, WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import { ClipboardClient } from "./clipboardClient.js";
import { FileSearchClient } from "./fileSearchClient.js";
import { DextCodeEditor } from "./codeEditor.js";
import { LanguageRequestBroker } from "./languageClient.js";
import { formatDuration } from "./duration.js";
import { agentMessageCopyText, presentAgentMessage } from "../agentMessagePresentation.js";
import type { AgentMessagePresentation } from "../agentMessagePresentation.js";
import { presentDiff } from "../diffPresentation.js";
import type { DextHistoryRecord, DextHistorySession } from "../historyStore.js";
import { groupMethodsForDisplay, isSyntheticBuiltinGroup } from "./methodGroups.js";
import {
  compactFileReferenceLabel,
  inputReferenceDisplayParts,
  inputReferenceDisplayText,
  normalizeInputReferenceSource,
  type ContextReferenceOccurrence
} from "../core/fileReference.js";
import { createFileReferenceChip, fileReferenceChipDescriptor } from "./fileReferenceChip.js";
import { outputExternalLink, outputLinkReference } from "./outputLink.js";
import { dextHighlightClass, dextHighlightRanges } from "../dextHighlight.js";
import { formatJsonOutput } from "./jsonOutput.js";

interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing Webview element '${id}'.`);
  return value as T;
}

const vscode = acquireVsCodeApi();

const elements = {
  main: element<HTMLElement>("dext-main"),
  conversationTabs: element<HTMLElement>("conversation-tabs"),
  methodsDialog: element<HTMLDialogElement>("methods-dialog"),
  closeMethods: element<HTMLButtonElement>("close-methods"),
  mcpDialog: element<HTMLDialogElement>("mcp-dialog"),
  closeMcp: element<HTMLButtonElement>("close-mcp"),
  mcpToggle: element<HTMLButtonElement>("mcp-toggle"),
  mcpServers: element<HTMLElement>("mcp-servers"),
  mcpSearch: element<HTMLInputElement>("mcp-search"),
  mcpCount: element<HTMLElement>("mcp-count"),
  mcpErrors: element<HTMLElement>("mcp-errors"),
  mcpEmpty: element<HTMLElement>("mcp-empty"),
  mcpAssistantDialog: element<HTMLDialogElement>("mcp-assistant-dialog"),
  mcpAssistantClose: element<HTMLButtonElement>("mcp-assistant-close"),
  mcpAssistantInput: element<HTMLTextAreaElement>("mcp-assistant-input"),
  mcpAssistantStatus: element<HTMLElement>("mcp-assistant-status"),
  mcpAssistantProcess: element<HTMLDetailsElement>("mcp-assistant-process"),
  mcpAssistantProcessMeta: element<HTMLElement>("mcp-assistant-process-meta"),
  mcpAssistantProcessBody: element<HTMLElement>("mcp-assistant-process-body"),
  mcpAssistantTools: element<HTMLElement>("mcp-assistant-tools"),
  mcpAssistantPreview: element<HTMLTextAreaElement>("mcp-assistant-preview"),
  mcpAssistantScope: element<HTMLSelectElement>("mcp-assistant-scope"),
  mcpAssistantScopeLabel: element<HTMLElement>("mcp-assistant-scope-label"),
  mcpAssistantGenerate: element<HTMLButtonElement>("mcp-assistant-generate"),
  mcpAssistantSave: element<HTMLButtonElement>("mcp-assistant-save"),
  uiDialog: element<HTMLDialogElement>("ui-dialog"),
  uiDialogForm: element<HTMLFormElement>("ui-dialog-form"),
  uiDialogTitle: element<HTMLElement>("ui-dialog-title"),
  uiDialogClose: element<HTMLButtonElement>("ui-dialog-close"),
  uiDialogBody: element<HTMLElement>("ui-dialog-body"),
  uiDialogActions: element<HTMLElement>("ui-dialog-actions"),
  inputSection: element<HTMLElement>("input-section"),
  inputHeading: element<HTMLElement>("input-heading"),
  inputBody: element<HTMLElement>("input-body"),
  inputShell: element<HTMLElement>("input-shell"),
  inputError: element<HTMLElement>("input-error"),
  codeEditor: element<HTMLElement>("code-editor"),
  attachFiles: element<HTMLButtonElement>("attach-files"),
  modeControl: element<HTMLButtonElement>("mode-control"),
  modeControlIcon: element<HTMLElement>("mode-control-icon"),
  modeControlValue: element<HTMLElement>("mode-control-value"),
  modeMenu: element<HTMLElement>("mode-menu"),
  permissionMenuShell: element<HTMLElement>("permission-menu-shell"),
  permissionControl: element<HTMLButtonElement>("permission-control"),
  permissionControlIcon: element<HTMLElement>("permission-control-icon"),
  permissionControlValue: element<HTMLElement>("permission-control-value"),
  permissionMenu: element<HTMLElement>("permission-menu"),
  agentControl: element<HTMLButtonElement>("agent-control"),
  agentControlValue: element<HTMLElement>("agent-control-value"),
  agentMenu: element<HTMLElement>("agent-menu"),
  modelControl: element<HTMLButtonElement>("model-control"),
  modelControlValue: element<HTMLElement>("model-control-value"),
  modelMenu: element<HTMLElement>("model-menu"),
  modelSubmenu: element<HTMLElement>("model-submenu"),
  composerMore: element<HTMLButtonElement>("composer-more"),
  run: element<HTMLButtonElement>("run"),
  runLabel: element<HTMLElement>("run-label"),
  problems: element<HTMLButtonElement>("problems"),
  resultSection: element<HTMLElement>("result-section"),
  resultHeading: element<HTMLElement>("result-heading"),
  resultBody: element<HTMLElement>("result-body"),
  methods: element<HTMLElement>("methods"),
  methodCount: element<HTMLElement>("method-count"),
  methodsToggle: element<HTMLButtonElement>("methods-toggle"),
  reloadMethods: element<HTMLButtonElement>("reload-methods"),
  configErrors: element<HTMLElement>("config-errors"),
  result: element<HTMLElement>("result"),
  resultToggle: element<HTMLButtonElement>("result-toggle"),
  inputFullscreen: element<HTMLButtonElement>("input-fullscreen"),
  resultFullscreen: element<HTMLButtonElement>("result-fullscreen"),
  planToolbar: element<HTMLElement>("plan-toolbar"),
  planTarget: element<HTMLButtonElement>("plan-target"),
  planChoose: element<HTMLButtonElement>("plan-choose"),
  planTargetLabel: element<HTMLElement>("plan-target-label"),
  planStatus: element<HTMLElement>("plan-status"),
  planBuild: element<HTMLButtonElement>("plan-build"),
  attachmentBar: element<HTMLElement>("attachment-bar")
};

const jumpToLatest = document.createElement("button");
jumpToLatest.type = "button";
jumpToLatest.className = "stream-jump-latest";
const jumpToLatestIcon = document.createElement("i");
jumpToLatestIcon.className = "codicon codicon-arrow-down";
jumpToLatestIcon.setAttribute("aria-hidden", "true");
jumpToLatest.append(jumpToLatestIcon);
jumpToLatest.setAttribute("aria-label", "Jump to latest output");
jumpToLatest.title = "Jump to latest output";
jumpToLatest.hidden = true;
// Keep the control in the result panel's viewport layer instead of inside the
// scrollable output. This keeps it visible while the reader inspects history.
elements.resultSection.append(jumpToLatest);

type UiRequestMessage = Extract<WebviewResponse, { type: "uiRequest" }>;
let activeUiRequest: UiRequestMessage | undefined;
let pendingConfirmation: (() => void) | undefined;

const broker = new LanguageRequestBroker((request) => vscode.postMessage(request));
const clipboard = new ClipboardClient((request) => vscode.postMessage(request));
const fileSearch = new FileSearchClient((request) => vscode.postMessage(request));
let executing = false;
let stopping = false;
let activeTurnId: string | undefined;
// The turn id alone is not enough when a history command activates another
// conversation while the previous tab is still running. Keep the session
// owner so a live row can never leak into the newly activated conversation.
let activeExecutionSessionId: string | undefined;
let hasErrors = false;
let problemCounts = { errors: 0, warnings: 0 };
let inputKind: "empty" | "workflow" | "invalid" = "empty";
type InputMode = "agent" | "ask" | "plan" | "code";
let inputMode: InputMode = "agent";
let activePlanPath: string | undefined;
let planStatus: "new" | "active" | "running" | "completed" | "failed" = "new";
type AgentPermission = "workspace-write" | "full-access";
const PERMISSION_LABEL: Record<AgentPermission, string> = {
  "workspace-write": "Workspace write",
  "full-access": "Full access"
};
const PERMISSION_ICON: Record<AgentPermission, string> = {
  "workspace-write": "codicon-edit",
  "full-access": "codicon-unlock"
};
let agentPermission: AgentPermission = "workspace-write";
let sidebarState: SidebarState | undefined;
let lastSidebarState: SidebarState | undefined;
// The API/resource trees are independent of the active conversation. Keep a
// compact signature so switching tabs only updates the composer controls
// instead of rebuilding both trees on every state message.
let renderedMethodsKey: string | undefined;
let renderedMcpKey: string | undefined;
let activeConversationId: string | undefined;
// Monotonically identifies the latest tab click. Host responses can be
// delayed by the Webview IPC queue, so stale responses must not overwrite a
// newer local selection.
let conversationSwitchId = 0;
// Scroll correction is deferred until layout has settled.  A tab switch or a
// real user scroll must invalidate an older correction; otherwise a queued
// frame from the previous conversation can yank the newly selected view while
// the user is trying to read it.
let resultScrollFrame: number | undefined;
let resultScrollGeneration = 0;
// A restored running conversation receives its live row and buffered events
// after the cached/history DOM has been painted. Force one final bottom snap
// for that replay; otherwise adding the running row makes the old bottom look
// like a manual scroll and the normal follow logic deliberately preserves it.
let forceInitialConversationScroll = false;
// Rendering a restored conversation can include Markdown, syntax highlighting,
// and diff construction. Keep the tab switch responsive by yielding once so
// the browser can paint an empty loading viewport before that work starts.
let conversationRenderGeneration = 0;
interface DraftAttachment {
  relativePath: string;
  webviewUri: string;
  name: string;
}
interface ConversationDraft {
  source: string;
  attachments: DraftAttachment[];
}
const conversationDrafts = new Map<string, ConversationDraft>();
let restoringDraft = false;
const runningConversationIds = new Set<string>();
let agentStream: HTMLElement | undefined;
let agentRunStartedAt = 0;
let agentRunTimer: ReturnType<typeof setInterval> | undefined;
let agentProgress: HTMLElement | undefined;
let agentProgressState = "Thinking";
let agentTokenUsage: AgentTokenUsage | undefined;
let agentCommandIds = new Set<string>();
let agentEditedUris = new Set<string>();
const agentEventItems = new Map<string, HTMLElement>();
const pendingAgentRenders = new Set<HTMLElement>();
let agentRenderFrame: number | undefined;
let pendingAgentEventBatches: Array<{ sessionId: string; events: AgentStreamEvent[] }> = [];
let agentEventBatchFrame: number | undefined;
interface AgentToolCommand {
  body: HTMLElement;
  copy: HTMLButtonElement;
  label: string;
  summaryLabel: HTMLElement;
  group?: AgentToolGroup;
}
interface AgentToolGroup {
  disclosure: HTMLDetailsElement;
  label: HTMLElement;
  body: HTMLElement;
  commands: AgentToolCommand[];
  /** Set when the agent named the group itself, which wins over a counted label. */
  labelText?: string;
}
const agentToolItems = new Map<string, AgentToolCommand>();
const agentToolGroups = new Map<string, AgentToolGroup>();
let agentToolGroup: AgentToolGroup | undefined;
let agentFileChanges: { disclosure: HTMLDetailsElement; body: HTMLElement; label: HTMLElement } | undefined;
const imageAttachments = new Map<string, HTMLElement>();
interface OutputTurnElements {
  disclosure: HTMLDetailsElement;
  input?: HTMLElement;
  process: HTMLElement;
  processDisclosure: HTMLDetailsElement;
  output: HTMLElement;
  outputDisclosure: HTMLDetailsElement;
  hydrated?: boolean;
  hydrate?: () => void;
}
const outputTurns = new Map<string, OutputTurnElements>();
let activeTurn: OutputTurnElements | undefined;

// Keep the rendered DOM for recently visited conversations. Rebuilding a
// long conversation means reparsing every process event and rerendering every
// diff, which made an ordinary tab switch scale with conversation size.
type ConversationViewCache = {
  nodes: Node[];
  turns: Map<string, OutputTurnElements>;
  pendingAgentItems: HTMLElement[];
  activeTurnId?: string;
  signature: string;
};
const conversationViewCache = new Map<string, ConversationViewCache>();
const MAX_CONVERSATION_VIEW_CACHE = 6;
let renderedConversationId: string | undefined;
let renderedConversationSignature: string | undefined;

function conversationSignature(session: DextHistorySession): string {
  const last = session.turns.at(-1);
  return `${session.updatedAt}:${session.turns.length}:${last?.id ?? ""}:${last?.process.length ?? 0}`;
}

function cacheRenderedConversation(): void {
  if (!renderedConversationId || !renderedConversationSignature) return;
  // A running turn is represented by a live, non-persisted output row and
  // its process events are replayed when the tab becomes active again. Do
  // not cache that transient DOM or those events would be appended twice.
  if (runningConversationIds.has(renderedConversationId)) {
    elements.result.replaceChildren();
    return;
  }
  // Do not synchronously Markdown-render a potentially large trace from the
  // pointerdown handler. Keep the dirty items with the detached nodes and
  // render them after that conversation is restored.
  const pendingAgentItems = [...pendingAgentRenders].filter((item) => item.isConnected);
  pendingAgentRenders.clear();
  if (agentRenderFrame !== undefined) cancelAnimationFrame(agentRenderFrame);
  agentRenderFrame = undefined;
  const activeTurnId = activeTurn?.disclosure.dataset.turnId;
  conversationViewCache.delete(renderedConversationId);
  conversationViewCache.set(renderedConversationId, {
    nodes: [...elements.result.childNodes],
    turns: new Map(outputTurns),
    pendingAgentItems,
    ...(activeTurnId ? { activeTurnId } : {}),
    signature: renderedConversationSignature
  });
  elements.result.replaceChildren();
  while (conversationViewCache.size > MAX_CONVERSATION_VIEW_CACHE) {
    const oldest = conversationViewCache.keys().next().value;
    if (!oldest) break;
    conversationViewCache.delete(oldest);
  }
}

/**
 * End the currently displayed conversation before asking the extension host
 * for another one.  Selection is local and synchronous, whereas an IPC
 * response (or a cold DOM rebuild) can take several frames.  Leaving the old
 * nodes in place during that gap makes a slow switch look like the newly
 * selected tab is lagging behind.  An empty result viewport is an honest
 * loading state and lets the browser paint the selection change immediately.
 */
function clearVisibleConversation(): void {
  conversationRenderGeneration += 1;
  cancelScheduledResultScroll();
  forceInitialConversationScroll = false;
  cacheRenderedConversation();
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  resetAgentTrace();
  clearInputError();
  elements.result.replaceChildren();
  outputTurns.clear();
  activeTurn = undefined;
  renderedConversationId = undefined;
  renderedConversationSignature = undefined;
  jumpToLatest.hidden = true;
  elements.resultBody.dataset.loading = "true";
  elements.resultBody.setAttribute("aria-busy", "true");
  syncResultToggle();
}

function finishConversationLoading(): void {
  delete elements.resultBody.dataset.loading;
  elements.resultBody.setAttribute("aria-busy", "false");
}

function cancelScheduledResultScroll(): void {
  resultScrollGeneration += 1;
  if (resultScrollFrame !== undefined) cancelAnimationFrame(resultScrollFrame);
  resultScrollFrame = undefined;
}

function restoreCachedAgentRenders(cached: ConversationViewCache): void {
  for (const item of cached.pendingAgentItems) {
    if (item.isConnected) scheduleAgentMessageRender(item);
  }
  cached.pendingAgentItems = [];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  })[character] ?? character);
}

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  // Agent output often contains a bare URL instead of Markdown's
  // `[label](url)` form. Turn those into anchors as well, so the shared
  // output-link handler can hand them to the extension host.
  linkify: true,
  highlight(source, language) {
    const normalized = language.trim().toLowerCase();
    if (normalized !== "python" && normalized !== "py") return "";
    try {
      let html = "";
      highlightCode(
        source,
        pythonParser.parse(source),
        classHighlighter,
        (text, classes) => {
          html += classes
            ? `<span class="${classes}">${escapeHtml(text)}</span>`
            : escapeHtml(text);
        },
        () => { html += "\n"; }
      );
      return html;
    } catch {
      return "";
    }
  }
});

// markdown-it intentionally rejects `file:` destinations. Dext's host-side
// handler validates these URLs against the current workspace, so keep the
// renderer from turning an otherwise valid file link into inert plain text.
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (url: string): boolean =>
  /^file:/i.test(url.trim()) || defaultValidateLink(url);

const editor = new DextCodeEditor({
  parent: elements.codeEditor,
  broker,
  clipboard,
  files: fileSearch,
  onRun: run,
  onOpenReference: openInputReference,
  onDiagnosticsChanged(counts) {
    problemCounts = counts;
    hasErrors = counts.errors > 0;
    updateRunState();
  },
  onInputKindChanged(kind) {
    inputKind = kind;
    updateRunState();
  },
  onSourceChanged() {
    clearInputError();
    persistComposerDraft();
    updateRunState();
  },
  onError: renderError
});

function openInputReference(reference: ContextReferenceOccurrence): void {
  if (reference.kind === "file") {
    vscode.postMessage({ type: "openFileReference", reference: reference.payload });
  }
}

/** Open output links through the host, since Webview CSP prevents navigation. */
function openOutputLink(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (!link || !elements.result.contains(link)) return;
  const href = link.getAttribute("href") ?? "";
  const reference = outputLinkReference(href);
  const externalUrl = reference ? undefined : outputExternalLink(href);
  if (!reference && !externalUrl) return;
  event.preventDefault();
  event.stopPropagation();
  if (reference) {
    vscode.postMessage({ type: "openFileReference", reference });
  } else if (externalUrl) {
    vscode.postMessage({ type: "openExternalLink", url: externalUrl });
  }
}

function updateRunState(): void {
  const codeMode = inputMode === "code";
  elements.inputSection.dataset.mode = inputMode;
  elements.run.disabled = executing
    ? stopping || !activeTurnId
    : !editor.source.trim() || (codeMode && (hasErrors || inputKind === "invalid"));
  elements.runLabel.textContent = executing ? (stopping ? "Stopping" : "Stop") : codeMode ? "Run" : "Send";
  const runIcon = elements.run.querySelector<HTMLElement>("i");
  if (runIcon) runIcon.className = `codicon codicon-${executing ? "debug-stop" : "run"}`;
  elements.run.classList.toggle("stopping", stopping);
  elements.run.classList.toggle("executing", executing);
  const parts = [
    problemCounts.errors ? `${problemCounts.errors} error${problemCounts.errors === 1 ? "" : "s"}` : "",
    problemCounts.warnings ? `${problemCounts.warnings} warning${problemCounts.warnings === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  elements.problems.textContent = parts.join(" · ") || "No problems";
  elements.problems.disabled = !codeMode || parts.length === 0;
  elements.problems.classList.toggle("has-problems", codeMode && parts.length > 0);
  elements.problems.classList.toggle("hidden", !codeMode);
  elements.inputShell.classList.toggle("conversation-mode", !codeMode);
  renderPlanToolbar();
  syncTurnActions();
}

function renderPlanToolbar(): void {
  const visible = inputMode === "plan";
  elements.planToolbar.hidden = !visible;
  if (!visible) return;
  elements.planTargetLabel.textContent = activePlanPath?.split("/").pop() ?? "New plan";
  elements.planTarget.title = activePlanPath ? `Open ${activePlanPath}` : "Select a plan";
  const labels = { new: "New plan", active: "Active", running: "Running", completed: "Completed", failed: "Failed" };
  elements.planStatus.textContent = labels[planStatus];
  elements.planBuild.hidden = !activePlanPath;
  // A plan cannot be switched while its current turn is being edited or built.
  // Keep the chooser in sync with Build so the host never receives a
  // plan-selection request that it must reject because an execution is active.
  const planLocked = executing || planStatus === "running";
  elements.planChoose.disabled = planLocked;
  // Opening the already-selected document remains useful while it runs. For a
  // new plan, the target button is itself a chooser and must be locked too.
  elements.planTarget.disabled = planLocked && !activePlanPath;
  const planBuildRunning = planStatus === "running" && executing;
  elements.planBuild.disabled = planBuildRunning
    ? stopping || !activeTurnId
    : executing || planStatus === "running" || !activePlanPath;
  elements.planBuild.classList.toggle("executing", planBuildRunning);
  elements.planBuild.classList.toggle("stopping", planBuildRunning && stopping);
  const buildLabel = elements.planBuild.querySelector("span");
  if (buildLabel) buildLabel.textContent = planBuildRunning ? "Stop" : planStatus === "completed" ? "Rebuild" : "Build";
  elements.planBuild.title = planBuildRunning ? "Stop building the active plan" : "Build the active plan";
  const buildIcon = elements.planBuild.querySelector<HTMLElement>("i");
  if (buildIcon) buildIcon.className = `codicon codicon-${planBuildRunning ? "debug-stop" : "play"}`;
}

function run(): void {
  if (executing) {
    if (!activeTurnId || stopping) return;
    stopping = true;
    vscode.postMessage({ type: "stopExecution", turnId: activeTurnId });
    updateRunState();
    return;
  }
  const source = editor.source.trim();
  if (!source || elements.run.disabled) return;
  clearInputError();
  if (inputMode === "plan" && activePlanPath) {
    vscode.postMessage({ type: "executeInput", mode: inputMode, source, planPath: activePlanPath });
  } else {
    vscode.postMessage({ type: "executeInput", mode: inputMode, source });
  }
  clearSubmittedInput();
}

type PanelName = "input" | "result";

const panels: Record<PanelName, { section: HTMLElement; heading: HTMLElement; body: HTMLElement; button: HTMLButtonElement; label: string }> = {
  input: { section: elements.inputSection, heading: elements.inputHeading, body: elements.inputBody, button: elements.inputFullscreen, label: "Input" },
  result: { section: elements.resultSection, heading: elements.resultHeading, body: elements.resultBody, button: elements.resultFullscreen, label: "Conversation" }
};
let fullscreenPanel: PanelName | undefined;
let fullscreenSnapshot: Record<PanelName, boolean> | undefined;

function syncFullscreenButtons(): void {
  for (const [name, panel] of Object.entries(panels) as [PanelName, typeof panels[PanelName]][]) {
    const active = fullscreenPanel === name;
    const title = active ? `Restore ${panel.label}` : `Maximize ${panel.label}`;
    panel.button.title = title;
    panel.button.setAttribute("aria-label", title);
    const icon = panel.button.querySelector<HTMLElement>("i");
    if (icon) icon.className = `codicon codicon-screen-${active ? "normal" : "full"}`;
  }
}

function toggleFullscreen(name: PanelName): void {
  if (fullscreenPanel === name) {
    fullscreenPanel = undefined;
    elements.main.classList.remove("workspace-fullscreen");
    for (const panelName of Object.keys(panels) as PanelName[]) {
      panels[panelName].section.classList.remove("panel-expanded");
      setSectionOpen(panels[panelName].heading, panels[panelName].body, fullscreenSnapshot?.[panelName] ?? true);
    }
    fullscreenSnapshot = undefined;
    syncFullscreenButtons();
    return;
  }
  if (!fullscreenPanel) {
    fullscreenSnapshot = Object.fromEntries((Object.keys(panels) as PanelName[]).map((panelName) => [
      panelName,
      panels[panelName].heading.getAttribute("aria-expanded") === "true"
    ])) as Record<PanelName, boolean>;
  }
  fullscreenPanel = name;
  elements.main.classList.add("workspace-fullscreen");
  for (const panelName of Object.keys(panels) as PanelName[]) {
    const active = panelName === name;
    panels[panelName].section.classList.toggle("panel-expanded", active);
    setSectionOpen(panels[panelName].heading, panels[panelName].body, active);
  }
  syncFullscreenButtons();
}

function setMethodsReloading(reloading: boolean): void {
  elements.reloadMethods.disabled = reloading;
  elements.reloadMethods.querySelector(".codicon")
    ?.classList.toggle("codicon-modifier-spin", reloading);
}

function openMethodsDialog(): void {
  closeComposerMenus();
  if (!elements.methodsDialog.open) elements.methodsDialog.showModal();
}

function closeMethodsDialog(): void {
  if (elements.methodsDialog.open) elements.methodsDialog.close();
}

function openMcpDialog(): void {
  closeComposerMenus();
  if (!elements.mcpDialog.open) elements.mcpDialog.showModal();
}

function closeMcpDialog(): void {
  if (elements.mcpDialog.open) elements.mcpDialog.close();
}

function syncResourceToggle(): void {
  const groups = [...elements.mcpServers.querySelectorAll<HTMLDetailsElement>("details.resource-category")];
  const open = groups.length === 0 || groups.every((group) => group.open);
  const icon = elements.mcpToggle.querySelector("i");
  if (icon) icon.className = `codicon codicon-${open ? "collapse-all" : "expand-all"}`;
  const title = open ? "Collapse resource categories" : "Expand resource categories";
  elements.mcpToggle.title = title;
  elements.mcpToggle.setAttribute("aria-label", title);
}

function toggleResourceCategories(): void {
  const groups = [...elements.mcpServers.querySelectorAll<HTMLDetailsElement>("details.resource-category")];
  const open = groups.some((group) => !group.open);
  groups.forEach((group) => { group.open = open; });
  syncResourceToggle();
}

function openMcpAssistantDialog(): void {
  closeComposerMenus();
  if (!elements.mcpAssistantDialog.open) elements.mcpAssistantDialog.showModal();
  updateMcpAssistantAction();
  elements.mcpAssistantInput.focus();
}

function finishUi(response: Extract<WebviewRequest, { type: "uiResponse" }>["response"]): void {
  if (!activeUiRequest) return;
  vscode.postMessage({ type: "uiResponse", requestId: activeUiRequest.requestId, response });
  activeUiRequest = undefined;
  if (elements.uiDialog.open) elements.uiDialog.close();
}

function cancelUi(): void {
  if (pendingConfirmation) {
    pendingConfirmation = undefined;
    if (elements.uiDialog.open) elements.uiDialog.close();
    return;
  }
  const request = activeUiRequest?.request;
  if (!request) return;
  if (request.type === "choice") finishUi({ type: "choice", selected: [] });
  else if (request.type === "confirm") finishUi({ type: "confirm", confirmed: false });
  else finishUi({ type: "input" });
}

function openConfirmationDialog(message: string, onConfirm: () => void): void {
  pendingConfirmation = onConfirm;
  activeUiRequest = undefined;
  closeComposerMenus();
  elements.uiDialogTitle.textContent = "Confirm";
  elements.uiDialogBody.replaceChildren();
  elements.uiDialogActions.replaceChildren();
  const text = document.createElement("div");
  text.textContent = message;
  elements.uiDialogBody.append(text);
  elements.uiDialogActions.append(
    uiButton("Cancel", true, cancelUi),
    uiButton("Confirm", false, () => {
      const confirm = pendingConfirmation;
      pendingConfirmation = undefined;
      if (elements.uiDialog.open) elements.uiDialog.close();
      confirm?.();
    })
  );
  if (!elements.uiDialog.open) elements.uiDialog.showModal();
}

function uiButton(label: string, secondary: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (secondary) button.className = "secondary";
  button.addEventListener("click", onClick);
  return button;
}

function openUiDialog(message: UiRequestMessage): void {
  pendingConfirmation = undefined;
  activeUiRequest = message;
  closeComposerMenus();
  elements.uiDialogTitle.textContent = message.request.type === "confirm" ? "Confirm" : message.request.label;
  elements.uiDialogBody.replaceChildren();
  elements.uiDialogActions.replaceChildren();
  if (message.request.type === "choice") {
    const choiceRequest = message.request;
    const prompt = document.createElement("div");
    prompt.className = "ui-dialog-label";
    prompt.textContent = message.request.label;
    elements.uiDialogBody.append(prompt);
    const group = document.createElement("div");
    const inputType = choiceRequest.multiple ? "checkbox" : "radio";
    choiceRequest.options.forEach((option, index) => {
      const label = document.createElement("label");
      label.className = "ui-dialog-option";
      const input = document.createElement("input");
      input.type = inputType;
      input.name = "ui-choice";
      input.value = option;
      if (!choiceRequest.multiple && index === 0) input.checked = true;
      label.append(input, document.createTextNode(option));
      group.append(label);
    });
    let customInput: HTMLInputElement | undefined;
    if (choiceRequest.allowCustom) {
      const customLabel = document.createElement("label");
      customLabel.className = "ui-dialog-option";
      customLabel.append(document.createTextNode("Other"));
      customInput = document.createElement("input");
      customInput.type = "text";
      customInput.className = "ui-dialog-input";
      customInput.placeholder = choiceRequest.customPlaceholder ?? "Enter a custom option";
      customLabel.append(customInput);
      group.append(customLabel);
    }
    elements.uiDialogBody.append(group);
    elements.uiDialogActions.append(
      uiButton("Cancel", true, cancelUi),
      uiButton("Continue", false, () => {
        const selected = [...elements.uiDialogBody.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked, input[type="radio"]:checked')].map((input) => input.value);
        const custom = customInput?.value.trim();
        finishUi({ type: "choice", selected: custom && !choiceRequest.multiple ? [] : selected, ...(custom ? { custom } : {}) });
      })
    );
    queueMicrotask(() => elements.uiDialogBody.querySelector<HTMLElement>("input")?.focus());
  } else if (message.request.type === "confirm") {
    const text = document.createElement("div");
    text.textContent = message.request.message;
    elements.uiDialogBody.append(text);
    elements.uiDialogActions.append(
      uiButton(message.request.cancelLabel, true, cancelUi),
      uiButton(message.request.confirmLabel, false, () => finishUi({ type: "confirm", confirmed: true }))
    );
  } else {
    const label = document.createElement("div");
    label.className = "ui-dialog-label";
    label.textContent = message.request.label;
    const input = message.request.multiline ? document.createElement("textarea") : document.createElement("input");
    input.className = "ui-dialog-input";
    input.placeholder = message.request.placeholder ?? "";
    elements.uiDialogBody.append(label, input);
    elements.uiDialogActions.append(
      uiButton("Cancel", true, cancelUi),
      uiButton("Submit", false, () => finishUi({ type: "input", value: input.value }))
    );
    if (!message.request.multiline) {
      input.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
          event.preventDefault();
          finishUi({ type: "input", value: input.value });
        }
      });
    }
    queueMicrotask(() => input.focus());
  }
  if (!elements.uiDialog.open) elements.uiDialog.showModal();
}

function renderMcp(state: SidebarState): void {
  const resources = state.globalResources ?? {
    apis: [],
    mcps: state.mcpServers.map((server) => ({ name: server.name, detail: server.transport })),
    rules: [],
    skills: []
  };
  elements.mcpServers.replaceChildren();
  const query = elements.mcpSearch.value.trim().toLowerCase();
  const matches = (item: { name: string; detail?: string }): boolean =>
    !query || `${item.name} ${item.detail ?? ""}`.toLowerCase().includes(query);
  const categories = [
    ["APIs", "symbol-method", resources.apis.filter(matches)],
    ["MCP", "server", resources.mcps.filter(matches)],
    ["Rules", "law", resources.rules.filter(matches)],
    ["Skills", "sparkle", resources.skills.filter(matches)]
  ] as const;
  const total = categories.reduce((sum, [, , items]) => sum + items.length, 0);
  elements.mcpCount.textContent = String(total);
  elements.mcpEmpty.hidden = total !== 0;
  for (const [title, icon, items] of categories) {
    const group = document.createElement("details");
    group.className = "resource-category";
    group.open = true;
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    // Keep resource categories in step with API groups: closed categories use
    // an explicit right chevron and open categories use a down chevron. Using
    // the generic disclosure chevron here applies a rotation transform that
    // makes the closed state point left instead.
    chevron.className = "method-chevron codicon codicon-chevron-down";
    const categoryIcon = document.createElement("i");
    categoryIcon.className = `resource-category-icon codicon codicon-${icon}`;
    const label = document.createElement("span");
    label.className = "resource-category-label";
    label.textContent = title;
    const count = document.createElement("span");
    count.className = "resource-category-count";
    count.textContent = String(items.length);
    summary.append(chevron, categoryIcon, label, count);
    const body = document.createElement("div");
    body.className = "resource-category-body";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "resource-empty";
      empty.textContent = `No global ${title.toLowerCase()} found.`;
      body.append(empty);
    }
    for (const resource of items) {
      const row = document.createElement("div");
      row.className = "method-row resource-row";
      const identity = document.createElement("span");
      identity.className = "method-identity";
      const name = document.createElement("span");
      name.className = "method-name";
      name.textContent = resource.name;
      identity.append(name);
      if (resource.detail) {
        const detail = document.createElement("span");
        detail.className = "method-signature";
        detail.textContent = resource.detail;
        identity.append(detail);
      }
      row.append(identity);
      body.append(row);
    }
    group.append(summary, body);
    group.addEventListener("toggle", syncResourceToggle);
    group.addEventListener("toggle", () => {
      chevron.className = `method-chevron codicon codicon-chevron-${group.open ? "down" : "right"}`;
    });
    elements.mcpServers.append(group);
  }
  syncResourceToggle();
  elements.mcpErrors.replaceChildren();
  for (const diagnostic of state.globalDiagnostics) {
    const item = document.createElement("div");
    item.textContent = diagnostic;
    elements.mcpErrors.append(item);
  }
}

let mcpAssistantRequestId: string | undefined;
let mcpAssistantRunningRequestId: string | undefined;
let mcpAssistantStopping = false;
let mcpAssistantServer: SidebarState["mcpServers"][number] | undefined;
let mcpAssistantProcessStartedAt: number | undefined;
let mcpAssistantProcessCount = 0;
let mcpAssistantProcessTokens: number | undefined;
let mcpAssistantPendingTools: string[] | undefined;

function resetMcpAssistantProcess(): void {
  mcpAssistantProcessStartedAt = undefined;
  mcpAssistantProcessCount = 0;
  mcpAssistantProcessTokens = undefined;
  mcpAssistantPendingTools = undefined;
  elements.mcpAssistantProcessBody.replaceChildren();
  elements.mcpAssistantProcessMeta.textContent = "";
  elements.mcpAssistantProcess.hidden = true;
  elements.mcpAssistantProcess.open = false;
  elements.mcpAssistantTools.replaceChildren();
  elements.mcpAssistantTools.hidden = true;
}

function updateMcpAssistantAction(): void {
  // MCP generation is presented in its own dialog. Keep its Stop state
  // independent from the conversation composer run control below.
  const closeLabel = mcpAssistantRunningRequestId
    ? mcpAssistantStopping ? "Stopping MCP generation" : "Stop MCP generation"
    : "Close MCP Assistant";
  elements.mcpAssistantClose.title = closeLabel;
  elements.mcpAssistantClose.setAttribute("aria-label", closeLabel);
  const closeIcon = elements.mcpAssistantClose.querySelector<HTMLElement>("i");
  if (closeIcon) closeIcon.className = `codicon codicon-${mcpAssistantRunningRequestId ? "debug-stop" : "close"}`;
  if (mcpAssistantRunningRequestId) {
    elements.mcpAssistantGenerate.hidden = false;
    elements.mcpAssistantGenerate.disabled = mcpAssistantStopping;
    elements.mcpAssistantGenerate.textContent = mcpAssistantStopping ? "Stopping" : "Stop";
    elements.mcpAssistantGenerate.classList.toggle("stopping", mcpAssistantStopping);
    return;
  }
  elements.mcpAssistantGenerate.disabled = false;
  elements.mcpAssistantGenerate.textContent = "Generate";
  elements.mcpAssistantGenerate.classList.remove("stopping");
}

function renderMcpAssistantEvent(event: AgentStreamEvent): void {
  if (!mcpAssistantProcessStartedAt) mcpAssistantProcessStartedAt = Date.now();
  mcpAssistantProcessCount += 1;
  const usage = event.usage;
  if (usage) {
    mcpAssistantProcessTokens = usage.totalTokens
      ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
        ? usage.inputTokens + usage.outputTokens
        : mcpAssistantProcessTokens);
  }
  elements.mcpAssistantProcess.hidden = false;
  const elapsed = Math.max(0, Date.now() - mcpAssistantProcessStartedAt);
  const tokenLabel = mcpAssistantProcessTokens === undefined ? "" : ` · ${mcpAssistantProcessTokens} tokens`;
  elements.mcpAssistantProcessMeta.textContent = `Worked for ${formatDuration(elapsed)} · ${mcpAssistantProcessCount} events${tokenLabel}`;
  if (event.phase === "status" && !event.text.trim()) return;
  const row = document.createElement("div");
  row.className = `mcp-process-event mcp-process-${event.phase}`;
  const title = document.createElement("strong");
  title.textContent = event.title || (event.phase === "tool" ? "Tool" : event.phase[0]!.toUpperCase() + event.phase.slice(1));
  const text = document.createElement("div");
  text.textContent = event.text;
  row.append(title, text);
  elements.mcpAssistantProcessBody.append(row);
  elements.mcpAssistantProcessBody.scrollTop = elements.mcpAssistantProcessBody.scrollHeight;
}

function generateMcpAssistant(): void {
  if (mcpAssistantRunningRequestId) {
    if (mcpAssistantStopping) return;
    mcpAssistantStopping = true;
    elements.mcpAssistantStatus.textContent = "Stopping MCP generation…";
    vscode.postMessage({ type: "stopExecution", turnId: mcpAssistantRunningRequestId });
    updateMcpAssistantAction();
    return;
  }
  const documentText = elements.mcpAssistantInput.value.trim();
  if (!documentText) { elements.mcpAssistantStatus.textContent = "Paste a documentation or registry URL first."; return; }
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  mcpAssistantRequestId = requestId;
  // Mark the request busy immediately, before the host's executing event
  // comes back. This closes the small race where a fast click on X/Esc could
  // dismiss the dialog while generation was already in flight.
  mcpAssistantRunningRequestId = requestId;
  mcpAssistantStopping = false;
  elements.mcpAssistantStatus.textContent = "Dext is reading the documentation and drafting a safe configuration…";
  resetMcpAssistantProcess();
  elements.mcpAssistantProcess.hidden = false;
  elements.mcpAssistantProcess.open = true;
  mcpAssistantProcessStartedAt = Date.now();
  updateMcpAssistantAction();
  vscode.postMessage({ type: "generateMcp", requestId, document: documentText });
}

function saveMcpAssistant(): void {
  if (!mcpAssistantServer) return;
  let value: unknown;
  try { value = JSON.parse(elements.mcpAssistantPreview.value); } catch { elements.mcpAssistantStatus.textContent = "Configuration must be valid JSON."; return; }
  if (!value || typeof value !== "object" || Array.isArray(value)) { elements.mcpAssistantStatus.textContent = "Configuration must be a JSON object."; return; }
  const server = value as Record<string, unknown>;
  if ((server.transport !== "http" && server.transport !== "stdio") || typeof server.name !== "string") {
    elements.mcpAssistantStatus.textContent = "Configuration needs a name and a supported transport."; return;
  }
  const candidate = server.transport === "http"
    ? { name: server.name, transport: "http" as const, url: typeof server.url === "string" ? server.url : "", ...(server.auth ? { auth: { type: "bearer" as const } } : {}) }
    : {
      name: server.name,
      transport: "stdio" as const,
      command: typeof server.command === "string" ? server.command : "",
      ...(Array.isArray(server.args) ? { args: server.args.filter((item): item is string => typeof item === "string") } : {}),
      ...(server.auth && typeof server.auth === "object" && (server.auth as Record<string, unknown>).type === "token"
        && typeof (server.auth as Record<string, unknown>).env === "string"
        ? { auth: { type: "token" as const, env: (server.auth as Record<string, unknown>).env as string } }
        : {})
    };
  if (mcpAssistantPendingTools === undefined) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    mcpAssistantRequestId = requestId;
    vscode.postMessage({ type: "prepareMcp", requestId, scope: elements.mcpAssistantScope.value as "project" | "global", server: candidate });
    elements.mcpAssistantStatus.textContent = "Discovering MCP tools…";
    elements.mcpAssistantSave.disabled = true;
    return;
  }
  vscode.postMessage({ type: "createMcp", scope: elements.mcpAssistantScope.value as "project" | "global", selectedTools: mcpAssistantPendingTools, server: candidate });
  elements.mcpAssistantStatus.textContent = "MCP saved. Refreshing its tools…";
  elements.mcpAssistantSave.disabled = true;
}

function renderMcpToolChoices(tools: Array<{ name: string; description?: string }>): void {
  mcpAssistantPendingTools = tools.map((tool) => tool.name);
  elements.mcpAssistantTools.replaceChildren();
  elements.mcpAssistantTools.hidden = false;
  const heading = document.createElement("div");
  heading.className = "mcp-assistant-label";
  heading.textContent = `Select tools to add (${tools.length})`;
  elements.mcpAssistantTools.append(heading);
  for (const tool of tools) {
    const label = document.createElement("label");
    label.className = "mcp-tool-choice";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.addEventListener("change", () => {
      if (!mcpAssistantPendingTools) return;
      mcpAssistantPendingTools = input.checked
        ? [...new Set([...mcpAssistantPendingTools, tool.name])]
        : mcpAssistantPendingTools.filter((name) => name !== tool.name);
    });
    const text = document.createElement("span");
    text.textContent = tool.name;
    const description = document.createElement("small");
    description.textContent = tool.description ?? "";
    label.append(input, text, description);
    elements.mcpAssistantTools.append(label);
  }
  elements.mcpAssistantStatus.textContent = "Choose the tools to include, then save MCP.";
  elements.mcpAssistantSave.disabled = false;
}

function defaultValue(field: FieldDefinition): string {
  if (field.multiple) return `[${defaultValue({ ...field, multiple: false })}]`;
  if (field.default !== undefined) {
    if (typeof field.default === "string") return `"${field.default}"`;
    if (typeof field.default === "object") return JSON.stringify(field.default);
    return String(field.default);
  }
  if (field.type === "context") return "@selection";
  if (field.type === "result") return "edit_result";
  if (field.type === "number") return "0";
  if (field.type === "boolean") return "False";
  if (field.type === "enum") return `"${field.values?.[0] ?? ""}"`;
  if (field.type === "object") return "{}";
  return '""';
}

function methodTemplate(method: SidebarState["methods"][number]): string {
  const args = method.input
    .filter((field) => field.required && field.default === undefined)
    .map((field) => `${field.name}=${defaultValue(field)}`);
  return `${method.id}(${args.join(", ")})`;
}

function renderMethods(state: SidebarState): void {
  editor.applyTheme(state.theme);
  elements.methods.replaceChildren();
  elements.methodCount.textContent = String(state.methods.length);
  const root = groupMethodsForDisplay(state.methods);
  const collectSources = (node: typeof root): Set<string> => {
    const sources = new Set<string>(node.methods.map((method) => method.source === "builtin" ? "builtin" : "project"));
    for (const child of node.children.values()) {
      for (const source of collectSources(child)) sources.add(source);
    }
    return sources;
  };
  const renderNode = (node: typeof root, parent: HTMLElement, prefix = ""): void => {
    for (const [name, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b))) {
      const group = document.createElement("details");
      group.className = "method-group";
      group.open = true;
      group.addEventListener("toggle", syncMethodToggle);
      const summary = document.createElement("summary");
      summary.className = "method-group-summary";
      const chevron = document.createElement("i");
      chevron.className = "method-chevron codicon codicon-chevron-down";
      const label = document.createElement("span");
      label.className = "method-group-label";
      const groupName = document.createElement("span");
      groupName.textContent = `${prefix}${name}`;
      label.append(groupName);
      const sources = [...collectSources(child)];
      const sourceName = isSyntheticBuiltinGroup(name, prefix, child)
        ? undefined
        : sources.length === 1 ? sources[0] : undefined;
      if (sourceName) {
        const source = document.createElement("span");
        source.className = "method-source";
        source.textContent = sourceName;
        label.append(source);
      }
      summary.append(chevron, label);
      group.append(summary);
      group.addEventListener("toggle", () => {
        chevron.className = `method-chevron codicon codicon-chevron-${group.open ? "down" : "right"}`;
      });
      renderNode(child, group, `${prefix}${name}.`);
      parent.append(group);
    }
    for (const method of node.methods) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "method-row";
      row.title = method.description;
      const identity = document.createElement("span");
      identity.className = "method-identity";
      const name = document.createElement("span");
      name.className = "method-name";
      name.textContent = method.id.split(".").at(-1) ?? method.id;
      const signature = document.createElement("span");
      signature.className = "method-signature";
      signature.textContent = formatMethodSignature({
        ...method,
        id: method.id.split(".").at(-1) ?? method.id
      }, { includeInternal: ["agent", "ask", "plan"].includes(method.id) });
      if (!prefix) {
        const source = document.createElement("span");
        source.className = "method-source-inline";
        source.textContent = method.source === "builtin" ? "builtin" : "project";
        identity.append(name, source, signature);
      } else {
        identity.append(name, signature);
      }
      const insert = document.createElement("i");
      insert.className = "codicon codicon-add";
      row.append(identity, insert);
      row.addEventListener("click", () => {
        editor.insertInvocation(methodTemplate(method));
        closeMethodsDialog();
      });
      parent.append(row);
    }
  }
  renderNode(root, elements.methods);
  syncMethodToggle();
  elements.configErrors.replaceChildren();
  for (const diagnostic of state.diagnostics) {
    const item = document.createElement("div");
    item.textContent = diagnostic;
    elements.configErrors.append(item);
  }
  editor.refreshLanguageState();
}

function setMethodGroupsOpen(open: boolean): void {
  elements.methods.querySelectorAll<HTMLDetailsElement>("details.method-group").forEach((group) => {
    group.open = open;
  });
  syncMethodToggle();
}

function syncMethodToggle(): void {
  const groups = [...elements.methods.querySelectorAll<HTMLDetailsElement>("details.method-group")];
  const open = groups.length === 0 || groups.every((group) => group.open);
  const icon = elements.methodsToggle.querySelector("i");
  if (icon) icon.className = `codicon codicon-${open ? "collapse-all" : "expand-all"}`;
  const title = open ? "Collapse API groups" : "Expand API groups";
  elements.methodsToggle.title = title;
  elements.methodsToggle.setAttribute("aria-label", title);
}

function toggleMethodGroups(): void {
  const groups = [...elements.methods.querySelectorAll<HTMLDetailsElement>("details.method-group")];
  setMethodGroupsOpen(groups.some((group) => !group.open));
}

function setResultDetailsOpen(open: boolean): void {
  elements.result.querySelectorAll<HTMLDetailsElement>("details").forEach((detail) => {
    detail.open = open;
  });
  syncResultToggle();
}

function syncResultToggle(): void {
  const details = [...elements.result.querySelectorAll<HTMLDetailsElement>("details.output-turn")];
  // Show the collapse action as soon as any conversation content is open.
  const open = details.length === 0 || details.some((detail) => detail.open);
  const icon = elements.resultToggle.querySelector("i");
  if (icon) icon.className = `codicon codicon-${open ? "collapse-all" : "expand-all"}`;
  const title = open ? "Collapse conversation" : "Expand conversation";
  elements.resultToggle.title = title;
  elements.resultToggle.setAttribute("aria-label", title);
}

function toggleResultDetails(): void {
  const details = [...elements.result.querySelectorAll<HTMLDetailsElement>("details.output-turn")];
  // The button is a collapse action whenever at least one turn is open. In a
  // mixed state it must therefore collapse everything, rather than expand the
  // closed turns just because one happens to be closed.
  setResultDetailsOpen(!details.some((detail) => detail.open));
}

function setSectionOpen(heading: HTMLElement, body: HTMLElement, open: boolean): void {
  heading.setAttribute("aria-expanded", String(open));
  body.classList.toggle("collapsed", !open);
  heading.parentElement?.classList.toggle("section-collapsed", !open);
  const icon = heading.querySelector<HTMLElement>(".section-chevron");
  if (icon) icon.className = `section-chevron codicon codicon-chevron-${open ? "down" : "right"}`;
}

function toggleSection(heading: HTMLElement, body: HTMLElement): void {
  if (fullscreenPanel) {
    if (panels[fullscreenPanel].heading !== heading) return;
    const panelName = fullscreenPanel;
    toggleFullscreen(panelName);
    setSectionOpen(heading, body, false);
    return;
  }
  setSectionOpen(heading, body, heading.getAttribute("aria-expanded") !== "true");
}

function displayOptionValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function renderAgentControls(state: SidebarState): void {
  sidebarState = state;
  // A tab with no stored mode is a fresh conversation and must use Agent. Do
  // not retain the previous tab's mode in the webview-local fallback.
  inputMode = state.agentSelection.mode ?? "agent";
  if (state.settings) {
    defaultDiffMode = state.settings.diffView;
    editor.setSubmitOnEnter(state.settings.submitOnEnter);
  }
  editor.setLanguageEnabled(inputMode === "code");
  const selected = state.agentProfiles.find((item) => item.id === state.agentSelection.profileId)
    ?? state.agentProfiles[0];
  type ModelOption = { id: string; label: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string };
  const options: ModelOption[] = selected?.modelOptions
    ? selected.modelOptions
    : (selected?.models ?? []).map((item): ModelOption => ({ id: item, label: item, reasoningEfforts: [], speedTiers: [], serviceTiers: [] }));
  const selectedModel = options.find((item) => item.id === state.agentSelection.model);
  const modeLabel: Record<InputMode, string> = { agent: "Agent", ask: "Ask", plan: "Plan", code: "Code" };
  const modeIcon: Record<InputMode, string> = {
    agent: "codicon-hubot",
    ask: "codicon-comment-discussion",
    plan: "codicon-checklist",
    code: "codicon-code"
  };
  elements.modeControlValue.textContent = modeLabel[inputMode];
  elements.modeControlIcon.className = `codicon ${modeIcon[inputMode]}`;
  // Invalidated legacy values fall back to the safe writable tier without a
  // migration step; the composer no longer offers a read-only Agent tier.
  agentPermission = state.agentSelection.permission === "full-access" ? "full-access" : "workspace-write";
  // Ask is the dedicated read-only mode. Agent and Plan choose their write
  // scope; Code carries its permission on each call.
  elements.permissionMenuShell.hidden = inputMode !== "agent" && inputMode !== "plan";
  elements.permissionControlValue.textContent = PERMISSION_LABEL[agentPermission];
  elements.permissionControlIcon.className = `codicon ${PERMISSION_ICON[agentPermission]}`;
  elements.permissionControl.classList.toggle("is-full-access", agentPermission === "full-access");
  elements.agentControlValue.textContent = selected?.label ?? "Choose";
  const selectedModelLabel = selectedModel?.label ?? "Default";
  const selectedEffort = state.agentSelection.reasoningEffort ?? selectedModel?.defaultReasoningEffort;
  elements.modelControlValue.textContent = selectedEffort && selectedModel
    ? `${selectedModelLabel} ${displayOptionValue(selectedEffort)}`
    : selectedModelLabel;
  renderComposerMenu(elements.modeMenu, [
    ["agent", "Agent", "codicon-hubot"],
    ["ask", "Ask", "codicon-comment-discussion"],
    ["plan", "Plan", "codicon-checklist"],
    ["code", "Code", "codicon-code"]
  ], inputMode, (mode) => {
    inputMode = mode as InputMode;
    submitAgentSelection({});
  }, [], {
    agent: "composer-menu-option-mode-agent",
    ask: "composer-menu-option-mode-ask",
    plan: "composer-menu-option-mode-plan",
    code: "composer-menu-option-mode-code"
  });
  renderComposerMenu(elements.permissionMenu, [
    ["workspace-write", PERMISSION_LABEL["workspace-write"], PERMISSION_ICON["workspace-write"]],
    ["full-access", PERMISSION_LABEL["full-access"], PERMISSION_ICON["full-access"]]
  ], agentPermission, (permission) => {
    agentPermission = permission as AgentPermission;
    submitAgentSelection({ permission: agentPermission });
  }, ["full-access"]);
  renderComposerMenu(elements.agentMenu, state.agentProfiles.map((item) => [item.id, item.label, "codicon-account"]), selected?.id ?? "", (profileId) => {
    submitAgentSelection({ profileId, model: "", reasoningEffort: "", speed: "", serviceTier: "" });
  });
  renderModelMenu(state, options, selectedModel);
  updateRunState();
}

function renderComposerMenu(
  menu: HTMLElement,
  items: readonly (readonly [string, string, string])[],
  selected: string,
  onSelect: (value: string) => void,
  warningValues: readonly string[] = [],
  itemClasses: Readonly<Record<string, string>> = {}
): void {
  menu.replaceChildren();
  for (const [value, label, icon] of items) {
    const button = document.createElement("button");
    button.type = "button";
    const itemClass = itemClasses[value];
    button.className = `composer-menu-option${warningValues.includes(value) ? " composer-menu-option-warning" : ""}${itemClass ? ` ${itemClass}` : ""}`;
    button.tabIndex = -1;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(value === selected));
    const glyph = document.createElement("i");
    glyph.className = `codicon ${icon}`;
    const text = document.createElement("span");
    text.textContent = label;
    const check = document.createElement("i");
    check.className = `codicon codicon-${value === selected ? "check" : "blank"}`;
    button.append(glyph, text, check);
    button.addEventListener("click", () => onSelect(value));
    menu.append(button);
  }
}

function renderModelMenu(
  state: SidebarState,
  options: readonly { id: string; label: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string }[],
  selectedModel: { id: string; label: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string } | undefined
): void {
  const current = state.agentSelection;
  const categories: { title: string; value: string; items: readonly (readonly [string, string])[]; selected: string; onSelect: (value: string) => void }[] = [
    {
      title: "Model",
      value: selectedModel?.label ?? "Default",
      items: options.map((item) => [item.id, item.label]),
      selected: current.model ?? "",
      onSelect: (model) => {
        const next = options.find((item) => item.id === model);
        submitAgentSelection({ model, reasoningEffort: next?.defaultReasoningEffort ?? "", speed: "", serviceTier: "" });
      }
    },
    {
      title: "Reasoning",
      value: displayOptionValue(current.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "Default"),
      items: (selectedModel?.reasoningEfforts ?? []).map((item) => [item, displayOptionValue(item)]),
      selected: current.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "",
      onSelect: (reasoningEffort) => submitAgentSelection({ reasoningEffort })
    },
    {
      title: "Speed",
      value: displayOptionValue(current.speed ?? "Default"),
      items: (selectedModel?.speedTiers ?? []).map((item) => [item, displayOptionValue(item)]),
      selected: current.speed ?? "",
      onSelect: (speed) => submitAgentSelection({ speed })
    },
    {
      title: "Advanced",
      value: displayOptionValue(current.serviceTier ?? "Default"),
      items: (selectedModel?.serviceTiers ?? []).map((item) => [item, displayOptionValue(item)]),
      selected: current.serviceTier ?? "",
      onSelect: (serviceTier) => submitAgentSelection({ serviceTier })
    }
  ];
  elements.modelMenu.replaceChildren();
  elements.modelMenu.dataset.modelMenuView = "categories";
  elements.modelSubmenu.replaceChildren();
  elements.modelSubmenu.hidden = true;
  for (const category of categories) {
    if (!category.items.length) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option composer-menu-category";
    button.tabIndex = -1;
    const title = document.createElement("span");
    title.textContent = category.title;
    const value = document.createElement("span");
    value.className = "composer-menu-category-value";
    value.textContent = category.value;
    const chevron = document.createElement("i");
    chevron.className = "codicon codicon-chevron-right";
    button.append(title, value, chevron);
    const openChoices = (event: Event): void => {
      event.stopPropagation();
      renderModelChoices(elements.modelSubmenu, category.title, category.items, category.selected, category.onSelect);
    };
    button.addEventListener("click", openChoices);
    elements.modelMenu.append(button);
  }
}

function renderModelChoices(
  menu: HTMLElement,
  title: string,
  items: readonly (readonly [string, string])[],
  selected: string,
  onSelect: (value: string) => void
): void {
  menu.replaceChildren();
  menu.dataset.modelMenuView = "choices";
  menu.hidden = false;
  positionModelSubmenu();
  const heading = document.createElement("div");
  heading.className = "composer-menu-submenu-heading";
  heading.textContent = title;
  menu.append(heading);
  for (const [value, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(value === selected));
    const text = document.createElement("span");
    text.textContent = label;
    const check = document.createElement("i");
    check.className = `codicon codicon-${value === selected ? "check" : "blank"}`;
    button.append(text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onSelect(value);
    });
    menu.append(button);
  }
}

function positionModelSubmenu(): void {
  if (elements.modelSubmenu.hidden) return;
  const modelMenu = elements.modelMenu.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const submenuWidth = Math.min(216, Math.max(0, viewportWidth - 24));
  const gap = 4;
  const edgePadding = 8;
  const rightSpace = viewportWidth - modelMenu.right - gap - edgePadding;
  const leftSpace = modelMenu.left - gap - edgePadding;
  const fitsRight = rightSpace >= submenuWidth;
  const fitsLeft = leftSpace >= submenuWidth;
  const side = fitsRight || (!fitsLeft && rightSpace >= leftSpace) ? "right" : "left";
  elements.modelSubmenu.dataset.submenuSide = side;
}

window.addEventListener("resize", positionModelSubmenu);

function submitAgentSelection(change: Partial<SidebarState["agentSelection"]>): void {
  const selection = sidebarState?.agentSelection;
  closeComposerMenus();
  vscode.postMessage({
    type: "agentSelection", selection: {
      mode: inputMode,
      permission: change.permission ?? agentPermission,
      profileId: change.profileId ?? selection?.profileId ?? "",
      model: change.model ?? selection?.model ?? "",
      reasoningEffort: change.reasoningEffort ?? selection?.reasoningEffort ?? "",
      speed: change.speed ?? selection?.speed ?? "",
      serviceTier: change.serviceTier ?? selection?.serviceTier ?? ""
    }
  });
}

function selectConversation(sessionId: string): void {
  if (sessionId === activeConversationId) return;
  const switchId = ++conversationSwitchId;
  // Commit the tab highlight and remove the prior tab's view in the same
  // event.  The replacement is restored from cache or received from the host
  // afterwards, so a slow response never leaves stale conversation content
  // below an already-selected tab.
  persistComposerDraft();
  activeConversationId = sessionId;
  scheduleComposerDraftRestore(sessionId, switchId);
  for (const tab of elements.conversationTabs.querySelectorAll<HTMLElement>(".conversation-tab")) {
    const active = tab.dataset.sessionId === sessionId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  executing = false;
  stopping = false;
  activeTurnId = undefined;
  activeExecutionSessionId = undefined;
  updateRunState();
  clearVisibleConversation();
  const cached = conversationViewCache.get(sessionId);
  if (cached) renderOutputSessionRef(sessionId, cached.signature, switchId);
  vscode.postMessage({ type: "selectConversation", sessionId, switchId });
}

function closeConversation(sessionId: string): void {
  if (runningConversationIds.has(sessionId)) return;
  const draft = conversationDrafts.get(sessionId);
  if (draft?.source.trim() || draft?.attachments.length) {
    const title = [...elements.conversationTabs.querySelectorAll<HTMLElement>(".conversation-tab")]
      .find((tab) => tab.dataset.sessionId === sessionId)?.title ?? "this conversation";
    openConfirmationDialog(`Discard the unsent draft in “${title}” and close it?`, () => {
      conversationDrafts.delete(sessionId);
      vscode.postMessage({ type: "closeConversation", sessionId });
    });
    return;
  }
  vscode.postMessage({ type: "closeConversation", sessionId });
}

function pinConversation(sessionId: string, pinned: boolean): void {
  vscode.postMessage({ type: "pinConversation", sessionId, pinned });
}

// Match editor tab strips: double-clicking unused space creates a fresh tab,
// while double-clicking an existing tab keeps the browser's normal behaviour.
elements.conversationTabs.addEventListener("dblclick", (event) => {
  if (event.target instanceof Element && event.target.closest(".conversation-tab")) return;
  vscode.postMessage({ type: "newConversation" });
});

function renderConversations(sessions: readonly ConversationSummary[], activeId: string): void {
  const activeChanged = activeConversationId !== activeId;
  if (activeChanged) persistComposerDraft();
  activeConversationId = activeId;
  if (activeChanged) scheduleComposerDraftRestore(activeId);
  runningConversationIds.clear();
  for (const conversation of sessions) {
    if (conversation.running) runningConversationIds.add(conversation.id);
  }
  // The next scoped `executing` message installs the selected conversation's
  // turn id. Clear the previous one even when both tabs happen to be running,
  // otherwise Stop can briefly target the conversation we just left.
  if (activeChanged || !runningConversationIds.has(activeId)) {
    executing = false;
    stopping = false;
    activeTurnId = undefined;
    activeExecutionSessionId = undefined;
    updateRunState();
  }
  elements.conversationTabs.replaceChildren();
  elements.conversationTabs.hidden = sessions.length === 0;
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
      closeConversation(conversation.id);
    });
    tab.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      // Keep a fallback for environments that do not deliver mousedown for
      // auxiliary buttons, while avoiding a duplicate close request.
      if (!middleButtonDown) closeConversation(conversation.id);
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
    // selectConversation is idempotent for the already-active tab.
    label.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      selectConversation(conversation.id);
    });
    label.addEventListener("click", () => {
      selectConversation(conversation.id);
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
      if (conversation.pinned) pinConversation(conversation.id, false);
      else closeConversation(conversation.id);
    });
    tab.append(label, activity, action);
    if (active) activeTab = tab;
    elements.conversationTabs.append(tab);
  }
  activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const composerMenus = [
  { control: elements.modeControl, menu: elements.modeMenu },
  { control: elements.permissionControl, menu: elements.permissionMenu },
  { control: elements.agentControl, menu: elements.agentMenu },
  { control: elements.modelControl, menu: elements.modelMenu }
];

for (const item of composerMenus) {
  item.menu.addEventListener("keydown", (event) => handleComposerMenuKeydown(item.menu, event));
}
elements.modelSubmenu.addEventListener("keydown", (event) => handleComposerMenuKeydown(elements.modelSubmenu, event));

function closeComposerMenus(except?: HTMLElement): void {
  for (const item of composerMenus) {
    const open = item.menu === except;
    item.menu.hidden = !open;
    item.control.setAttribute("aria-expanded", String(open));
  }
  if (except !== elements.modelMenu) elements.modelSubmenu.hidden = true;
}

function closeComposerExtras(): void {
  elements.composerMore.setAttribute("aria-expanded", "false");
  elements.composerMore.closest(".composer-controls")?.classList.remove("show-extra");
}

function composerMenuItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")];
}

function focusComposerMenuItem(menu: HTMLElement, index: number): void {
  const items = composerMenuItems(menu);
  if (!items.length) return;
  const target = items[Math.max(0, Math.min(index, items.length - 1))]!;
  items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
  target.focus();
}

function focusComposerTrigger(menu: HTMLElement): void {
  const item = composerMenus.find((entry) => entry.menu === menu);
  (item?.control ?? elements.modelControl).focus();
}

function handleComposerMenuKeydown(menu: HTMLElement, event: KeyboardEvent): void {
  const items = composerMenuItems(menu);
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeComposerMenus();
    focusComposerTrigger(menu === elements.modelSubmenu ? elements.modelMenu : menu);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (current < 0 ? 0 : (current + direction + items.length) % items.length);
    focusComposerMenuItem(menu, next);
    return;
  }
  if (menu === elements.modelMenu && event.key === "ArrowRight" && current >= 0) {
    event.preventDefault();
    items[current]!.click();
    queueMicrotask(() => focusComposerMenuItem(elements.modelSubmenu, 0));
  } else if (menu === elements.modelSubmenu && event.key === "ArrowLeft") {
    event.preventDefault();
    elements.modelSubmenu.hidden = true;
    elements.modelSubmenu.replaceChildren();
    elements.modelMenu.hidden = false;
    focusComposerMenuItem(elements.modelMenu, 0);
  }
}

function toggleComposerMenu(menu: HTMLElement): void {
  closeComposerMenus(menu.hidden ? menu : undefined);
  if (!menu.hidden) {
    queueMicrotask(() => {
      const items = composerMenuItems(menu);
      const selected = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
      focusComposerMenuItem(menu, selected >= 0 ? selected : 0);
    });
  }
}

function resultHeading(response: RuntimeResponse): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "result-meta execution-heading";
  heading.textContent = `${response.method.id} | ${formatDuration(response.durationMs)}`;
  let copyText: string;
  try {
    copyText = JSON.stringify(response.result, null, 2);
  } catch {
    copyText = "Unable to serialize execution output.";
  }
  heading.append(copyButton(copyText));
  return heading;
}

function copyButton(text: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button compact output-copy";
  button.title = "Copy output";
  button.setAttribute("aria-label", "Copy output");
  const icon = document.createElement("i");
  icon.className = "codicon codicon-copy";
  button.append(icon);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void clipboard.write(text).then((success) => {
      if (!success) return;
      icon.className = "codicon codicon-check";
      window.setTimeout(() => { icon.className = "codicon codicon-copy"; }, 900);
    });
  });
  return button;
}

function copyableContent(content: string, className = ""): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "output-copyable";
  const pre = document.createElement("pre");
  if (className) pre.className = className;
  const code = document.createElement("code");
  code.textContent = content;
  pre.append(code);
  wrapper.append(pre, copyButton(content));
  return wrapper;
}

function codeBlock(content: string): HTMLElement {
  return copyableContent(content);
}

function jsonOutput(content: string): HTMLElement {
  const formatted = formatJsonOutput(content);
  if (!formatted) return copyableText(content);
  const wrapper = document.createElement("div");
  wrapper.className = "output-text-copyable json-output";
  const body = document.createElement("div");
  body.className = "markdown-body";
  // Keep one shared Markdown rendering path for every output. The fence is
  // needed to preserve JSON whitespace while still letting Markdown own the
  // surrounding layout and code-block styling.
  body.innerHTML = markdown.render("```json\n" + formatted + "\n```");
  wrapper.append(body, copyButton(formatted));
  return wrapper;
}

function uiResultText(result: Extract<DextResult, { kind: "ui" }>): string {
  if (result.type === "choice") {
    const selected = result.selected.length ? result.selected.join(", ") : "No selection";
    return result.custom ? `${selected} (custom: ${result.custom})` : selected;
  }
  if (result.type === "confirm") return result.confirmed ? "Confirmed" : "Cancelled";
  return result.value ?? "No input";
}

const ANSI_COLOR_CLASSES = [
  "ansi-black", "ansi-red", "ansi-green", "ansi-yellow",
  "ansi-blue", "ansi-magenta", "ansi-cyan", "ansi-white",
  "ansi-bright-black", "ansi-bright-red", "ansi-bright-green", "ansi-bright-yellow",
  "ansi-bright-blue", "ansi-bright-magenta", "ansi-bright-cyan", "ansi-bright-white"
];

const ANSI_COLORS = new Map<number, string>([
  [30, "ansi-black"], [31, "ansi-red"], [32, "ansi-green"], [33, "ansi-yellow"],
  [34, "ansi-blue"], [35, "ansi-magenta"], [36, "ansi-cyan"], [37, "ansi-white"],
  [90, "ansi-bright-black"], [91, "ansi-bright-red"], [92, "ansi-bright-green"], [93, "ansi-bright-yellow"],
  [94, "ansi-bright-blue"], [95, "ansi-bright-magenta"], [96, "ansi-bright-cyan"], [97, "ansi-bright-white"]
]);

const ANSI_PALETTE = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"
];

function ansi256Color(value: number): string {
  if (value < 16) return ANSI_PALETTE[value] ?? ANSI_PALETTE[7]!;
  if (value >= 232) {
    const gray = 8 + (value - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  const index = value - 16;
  const red = Math.floor(index / 36);
  const green = Math.floor((index % 36) / 6);
  const blue = index % 6;
  const channel = (component: number): number => component === 0 ? 0 : 55 + component * 40;
  return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
}

function normalizeTerminalText(content: string): string {
  // Progress tools redraw a line with a bare carriage return. Resolve that
  // redraw before putting the text into a webview <pre>, which cannot emulate
  // a terminal cursor.
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/**
 * A number of CLIs (notably when launched through a JSON/non-TTY adapter)
 * deliberately omit ANSI SGR codes. Keep the output readable in that case by
 * highlighting the small, tool-agnostic vocabulary used by test runners and
 * shell prompts. This is only a fallback; real ANSI styling always wins.
 */
function plainTerminalClass(line: string): string | undefined {
  if (/^\s*(?:[>$]|PS [^>]*>)\s+/.test(line)) return "ansi-cyan";
  if (/\b(?:fail(?:ed|ure)?|errors?|fatal)\b|[✗×]/i.test(line)) return "ansi-red";
  if (/\b(?:pass(?:ed)?|success(?:ful)?|succeed(?:ed)?|ok)\b|✓/i.test(line)) return "ansi-green";
  if (/^\s*(?:RUN|Test Files|Tests|Snapshots|Start|Duration)\b/.test(line)) return "ansi-bright-blue";
  return undefined;
}

function terminalText(content: string): DocumentFragment {
  content = normalizeTerminalText(content);
  const fragment = document.createDocumentFragment();
  const active = new Set<string>();
  let foreground: string | undefined;
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const ansi = new RegExp(
    `${escape}(?:\\[([0-9;]*)m|\\[[0-?]*[ -/]*[@-~]|\\][^${bell}]*(?:${bell}|${escape}\\\\))`,
    "g"
  );
  let cursor = 0;
  const hasAnsi = content.includes(escape);

  const appendText = (value: string): void => {
    if (!value) return;
    if (active.size === 0 && !foreground) {
      if (hasAnsi) {
        fragment.append(document.createTextNode(value));
        return;
      }
      const lines = value.split("\n");
      lines.forEach((line, index) => {
        const className = plainTerminalClass(line);
        if (className) {
          const span = document.createElement("span");
          span.className = className;
          span.textContent = line;
          fragment.append(span);
        } else {
          fragment.append(document.createTextNode(line));
        }
        if (index < lines.length - 1) fragment.append(document.createTextNode("\n"));
      });
      return;
    }
    const span = document.createElement("span");
    span.className = [...active].join(" ");
    if (foreground) span.style.color = foreground;
    span.textContent = value;
    fragment.append(span);
  };

  for (const match of content.matchAll(ansi)) {
    appendText(content.slice(cursor, match.index));
    const codes = match[1] === undefined ? [] : (match[1] ? match[1].split(";").map(Number) : [0]);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? 0;
      if (code === 0) {
        active.clear();
        foreground = undefined;
      } else if (code === 1) {
        active.add("ansi-bold");
      } else if (code === 2) {
        active.add("ansi-dim");
      } else if (code === 3) {
        active.add("ansi-italic");
      } else if (code === 4) {
        active.add("ansi-underline");
      } else if (code === 22) {
        active.delete("ansi-bold");
        active.delete("ansi-dim");
      } else if (code === 23) {
        active.delete("ansi-italic");
      } else if (code === 24) {
        active.delete("ansi-underline");
      } else if (code === 39) {
        for (const color of ANSI_COLOR_CLASSES) active.delete(color);
        foreground = undefined;
      } else if (code === 49) {
        // Background colors are intentionally ignored to keep output readable.
      } else {
        const color = ANSI_COLORS.get(code);
        if (color) {
          for (const existing of ANSI_COLOR_CLASSES) active.delete(existing);
          active.add(color);
          foreground = undefined;
          continue;
        }
        if (code >= 40 && code <= 47 || code >= 100 && code <= 107 || code === 7 || code === 27) {
          // Do not reproduce terminal reverse/background blocks in the webview.
          continue;
        }
        if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
          const value = ansi256Color(codes[index + 2]!);
          if (code === 38) foreground = value;
          // 48;5/48;2 background colors are deliberately ignored.
          index += 2;
          continue;
        }
        if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes[index + 4] !== undefined) {
          const [red, green, blue] = codes.slice(index + 2, index + 5);
          const value = `rgb(${red}, ${green}, ${blue})`;
          if (code === 38) foreground = value;
          // 48;2 background colors are deliberately ignored.
          index += 4;
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  appendText(content.slice(cursor));
  return fragment;
}

function terminalBlock(content: string, className = "terminal-output"): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "output-copyable";
  const pre = document.createElement("pre");
  pre.className = className;
  const code = document.createElement("code");
  code.append(terminalText(content));
  pre.append(code);
  wrapper.append(pre, copyButton(content));
  return wrapper;
}

function copyableText(content: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "output-text-copyable";
  const body = document.createElement("div");
  body.className = "markdown-body";
  body.innerHTML = markdown.render(content);
  wrapper.append(body, copyButton(content));
  return wrapper;
}

function disclosureSummary(label: string, detail: string): HTMLElement {
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const title = document.createElement("span");
  title.textContent = label;
  const meta = document.createElement("span");
  meta.className = "disclosure-meta";
  meta.textContent = detail;
  summary.append(chevron, title, meta);
  return summary;
}

function outputTurnSection(label: string, open: boolean): { disclosure: HTMLDetailsElement; body: HTMLElement } {
  const disclosure = document.createElement("details");
  disclosure.className = "output-turn-section execution-disclosure";
  disclosure.open = open;
  disclosure.append(disclosureSummary(label, ""));
  const body = document.createElement("div");
  body.className = "output-turn-section-body execution-disclosure-body";
  disclosure.append(body);
  return { disclosure, body };
}

function referenceIcon(kind: "file" | "dir" | "symbol" | "selection" | "activeFile"): string {
  if (kind === "dir") return "folder";
  if (kind === "symbol") return "symbol-method";
  return "file";
}

/** Renders readable @path tokens as the same chips used by the editor.
 * The source remains unchanged for copy and history replay. */
function renderedInputSource(source: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "dext-source";
  const parts = inputReferenceDisplayParts(source);
  const references = parts.filter((part): part is Extract<typeof part, { kind: "ref" }> => part.kind === "ref");
  if (!references.length) {
    pre.append(highlightDextFragment(source));
    return pre;
  }

  // Highlight the complete source with valid identifiers in place of @path
  // tokens, then swap those identifiers for their interactive Chips. This
  // keeps strings and multiline calls in one parse tree instead of attempting
  // to highlight incomplete fragments around each reference.
  const placeholders = references.map((_, index) => {
    let value = `__dext_reference_${index}__`;
    while (source.includes(value)) value = `_${value}_`;
    return value;
  });
  const highlightedSource = parts.map((part) => part.kind === "ref"
    ? placeholders[references.indexOf(part)]!
    : part.value
  ).join("");
  const highlighted = highlightDextFragment(highlightedSource);
  const walker = document.createTreeWalker(highlighted, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? "";
    const marker = new RegExp(`(${placeholders.map(escapeRegExp).join("|")})`, "g");
    if (!marker.test(value)) continue;
    marker.lastIndex = 0;
    const replacement = document.createDocumentFragment();
    let cursor = 0;
    for (const match of value.matchAll(marker)) {
      const index = match.index ?? 0;
      if (index > cursor) replacement.append(document.createTextNode(value.slice(cursor, index)));
      const referenceIndex = placeholders.indexOf(match[0]);
      if (referenceIndex >= 0) replacement.append(inputReferenceChipElement(references[referenceIndex]!.reference));
      cursor = index + match[0].length;
    }
    if (cursor < value.length) replacement.append(document.createTextNode(value.slice(cursor)));
    textNode.replaceWith(replacement);
  }
  pre.append(highlighted);
  return pre;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightDextFragment(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  const ranges = dextHighlightRanges(source);
  highlightCode(
    source,
    pythonParser.parse(source),
    classHighlighter,
    (text, classes) => {
      if (!text) return;
      const highlighted = dextHighlightClass(classes, offset, text, ranges);
      if (!highlighted) {
        fragment.append(document.createTextNode(text));
        offset += text.length;
        return;
      }
      const span = document.createElement("span");
      span.className = highlighted;
      span.textContent = text;
      fragment.append(span);
      offset += text.length;
    },
    () => { fragment.append(document.createTextNode("\n")); offset += 1; }
  );
  return fragment;
}

function inputReferenceChipElement(reference: ContextReferenceOccurrence): HTMLElement {
  const descriptor = fileReferenceChipDescriptor(
    compactFileReferenceLabel(reference.payload),
    reference.payload
  );
  return createFileReferenceChip({
    document,
    ...descriptor,
    modifierClass: "output-file-reference",
    icon: referenceIcon(reference.kind),
    ...(reference.kind === "file"
      ? { onOpen: () => openInputReference(reference) }
      : {})
  });
}

/** Turn actions live in the summary, which is a click target of its own, so
 * every one of them has to stop the click from folding the turn. */
function turnActionButton(icon: string, label: string, onActivate: () => void, disableWhileRunning = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "output-turn-action icon-button compact";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disableWhileRunning && executing;
  if (disableWhileRunning) button.dataset.disableWhileRunning = "true";
  const glyph = document.createElement("i");
  glyph.className = `codicon codicon-${icon}`;
  button.append(glyph);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  return button;
}

function turnCopyButton(text: () => string): HTMLButtonElement {
  const button = turnActionButton("copy", "Copy turn", () => {
    void clipboard.write(text()).then((success) => {
      if (!success) return;
      const icon = button.querySelector<HTMLElement>("i");
      if (!icon) return;
      icon.className = "codicon codicon-check";
      window.setTimeout(() => { icon.className = "codicon codicon-copy"; }, 900);
    });
  });
  return button;
}

function syncTurnActions(): void {
  for (const button of elements.result.querySelectorAll<HTMLButtonElement>(".output-turn-action[data-disable-while-running], .plan-action.primary")) {
    const turn = button.closest<HTMLElement>(".output-turn");
    button.disabled = executing && (!turn || turn.dataset.turnId === activeTurnId);
  }
}

function createOutputTurn(
  turnId: string,
  source: string,
  createdAt = Date.now(),
  options: { executePlan?: boolean; planPath?: string; lazy?: boolean; open?: boolean } = {}
): OutputTurnElements {
  source = normalizeInputReferenceSource(source);
  const lazy = options.lazy === true;
  for (const turn of outputTurns.values()) turn.disclosure.open = false;
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
  title.textContent = options.executePlan && options.planPath
    ? `Plan: ${options.planPath.split("/").pop() ?? options.planPath}`
    : inputReferenceDisplayText(source).split(/\r?\n/, 1)[0]?.slice(0, 140) || "Dext turn";
  const body = document.createElement("div");
  body.className = "output-turn-body";
  const actions = document.createElement("span");
  actions.className = "output-turn-actions";
  actions.append(
    turnActionButton("edit", "Edit and resend", () => {
      editor.setValue(source);
      setSectionOpen(elements.inputHeading, elements.inputBody, true);
    }),
    turnActionButton("debug-restart", "Retry this turn", () => {
      openConfirmationDialog(
        "Retry this turn? Any write actions may run again.",
        () => vscode.postMessage({ type: "retryTurn", turnId })
      );
    }, true),
    turnActionButton("repo-forked", "Fork from this turn", () => {
      vscode.postMessage({ type: "forkFromTurn", turnId });
    }, true),
    turnCopyButton(() => {
      // Copying a collapsed history row is an explicit request for its full
      // content, so hydrate it before collecting the text.
      // Hydration resets the global agent trace and active turn. Never do
      // that to a different row while another turn is streaming; its later
      // events would otherwise be appended to this historical row.
      if (!executing || activeTurn === turn) turn.hydrate?.();
      return disclosure.textContent?.trim() ?? "";
    }),
    turnActionButton("trash", "Delete turn", () => {
      openConfirmationDialog(
        "Delete this turn from the conversation?",
        () => vscode.postMessage({ type: "deleteTurn", turnId })
      );
    }, true)
  );
  // Keep the turn title as the primary row label, matching the history view;
  // metadata belongs at the trailing edge of the row rather than before it.
  summary.append(chevron, title, time, actions);
  let inputBody: HTMLElement | undefined;
  if (!options.executePlan) {
    // Keep the shared disclosure construction recognizable; lazy history
    // turns close it immediately after creating the lightweight shell.
    const input = outputTurnSection("Input", true);
    input.disclosure.open = !lazy;
    inputBody = input.body;
    if (!lazy) {
      const inputText = renderedInputSource(source);
      const inputCopy = document.createElement("div");
      inputCopy.className = "output-turn-input";
      inputCopy.append(inputText, copyButton(source));
      input.body.append(inputCopy);
    }
    body.append(input.disclosure);
  }
  const process = outputTurnSection("Process", !lazy);
  const output = outputTurnSection("Output", !lazy);
  body.append(process.disclosure, output.disclosure);
  disclosure.append(summary, body);
  elements.result.append(disclosure);
  const turn: OutputTurnElements = {
    disclosure,
    ...(inputBody ? { input: inputBody } : {}),
    process: process.body,
    processDisclosure: process.disclosure,
    output: output.body,
    outputDisclosure: output.disclosure,
    hydrated: !lazy
  };
  outputTurns.set(turnId, turn);
  activeTurn = turn;
  syncResultToggle();
  return turn;
}

function selectOutputTurn(turnId: string): OutputTurnElements | undefined {
  activeTurn = outputTurns.get(turnId);
  return activeTurn;
}

type DiffMode = "inline" | "split";

let defaultDiffMode: DiffMode = "inline";

function setDiffMode(container: HTMLElement, mode: DiffMode): void {
  const view = container.querySelector<HTMLElement>(".diff-view");
  if (view) view.dataset.diffView = mode;
  container.querySelectorAll<HTMLButtonElement>(".diff-mode-button").forEach((button) => {
    const active = button.dataset.diffMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function diffModeSwitch(container: HTMLElement): HTMLElement {
  const control = document.createElement("span");
  control.className = "diff-mode-switch";
  control.setAttribute("role", "group");
  control.setAttribute("aria-label", "Diff layout");
  for (const [mode, label] of [["inline", "Inline"], ["split", "Split"]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `diff-mode-button${mode === defaultDiffMode ? " active" : ""}`;
    button.dataset.diffMode = mode;
    button.title = `${label} diff`;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(mode === defaultDiffMode));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setDiffMode(container, mode);
    });
    control.append(button);
  }
  return control;
}

function diffSide(line: ReturnType<typeof presentDiff>["rows"][number]["before"], marker: string): HTMLElement {
  const side = document.createElement("span");
  side.className = `diff-side ${line?.kind ?? "empty"}`;
  const lineNumber = document.createElement("span");
  lineNumber.className = "diff-line-number";
  lineNumber.textContent = line ? String(line.line) : "";
  const sign = document.createElement("span");
  sign.className = "diff-marker";
  sign.textContent = line ? marker : "";
  const code = document.createElement("span");
  code.className = "diff-code";
  code.textContent = line?.text ?? "";
  side.append(lineNumber, sign, code);
  return side;
}

function appendDiffView(container: HTMLElement, change: PatchChange): void {
  const presentation = presentDiff(change);
  const view = document.createElement("div");
  view.className = "diff-view";
  view.dataset.diffView = "inline";
  const inline = document.createElement("div");
  inline.className = "diff-inline";
  const split = document.createElement("div");
  split.className = "diff-split";
  for (const row of presentation.rows) {
    if (row.before?.kind === "context") inline.append(diffSide(row.before, " "));
    else {
      if (row.before) inline.append(diffSide(row.before, "-"));
      if (row.after) inline.append(diffSide(row.after, "+"));
    }
    const splitRow = document.createElement("span");
    splitRow.className = "diff-split-row";
    splitRow.append(
      diffSide(row.before, row.before?.kind === "removed" ? "-" : " "),
      diffSide(row.after, row.after?.kind === "added" ? "+" : " ")
    );
    split.append(splitRow);
  }
  view.dataset.diffView = defaultDiffMode;
  view.append(inline, split);
  container.append(view);
}

function fileChangeDisclosure(
  change: PatchChange,
  className = "agent-file-change",
  reviewTurnId?: string
): HTMLDetailsElement {
  const disclosure = document.createElement("details");
  disclosure.className = className;
  disclosure.dataset.diffContainer = "";
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const name = change.uri.replaceAll("\\", "/").split("/").pop() ?? change.uri;
  const counts = presentDiff(change);
  const label = document.createElement("span");
  label.textContent = name;
  const count = document.createElement("span");
  count.className = "diff-count";
  count.innerHTML = `<span class="diff-added">+${counts.added}</span> <span class="diff-removed">-${counts.removed}</span>`;
  const path = document.createElement("div");
  path.className = "agent-file-path";
  path.textContent = change.uri;
  summary.append(chevron, label, count, diffModeSwitch(disclosure));
  if (reviewTurnId) {
    disclosure.dataset.reviewUri = change.uri;
    summary.append(patchReviewActions(reviewTurnId, [change.uri]));
  }
  disclosure.append(summary, path);
  appendDiffView(disclosure, change);
  return disclosure;
}

/** Nothing has been written yet at this point, so the buttons are the only way
 * the change reaches the workspace. */
function patchReviewActions(turnId: string, uris: readonly string[], suffix = ""): HTMLElement {
  const row = document.createElement("span");
  row.className = "patch-review-actions";
  const button = (
    icon: string,
    label: string,
    accept: boolean,
    variant: string
  ): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `patch-review-action ${variant}`;
    element.title = label;
    element.setAttribute("aria-label", label);
    const glyph = document.createElement("i");
    glyph.className = `codicon codicon-${icon}`;
    const text = document.createElement("span");
    text.textContent = label;
    element.append(glyph, text);
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      for (const sibling of row.querySelectorAll("button")) sibling.disabled = true;
      vscode.postMessage({ type: "resolvePatch", turnId, uris: [...uris], accept });
    });
    return element;
  };
  row.append(
    button("check", `Accept${suffix}`, true, "accept"),
    button("close", `Reject${suffix}`, false, "reject")
  );
  return row;
}

/** A resolved file stops being a proposal, so its entry either reports what
 * happened or steps aside. A conflict stays reviewable on purpose. */
function applyPatchResolution(
  turnId: string,
  uris: readonly string[],
  status: "applied" | "rejected" | "conflict" | "unchanged",
  message: string
): void {
  for (const uri of uris) {
    for (const entry of elements.result.querySelectorAll<HTMLDetailsElement>("details[data-review-uri]")) {
      if (entry.dataset.reviewUri !== uri) continue;
      const actions = entry.querySelector<HTMLElement>(".patch-review-actions");
      if (status === "conflict") {
        for (const button of actions?.querySelectorAll("button") ?? []) button.disabled = false;
        entry.classList.add("patch-conflict");
        continue;
      }
      entry.open = false;
      delete entry.dataset.reviewUri;
      entry.classList.remove("patch-conflict");
      entry.classList.add(status === "rejected" ? "patch-rejected" : "patch-applied");
      actions?.replaceWith(patchReviewOutcome(status));
    }
  }
  const all = elements.result.querySelector<HTMLElement>(`[data-review-all="${turnId}"]`);
  if (all) {
    if (elements.result.querySelector("details[data-review-uri]")) {
      for (const button of all.querySelectorAll("button")) button.disabled = false;
    } else {
      all.remove();
    }
  }
  if (status === "conflict") appendPatchNotice(message);
}

/** A conflict is reported beside the changes rather than through the error
 * renderer, which clears the turn it is called on. */
function appendPatchNotice(message: string): void {
  const target = activeTurn?.output ?? elements.result;
  const existing = target.querySelector(".patch-review-notice");
  if (existing) existing.remove();
  const notice = document.createElement("div");
  notice.className = "patch-review-notice";
  notice.textContent = message;
  target.append(notice);
}

function patchReviewOutcome(status: "applied" | "rejected" | "unchanged"): HTMLElement {
  const outcome = document.createElement("span");
  outcome.className = `patch-review-outcome ${status}`;
  const glyph = document.createElement("i");
  glyph.className = `codicon codicon-${status === "rejected" ? "circle-slash" : "check-all"}`;
  const label = document.createElement("span");
  label.textContent = status === "rejected" ? "Rejected" : status === "unchanged" ? "No change" : "Accepted";
  outcome.append(glyph, label);
  return outcome;
}

function appendAgentPresentationExtras(container: HTMLElement, presentation: AgentMessagePresentation): void {
  for (const detail of presentation.details) {
    const element = document.createElement("div");
    element.className = `agent-result-detail ${detail.tone}`;
    if (detail.meta) {
      const meta = document.createElement("span");
      meta.className = "agent-result-detail-meta";
      meta.textContent = detail.meta;
      element.append(meta);
    }
    element.append(document.createTextNode(detail.text));
    container.append(element);
  }
  for (const change of presentation.changes) {
    container.append(fileChangeDisclosure(change, "agent-file-change agent-result-change"));
  }
  for (const reference of presentation.references) {
    const disclosure = document.createElement("details");
    disclosure.className = "agent-result-reference";
    const name = reference.uri.replaceAll("\\", "/").split("/").pop() ?? reference.uri;
    const meta = [reference.location, reference.symbol].filter(Boolean).join(" · ");
    disclosure.append(disclosureSummary(name, meta));
    const path = document.createElement("div");
    path.className = "agent-file-path";
    path.textContent = reference.uri;
    disclosure.append(path);
    if (reference.content) disclosure.append(codeBlock(reference.content));
    container.append(disclosure);
  }
  for (const section of presentation.sections) {
    const disclosure = document.createElement("details");
    disclosure.className = `agent-result-section ${section.tone}`;
    disclosure.append(disclosureSummary(section.title, ""));
    const body = document.createElement("div");
    body.className = "agent-result-section-body";
    body.append(section.code ? codeBlock(section.text) : copyableText(section.text));
    disclosure.append(body);
    container.append(disclosure);
  }
}

/** A plan result links back to its saved document for review or editing. */
function planActions(planPath: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "plan-actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "plan-action";
  const openGlyph = document.createElement("i");
  openGlyph.className = "codicon codicon-checklist";
  const openLabel = document.createElement("span");
  openLabel.textContent = `Plan: ${planPath.split("/").pop() ?? planPath}`;
  open.title = `Open ${planPath}`;
  open.append(openGlyph, openLabel);
  open.addEventListener("click", () => {
    vscode.postMessage({ type: "openFileReference", reference: planPath });
  });
  row.append(open);
  return row;
}

function renderExecution(response: RuntimeResponse, reviewTurnId?: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(resultHeading(response));
  const result = response.result;
  if (result.kind === "chat" || result.kind === "text") {
    fragment.append(copyableText(result.text));
    if (result.kind === "chat" && result.planPath) fragment.append(planActions(result.planPath));
  } else if (result.kind === "explain") {
    fragment.append(copyableText(result.text));
  } else if (result.kind === "edit" || result.kind === "agent") {
    const summary = result.kind === "agent" ? result.text : result.summary;
    if (summary) fragment.append(copyableText(summary));
    const changes = result.kind === "agent" ? result.patch?.changes ?? [] : result.patch.changes;
    for (const change of changes) {
      fragment.append(fileChangeDisclosure(change, "agent-file-change execution-file-change", reviewTurnId));
    }
  } else if (result.kind === "apply") {
    fragment.append(copyableText(`${result.status}: ${result.summary}`));
  } else if (result.kind === "print") {
    if (result.label) {
      const label = document.createElement("div");
      label.className = "output-title";
      label.textContent = result.label;
      fragment.append(label);
    }
    // Structured print values are formatted and highlighted as JSON; non-JSON
    // text continues through the normal Markdown renderer.
    fragment.append(jsonOutput(result.text));
  } else if (result.kind === "terminal") {
    const disclosure = document.createElement("details");
    disclosure.className = "execution-disclosure terminal-disclosure";
    disclosure.append(disclosureSummary(
      result.command,
      `${result.status} | exit ${result.exit_code} | ${formatDuration(result.duration_ms)}`
    ));
    const body = document.createElement("div");
    body.className = "execution-disclosure-body";
    const cwd = document.createElement("div");
    cwd.className = "result-meta";
    cwd.textContent = result.cwd;
    body.append(cwd);
    if (result.stdout) body.append(terminalBlock(result.stdout));
    if (result.stderr) body.append(terminalBlock(result.stderr, "terminal-output terminal-stderr"));
    disclosure.append(body);
    fragment.append(disclosure);
  } else if (result.kind === "code") {
    if (result.title) {
      const title = document.createElement("div");
      title.className = "output-title";
      title.textContent = result.title;
      fragment.append(title);
    }
    fragment.append(codeBlock(result.code));
  } else if (result.kind === "review") {
    fragment.append(copyableText(result.summary));
    for (const finding of result.findings) {
      const item = document.createElement("div");
      item.className = `finding ${finding.severity} with-icon`;
      const icon = document.createElement("i");
      icon.className = `codicon codicon-${finding.severity}`;
      const content = document.createElement("span");
      content.textContent = finding.message;
      item.append(icon, content);
      fragment.append(item);
    }
  } else if (result.kind === "plan") {
    const title = document.createElement("div");
    title.className = "output-title";
    title.textContent = result.title;
    const list = document.createElement("ol");
    list.className = "plan-list";
    for (const step of result.steps) {
      const item = document.createElement("li");
      item.textContent = step.title;
      if (step.detail) {
        const detail = document.createElement("small");
        detail.textContent = step.detail;
        item.append(detail);
      }
      list.append(item);
    }
    fragment.append(title, list);
  } else if (result.kind === "patch") {
    const title = document.createElement("div");
    title.className = "output-title";
    title.textContent = result.title;
    fragment.append(title);
    for (const change of result.changes) fragment.append(fileChangeDisclosure(change, "agent-file-change execution-file-change"));
  } else if (result.kind === "ui") {
    fragment.append(copyableText(uiResultText(result)));
  }
  return fragment;
}

/** Reviewing file by file is the careful path, so a single row covers the common
 * case of taking or dropping the whole proposal. */
function patchReviewHeader(turnId: string, entries: readonly WorkflowStepResponse[]): HTMLElement {
  const files = new Set<string>();
  for (const step of entries) {
    const result = step.response?.result;
    if (result?.kind !== "agent") continue;
    for (const change of result.patch?.changes ?? []) files.add(change.uri);
  }
  const header = document.createElement("div");
  header.className = "patch-review-header";
  header.dataset.reviewAll = turnId;
  const label = document.createElement("span");
  label.className = "patch-review-label";
  label.textContent = `${files.size} file${files.size === 1 ? "" : "s"} awaiting review`;
  // An empty uri list is the host's signal to take every pending file, so the
  // row keeps working after some files have already been resolved.
  header.append(label, patchReviewActions(turnId, [], " all"));
  return header;
}

function renderResult(response: InputExecutionResponse, reviewTurnId?: string): void {
  const target = activeTurn?.output ?? elements.result;
  target.replaceChildren();
  const entries: WorkflowStepResponse[] = response.steps ?? response.executions.map((execution) => ({
    method: execution.method.id,
    state: "success" as const,
    response: execution
  }));
  renderAgentFileChanges(entries);
  if (reviewTurnId) target.append(patchReviewHeader(reviewTurnId, entries));
  // Comprehension branches ran at the same time, so they are laid out beside one
  // another instead of pretending they were a sequence.
  let fanOut: HTMLElement | undefined;
  for (const [index, step] of entries.entries()) {
    const item = document.createElement("section");
    item.className = "execution-result";
    if (step.response) item.append(renderExecution(step.response, reviewTurnId));
    else {
      const disclosure = document.createElement("details");
      disclosure.className = "execution-disclosure step-disclosure";
      disclosure.append(disclosureSummary(
        step.method,
        `${step.state}${step.assignment ? ` | ${step.assignment}` : ""}`
      ));
      if (step.error) {
        const error = document.createElement("pre");
        error.className = "error-output";
        error.textContent = String(step.error);
        disclosure.append(error);
      }
      item.append(disclosure);
    }
    if (step.branch === undefined) {
      fanOut = undefined;
      target.append(item);
      if (index < entries.length - 1) item.classList.add("has-next");
      continue;
    }
    if (!fanOut) {
      fanOut = document.createElement("div");
      fanOut.className = "fan-out";
      target.append(fanOut);
    }
    item.classList.add("fan-out-branch");
    item.dataset.branch = String(step.branch + 1);
    fanOut.append(item);
  }
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
}

function clearInputError(): void {
  elements.inputError.textContent = "";
  elements.inputError.hidden = true;
}

function renderInputError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  elements.inputError.textContent = text;
  elements.inputError.hidden = false;
}

function renderOutputError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  const target = activeTurn?.output ?? elements.result;
  target.replaceChildren();
  const summary = document.createElement("pre");
  summary.className = "error-output";
  summary.textContent = text;
  target.append(summary);
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
}

function renderError(message: unknown): void {
  renderInputError(message);
}

/** Keep a live Agent trace in view only while the reader is already at its
 * end. Scrolling upward to inspect an earlier event must remain stable. */
function resultIsNearBottom(): boolean {
  const { scrollTop, scrollHeight, clientHeight } = elements.resultBody;
  return scrollHeight - scrollTop - clientHeight <= 24;
}

function syncJumpToLatest(): void {
  // The control is useful for both a live stream and already-finished
  // conversations.  Tying visibility to `executing` (or to an active stream
  // panel) made it disappear as soon as a response finished, even when the
  // reader had scrolled away from the newest output.
  jumpToLatest.hidden = resultIsNearBottom();
}

function followResultIfNeeded(shouldFollow: boolean): void {
  if (!shouldFollow) {
    cancelScheduledResultScroll();
    return;
  }
  cancelScheduledResultScroll();
  const generation = resultScrollGeneration;
  resultScrollFrame = requestAnimationFrame(() => {
    resultScrollFrame = undefined;
    if (generation !== resultScrollGeneration) return;
    elements.resultBody.scrollTop = elements.resultBody.scrollHeight;
    syncJumpToLatest();
  });
}

/** Selecting a conversation should open at its latest reply, like a chat
 * timeline. Defer until the freshly-rendered disclosures have been laid out
 * so scrollHeight reflects the complete session. */
function scrollResultToBottom(): void {
  cancelScheduledResultScroll();
  const generation = resultScrollGeneration;
  resultScrollFrame = requestAnimationFrame(() => {
    resultScrollFrame = requestAnimationFrame(() => {
      resultScrollFrame = undefined;
      if (generation !== resultScrollGeneration || !activeConversationId || activeConversationId !== renderedConversationId) return;
      elements.resultBody.scrollTop = elements.resultBody.scrollHeight;
      syncJumpToLatest();
    });
  });
}

function agentStreamPanel(): HTMLElement {
  if (agentStream?.isConnected) return agentStream;
  const panel = document.createElement("section");
  panel.className = "agent-stream-panel";
  (activeTurn?.process ?? elements.result).append(panel);
  agentStream = panel;
  // Process already owns the first-level disclosure. Put live run metadata in
  // its title instead of nesting a second disclosure around the timeline.
  agentProgress = activeTurn?.processDisclosure.querySelector<HTMLElement>(".disclosure-meta") ?? undefined;
  updateAgentProgress(agentProgressState);
  return panel;
}

function updateAgentProgress(label: string): void {
  if (!agentProgress) return;
  agentProgressState = label;
  const elapsed = agentRunStartedAt ? Math.max(0, Date.now() - agentRunStartedAt) : 0;
  const totalTokens = agentTokenUsage?.totalTokens
    ?? (agentTokenUsage?.inputTokens !== undefined && agentTokenUsage.outputTokens !== undefined
      ? agentTokenUsage.inputTokens + agentTokenUsage.outputTokens
      : undefined);
  const tokenLabel = totalTokens === undefined
    ? ""
    : `${totalTokens >= 1_000 ? `${(totalTokens / 1_000).toFixed(totalTokens >= 10_000 ? 0 : 1)}k` : totalTokens} tokens`;
  const details = [
    tokenLabel,
    agentEditedUris.size ? `Edited ${agentEditedUris.size} file${agentEditedUris.size === 1 ? "" : "s"}` : "",
    agentCommandIds.size ? `Ran ${agentCommandIds.size} command${agentCommandIds.size === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  agentProgress.textContent = `${agentProgressState} for ${formatDuration(elapsed)}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function startAgentProgress(startedAt = Date.now()): void {
  agentRunStartedAt = startedAt;
  agentStreamPanel();
  updateAgentProgress("Thinking");
  agentRunTimer = setInterval(() => updateAgentProgress(agentProgressState), 100);
}

function finishAgentProgress(): void {
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  updateAgentProgress("Worked");
}

function agentEventKind(event: AgentStreamEvent): "reasoning" | "work" | "tool" {
  if (event.phase === "tool") return "tool";
  return event.group === "aioa-work-log" ? "work" : "reasoning";
}

function createAgentEventItem(event: AgentStreamEvent): HTMLElement {
  const kind = agentEventKind(event);
  const message = document.createElement("section");
  message.className = `agent-stream-item agent-trace-message agent-trace-${kind}`;
  const body = document.createElement("div");
  body.className = "agent-stream-text markdown-body";
  message.append(body);
  return message;
}

function agentToolLabel(event: AgentStreamEvent): string {
  return (event.title ?? event.text.split(/\r?\n/, 1)[0] ?? "Command").slice(0, 180);
}

function updateAgentToolGroupLabel(group: AgentToolGroup): void {
  if (group.labelText) {
    group.label.textContent = group.labelText;
    return;
  }
  const count = group.commands.length;
  group.label.textContent = `Ran ${count} command${count === 1 ? "" : "s"}`;
}

const TOOL_GLYPHS: Record<AgentToolKind, string> = {
  command: "codicon-terminal",
  file: "codicon-diff",
  image: "codicon-file-media",
  step: "codicon-circle-small-filled"
};

function toolGlyph(kind: AgentToolKind = "command"): HTMLElement {
  const icon = document.createElement("i");
  icon.className = `agent-trace-glyph codicon ${TOOL_GLYPHS[kind]}`;
  return icon;
}

function createAgentToolGroup(): AgentToolGroup {
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
  summary.append(toolGlyph(), label, chevron);
  disclosure.append(summary, body);
  agentStreamPanel().append(disclosure);
  return { disclosure, label, body, commands: [] };
}

function createAgentToolCommand(
  event: AgentStreamEvent,
  container: HTMLElement,
  group?: AgentToolGroup
): AgentToolCommand {
  const command = document.createElement("details");
  command.className = "agent-trace-command";
  command.open = false;
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const summaryLabel = document.createElement("span");
  summaryLabel.className = "agent-trace-command-label";
  summary.append(toolGlyph(event.toolKind), summaryLabel, chevron);
  command.append(summary);
  const body = document.createElement("pre");
  body.className = "terminal-output agent-trace-command-body";
  const code = document.createElement("code");
  body.append(code);
  const copy = copyButton(event.text);
  command.append(body, copy);
  container.append(command);
  const item: AgentToolCommand = {
    body,
    copy,
    label: agentToolLabel(event),
    summaryLabel,
    ...(group ? { group } : {})
  };
  summaryLabel.textContent = item.label;
  if (group) {
    group.commands.push(item);
    updateAgentToolGroupLabel(group);
  }
  return item;
}

/**
 * Agents that report their own step grouping get reproduced exactly, including
 * steps they chose to show on their own row. Agents that only stream a flat list
 * of tool calls keep the older behaviour of folding consecutive calls together.
 */
function agentToolGroupFor(
  event: AgentStreamEvent,
  trailingGroup: (group: AgentToolGroup | undefined) => AgentToolGroup | undefined
): AgentToolGroup | undefined {
  if (event.solo) {
    agentToolGroup = undefined;
    return undefined;
  }
  if (event.groupId) {
    agentToolGroup = undefined;
    const existing = agentToolGroups.get(event.groupId);
    const group = existing?.disclosure.isConnected ? existing : createAgentToolGroup();
    if (event.groupLabel) group.labelText = event.groupLabel;
    agentToolGroups.set(event.groupId, group);
    return group;
  }
  const group = trailingGroup(agentToolGroup) ?? createAgentToolGroup();
  agentToolGroup = group;
  return group;
}

function renderAgentMessageItem(item: HTMLElement, body: HTMLElement): void {
  if (!body.isConnected) return;
  const raw = body.dataset.raw ?? "";
  const presentation = presentAgentMessage(raw);
  const copyText = agentMessageCopyText(presentation);
  body.classList.toggle("agent-stream-result", presentation.structured);
  if (presentation.structured) {
    const heading = document.createElement("div");
    heading.className = "agent-result-heading";
    const title = document.createElement("span");
    title.className = "agent-result-title";
    title.textContent = presentation.title;
    heading.append(title);
    if (presentation.meta.length) {
      const meta = document.createElement("span");
      meta.className = "agent-result-meta";
      meta.textContent = presentation.meta.join(" · ");
      heading.append(meta);
    }
    const content = document.createElement("div");
    content.className = "agent-result-content markdown-body";
    content.innerHTML = presentation.text ? markdown.render(presentation.text) : "";
    body.replaceChildren(heading, ...(presentation.text ? [content] : []));
    appendAgentPresentationExtras(body, presentation);
  } else {
    body.innerHTML = markdown.render(raw);
  }
  const outputCopy = item.querySelector<HTMLButtonElement>(".output-copy");
  if (outputCopy) outputCopy.replaceWith(copyButton(copyText));
}

function scheduleAgentMessageRender(item: HTMLElement): void {
  pendingAgentRenders.add(item);
  if (agentRenderFrame !== undefined) return;
  agentRenderFrame = requestAnimationFrame(() => {
    agentRenderFrame = undefined;
    flushAgentMessageRenders();
  });
}

function flushAgentMessageRenders(): void {
  if (agentRenderFrame !== undefined) cancelAnimationFrame(agentRenderFrame);
  agentRenderFrame = undefined;
  const items = [...pendingAgentRenders];
  pendingAgentRenders.clear();
  for (const queued of items) {
    const queuedBody = queued.querySelector<HTMLElement>(".agent-stream-text");
    if (queuedBody) renderAgentMessageItem(queued, queuedBody);
  }
}

function renderAgentEvent(event: AgentStreamEvent): void {
  if (event.usage) agentTokenUsage = event.usage;
  if (event.phase === "status") {
    updateAgentProgress(event.text || agentProgressState);
    return;
  }
  if (event.phase === "reasoning" || event.phase === "message") updateAgentProgress("Thinking");
  const panel = agentStreamPanel();
  // An adjacency group may only keep collecting while it is the newest entry,
  // otherwise a later command would be back-dated into an earlier point.
  const trailingGroup = (group: AgentToolGroup | undefined): AgentToolGroup | undefined =>
    group?.disclosure.isConnected && group.disclosure === panel.lastElementChild ? group : undefined;
  if (event.phase === "tool") {
    // The header counts commands, so steps the agent reported as file or image
    // work must not inflate it.
    if ((event.toolKind ?? "command") === "command") agentCommandIds.add(event.id ?? event.title ?? event.text);
    updateAgentProgress(agentProgressState);
    let command = event.id ? agentToolItems.get(event.id) : undefined;
    if (command) {
      agentToolGroup = event.groupId || event.solo ? undefined : trailingGroup(command.group);
      if (command.group && event.groupLabel) command.group.labelText = event.groupLabel;
    } else {
      const group = agentToolGroupFor(event, trailingGroup);
      command = createAgentToolCommand(event, group?.body ?? panel, group);
      if (event.id) agentToolItems.set(event.id, command);
    }
    const raw = event.replace ? event.text : `${command.body.textContent ?? ""}${event.text}`;
    const code = command.body.querySelector("code");
    if (code) code.replaceChildren(terminalText(raw));
    else command.body.textContent = raw;
    command.label = event.title ?? command.label;
    command.summaryLabel.textContent = command.label;
    const copy = copyButton(raw);
    command.copy.replaceWith(copy);
    command.copy = copy;
    if (command.group) updateAgentToolGroupLabel(command.group);
    elements.resultSection.classList.remove("hidden");
    return;
  }
  let item = event.id ? agentEventItems.get(event.id) : undefined;
  if (!item) {
    // Only a newly appended message breaks the run of commands; replacing the text
    // of an earlier message leaves the trailing group open for more commands.
    agentToolGroup = undefined;
    item = createAgentEventItem(event);
    if (event.id) agentEventItems.set(event.id, item);
    item.append(copyButton(event.text));
    panel.append(item);
  }
  const body = item.querySelector<HTMLElement>(".agent-stream-text");
  const eventBody = event.text;
  if (body) {
    const raw = event.replace ? eventBody : `${body.dataset.raw ?? ""}${eventBody}`;
    body.dataset.raw = raw;
    scheduleAgentMessageRender(item);
  }
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
}

function renderAgentFileChanges(entries: readonly WorkflowStepResponse[]): void {
  const changes = entries.flatMap((step): PatchChange[] => {
    const result = step.response?.result;
    if (result?.kind === "edit") return result.patch.changes;
    if (result?.kind === "patch") return result.changes;
    return [];
  }).filter((change) => change.before !== change.after);
  for (const change of changes) {
    if (agentEditedUris.has(change.uri)) continue;
    agentEditedUris.add(change.uri);
    if (!agentFileChanges?.disclosure.isConnected) {
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
      agentStreamPanel().append(disclosure);
      agentFileChanges = { disclosure, body, label };
    }
    agentFileChanges.body.append(fileChangeDisclosure(change));
  }
  if (changes.length) {
    if (agentFileChanges) agentFileChanges.label.textContent = `Edited ${agentEditedUris.size} file${agentEditedUris.size === 1 ? "" : "s"}`;
    updateAgentProgress(agentProgressState);
  }
}

function resetAgentTrace(): void {
  pendingAgentRenders.clear();
  if (agentRenderFrame !== undefined) cancelAnimationFrame(agentRenderFrame);
  agentRenderFrame = undefined;
  agentStream = undefined;
  agentProgress = undefined;
  agentProgressState = "Thinking";
  agentTokenUsage = undefined;
  agentCommandIds = new Set<string>();
  agentEditedUris = new Set<string>();
  agentEventItems.clear();
  agentToolItems.clear();
  agentToolGroups.clear();
  agentToolGroup = undefined;
  agentFileChanges = undefined;
  pendingAgentEventBatches = [];
  if (agentEventBatchFrame !== undefined) cancelAnimationFrame(agentEventBatchFrame);
  agentEventBatchFrame = undefined;
}

function flushAgentEventBatches(): void {
  agentEventBatchFrame = undefined;
  const batches = pendingAgentEventBatches;
  pendingAgentEventBatches = [];
  const shouldFollow = resultIsNearBottom();
  const events = batches
    .filter((batch) => batch.sessionId === activeConversationId)
    .flatMap((batch) => batch.events);
  if (!events.length) return;
  for (const event of events) renderAgentEvent(event);
  if (forceInitialConversationScroll) {
    forceInitialConversationScroll = false;
    scrollResultToBottom();
  } else {
    followResultIfNeeded(shouldFollow);
  }
  syncJumpToLatest();
}

function queueAgentEvents(sessionId: string, events: readonly AgentStreamEvent[]): void {
  if (sessionId !== activeConversationId || !events.length) return;
  pendingAgentEventBatches.push({ sessionId, events: [...events] });
  if (agentEventBatchFrame === undefined) {
    agentEventBatchFrame = requestAnimationFrame(flushAgentEventBatches);
  }
}

function storedResponse(record: DextHistoryRecord): InputExecutionResponse | undefined {
  if (record.response) return record.response;
  try {
    const parsed = JSON.parse(record.output) as InputExecutionResponse;
    return parsed?.kind === "workflow" && Array.isArray(parsed.executions) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Populate a history turn only when its disclosure is opened.  The shell
 * still exposes the input title and turn actions, while expensive Markdown,
 * syntax highlighting, diffs, and streamed process events stay out of the
 * tab-switch critical path. */
function hydrateStoredTurn(record: DextHistoryRecord, turn: OutputTurnElements): void {
  if (turn.hydrated) return;
  turn.hydrated = true;
  const response = storedResponse(record);

  // Plan turns use a more useful title once their response has been parsed.
  // Keep that JSON parse off the tab-switch path and update the lightweight
  // summary only after deferred hydration completes.
  const planExecution = response?.executions.find((item) => item.result.kind === "chat" && item.result.executePlan);
  const planResult = planExecution?.result.kind === "chat" ? planExecution.result : undefined;
  if (planResult?.executePlan && planResult.planPath) {
    const title = turn.disclosure.querySelector<HTMLElement>(".output-turn-title");
    if (title) title.textContent = `Plan: ${planResult.planPath.split("/").pop() ?? planResult.planPath}`;
  }

  activeTurn = turn;
  resetAgentTrace();
  agentRunStartedAt = Date.now();
  if (turn.input && turn.input.childElementCount === 0) {
    const inputCopy = document.createElement("div");
    inputCopy.className = "output-turn-input";
    inputCopy.append(renderedInputSource(record.input), copyButton(record.input));
    turn.input.append(inputCopy);
  }
  for (const event of record.process) renderAgentEvent(event);
  if (agentStream) finishAgentProgress();
  turn.processDisclosure.open = false;
  if (record.error) renderOutputError(record.error);
  else if (response) renderResult(response);
  else if (record.output) turn.output.append(jsonOutput(record.output));
  turn.outputDisclosure.open = true;
  syncResultToggle();
}

function hydrateOutputTurnOnOpen(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement) || !target.open || !target.classList.contains("output-turn")) return;
  const turnId = target.dataset.turnId;
  if (!turnId) return;
  const turn = outputTurns.get(turnId);
  if (!turn?.hydrate) return;
  // Keep a live turn's streaming state intact while it is running. The
  // historical row can be hydrated after the run completes.
  if (executing && activeTurn && activeTurn !== turn) return;
  const previousActiveTurn = activeTurn;
  turn.hydrate();
  if (previousActiveTurn && previousActiveTurn !== turn) activeTurn = previousActiveTurn;
}

function renderOutputSession(session: DextHistorySession): void {
  const signature = conversationSignature(session);
  if (renderedConversationId === session.id && renderedConversationSignature === signature) {
    return;
  }
  if (renderedConversationId && renderedConversationId !== session.id) cacheRenderedConversation();

  // Normally the host sends the historical session before replaying an active
  // execution. A cache-ref miss can invert those two deliveries, however. In
  // that case retain the already-created live row while rebuilding the stored
  // rows, otherwise accepting the late session would erase the stream.
  const liveTurn = executing && activeExecutionSessionId === session.id && activeTurn && activeTurnId
    ? activeTurn
    : undefined;
  const liveTurnId = liveTurn ? activeTurnId : undefined;

  const cached = conversationViewCache.get(session.id);
  // Also verify turn identities. Older builds persisted a different id than
  // the live row, so blindly restoring such a snapshot would keep delete and
  // retry actions broken until the webview was fully reloaded.
  const sessionTurnIds = new Set(session.turns.map((turn) => turn.id));
  const cacheMatchesSession = cached
    && cached.turns.size === sessionTurnIds.size
    && [...cached.turns.keys()].every((turnId) => sessionTurnIds.has(turnId));
  if (!liveTurn && cached && cached.signature === signature && cacheMatchesSession) {
    elements.result.replaceChildren(...cached.nodes);
    restoreCachedAgentRenders(cached);
    outputTurns.clear();
    for (const [turnId, turn] of cached.turns) outputTurns.set(turnId, turn);
    activeTurn = cached.activeTurnId ? outputTurns.get(cached.activeTurnId) : [...outputTurns.values()].at(-1);
    conversationViewCache.delete(session.id);
    conversationViewCache.set(session.id, cached);
    renderedConversationId = session.id;
    renderedConversationSignature = signature;
    elements.resultSection.classList.remove("hidden");
    finishConversationLoading();
    syncResultToggle();
    syncJumpToLatest();
    scrollResultToBottom();
    return;
  }

  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  clearInputError();
  elements.result.replaceChildren();
  outputTurns.clear();
  activeTurn = undefined;
  const renderGeneration = ++conversationRenderGeneration;
  let latestTurn: OutputTurnElements | undefined;
  for (const [index, record] of session.turns.entries()) {
    // Keep all historical payload parsing lazy. The newest turn is hydrated
    // after the browser paints the loading viewport; older turns parse their
    // response only when the user expands them.
    const latest = index === session.turns.length - 1;
    const turn = createOutputTurn(record.id, record.input, record.createdAt, {
      lazy: true,
      open: latest
    });
    turn.hydrate = () => hydrateStoredTurn(record, turn);
    if (latest) latestTurn = turn;
  }
  if (liveTurn && liveTurnId) {
    elements.result.append(liveTurn.disclosure);
    outputTurns.set(liveTurnId, liveTurn);
    activeTurn = liveTurn;
  }
  // Set these before scheduling the correction: scrollResultToBottom rejects
  // callbacks that no longer belong to the visible conversation.
  renderedConversationId = session.id;
  renderedConversationSignature = signature;
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
  syncJumpToLatest();
  // Let the empty viewport paint first. This prevents a large restored turn
  // from blocking wheel/touch input for the duration of Markdown rendering.
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (renderGeneration !== conversationRenderGeneration
        || activeConversationId !== session.id
        || renderedConversationId !== session.id) return;
      // A running turn may have been replayed while the historical snapshot
      // was waiting for its deferred hydration. Leave the live row untouched;
      // its stream renderer owns activeTurn and will keep appending there.
      if (executing) {
        finishConversationLoading();
        syncResultToggle();
        syncJumpToLatest();
        scrollResultToBottom();
        return;
      }
      latestTurn?.hydrate?.();
      finishConversationLoading();
      syncResultToggle();
      syncJumpToLatest();
      scrollResultToBottom();
    }, 0);
  });
}

function findImageItem(data: DataTransfer | null): DataTransferItem | undefined {
  if (!data) return undefined;
  for (const item of data.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item;
  }
  return undefined;
}

function renderOutputSessionRef(sessionId: string, signature: string, switchId?: number, hostInitiated = false): void {
  if (renderedConversationId === sessionId && renderedConversationSignature === signature) {
    return;
  }
  if (renderedConversationId && renderedConversationId !== sessionId) cacheRenderedConversation();
  const cached = conversationViewCache.get(sessionId);
  if (!cached || cached.signature !== signature) {
    vscode.postMessage({ type: "outputSessionRefMiss", sessionId, signature, ...(switchId !== undefined ? { switchId } : {}), ...(hostInitiated ? { hostInitiated: true as const } : {}) });
    return;
  }
  elements.result.replaceChildren(...cached.nodes);
  restoreCachedAgentRenders(cached);
  outputTurns.clear();
  for (const [turnId, turn] of cached.turns) outputTurns.set(turnId, turn);
  activeTurn = cached.activeTurnId ? outputTurns.get(cached.activeTurnId) : [...outputTurns.values()].at(-1);
  conversationViewCache.delete(sessionId);
  conversationViewCache.set(sessionId, cached);
  renderedConversationId = sessionId;
  renderedConversationSignature = signature;
  elements.resultSection.classList.remove("hidden");
  finishConversationLoading();
  syncResultToggle();
  syncJumpToLatest();
  scrollResultToBottom();
}

function addImageAttachment(relativePath: string, webviewUri: string, name: string): void {
  if (imageAttachments.has(relativePath)) return;
  const chip = document.createElement("div");
  chip.className = "image-attachment";
  const image = document.createElement("img");
  image.src = webviewUri;
  image.alt = name;
  image.title = name;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "image-attachment-remove";
  remove.setAttribute("aria-label", "Remove image");
  remove.textContent = "\u00d7";
  remove.addEventListener("click", () => {
    chip.remove();
    imageAttachments.delete(relativePath);
    activeImageAttachmentMetadata.delete(relativePath);
    editor.removeFileReference(relativePath);
    vscode.postMessage({ type: "deleteImageAttachment", relativePath });
  });
  chip.append(image, remove);
  elements.attachmentBar.append(chip);
  elements.attachmentBar.classList.remove("hidden");
  imageAttachments.set(relativePath, chip);
  activeImageAttachmentMetadata.set(relativePath, { relativePath, webviewUri, name });
  persistComposerDraft();
}

const activeImageAttachmentMetadata = new Map<string, DraftAttachment>();

function clearRenderedAttachments(): void {
  for (const chip of imageAttachments.values()) chip.remove();
  imageAttachments.clear();
  activeImageAttachmentMetadata.clear();
  elements.attachmentBar.classList.add("hidden");
}

function persistComposerDraft(): void {
  if (!activeConversationId || restoringDraft) return;
  const source = editor.source;
  conversationDrafts.set(activeConversationId, {
    source,
    // If the user removes an image's @ reference directly in the editor, do
    // not resurrect its chip when returning to this tab.
    attachments: [...activeImageAttachmentMetadata.values()]
      .filter((item) => source.includes(`@${item.relativePath}`))
      .map((item) => ({ ...item }))
  });
}

function restoreComposerDraft(sessionId: string): void {
  const draft = conversationDrafts.get(sessionId);
  restoringDraft = true;
  try {
    clearRenderedAttachments();
    editor.setValue(draft?.source ?? "");
    for (const attachment of draft?.attachments ?? []) {
      addImageAttachment(attachment.relativePath, attachment.webviewUri, attachment.name);
    }
  } finally {
    restoringDraft = false;
  }
  updateRunState();
}

function scheduleComposerDraftRestore(sessionId: string, switchId?: number): void {
  requestAnimationFrame(() => {
    if (activeConversationId !== sessionId) return;
    if (switchId !== undefined && switchId !== conversationSwitchId) return;
    restoreComposerDraft(sessionId);
  });
}

function clearSubmittedInput(): void {
  editor.setValue("");
  // The chips stand for references that just left the composer with the turn,
  // so they go with it. The files stay on disk because the recorded turn and
  // its history entry still point at them.
  for (const chip of imageAttachments.values()) chip.remove();
  imageAttachments.clear();
  activeImageAttachmentMetadata.clear();
  elements.attachmentBar.classList.add("hidden");
  persistComposerDraft();
}

elements.run.addEventListener("click", run);
elements.planTarget.addEventListener("click", () => {
  if (activePlanPath) vscode.postMessage({ type: "openFileReference", reference: activePlanPath });
  else vscode.postMessage({ type: "choosePlan" });
});
elements.planChoose.addEventListener("click", () => vscode.postMessage({ type: "choosePlan" }));
elements.planBuild.addEventListener("click", () => {
  const planBuildRunning = planStatus === "running" && executing;
  if (planBuildRunning) {
    if (!activeTurnId || stopping) return;
    stopping = true;
    vscode.postMessage({ type: "stopExecution", turnId: activeTurnId });
    updateRunState();
    return;
  }
  if (!activePlanPath || executing) return;
  elements.planBuild.disabled = true;
  vscode.postMessage({ type: "buildPlan", planPath: activePlanPath });
});
elements.result.addEventListener("click", openOutputLink);
elements.resultToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleResultDetails();
});
elements.result.addEventListener("toggle", hydrateOutputTurnOnOpen, true);
elements.result.addEventListener("toggle", syncResultToggle, true);
elements.resultBody.addEventListener("scroll", () => {
  // A manual wheel/touch scroll takes precedence over any deferred follow
  // request left by a stream update or a previous tab switch.
  cancelScheduledResultScroll();
  syncJumpToLatest();
}, { passive: true });
jumpToLatest.addEventListener("click", () => {
  elements.resultBody.scrollTop = elements.resultBody.scrollHeight;
  syncJumpToLatest();
  elements.resultBody.focus({ preventScroll: true });
});
elements.problems.addEventListener("click", () => editor.goToFirstDiagnostic());
elements.methodsToggle.addEventListener("click", toggleMethodGroups);
elements.reloadMethods.addEventListener("click", () => {
  // Reloading an unchanged API set would otherwise look like nothing happened.
  setMethodsReloading(true);
  vscode.postMessage({ type: "reload" });
});
elements.closeMethods.addEventListener("click", closeMethodsDialog);
elements.methodsDialog.addEventListener("click", (event) => {
  if (event.target === elements.methodsDialog) closeMethodsDialog();
});
elements.closeMcp.addEventListener("click", closeMcpDialog);
elements.mcpToggle.addEventListener("click", toggleResourceCategories);
elements.mcpSearch.addEventListener("input", () => {
  if (lastSidebarState) renderMcp(lastSidebarState);
});
elements.mcpDialog.addEventListener("click", (event) => {
  if (event.target === elements.mcpDialog) closeMcpDialog();
});
function requestCloseMcpAssistant(): void {
  if (mcpAssistantRunningRequestId) {
    // Closing while generation is active must go through the same cancellation
    // path as the visible Stop button. The dialog stays open until the host
    // confirms the abort with an `executing: false` message.
    generateMcpAssistant();
    return;
  }
  if (elements.mcpAssistantDialog.open) elements.mcpAssistantDialog.close();
}

elements.mcpAssistantClose.addEventListener("click", requestCloseMcpAssistant);
elements.mcpAssistantGenerate.addEventListener("click", generateMcpAssistant);
elements.mcpAssistantSave.addEventListener("click", saveMcpAssistant);
elements.mcpAssistantDialog.addEventListener("click", (event) => {
  if (event.target === elements.mcpAssistantDialog) requestCloseMcpAssistant();
});
elements.mcpAssistantDialog.addEventListener("cancel", (event) => {
  // Native dialog Esc dispatches `cancel` before closing. Intercept it while
  // active so Esc behaves exactly like the close button and backdrop click.
  if (!mcpAssistantRunningRequestId) return;
  event.preventDefault();
  requestCloseMcpAssistant();
});
elements.uiDialogClose.addEventListener("click", cancelUi);
elements.uiDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelUi();
});
elements.uiDialogForm.addEventListener("submit", (event) => event.preventDefault());
elements.inputHeading.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  toggleSection(elements.inputHeading, elements.inputBody);
});
elements.inputHeading.addEventListener("keydown", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleSection(elements.inputHeading, elements.inputBody);
  }
});
for (const [name, panel] of Object.entries(panels) as [PanelName, typeof panels[PanelName]][]) {
  panel.button.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFullscreen(name);
  });
}
elements.resultHeading.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  toggleSection(elements.resultHeading, elements.resultBody);
});
elements.resultHeading.addEventListener("keydown", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleSection(elements.resultHeading, elements.resultBody);
  }
});
elements.attachFiles.addEventListener("click", () => vscode.postMessage({ type: "chooseFiles" }));
elements.composerMore.addEventListener("click", (event) => {
  event.stopPropagation();
  const controls = elements.composerMore.closest(".composer-controls");
  const open = !controls?.classList.contains("show-extra");
  controls?.classList.toggle("show-extra", open);
  elements.composerMore.setAttribute("aria-expanded", String(open));
});
for (const item of composerMenus) {
  item.control.addEventListener("click", () => toggleComposerMenu(item.menu));
}
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".composer-menu")) return;
  closeComposerExtras();
  closeComposerMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  closeComposerExtras();
  closeComposerMenus();
});
elements.inputShell.addEventListener("paste", (event) => {
  const imageItem = findImageItem(event.clipboardData);
  if (!imageItem) return;
  const file = imageItem.getAsFile();
  if (!file) return;
  event.preventDefault();
  event.stopPropagation();
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== "string") return;
    const dataUrl = reader.result;
    const comma = dataUrl.indexOf(",");
    const header = dataUrl.slice(0, comma);
    const mimeType = header.slice(5, header.indexOf(";"));
    const base64 = dataUrl.slice(comma + 1);
    vscode.postMessage({ type: "pasteImage", data: base64, mimeType });
  };
  reader.readAsDataURL(file);
}, true);

window.addEventListener("message", (event: MessageEvent<WebviewResponse>) => {
  const message = event.data;
  if (broker.accept(message) || clipboard.accept(message) || fileSearch.accept(message)) return;
  if (message.type === "state") {
    lastSidebarState = message.state;
    setMethodsReloading(false);
    const methodsKey = JSON.stringify([
      message.state.theme,
      message.state.methods,
      message.state.diagnostics
    ]);
    if (methodsKey !== renderedMethodsKey) {
      renderedMethodsKey = methodsKey;
      renderMethods(message.state);
    }
    const mcpKey = JSON.stringify([
      message.state.mcpServers,
      message.state.globalDiagnostics,
      message.state.globalResources
    ]);
    if (mcpKey !== renderedMcpKey) {
      renderedMcpKey = mcpKey;
      renderMcp(message.state);
    }
    // Controls are conversation-scoped, unlike the API/resource trees above.
    renderAgentControls(message.state);
  }
  if (message.type === "inputKind") {
    inputKind = message.kind;
    updateRunState();
  }
  if (message.type === "insertFileReferences") {
    editor.insertFileReferences(message.expressions);
  }
  if (message.type === "imageAttachment") {
    addImageAttachment(message.relativePath, message.webviewUri, message.name);
    editor.insertFileReferences([`@${message.relativePath}`]);
  }
  if (message.type === "outputSession") {
    if (message.switchId !== undefined && message.switchId !== conversationSwitchId) return;
    // A pre-click payload can arrive after the local tab selection.  It has
    // no switch id to reject, so also require it to match the visible tab.
    if (!message.hostInitiated && activeConversationId && message.session.id !== activeConversationId) return;
    // A live row may have been restored before a delayed historical payload.
    // Rebuilding the session in that case would silently remove the running
    // turn from the pane.
    if (executing && activeTurn && activeTurnId && message.session.id === activeConversationId
      && elements.resultBody.dataset.loading !== "true") return;
    renderOutputSession(message.session);
  }
  if (message.type === "outputSessionRef") {
    if (message.switchId !== undefined && message.switchId !== conversationSwitchId) return;
    if (!message.hostInitiated && activeConversationId && message.sessionId !== activeConversationId) return;
    if (executing && activeTurn && activeTurnId && message.sessionId === activeConversationId) return;
    renderOutputSessionRef(message.sessionId, message.signature, message.switchId, message.hostInitiated === true);
  }
  if (message.type === "activeConversation") {
    if (message.switchId !== undefined && message.switchId !== conversationSwitchId) return;
    // Messages emitted by refreshes before a click have no switch id.  Once
    // the tab press has committed locally, an older active-id must not undo
    // that selection (and trigger another layout/scroll pass).
    if (!message.hostInitiated && message.switchId === undefined && activeConversationId && message.activeId !== activeConversationId) return;
    // History actions (Continue/Fork) activate a conversation from the host,
    // without going through selectConversation(). Clear the previous tab's
    // execution state before its historical DOM is restored; otherwise the
    // old live row can be appended to the newly selected conversation.
    if (activeConversationId !== message.activeId) {
      executing = false;
      stopping = false;
      activeTurnId = undefined;
      activeExecutionSessionId = undefined;
      clearVisibleConversation();
    }
    activeConversationId = message.activeId;
    for (const tab of elements.conversationTabs.querySelectorAll<HTMLElement>(".conversation-tab")) {
      const active = tab.dataset.sessionId === message.activeId;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    if (lastSidebarState) renderAgentControls({ ...lastSidebarState, agentSelection: message.selection });
    activePlanPath = message.planPath;
    planStatus = message.planStatus;
    renderPlanToolbar();
  }
  if (message.type === "conversations") {
    if (message.switchId !== undefined && message.switchId !== conversationSwitchId) return;
    if (!message.hostInitiated && message.switchId === undefined && activeConversationId && message.activeId !== activeConversationId) return;
    renderConversations(message.sessions, message.activeId);
    if (message.selection && lastSidebarState) {
      renderAgentControls({ ...lastSidebarState, agentSelection: message.selection });
    }
    if (message.planStatus) {
      activePlanPath = message.planPath;
      planStatus = message.planStatus;
      renderPlanToolbar();
    }
  }
  if (message.type === "planContext") {
    activePlanPath = message.path;
    planStatus = message.status;
    renderPlanToolbar();
  }
  if (message.type === "openMethods") openMethodsDialog();
  if (message.type === "openMcp") openMcpDialog();
  if (message.type === "mcpAssistant") openMcpAssistantDialog();
  if (message.type === "mcpProgress" && message.requestId === mcpAssistantRequestId) {
    renderMcpAssistantEvent(message.event);
  }
  if (message.type === "mcpToolsDiscovered" && message.requestId === mcpAssistantRequestId) {
    renderMcpToolChoices(message.tools);
  }
  if (message.type === "mcpGenerated" && message.requestId === mcpAssistantRequestId) {
    mcpAssistantServer = message.server;
    elements.mcpAssistantPreview.value = JSON.stringify(message.server, null, 2);
    elements.mcpAssistantPreview.hidden = false;
    elements.mcpAssistantScope.hidden = false;
    elements.mcpAssistantScopeLabel.hidden = false;
    elements.mcpAssistantGenerate.hidden = true;
    elements.mcpAssistantSave.hidden = false;
    // Tool discovery follows generation; keep Save disabled until the
    // allowlist view has been populated.
    elements.mcpAssistantSave.disabled = true;
    // Completed Conversation Process sections are collapsed by default; keep
    // the MCP trace available on demand as well.
    elements.mcpAssistantProcess.open = false;
    const elapsed = mcpAssistantProcessStartedAt ? Math.max(0, Date.now() - mcpAssistantProcessStartedAt) : 0;
    const tokenLabel = mcpAssistantProcessTokens === undefined ? "" : ` · ${mcpAssistantProcessTokens} tokens`;
    elements.mcpAssistantProcessMeta.textContent = `Worked for ${formatDuration(elapsed)} · ${mcpAssistantProcessCount} events${tokenLabel}`;
    elements.mcpAssistantStatus.textContent = "Review the draft, choose where to save it, then confirm.";
  }
  if (message.type === "mcpCreated") {
    elements.mcpAssistantStatus.textContent = `MCP '${message.name}' was added and its tools are ready.`;
    elements.mcpAssistantDialog.close();
    openMcpDialog();
  }
  if (message.type === "uiRequest") openUiDialog(message);
  if (message.type === "execution") {
    // A background turn changes the session while its DOM may be cached.
    // Drop that snapshot so returning to the tab renders the new turn once.
    conversationViewCache.delete(message.sessionId);
  }
  if (message.type === "execution" && message.sessionId === activeConversationId) {
    selectOutputTurn(message.turnId);
    renderResult(message.response, message.reviewPatch ? message.turnId : undefined);
  }
  if (message.type === "patchResolved" && message.sessionId === activeConversationId) {
    applyPatchResolution(message.turnId, message.uris, message.status, message.message);
  }
  if (message.type === "executionFailed") {
    conversationViewCache.delete(message.sessionId);
  }
  if (message.type === "executionFailed" && message.sessionId === activeConversationId) {
    selectOutputTurn(message.turnId);
    renderOutputError(message.message);
  }
  if (message.type === "agentEvent" && message.sessionId === activeConversationId) {
    const shouldFollow = resultIsNearBottom();
    renderAgentEvent(message.event);
    if (forceInitialConversationScroll) {
      forceInitialConversationScroll = false;
      scrollResultToBottom();
    } else {
      followResultIfNeeded(shouldFollow);
    }
    syncJumpToLatest();
  }
  if (message.type === "agentEvents"
    && (message.switchId === undefined || message.switchId === conversationSwitchId)
    && message.sessionId === activeConversationId) {
    queueAgentEvents(message.sessionId, message.events);
  }
  if (message.type === "executing"
    && (message.switchId === undefined || message.switchId === conversationSwitchId)
    && (
    message.sessionId === activeConversationId
    || message.turnId === mcpAssistantRunningRequestId
    || (message.value && message.turnId === mcpAssistantRequestId)
  )) {
    // MCP manifest generation has its own action in the MCP dialog. It is not
    // a conversation turn and must not change the composer run control or
    // create a phantom output entry in conversation history.
    if (message.turnId === mcpAssistantRunningRequestId || (!mcpAssistantRunningRequestId && message.turnId === mcpAssistantRequestId && message.value)) {
      if (message.value) {
        mcpAssistantRunningRequestId = message.turnId;
        mcpAssistantStopping = false;
      } else {
        mcpAssistantRunningRequestId = undefined;
        elements.mcpAssistantProcess.open = false;
      }
      updateMcpAssistantAction();
      return;
    }
    executing = message.value;
    if (message.value) {
      if (message.switchId !== undefined) {
        // The row is appended after the restored conversation's initial
        // scroll correction. Keep the replay pinned to the newest event.
        forceInitialConversationScroll = true;
        scrollResultToBottom();
      }
      activeTurnId = message.turnId;
      activeExecutionSessionId = message.sessionId;
      stopping = false;
      const existingTurn = outputTurns.get(message.turnId);
      if (existingTurn) {
        activeTurn = existingTurn;
      } else {
        createOutputTurn(message.turnId, message.source ?? "Dext turn", Date.now(), {
          ...(message.executePlan ? { executePlan: true } : {}),
          ...(message.planPath ? { planPath: message.planPath } : {})
        });
        resetAgentTrace();
        startAgentProgress(message.startedAt);
      }
      elements.resultSection.classList.remove("hidden");
      if (!fullscreenPanel || fullscreenPanel === "result") {
        setSectionOpen(elements.resultHeading, elements.resultBody, true);
      }
      syncJumpToLatest();
    } else {
      forceInitialConversationScroll = false;
      const shouldFollow = resultIsNearBottom();
      if (activeTurnId === message.turnId) activeTurnId = undefined;
      if (activeExecutionSessionId === message.sessionId) activeExecutionSessionId = undefined;
      stopping = false;
      selectOutputTurn(message.turnId);
      finishAgentProgress();
      if (activeTurn) {
        activeTurn.processDisclosure.open = false;
        activeTurn.outputDisclosure.open = true;
        followResultIfNeeded(shouldFollow);
      }
      syncJumpToLatest();
    }
    updateRunState();
  }
  if (message.type === "error") {
    renderInputError(message.message);
    if (elements.mcpAssistantDialog.open) {
      elements.mcpAssistantStatus.textContent = message.message;
      updateMcpAssistantAction();
      elements.mcpAssistantSave.disabled = false;
    }
  }
  if (message.type === "setInput") {
    editor.setValue(message.source);
    editor.focus();
  }
  if (message.type === "focusEditor" || message.type === "focusInput") editor.focus();
  if (message.type === "triggerSuggest") editor.triggerSuggest();
  if (message.type === "triggerParameterHints") editor.triggerParameterHints();
});

window.addEventListener("unload", () => {
  broker.dispose();
  clipboard.dispose();
  editor.destroy();
});

updateRunState();
syncFullscreenButtons();
syncResultToggle();
vscode.postMessage({ type: "ready" });
