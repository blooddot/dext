import "../../media/styles.css";
import { TranscriptView, type OutputTurnElements } from "../features/conversations/browser/transcriptView.js";
import { turnDomAdapter } from "../features/conversations/browser/turnDomAdapter.js";
import type { DextHistoryRecord, DextHistorySession } from "../features/conversations/contracts/history.js";
import type { ConversationSummary } from "../features/conversations/contracts/protocol.js";
import { prepareHistoryTrace } from "../features/conversations/domain/agentTraceReplay.js";
import { readHistoryResponse } from "../features/conversations/domain/historyResponse.js";
import { renderTurnInput, renderTurnJson, renderTurnMarkdown, renderTurnResult } from "../features/conversations/presentation/turnComponents.js";
import {
  formatTurnTokenUsage,
  presentTurn,
  resultCopyText,
  updateTurnTokenUsage
} from "../features/conversations/presentation/turnPresentation.js";
import { RESOURCE_DIRECTORIES, RESOURCE_ICONS, RESOURCE_LABELS, type ResourceKind, type ResourceScope, type ResourceSession } from "../features/resources/contracts/resourceSession.js";
import { FileSearchClient } from "../features/workspace/browser/fileSearchClient.js";
import type { SidebarState, WebviewRequest, WebviewResponse } from "../platform/webviewProtocol.js";
import type {
  AgentStreamEvent,
  AgentTokenUsage,
  InputExecutionResponse,
  RuntimeResponse,
  WorkflowStepResponse
} from "../shared/contracts/types.js";
import type { UiFormAnswers } from "../shared/contracts/uiForm.js";
import { formatDuration } from "../shared/lib/duration.js";
import { markdownCodeCopy } from "../shared/lib/markdownCopy.js";
import { dextMarkdown } from "../shared/lib/markdown.js";
import { ClipboardClient } from "./clipboardClient.js";
import { DextCodeEditor } from "./codeEditor.js";
import { bindFileDropTarget, droppedFilePaths, fileSelectionDropEffect, findImageItem, isFileDrag } from "../platform/browser/fileDrop.js";
import { FileDropClient } from "./fileDropClient.js";
import { ImageAttachments } from "./imageAttachments.js";
import { McpAssistantView } from "./mcpAssistantView.js";
import { ProjectReferenceClient } from "./projectReferenceClient.js";
import { colorizeSource } from "./sourceHighlight.js";

import type { HarnessPresetOption } from "../features/agents/contracts/agent.js";
import { CLI_SPEEDS } from "../features/agents/domain/builtinCli.js";
import { DEFAULT_HARNESS_PRESET, harnessPresetOrDefault } from "../features/agents/domain/harnessPresetDefault.js";
import { presentAgentSelection } from "../features/agents/presentation/agentSelectionDefaults.js";
import { AgentInputView } from "../features/conversations/browser/agentInputView.js";
import { AgentTodoView } from "../features/conversations/browser/agentTodoView.js";
import { AgentTraceView } from "../features/conversations/browser/agentTraceView.js";
import { ComposerDraftStore } from "../features/conversations/browser/composerController.js";
import { observeComposerOverflow } from "../features/conversations/browser/composerOverflow.js";
import { ConversationBrowser, ConversationViewStore, conversationSignature } from "../features/conversations/browser/conversationController.js";
import { enableConversationTabDrag } from "../features/conversations/browser/conversationTabDrag.js";
import { renderConversationTabs } from "../features/conversations/browser/conversationTabs.js";
import { OutputScrollController } from "../features/conversations/browser/outputScrollController.js";
import { planActions, renderPlanToolbar as renderPlanToolbarView } from "../features/conversations/browser/planControls.js";
import { installResultScrollProbe } from "../features/conversations/browser/scrollProbe.js";
import {
  groupSkills, packCheckState, selectionLabel, togglePack, toggleSkill
} from "../features/conversations/browser/skillSelection.js";
import { planExecutionLabel } from "../features/conversations/presentation/agentTodoPresentation.js";
import { terminalSegments } from "../features/conversations/presentation/terminalText.js";
import { looksLikeGithubUrl } from "../features/resources/domain/skillSource.js";
import { outputExternalLink, outputLinkReference } from "../features/workspace/browser/outputLink.js";
import type { ContextReferenceOccurrence } from "../features/workspace/domain/fileReference.js";
import { renderMarkdownDiagrams } from "../platform/browser/markdownDiagrams.js";
import type { PlanProjectContext } from "../shared/contracts/planProject.js";
import { registerSlashCommandProvider } from "./monacoSlashCommands.js";

interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): { interactionDrafts?: Record<string, UiFormAnswers> } | undefined;
  setState(state: { interactionDrafts: Record<string, UiFormAnswers> }): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing Webview element '${id}'.`);
  return value as T;
}

const vscode = acquireVsCodeApi();

const elements = {
  conversationTabs: element<HTMLElement>("conversation-tabs"),
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
  createResource: element<HTMLButtonElement>("create-resource"),
  resourceToolbar: element<HTMLElement>("resource-toolbar"),
  resourceTarget: element<HTMLButtonElement>("resource-target"),
  resourceChoose: element<HTMLButtonElement>("resource-choose"),
  resourceTargetLabel: element<HTMLElement>("resource-target-label"),
  resourceStatus: element<HTMLElement>("resource-status"),
  resourcePreview: element<HTMLButtonElement>("resource-preview"),
  resourceSave: element<HTMLButtonElement>("resource-save"),
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
  inputErrorMessage: element<HTMLElement>("input-error-message"),
  dismissInputError: element<HTMLButtonElement>("dismiss-input-error"),
  codeEditor: element<HTMLElement>("code-editor"),
  attachFiles: element<HTMLButtonElement>("attach-files"),
  modeControl: element<HTMLButtonElement>("mode-control"),
  modeControlIcon: element<HTMLElement>("mode-control-icon"),
  modeControlValue: element<HTMLElement>("mode-control-value"),
  modeMenu: element<HTMLElement>("mode-menu"),
  skillsMenuShell: element<HTMLElement>("skills-menu-shell"),
  skillsControl: element<HTMLButtonElement>("skills-control"),
  skillsControlValue: element<HTMLElement>("skills-control-value"),
  skillsMenu: element<HTMLElement>("skills-menu"),
  resourceSourceToggle: element<HTMLElement>("resource-source-toggle"),
  resourceSourceDescribe: element<HTMLButtonElement>("resource-source-describe"),
  resourceSourceImport: element<HTMLButtonElement>("resource-source-import"),
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
  result: element<HTMLElement>("result"),
  resultToggle: element<HTMLButtonElement>("result-toggle"),
  planToolbar: element<HTMLElement>("plan-toolbar"),
  planTarget: element<HTMLButtonElement>("plan-target"),
  planChoose: element<HTMLButtonElement>("plan-choose"),
  planTargetLabel: element<HTMLElement>("plan-target-label"),
  planStatus: element<HTMLElement>("plan-status"),
  planBuild: element<HTMLButtonElement>("plan-build"),
  attachmentBar: element<HTMLElement>("attachment-bar")
};

const browser = new ConversationBrowser();
const drafts = new ComposerDraftStore();
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
const jumpToTop = document.createElement("button");
jumpToTop.type = "button";
jumpToTop.className = "stream-jump-top";
const jumpToTopIcon = document.createElement("i");
jumpToTopIcon.className = "codicon codicon-arrow-up";
jumpToTopIcon.setAttribute("aria-hidden", "true");
jumpToTop.append(jumpToTopIcon);
jumpToTop.setAttribute("aria-label", "Jump to top");
jumpToTop.title = "Jump to top";
jumpToTop.hidden = true;
const scroll = new OutputScrollController({
  viewport: { body: elements.resultBody, result: elements.result, section: elements.resultSection, jumpToLatest, jumpToTop },
  conversation: { activeId: () => browser.activeId, renderedId: () => browser.renderedId },
  canFollow: () => resultFollowAllowed(),
  onDiagnostic: (message) => renderInputError(message)
});
// Keep the control in the result panel's viewport layer instead of inside the
// scrollable output. This keeps it visible while the reader inspects history.
elements.resultSection.append(jumpToTop);
elements.resultSection.append(jumpToLatest);
syncResultScrollGutter();
window.addEventListener("resize", syncResultScrollGutter, { passive: true });
if (typeof ResizeObserver === "function") {
  // Docked, collapsed, and resized panels all change the scrollbar gutter.
  // A following reader also expects the newest output to stay in view when the
  // composer grows or the panel is maximized under the same conversation. The
  // result itself is observed as well: streamed Markdown, fonts, and hydrated
  // disclosures can grow the scrollHeight without changing the scroll port's
  // own size.
  const syncResultLayout = (): void => {
    syncResultScrollGutter();
    syncJumpToLatest();
    reportStaleResultRange();
    scroll.measureLayout();
    pinResultToBottom();
  };
  const resultLayoutObserver = new ResizeObserver(syncResultLayout);
  resultLayoutObserver.observe(elements.resultBody);
  resultLayoutObserver.observe(elements.result);
}
// Console surface for the scroll port: `dextScrollWatch = true` logs a
// measurement on every scroll/layout pass and `dextScrollReport()` returns one
// on demand, naming whatever makes the range disagree with what it paints.
installResultScrollProbe({ body: elements.resultBody, result: elements.result });

let pendingConfirmation: (() => void) | undefined;

const clipboard = new ClipboardClient((request) => vscode.postMessage(request));
const fileSearch = new FileSearchClient((request) => vscode.postMessage(request));
const projectReferences = new ProjectReferenceClient((request) => vscode.postMessage(request), (message) => renderError(new Error(message)));
const fileDrop = new FileDropClient((request) => vscode.postMessage(request));
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
let planProjectContext: PlanProjectContext | undefined;
let planStatus: "new" | "active" | "running" | "completed" | "failed" = "new";
// A Build leaves the composer before the host starts a turn: it re-reads the plan
// and may assess it against the Project with an AI call. Remember whose build is
// still being prepared, so the wait survives a re-render (including a tab
// switch) instead of turning back into a clickable Build.
const pendingBuilds = new Map<string, string>();
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
type ResourceSource = "describe" | "import";
let resourceSource: ResourceSource = "describe";
let resourceSourceKey = "";
let sidebarState: SidebarState | undefined;
let lastSidebarState: SidebarState | undefined;
// The theme is independent of the active conversation. Keep a compact signature so switching tabs
// only updates the composer controls instead of rebuilding the document styles again.
let renderedThemeKey: string | undefined;
const resourceSessions = new Map<string, ResourceSession>();
const resourcePending = new Set<string>();
const resourceErrors = new Map<string, string>();
function activeResource(): ResourceSession | undefined { return resourceSessions.get(browser.activeId ?? ""); }
let restoringDraft = false;
const runningConversationIds = new Set<string>();
let agentStream: HTMLElement | undefined;
let agentRunStartedAt = 0;
let agentRunTimer: ReturnType<typeof setInterval> | undefined;
let agentProgress: HTMLElement | undefined;
let agentProgressState = "Thinking";
let agentTokenUsage: AgentTokenUsage | undefined;
let pendingAgentEventBatches: Array<{ sessionId: string; events: AgentStreamEvent[] }> = [];
let agentEventBatchFrame: number | undefined;
const attachments = new ImageAttachments({
  bar: elements.attachmentBar,
  post: (message) => vscode.postMessage(message),
  removeReference: (relativePath) => editor.removeFileReference(relativePath),
  onChanged: () => persistComposerDraft()
});
/** Form fields awaiting a stored image, keyed by the request that asked for it. */
const pendingFormImages = new Map<number, (relativePath: string) => void>();
let nextFormImage = 0;
function readImageData(file: File): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the pasted image."));
    reader.onload = () => {
      if (typeof reader.result !== "string") { reject(new Error("Could not read the pasted image.")); return; }
      const comma = reader.result.indexOf(",");
      resolve({ data: reader.result.slice(comma + 1), mimeType: reader.result.slice(5, reader.result.indexOf(";")) });
    };
    reader.readAsDataURL(file);
  });
}
/** A form answer is text, so an attached image arrives as the stored @path. */
async function attachFormImage(file: File): Promise<string> {
  const image = await readImageData(file);
  return new Promise((resolve) => {
    const requestId = ++nextFormImage;
    pendingFormImages.set(requestId, resolve);
    vscode.postMessage({ type: "pasteImage", requestId, ...image });
  });
}

function createTurnQuestions(turnId: string, sessionId: string | undefined): AgentInputView {
  return new AgentInputView((requestId, answers) => {
    if (sessionId) vscode.postMessage({ type: "agentInputResponse", sessionId, turnId, requestId, answers });
  }, (state, response) => vscode.postMessage({ type: "uiResponse", sessionId: state.sessionId, turnId: state.turnId, requestId: state.requestId, response }),
  `${sessionId}:${turnId}`, {
    get: (key) => vscode.getState()?.interactionDrafts?.[key],
    set: (key, draft) => {
      const interactionDrafts = { ...vscode.getState()?.interactionDrafts };
      delete interactionDrafts[key];
      if (Object.keys(draft).length) interactionDrafts[key] = draft;
      const entries = Object.entries(interactionDrafts).slice(-32);
      while (JSON.stringify(entries).length > 200000) entries.shift();
      vscode.setState({ interactionDrafts: Object.fromEntries(entries) });
    }
  }, { resolve: (paths) => fileDrop.resolve(paths), attach: attachFormImage, onError: renderError });
}

const transcript = new TranscriptView({
  document,
  result: elements.result,
  activeSessionId: () => browser.activeId,
  isExecuting: () => executing,
  activeTurnId: () => activeTurnId,
  activeExecutionSessionId: () => activeExecutionSessionId,
  copy: (source) => copyButton(source),
  copyLive: (read) => copyButtonFrom(read),
  edit: (source) => editor.setValue(source),
  openInput: () => setSectionOpen(elements.inputHeading, elements.inputBody, true),
  retryTurn: (sessionId, turnId) => vscode.postMessage({ type: "retryTurn", sessionId, turnId }),
  renameTurn: (sessionId, turnId) => vscode.postMessage({ type: "renameTurn", sessionId, turnId }),
  forkFromTurn: (sessionId, turnId) => vscode.postMessage({ type: "forkFromTurn", sessionId, turnId }),
  addTurnToInput: (sessionId, turnId) => vscode.postMessage({ type: "addTurnToDext", sessionId, turnId }),
  copyTurn: (sessionId, turnId) => vscode.postMessage({ type: "copyTurn", sessionId, turnId }),
  deleteTurn: (sessionId, turnId) => vscode.postMessage({ type: "deleteTurn", sessionId, turnId }),
  openSpill: (sessionId, turnId) => vscode.postMessage({ type: "openSpillFile", sessionId, turnId }),
  createTodos: () => new AgentTodoView(),
  createQuestions: (turnId, sessionId) => createTurnQuestions(turnId, sessionId),
  openReference: (reference) => openInputReference(reference),
  syncResultToggle: () => syncResultToggle(),
  colorizeSource: (pre) => colorizeSource(pre)
});

const trace = new AgentTraceView({
  document,
  markdown: (text) => markdown.render(text),
  codeBlock: (text) => codeBlock(text),
  terminal: (text) => terminalText(text),
  panel: () => agentStreamPanel(),
  progressState: () => agentProgressState,
  updateProgress: (label) => updateAgentProgress(label),
  revealResult: () => elements.resultSection.classList.remove("hidden"),
  syncResultToggle: () => syncResultToggle(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle)
});

// Keep the rendered DOM for recently visited conversations. Rebuilding a
// long conversation means reparsing every process event and rerendering every
// diff, which made an ordinary tab switch scale with conversation size.
type CachedConversationViewState = {
  nodes: Node[];
  turns: Map<string, OutputTurnElements>;
  pendingAgentItems: HTMLElement[];
  activeTurnId?: string;
  signature: string;
};
const conversationViewCache = new ConversationViewStore<CachedConversationViewState>();

function cacheRenderedConversation(): void {
  if (!browser.renderedId || !browser.renderedSignature) return;
  // A running turn is represented by a live, non-persisted output row and
  // its process events are replayed when the tab becomes active again. Do
  // not cache that transient DOM or those events would be appended twice.
  if (runningConversationIds.has(browser.renderedId)) {
    for (const turn of transcript.values()) turn.questions?.suspend();
    elements.result.replaceChildren();
    return;
  }
  // Do not synchronously Markdown-render a potentially large trace from the
  // pointerdown handler. Keep the dirty items with the detached nodes and
  // render them after that conversation is restored.
  const pendingAgentItems = trace.takePendingItems();
  const activeTurnId = transcript.active?.disclosure.dataset.turnId;
  conversationViewCache.put(browser.renderedId, {
    nodes: [...elements.result.childNodes],
    turns: new Map(transcript.entries()),
    pendingAgentItems,
    ...(activeTurnId ? { activeTurnId } : {}),
    signature: browser.renderedSignature
  });
  for (const turn of transcript.values()) turn.questions?.suspend();
  elements.result.replaceChildren();
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
  browser.renderGeneration += 1;
  scroll.beginSwitch();
  cacheRenderedConversation();
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  resetAgentTrace();
  clearInputError();
  for (const turn of transcript.values()) turn.questions?.suspend();
  elements.result.replaceChildren();
  transcript.clear();
  transcript.active = undefined;
  browser.clearRendered();
  jumpToLatest.hidden = true;
  elements.resultBody.dataset.loading = "true";
  elements.resultBody.setAttribute("aria-busy", "true");
  syncResultToggle();
}

function finishConversationLoading(): void {
  delete elements.resultBody.dataset.loading;
  elements.resultBody.setAttribute("aria-busy", "false");
}

function restoreCachedAgentRenders(cached: CachedConversationViewState): void {
  for (const item of cached.pendingAgentItems) {
    if (item.isConnected) trace.scheduleMessageRender(item);
  }
  cached.pendingAgentItems = [];
}

const markdown = dextMarkdown();
markdown.use(markdownCodeCopy);

const editor = new DextCodeEditor({
  parent: elements.codeEditor,
  workerUri: document.querySelector<HTMLMetaElement>('meta[name="dext-editor-worker"]')!.content,
  dropTarget: elements.inputShell,
  clipboard,
  files: fileSearch,
  projects: projectReferences,
  resolveDroppedFiles: (paths) => fileDrop.resolve(paths),
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
  onError: renderError,
  // The host pushes the types too; asking means a Webview that missed that message
  // still gets a working editor instead of one that silently completes nothing.
  requestComposerTypes: () => vscode.postMessage({ type: "composerTypes" }),
  reportComposerTypes: (counts) => vscode.postMessage({ type: "composerTypesApplied", ...counts })
});

registerSlashCommandProvider(() => ({
  commands: sidebarState?.skillCommands ?? [],
  selectedSkillIds: sidebarState?.agentSelection.skills ?? []
}));

function openInputReference(reference: ContextReferenceOccurrence): void {  if (reference.kind === "project") {
    vscode.postMessage({ type: "openProjectReference", objectId: reference.payload });
    return;
  }
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

function composerSelectionLocked(): boolean {
  return executing || runningConversationIds.has(browser.activeId ?? "") || resourcePending.has(browser.activeId ?? "");
}

/** A preset that runs outside the Harness sandbox needs Full access on every
 * writable turn. Read-only turns substitute a confined preset, so only the turns
 * that apply the selection as-is are blocked. */
function fullAccessPresetRestriction(writableTurn: boolean): string | undefined {
  const selection = sidebarState?.agentSelection;
  // An unset preset blocks the turn when the Harness default it will run as does.
  const selectedPreset = harnessPresetOrDefault(selection?.agentPreset);
  const preset = selection?.profileId === "deepseek-harness"
    ? sidebarState?.agentProfiles.find((profile) => profile.id === selection.profileId)?.presets?.find((item) => item.id === selectedPreset)
    : undefined;
  if (!preset || !writableTurn) return undefined;
  return preset.error ?? (preset.requiresFullAccess && agentPermission !== "full-access"
    ? "This preset requires Full access in Agent or Plan mode." : undefined);
}

function updateRunState(): void {
  const selectionLocked = composerSelectionLocked();
  for (const control of [elements.modeControl, elements.permissionControl, elements.agentControl, elements.modelControl]) {
    control.disabled = selectionLocked;
  }
  elements.skillsControl.disabled = selectionLocked || sidebarState?.skillsEnabled === false;
  for (const menu of [elements.modeMenu, elements.permissionMenu, elements.agentMenu, elements.modelMenu, elements.modelSubmenu]) {
    for (const button of menu.querySelectorAll<HTMLButtonElement>("button")) button.disabled = selectionLocked || button.dataset.presetDisabled === "true" || button.dataset.permissionDisabled === "true";
  }
  if (selectionLocked) closeComposerMenus();
  const codeMode = !activeResource() && inputMode === "code";
  // Agent and Code send a writable turn, so they apply the preset as-is. Ask and
  // Plan's Send are read-only and substitute a confined preset instead.
  const presetRestriction = fullAccessPresetRestriction(inputMode === "agent" || codeMode);
  const resource = activeResource();
  const importing = pristineNewSkill(resource) && resourceSource === "import";
  const invalidImport = importing && !looksLikeGithubUrl(editor.source.trim());
  elements.inputSection.dataset.mode = resource ? "resource" : inputMode;
  if (resource) elements.inputSection.dataset.resourceType = resource.type;
  else delete elements.inputSection.dataset.resourceType;
  elements.run.disabled = executing
    ? stopping || !activeTurnId
    : resourcePending.has(browser.activeId ?? "") || !editor.source.trim() || Boolean(presetRestriction) || (codeMode && (hasErrors || inputKind === "invalid")) || invalidImport;
  elements.runLabel.textContent = executing ? (stopping ? "Stopping" : "Stop") : importing ? "Import" : codeMode ? "Run" : "Send";
  elements.run.title = !executing && (invalidImport ? "Paste a public GitHub URL" : presetRestriction) || elements.runLabel.textContent;
  elements.run.setAttribute("aria-label", elements.runLabel.textContent);
  const runIcon = elements.run.querySelector<HTMLElement>("i");
  if (runIcon) runIcon.className = `codicon codicon-${executing ? "debug-stop" : codeMode ? "play" : "arrow-up"}`;
  elements.run.classList.toggle("stopping", stopping);
  elements.run.classList.toggle("executing", executing);
  for (const [turnId, turn] of transcript.entries()) {
    turn.processDisclosure.classList.toggle("running-process",
      executing && turnId === activeTurnId && activeExecutionSessionId === browser.activeId);
  }
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
  renderResourceToolbar();
  syncTurnActions();
}

function renderPlanToolbar(): void {
  renderPlanToolbarView({
    document,
    elements: {
      toolbar: elements.planToolbar,
      target: elements.planTarget,
      choose: elements.planChoose,
      targetLabel: elements.planTargetLabel,
      status: elements.planStatus,
      build: elements.planBuild
    },
    hasResource: () => Boolean(activeResource()),
    inputMode: () => inputMode,
    activePlanPath: () => activePlanPath,
    planStatus: () => planStatus,
    projectContext: () => planProjectContext,
    executing: () => executing,
    stopping: () => stopping,
    activeTurnId: () => activeTurnId,
    buildRestriction: () => fullAccessPresetRestriction(true),
    preparingBuild: () => Boolean(activePlanPath) && !executing
      && (planStatus === "running"
        // The host reports its own state for this plan; the local wait only covers
        // the time before the first of those messages arrives.
        || (planStatus === "active" && pendingBuilds.get(browser.activeId ?? "") === activePlanPath)),
    setPlaceholder: (text) => editor.setPlaceholder(text),
    onResourceActive: renderResourceToolbar
  });
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
  const importing = pristineNewSkill(activeResource()) && resourceSource === "import";
  if (importing) {
    if (!looksLikeGithubUrl(source)) return;
    vscode.postMessage({ type: "executeInput", mode: "ask", source, resourceSource: "import" });
  } else if (inputMode === "plan" && activePlanPath) {
    vscode.postMessage({ type: "executeInput", mode: inputMode, source, planPath: activePlanPath });
  } else {
    vscode.postMessage({ type: "executeInput", mode: inputMode, source });
  }
  clearSubmittedInput();
}

function cancelUi(): void {
  pendingConfirmation = undefined;
  if (elements.uiDialog.open) elements.uiDialog.close();
}

function openConfirmationDialog(message: string, onConfirm: () => void): void {
  pendingConfirmation = onConfirm;
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

const mcp = new McpAssistantView({
  elements: {
    dialog: elements.mcpAssistantDialog, close: elements.mcpAssistantClose, input: elements.mcpAssistantInput,
    status: elements.mcpAssistantStatus, process: elements.mcpAssistantProcess, processMeta: elements.mcpAssistantProcessMeta,
    processBody: elements.mcpAssistantProcessBody, tools: elements.mcpAssistantTools, preview: elements.mcpAssistantPreview,
    scope: elements.mcpAssistantScope, scopeLabel: elements.mcpAssistantScopeLabel,
    generate: elements.mcpAssistantGenerate, save: elements.mcpAssistantSave
  },
  post: (message) => vscode.postMessage(message),
  beforeOpen: () => closeComposerMenus()
});

function sendResourceAction(type: "chooseResource" | "previewResource" | "saveResource"): void {
  if (!browser.activeId || composerSelectionLocked()) return;
  resourceErrors.delete(browser.activeId);
  clearInputError();
  resourcePending.add(browser.activeId);
  vscode.postMessage({ type, sessionId: browser.activeId });
  updateRunState();
}

function changeResourceOptions(resourceType: ResourceKind, scope: ResourceScope): void {
  const sessionId = browser.activeId;
  const resource = activeResource();
  if (!sessionId || !resource || composerSelectionLocked()) return;
  closeComposerMenus();
  const submit = (): void => {
    resourceErrors.delete(sessionId);
    resourcePending.add(sessionId);
    vscode.postMessage({ type: "resourceOptions", sessionId, resourceType, scope });
    updateRunState();
  };
  if (resourceType !== resource.type && resource.draft) {
    openConfirmationDialog("Discard the current resource draft and change its type?", submit);
  } else submit();
}

function pristineNewSkill(resource: ResourceSession | undefined): resource is ResourceSession {
  return Boolean(resource && resource.type === "skill" && !resource.target && !resource.draft);
}

/** Describe | Import belongs to one new Skill. A different type, target, draft,
 * conversation or mode starts a new decision, so the toggle resets to Describe. */
function renderResourceSource(resource: ResourceSession | undefined): void {
  const key = [
    browser.activeId ?? "", inputMode, resource?.type ?? "", resource?.scope ?? "",
    resource?.target?.path ?? "", resource?.draft ? "draft" : "", pristineNewSkill(resource) ? "new" : ""
  ].join("|");
  if (key !== resourceSourceKey) {
    resourceSourceKey = key;
    resourceSource = "describe";
  }
  const visible = pristineNewSkill(resource);
  elements.resourceSourceToggle.hidden = !visible;
  for (const button of [elements.resourceSourceDescribe, elements.resourceSourceImport]) {
    const selected = button.dataset.resourceSource === resourceSource;
    button.setAttribute("aria-selected", String(selected));
    button.classList.toggle("is-selected", selected);
    button.disabled = composerSelectionLocked();
  }
  elements.inputSection.classList.toggle("resource-import", visible && resourceSource === "import");
}

function renderResourceControls(): void {
  const resource = activeResource();
  renderResourceSource(resource);
  elements.modeControl.querySelector(".composer-control-label")!.textContent = resource ? "Resource" : "Mode";
  elements.permissionControl.querySelector(".composer-control-label")!.textContent = resource ? "Save to" : "Permission";
  elements.modeControl.title = resource ? "Resource type" : "Mode";
  elements.permissionControl.title = resource ? resourceDirectory(resource.scope, resource.type) : "Permission";
  if (!resource) return;
  elements.modeControlValue.textContent = RESOURCE_LABELS[resource.type];
  elements.modeControlIcon.className = `codicon codicon-${RESOURCE_ICONS[resource.type]}`;
  elements.permissionMenuShell.hidden = false;
  elements.permissionControlValue.textContent = resource.scope === "project" ? "Project" : "Global";
  elements.permissionControlIcon.className = "codicon codicon-folder";
  elements.permissionControl.classList.remove("is-full-access");
  renderComposerMenu(elements.modeMenu, (Object.entries(RESOURCE_LABELS) as Array<[ResourceKind, string]>)
    // Project norms live in this workspace's model, so the mode appears only when there is one.
    .filter(([type]) => type !== "project" || Boolean(sidebarState?.resourceRoots?.project))
    .map(([type, label]) => [type, label, `codicon-${RESOURCE_ICONS[type]}`]), resource.type,
  (type) => changeResourceOptions(type as ResourceKind, type === "project" ? "project" : resource.scope));
  const resourceKindKeys = (Object.keys(RESOURCE_LABELS) as ResourceKind[]).filter((type) => type !== "project" || Boolean(sidebarState?.resourceRoots?.project));
  for (const [index, button] of Array.from(elements.modeMenu.querySelectorAll("button")).entries()) {
    button.dataset.resourceType = resourceKindKeys[index]!;
  }
  const scopes: ResourceScope[] = resource.type === "file" || resource.type === "project"
    ? (sidebarState?.resourceRoots?.project ? ["project"] : [])
    : sidebarState?.resourceRoots?.project ? ["project", "global"] : ["global"];
  renderComposerMenu(elements.permissionMenu, scopes.map((scope) => [scope,
    `${resource.target && resource.scope !== scope ? "Save as · " : ""}${scope === "project" ? "Project" : "Global"}`, "codicon-folder"]), resource.scope,
    (scope) => changeResourceOptions(resource.type, scope as ResourceScope));
  for (const [index, button] of Array.from(elements.permissionMenu.querySelectorAll("button")).entries()) {
    const path = resourceDirectory(scopes[index]!, resource.type);
    button.title = path;
    const detail = document.createElement("small");
    detail.className = "resource-directory";
    detail.textContent = path;
    button.querySelector("span")?.append(detail);
  }
}

function resourceDirectory(scope: ResourceScope, type: ResourceKind): string {
  if (type === "file" && scope === "project") {
    const dextRoot = sidebarState?.resourceRoots?.project;
    if (dextRoot) return dextRoot.replace(/[\\/]\.dext$/, "") || ".";
  }
  return `${sidebarState?.resourceRoots?.[scope] ?? (scope === "project" ? ".dext" : ".dext-global")}/${RESOURCE_DIRECTORIES[type]}`;
}

function renderResourceToolbar(): void {
  const resource = activeResource();
  elements.resourceToolbar.hidden = !resource;
  if (!resource) return;
  const locked = composerSelectionLocked();
  const document = resource.draft ?? resource.target;
  const fileCount = 1 + (document?.files?.length ?? 0);
  elements.resourceTargetLabel.textContent = document?.name ?? "New resource";
  elements.resourceTarget.querySelector(".codicon")!.className = `codicon codicon-${RESOURCE_ICONS[resource.type]}`;
  elements.resourceTarget.title = resource.target ? `${resourceDirectory(resource.scope, resource.type)}/${resource.target.path}` : "Select a resource (or hold Shift and drop a file)";
  elements.resourceTarget.disabled = locked;
  elements.resourceChoose.disabled = locked;
  elements.resourcePreview.disabled = locked || !document;
  elements.resourcePreview.textContent = resource.draft && resource.target ? "View changes" : "Preview";
  elements.resourceSave.disabled = locked || !resource.draft;
  elements.resourceSave.textContent = resource.target ? "Save changes" : "Create";
  elements.resourceStatus.dataset.state = resourceErrors.has(browser.activeId ?? "") ? "error" : !locked && !resource.draft && resource.saved ? "saved" : "idle";
  elements.resourceStatus.textContent = resourceErrors.get(browser.activeId ?? "") ?? (resourcePending.has(browser.activeId ?? "") ? "Working…" : executing ? "Generating…" : resource.draft ? "Unsaved draft" : resource.saved ? "Saved" : resource.target ? "Editing" : "New resource");
  if (fileCount > 1 && !resourceErrors.has(browser.activeId ?? "")) elements.resourceStatus.textContent += ` · ${fileCount} files`;
  const importing = pristineNewSkill(resource) && resourceSource === "import";
  editor.setPlaceholder(importing
    ? "Paste a GitHub URL"
    : resource.type === "project" ? "Describe the norm to create…"
      : resource.target ? `Describe changes to ${resource.target.name}…` : `Describe the ${RESOURCE_LABELS[resource.type]} to create…`);
}

/** Applies the editor theme and Dext token styles to the sidebar document. */
function applySidebarTheme(state: SidebarState): void {
  editor.applyTheme(state.theme);
  let tokenStyle = document.getElementById("dext-token-theme");
  if (!tokenStyle) {
    tokenStyle = document.createElement("style");
    tokenStyle.id = "dext-token-theme";
    document.head.append(tokenStyle);
  }
  editor.refreshLanguageState();
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
  // A collapsed body is display:none, which drops the scroll offset. Reopening
  // the conversation while following its output has to end at the newest reply
  // again rather than at the top of the earliest turn.
  if (open && body === elements.resultBody) pinResultToBottom();
}

function toggleSection(heading: HTMLElement, body: HTMLElement): void {
  setSectionOpen(heading, body, heading.getAttribute("aria-expanded") !== "true");
}

function displayOptionValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function renderSkillsMenu(state: SidebarState, selected: readonly string[], enabled: boolean): void {
  const menu = elements.skillsMenu;
  menu.replaceChildren();
  const groups = groupSkills(state.skills ?? [], state.skillCommands ?? []);
  if (!enabled) {
    const note = document.createElement("div");
    note.className = "composer-menu-empty";
    note.textContent = state.skillsDisabledReason ?? "Skills are disabled in this workspace.";
    menu.append(note);
    return;
  }
  if (!groups.length) {
    const note = document.createElement("div");
    note.className = "composer-menu-empty";
    note.textContent = "No skills are installed. Add a SKILL.md package under .dext/skills or import a GitHub repository.";
    menu.append(note);
    return;
  }
  const row = (options: {
    label: string;
    value: string;
    checked: "checked" | "mixed" | "unchecked";
    level: number;
    pack?: boolean;
    commands?: string;
    disabled?: boolean;
    onToggle(): void;
  }): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = options.disabled === true;
    button.className = `composer-menu-option composer-skill-option${options.pack ? " composer-skill-pack" : ""}`;
    button.dataset.level = String(options.level);
    button.dataset.value = options.value;
    button.tabIndex = -1;
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-checked", options.checked);
    const glyph = document.createElement("i");
    glyph.className = `codicon codicon-${options.checked === "checked" ? "check" : options.checked === "mixed" ? "circle-filled" : "blank"}`;
    const text = document.createElement("span");
    text.textContent = options.label;
    if (options.commands) {
      const hint = document.createElement("small");
      hint.className = "composer-skill-commands";
      hint.textContent = options.commands;
      text.append(hint);
    }
    button.append(glyph, text);
    button.addEventListener("click", () => { if (!composerSelectionLocked() && enabled) options.onToggle(); });
    return button;
  };
  for (const group of groups) {
    if (group.packId) {
      const availableIds = group.skills.filter((skill) => skill.available !== false).map((skill) => skill.id);
      const check = packCheckState(availableIds, selected);
      menu.append(row({
        label: group.name, value: `pack:${group.packId}`, checked: check, level: 0, pack: true,
        commands: `${group.skills.length} skill${group.skills.length === 1 ? "" : "s"}`,
        disabled: availableIds.length === 0,
        onToggle: () => submitAgentSelection({ skills: togglePack(selected, availableIds, check !== "checked") }, true)
      }));
    }
    for (const skill of group.skills) {
      const commands = group.commands.filter((command) => command.skillId === skill.id);
      menu.append(row({
        label: skill.title, value: `skill:${skill.id}`, checked: selected.includes(skill.id) ? "checked" : "unchecked", level: 1,
        commands: skill.available === false ? "No version for this Agent or shared fallback"
          : [skill.variant ? `${displayOptionValue(skill.variant)} version` : "", ...commands.map((command) => command.syntax)].filter(Boolean).join(" · "),
        disabled: skill.available === false && !selected.includes(skill.id),
        onToggle: () => submitAgentSelection({ skills: toggleSkill(selected, skill.id) }, true)
      }));
    }
  }
}

function renderSkillsControl(state: SidebarState): void {
  const resource = activeResource();
  const visible = !resource && inputMode !== "code";
  elements.skillsMenuShell.hidden = !visible;
  if (!visible) {
    if (!elements.skillsMenu.hidden) closeComposerMenus();
    return;
  }
  const selected = state.agentSelection.skills ?? [];
  const enabled = state.skillsEnabled !== false;
  elements.skillsControl.disabled = composerSelectionLocked() || !enabled;
  elements.skillsControl.title = enabled
    ? "Skills for this conversation"
    : state.skillsDisabledReason ?? "Skills are disabled in this workspace.";
  elements.skillsControlValue.textContent = selectionLabel(selected, state.skills ?? []);
  elements.skillsControl.classList.toggle("has-skills", selected.length > 0);
  const focused = document.activeElement instanceof HTMLElement && elements.skillsMenu.contains(document.activeElement)
    ? document.activeElement.dataset.value
    : undefined;
  renderSkillsMenu(state, selected, enabled);
  // Rebuilding the tree must not drop roving keyboard focus after a toggle.
  if (focused) elements.skillsMenu.querySelector<HTMLButtonElement>(`button[data-value="${focused}"]`)?.focus();
}

function renderAgentControls(state: SidebarState): void {
  sidebarState = state;
  // A tab with no stored mode is a fresh conversation and must use Agent. Do
  // not retain the previous tab's mode in the webview-local fallback.
  inputMode = activeResource() ? "ask" : state.agentSelection.mode ?? "agent";
  if (state.settings) {
    editor.setSubmitOnEnter(state.settings.submitOnEnter);
  }
  editor.setMode(inputMode === "code" ? "code" : "chat");
  const selected = state.agentProfiles.find((item) => item.id === state.agentSelection.profileId)
    ?? state.agentProfiles[0];
  const effective = presentAgentSelection(selected, state.agentSelection);
  const options = effective.options;
  const selectedModel = options.find((item) => item.id === effective.model);
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
  const selectedModelLabel = effective.modelLabel;
  const selectedEffort = effective.reasoningEffort;
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
    // The badge is local, so the editor has to follow it now: waiting for the host to
    // echo the selection leaves a Code badge above a plain-text model, which completes
    // nothing and shows no diagnostics at all.
    editor.setMode(inputMode === "code" ? "code" : "chat");
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
  for (const button of elements.permissionMenu.querySelectorAll<HTMLButtonElement>("button[data-value]")) {
    const permission = button.dataset.value as AgentPermission;
    if (selected?.writablePermissions && !selected.writablePermissions.includes(permission)) {
      button.disabled = true;
      button.dataset.permissionDisabled = "true";
      button.title = `${selected.label} requires an explicit Full access selection for writes. Ask and plan generation remain read-only.`;
    }
  }
  elements.permissionControl.title = selected?.provider === "pi" && agentPermission === "workspace-write"
    ? "Pi does not support Workspace write. Select Full access explicitly for Agent edits or plan execution." : "Permission";
  renderComposerMenu(elements.agentMenu, state.agentProfiles.map((item) => [item.id, item.label, "codicon-account"]), selected?.id ?? "", (profileId) => {
    submitAgentSelection({ profileId, model: "", reasoningEffort: "", speed: "", serviceTier: "",
      agentPreset: state.agentSelection.agentPreset ?? (profileId === "deepseek-harness" && !transcript.size ? DEFAULT_HARNESS_PRESET : "") });
  });
  renderModelMenu(state, options, selectedModel);
  renderSkillsControl(state);
  renderResourceControls();
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
    button.dataset.value = value;
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
    button.addEventListener("click", () => {
      if (!composerSelectionLocked()) onSelect(value);
    });
    menu.append(button);
  }
}

function renderModelMenu(
  state: SidebarState,
  options: readonly { id: string; label: string; group?: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string }[],
  selectedModel: { id: string; label: string; group?: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string } | undefined
): void {
  const current = state.agentSelection;
  const profile = state.agentProfiles.find((item) => item.id === current.profileId) ?? state.agentProfiles[0];
  const effective = presentAgentSelection(profile, current);
  const selectedSpeed = effective.speed;
  const categories: { title: string; value: string; items: readonly { value: string; label: string; group?: string }[]; selected: string; onSelect: (value: string) => void }[] = [
    {
      title: "Model",
      value: effective.modelLabel,
      items: options.map((item) => ({ value: item.id, label: item.label, ...(item.group ? { group: item.group } : {}) })),
      selected: effective.model,
      onSelect: (model) => {
        const next = options.find((item) => item.id === model);
        submitAgentSelection({ model, reasoningEffort: next?.defaultReasoningEffort ?? "", speed: "", serviceTier: "" });
      }
    },
    {
      title: "Reasoning",
      value: displayOptionValue(effective.reasoningEffort || "CLI setting"),
      items: (selectedModel?.reasoningEfforts ?? []).map((item) => ({ value: item, label: displayOptionValue(item) })),
      selected: effective.reasoningEffort,
      onSelect: (reasoningEffort) => submitAgentSelection({ reasoningEffort })
    },
    {
      title: "Speed",
      value: displayOptionValue(selectedSpeed || "CLI setting"),
      items: (profile?.provider === "codex" ? CLI_SPEEDS : []).map((item) => ({ value: item, label: displayOptionValue(item) })),
      selected: selectedSpeed,
      onSelect: (speed) => submitAgentSelection({ speed, serviceTier: "" })
    }
  ];
  elements.modelMenu.replaceChildren();
  elements.modelMenu.dataset.modelMenuView = "categories";
  elements.modelSubmenu.replaceChildren();
  elements.modelSubmenu.hidden = true;
  if (profile?.provider === "deepseek-harness") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option composer-menu-category";
    button.tabIndex = -1;
    const title = document.createElement("span");
    title.textContent = "Agent preset";
    const value = document.createElement("span");
    value.className = "composer-menu-category-value";
    // The catalog is the only source of preset choices; an unset selection is
    // shown as the Harness default it will run as.
    const selectedPreset = harnessPresetOrDefault(current.agentPreset);
    value.textContent = profile.presets?.find((preset) => preset.id === selectedPreset)?.label ?? selectedPreset;
    const chevron = document.createElement("i");
    chevron.className = "codicon codicon-chevron-right";
    button.append(title, value, chevron);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!composerSelectionLocked()) renderHarnessPresetChoices(state);
    });
    elements.modelMenu.append(button);
  }
  if (!options.length) {
    const empty = document.createElement("div");
    empty.className = "composer-menu-empty";
    empty.textContent = profile?.provider === "pi" ? "No Pi models discovered. Associate an installed Pi CLI using Dext: Configure Agent; configure models and authentication in Pi."
      : profile?.provider === "deepseek-harness"
      ? "No models discovered. Using the Harness configuration; run Dext: Configure Agent to refresh this list."
      : "No models are available for this Agent.";
    elements.modelMenu.append(empty);
    if (profile?.provider === "deepseek-harness") appendHarnessPresetManagementMenu();
    return;
  }
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
      if (composerSelectionLocked()) return;
      renderModelChoices(elements.modelSubmenu, category.title, category.items, category.selected, category.onSelect);
    };
    button.addEventListener("click", openChoices);
    elements.modelMenu.append(button);
  }
  if (profile?.provider === "deepseek-harness") appendHarnessPresetManagementMenu();
  if (profile?.provider === "pi" && state.piPlugins?.length) appendPluginCategory(state);
}

/** The installed Pi packages this conversation runs with. An absent selection
 * means every package, which is what a new conversation starts on. */
function appendPluginCategory(state: SidebarState): void {
  const installed = state.piPlugins ?? [];
  const selected = state.agentSelection.piPlugins;
  const count = selected ? selected.length : installed.length;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "composer-menu-option composer-menu-category";
  button.tabIndex = -1;
  const title = document.createElement("span");
  title.textContent = "Plugins";
  const value = document.createElement("span");
  value.className = "composer-menu-category-value";
  value.textContent = count === 0 ? "None" : count === installed.length ? `All (${count})` : `${count} of ${installed.length}`;
  const chevron = document.createElement("i");
  chevron.className = "codicon codicon-chevron-right";
  button.append(title, value, chevron);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!composerSelectionLocked()) renderPluginChoices(state);
  });
  elements.modelMenu.append(button);
}

function renderPluginChoices(state: SidebarState): void {
  const menu = elements.modelSubmenu;
  renderModelChoices(menu, "Plugins", [], "", () => undefined);
  const installed = state.piPlugins ?? [];
  const selected = state.agentSelection.piPlugins ?? installed.map((plugin) => plugin.id);
  for (const plugin of installed) {
    const checked = selected.includes(plugin.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitemcheckbox");
    button.setAttribute("aria-checked", String(checked));
    const text = document.createElement("span");
    text.textContent = plugin.label;
    const check = document.createElement("i");
    check.className = `codicon codicon-${checked ? "check" : "blank"}`;
    button.append(text, check);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      submitAgentSelection({ piPlugins: checked ? selected.filter((id) => id !== plugin.id) : [...selected, plugin.id] });
    });
    menu.append(button);
  }
}

function appendHarnessPresetManagementMenu(): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "composer-menu-option composer-preset-management";
  button.tabIndex = -1;
  const label = document.createElement("span");
  label.textContent = "Manage presets";
  const chevron = document.createElement("i");
  chevron.className = "codicon codicon-chevron-right";
  button.append(label, chevron);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!composerSelectionLocked()) renderHarnessPresetManagement();
  });
  elements.modelMenu.append(button);
}

function renderHarnessPresetChoices(state: SidebarState): void {
  const profile = state.agentProfiles.find((item) => item.id === "deepseek-harness");
  // Dext offers exactly the installed Harness catalog, and an unset selection
  // reads as the Harness default it will run as.
  const presets: readonly HarnessPresetOption[] = profile?.presets ?? [];
  const current = harnessPresetOrDefault(state.agentSelection.agentPreset);
  const locked = transcript.size > 0;
  // Agent turns are always writable, and a Plan conversation applies the preset
  // when the plan builds. Ask is read-only and Code carries its own per-call
  // permission, so neither mode can decide a preset that needs Full access.
  const writable = inputMode === "agent" || inputMode === "plan";
  const fullAccess = state.agentSelection.permission === "full-access" && writable;
  const menu = elements.modelSubmenu;
  renderModelChoices(menu, "Agent preset", [], current, () => undefined);
  if (locked) {
    const note = document.createElement("div");
    note.className = "composer-menu-empty";
    note.textContent = "This conversation keeps its preset. Start a new conversation to change it.";
    menu.append(note);
  }
  if (!presets.length) {
    const missing = document.createElement("div");
    missing.className = "composer-menu-empty";
    missing.textContent = "No Harness presets found. Refresh presets or check the installed Harness.";
    menu.append(missing);
  }
  for (const preset of presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(preset.id === current));
    const restriction = preset.requiresFullAccess && !fullAccess;
    const buildOnly = !restriction && Boolean(preset.writableTurnsOnly) && writable && inputMode === "plan";
    button.disabled = locked || Boolean(preset.error) || restriction;
    button.dataset.presetDisabled = String(button.disabled);
    button.title = preset.error || (restriction ? "Requires Full access in Agent or Plan mode."
      : buildOnly ? "Planning turns stay read-only; this preset runs when the plan builds." : preset.description);
    const label = document.createElement("span");
    label.textContent = `${preset.label}${preset.error ? " (unavailable)" : restriction ? " (Full access)" : buildOnly ? " (Build only)" : ""}`;
    const check = document.createElement("i");
    check.className = `codicon codicon-${preset.id === current ? "check" : "blank"}`;
    button.append(label, check);
    button.addEventListener("click", (event) => { event.stopPropagation(); submitAgentSelection({ agentPreset: preset.id }); });
    menu.append(button);
  }
  if (presets.length && !presets.some((preset) => preset.id === current)) {
    const missing = document.createElement("div");
    missing.className = "composer-menu-empty";
    missing.textContent = `Preset '${current}' is unavailable. Refresh presets or choose another in a new conversation.`;
    menu.append(missing);
  }
  positionModelSubmenu();
}

function renderHarnessPresetManagement(): void {
  const menu = elements.modelSubmenu;
  renderModelChoices(menu, "Manage presets", [], "", () => undefined);
  const actions: ["refresh", string][] = [["refresh", "Refresh presets"]];
  for (const [action, label] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
    button.tabIndex = -1;
    button.setAttribute("role", "menuitem");
    const text = document.createElement("span");
    text.textContent = label;
    button.append(text);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (composerSelectionLocked()) return;
      closeComposerMenus();
      vscode.postMessage({ type: "harnessPresetAction", action });    });
    menu.append(button);
  }
  positionModelSubmenu();
}

function renderModelChoices(
  menu: HTMLElement,
  title: string,
  items: readonly { value: string; label: string; group?: string }[],
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
  let priorGroup: string | undefined;
  for (const { value, label, group } of items) {
    if (group && group !== priorGroup) {
      const heading = document.createElement("div");
      heading.className = "composer-model-group-heading";
      heading.textContent = group;
      menu.append(heading);
    }
    priorGroup = group;
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
      if (composerSelectionLocked()) return;
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
  const side = fitsRight ? "right" : fitsLeft ? "left" : "above";
  elements.modelSubmenu.dataset.submenuSide = side;
  elements.modelSubmenu.style.left = side === "above"
    ? `${modelMenu.left - elements.modelSubmenu.parentElement!.getBoundingClientRect().left}px` : "";
  elements.modelSubmenu.style.setProperty("--composer-model-menu-height", `${modelMenu.height}px`);
  elements.modelSubmenu.style.maxHeight = side === "above"
    ? `${Math.max(0, modelMenu.top - gap - edgePadding)}px` : "";
}

window.addEventListener("resize", positionModelSubmenu);

function submitAgentSelection(change: Partial<SidebarState["agentSelection"]>, keepMenuOpen = false): void {
  if (composerSelectionLocked()) return;
  const selection = sidebarState?.agentSelection;
  if (!keepMenuOpen) closeComposerMenus();
  vscode.postMessage({
    type: "agentSelection", selection: {
      mode: inputMode,
      permission: change.permission ?? agentPermission,
      profileId: change.profileId ?? selection?.profileId ?? "",
      model: change.model ?? selection?.model ?? "",
      agentPreset: harnessPresetOrDefault(change.agentPreset ?? selection?.agentPreset),
      reasoningEffort: change.reasoningEffort ?? selection?.reasoningEffort ?? "",
      speed: change.speed ?? selection?.speed ?? "",
      serviceTier: change.serviceTier ?? selection?.serviceTier ?? "",
      ...(change.skills !== undefined || selection?.skills?.length
        ? { skills: change.skills ?? selection?.skills ?? [] }
        : {}),
      ...(change.piPlugins !== undefined || selection?.piPlugins
        ? { piPlugins: change.piPlugins ?? selection?.piPlugins ?? [] }
        : {})
    }
  });
}

function selectConversation(sessionId: string): void {
  if (sessionId === browser.activeId) return;
  const switchId = browser.beginSelection(sessionId);
  // Commit the tab highlight and remove the prior tab's view in the same
  // event.  The replacement is restored from cache or received from the host
  // afterwards, so a slow response never leaves stale conversation content
  // below an already-selected tab.
  if (sidebarState) renderAgentControls(sidebarState);
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
  if (drafts.hasUnsent(sessionId)) {
    const title = [...elements.conversationTabs.querySelectorAll<HTMLElement>(".conversation-tab")]
      .find((tab) => tab.dataset.sessionId === sessionId)?.title ?? "this conversation";
    openConfirmationDialog(`Discard the unsent draft in “${title}” and close it?`, () => {
      drafts.delete(sessionId);
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

const conversationTabDrag = enableConversationTabDrag(elements.conversationTabs, (sessionId, beforeSessionId) => {
  vscode.postMessage({ type: "moveConversation", sessionId, beforeSessionId });
});

function renderConversations(sessions: readonly ConversationSummary[], activeId: string): void {
  const activeChanged = browser.setActiveId(activeId);
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
  }
  updateRunState();
  const activeTab = renderConversationTabs({
    document,
    container: elements.conversationTabs,
    actions: { select: selectConversation, close: closeConversation, pin: pinConversation }
  }, sessions, activeId);
  conversationTabDrag.refresh();
  if (!conversationTabDrag.tracking()) activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  conversationTabDrag.refresh();
  if (!conversationTabDrag.tracking()) activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const composerMenus = [
  { control: elements.modeControl, menu: elements.modeMenu },
  { control: elements.skillsControl, menu: elements.skillsMenu },
  { control: elements.permissionControl, menu: elements.permissionMenu },
  { control: elements.agentControl, menu: elements.agentMenu },
  { control: elements.modelControl, menu: elements.modelMenu }
];

observeComposerOverflow(element<HTMLElement>("composer-controls"));

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
  return [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")].filter((button) => !button.disabled);
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
  if (composerSelectionLocked()) return;
  closeComposerMenus(menu.hidden ? menu : undefined);
  if (!menu.hidden) {
    queueMicrotask(() => {
      const items = composerMenuItems(menu);
      const selected = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
      focusComposerMenuItem(menu, selected >= 0 ? selected : 0);
    });
  }
}

function copyButton(text: string): HTMLButtonElement {
  return copyButtonFrom(() => text);
}

/** Streaming sections resolve their payload at click time. */
function copyButtonFrom(read: () => string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button compact output-copy";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy");
  const icon = document.createElement("i");
  icon.className = "codicon codicon-copy";
  button.append(icon);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void clipboard.write(read()).then((success) => {
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
  return renderTurnJson(turnDomAdapter(document), content, copyButton(content)) ?? copyableText(content);
}


function terminalText(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const segment of terminalSegments(content)) {
    if (!segment.classes.length && segment.color === undefined) {
      fragment.append(document.createTextNode(segment.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = segment.classes.join(" ");
    if (segment.color !== undefined) span.style.color = segment.color;
    span.textContent = segment.text;
    fragment.append(span);
  }
  return fragment;
}

function copyableText(content: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "markdown-body";
  body.innerHTML = markdown.render(content);
  renderMarkdownDiagrams(body);
  return renderTurnMarkdown(turnDomAdapter(document), body);
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

function syncTurnActions(): void {
  for (const button of elements.result.querySelectorAll<HTMLButtonElement>(".output-turn-action[data-disable-while-running], .plan-action.primary")) {
    const turn = button.closest<HTMLElement>(".output-turn");
    button.disabled = executing && (!turn || turn.dataset.turnId === activeTurnId);
  }
}


function renderExecution(response: RuntimeResponse): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(...renderTurnResult({
    ...turnDomAdapter(document),
    markdown: copyableText,
    json: jsonOutput,
    plan: (planPath) => planActions(document, planPath, (reference) => vscode.postMessage({ type: "openFileReference", reference }))
  }, response.result, response.patchApplication));
  return fragment;
}

function renderResult(response: InputExecutionResponse): void {  const target = transcript.active?.output ?? elements.result;
  target.replaceChildren();
  const entries: WorkflowStepResponse[] = response.steps ?? response.executions.map((execution) => ({
    method: execution.method.id,
    state: "success" as const,
    response: execution
  }));
  trace.renderFileChanges(entries);
  // Comprehension branches ran at the same time, so they are laid out beside one
  // another instead of pretending they were a sequence.
  let fanOut: HTMLElement | undefined;
  for (const [index, step] of entries.entries()) {
    // No `echo: true` — the call keeps its own result out of Output.
    if (step.quiet) {
      if (step.branch === undefined) fanOut = undefined;
      continue;
    }
    const item = document.createElement("section");
    item.className = "execution-result";
    if (step.response) item.append(renderExecution(step.response));
    else if (step.stream) {
      // Process output is not an API call, so it gets no card of its own.
      const output = document.createElement("pre");
      output.className = `process-output process-output-${step.stream.channel}`;
      output.dataset.channel = step.stream.channel;
      output.textContent = step.stream.text;
      item.append(output);
    } else {
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
      if (item.childNodes.length > 0) target.append(item);
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
  const outputCopy = entries.flatMap((step) => {
    if (step.quiet) return [];
    if (step.response) return [resultCopyText(step.response.result)];
    if (step.stream) return [step.stream.text];
    return [];
  }).filter(Boolean).join("\n\n");
  transcript.active?.setOutputCopy?.(outputCopy);
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
}

function clearInputError(): void {
  elements.inputErrorMessage.textContent = "";
  elements.inputError.hidden = true;
}

function renderInputError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  elements.inputErrorMessage.textContent = text;
  elements.inputError.hidden = false;
}

function renderOutputError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  const target = transcript.active?.output ?? elements.result;
  target.replaceChildren();
  const summary = document.createElement("pre");
  summary.className = "error-output";
  summary.textContent = text;
  target.append(summary);
  transcript.active?.setOutputCopy?.("");
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
}

function renderError(message: unknown): void {
  renderInputError(message);
}

function syncJumpToLatest(): void {
  scroll.syncJumpControls();
}

function reportStaleResultRange(): void {
  scroll.reportStaleRange();
}

function syncResultScrollGutter(): void {
  scroll.syncGutter();
}

/** A running turn follows its Process timeline only while that timeline is
 * visible. Keeping the disclosure closed is an explicit reader choice; new
 * events must not reopen it or pull the reader back to the live end. */
function resultFollowAllowed(): boolean {
  return !executing || !transcript.active?.processDisclosure || transcript.active.processDisclosure.open;
}

function pinResultToBottom(): void {
  scroll.pin();
}

function scrollResultToBottom(): void {
  scroll.scrollToBottom();
}

function agentStreamPanel(): HTMLElement {
  if (agentStream?.isConnected) return agentStream;
  const panel = document.createElement("section");
  panel.className = "agent-stream-panel";
  (transcript.active?.process ?? elements.result).append(panel);
  agentStream = panel;
  // Process already owns the first-level disclosure. Put live run metadata in
  // its title instead of nesting a second disclosure around the timeline.
  agentProgress = transcript.active?.processMeta;
  updateAgentProgress(agentProgressState);
  return panel;
}

function updateAgentProgress(label: string): void {
  if (!agentProgress) return;
  agentProgressState = label;
  const elapsed = agentRunStartedAt ? Math.max(0, Date.now() - agentRunStartedAt) : 0;
  const tokenLabel = formatTurnTokenUsage(agentTokenUsage);
  const details = [
    tokenLabel,
    trace.editedFileCount() ? `Edited ${trace.editedFileCount()} file${trace.editedFileCount() === 1 ? "" : "s"}` : "",
    trace.commandCount() ? `Ran ${trace.commandCount()} command${trace.commandCount() === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  const text = `${agentProgressState} for ${formatDuration(elapsed)}${details.length ? ` · ${details.join(" · ")}` : ""}`;
  // The timer polls faster than the displayed duration changes. Keep the text
  // node stable between changes instead of invalidating layout on every tick.
  if (agentProgress.textContent !== text) agentProgress.textContent = text;
}

function startAgentProgress(startedAt = Date.now()): void {
  agentRunStartedAt = startedAt;
  agentStreamPanel();
  updateAgentProgress("Thinking");
  agentRunTimer = setInterval(() => updateAgentProgress(agentProgressState), 100);
}

function finishAgentProgress(): void {
  transcript.active?.todos.setRunning(false);
  transcript.active?.questions?.setRunning(false);
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  updateAgentProgress("Worked");
}

function revealWaitingCard(kind: "agent" | "ui", requestId: string, blocking: boolean): void {
  // A question the agent answers in parallel does not park the turn; leaving
  // the reader where they were is the honest behaviour for it.
  if (!blocking || !transcript.active?.questions.focusRequest(kind, requestId)) return;
  scroll.setFollowing(false);
  syncJumpToLatest();
}

function renderAgentEvent(event: AgentStreamEvent): void {
  if (event.phase === "input") {
    if (event.userInput && transcript.active?.questions?.update(event.userInput)) {
      revealWaitingCard("agent", event.userInput.id, event.userInput.blocking);
    }
    if (event.uiInteraction && transcript.active?.questions?.updateUi(event.uiInteraction)) {
      revealWaitingCard("ui", event.uiInteraction.requestId, true);
    }
    return;
  }
  if (event.phase === "todo") {
    if (event.todos) transcript.active?.todos.update(event.todos);
    return;
  }
  if (event.usage) agentTokenUsage = updateTurnTokenUsage(agentTokenUsage, event.usage);
  if (event.phase === "status") {
    updateAgentProgress(event.text || agentProgressState);
    return;
  }
  trace.renderEvent(event);
  transcript.active?.setProcessCopy?.(trace.copyText());
}

function resetAgentTrace(): void {
  trace.reset();
  agentStream = undefined;
  agentProgress = undefined;
  agentProgressState = "Thinking";
  agentTokenUsage = undefined;
  pendingAgentEventBatches = [];
  if (agentEventBatchFrame !== undefined) cancelAnimationFrame(agentEventBatchFrame);
  agentEventBatchFrame = undefined;
}

function flushAgentEventBatches(): void {
  agentEventBatchFrame = undefined;
  const batches = pendingAgentEventBatches;
  pendingAgentEventBatches = [];
  const events = batches
    .filter((batch) => batch.sessionId === browser.activeId)
    .flatMap((batch) => batch.events);
  if (!events.length) return;
  for (const event of events) renderAgentEvent(event);
  if (scroll.consumeForcedInitialScroll()) {
    scrollResultToBottom();
  } else {
    pinResultToBottom();
  }
  syncJumpToLatest();
}

function queueAgentEvents(sessionId: string, events: readonly AgentStreamEvent[]): void {
  if (sessionId !== browser.activeId || !events.length) return;
  pendingAgentEventBatches.push({ sessionId, events: [...events] });
  if (agentEventBatchFrame === undefined) {
    agentEventBatchFrame = requestAnimationFrame(flushAgentEventBatches);
  }
}

/** Replay a stored turn synchronously without consuming the live turn's queues,
 * reusing its event IDs, or stopping its progress timer. Scheduled callbacks
 * resume with the original state after this scope returns. */
function withIsolatedAgentTrace(turn: OutputTurnElements, render: () => void): void {
  const previous = {
    activeTurn: transcript.active, agentStream, agentRunStartedAt, agentRunTimer,
    agentProgress, agentProgressState, agentTokenUsage,
    pendingAgentEventBatches, agentEventBatchFrame
  };
  const traceState = trace.isolate();
  agentEventBatchFrame = undefined;
  agentRunTimer = undefined;
  resetAgentTrace();
  transcript.active = turn;
  try {
    render();
    // Historical prose must be painted before restoring the live render queue.
    trace.flushMessageRenders();
  } finally {
    trace.restore(traceState);
    ({
      activeTurn: transcript.active, agentStream, agentRunStartedAt, agentRunTimer,
      agentProgress, agentProgressState, agentTokenUsage,
      pendingAgentEventBatches, agentEventBatchFrame
    } = previous);
  }
}

function storedResponse(record: DextHistoryRecord): InputExecutionResponse | undefined {
  return readHistoryResponse(record);
}

/** Populate a history turn only when its disclosure is opened.  The shell
 * still exposes the input title and turn actions, while expensive Markdown,
 * syntax highlighting, diffs, and streamed process events stay out of the
 * tab-switch critical path. */
function hydrateStoredTurn(record: DextHistoryRecord, turn: OutputTurnElements): void {
  if (turn.hydrated) return;
  withIsolatedAgentTrace(turn, () => renderStoredTurn(record, turn));
  turn.hydrated = true;
}

function renderStoredTurn(record: DextHistoryRecord, turn: OutputTurnElements): void {
  const response = storedResponse(record);

  // Plan turns use a more useful title once their response has been parsed.
  // Keep that JSON parse off the tab-switch path and update the lightweight
  // summary only after deferred hydration completes.
  const planExecution = response?.executions.find((item) => item.result.kind === "plan" && item.result.executePlan);
  const planResult = planExecution?.result.kind === "plan" ? planExecution.result : undefined;
  if (record.executePlan || planResult?.executePlan) {
    if (turn.planExecutionStatus) {
      turn.planExecutionStatus.hidden = false;
      turn.planExecutionStatus.textContent = planExecutionLabel(record.process, record.error, record.planOutcome ?? planResult?.planOutcome);
    }
    const planPath = record.planPath ?? planResult?.planPath;
    if (planPath) turn.title.setPlanPath(planPath);
    // Older records have no execution metadata until their response is parsed.
    // Remove the generic shell before rendering the internal build prompt.
    turn.input?.closest(".output-turn-section")?.remove();
    delete turn.input;
  }

  agentRunStartedAt = Date.now();
  if (turn.input && turn.input.childElementCount === 0) {
    // Hydrated history renders the persisted source exactly as authored, in the colors
    // the composer wrote it in: a record's mode says whether that source was code.
    const inputCopy = renderTurnInput(turnDomAdapter(document), transcript.renderInputSource(record.input, record.mode));
    turn.input.append(inputCopy);
  }
  const replay = typeof prepareHistoryTrace === "undefined" ? record.process : prepareHistoryTrace(record.process);
  for (const event of replay) renderAgentEvent(event);
  turn.setProcessCopy?.(trace.copyText());
  if (agentStream) finishAgentProgress();
  const duration = response?.executions.reduce((total, item) => total + item.durationMs, 0) ?? 0;
  if (turn.processMeta) turn.processMeta.textContent = presentTurn({
    source: record.input, mode: record.mode, durationMs: duration, process: record.process
  }).process.detail ?? "";
  turn.todos.setRunning(false);
  turn.processDisclosure.open = false;
  if (record.error) renderOutputError(record.error);
  else if (response) renderResult(response);
  else if (record.output) {
    turn.output.append(jsonOutput(record.output));
    turn.setOutputCopy?.(record.output);
  }
  turn.outputDisclosure.open = true;
  syncResultToggle();
}

function hydrateOutputTurnOnOpen(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement) || !target.open || !target.classList.contains("output-turn")) return;
  const turnId = target.dataset.turnId;
  if (!turnId) return;
  const turn = transcript.get(turnId);
  if (!turn?.hydrate) return;
  turn.hydrate();
  // A hydrated turn can be far taller than its collapsed row. Following the
  // output has to survive that growth; a reader who scrolled away is unaffected.
  pinResultToBottom();
}

function renderOutputSession(session: DextHistorySession): void {
  const signature = conversationSignature(session);
  const sessionTurnIds = new Set(session.turns.map((turn) => turn.id));
  // A newly streamed row is newer than the last historical signature. Deleting
  // that row can return to the same signature while the DOM still contains it.
  const visibleTurnsMatch = transcript.size === sessionTurnIds.size
    && [...transcript.keys()].every((turnId) => sessionTurnIds.has(turnId));
  if (browser.renderedId === session.id && browser.renderedSignature === signature && visibleTurnsMatch) {
    return;
  }
  if (browser.renderedId && browser.renderedId !== session.id) cacheRenderedConversation();

  // Normally the host sends the historical session before replaying an active
  // execution. A cache-ref miss can invert those two deliveries, however. In
  // that case retain the already-created live row while rebuilding the stored
  // rows, otherwise accepting the late session would erase the stream.
  const liveTurn = executing && activeExecutionSessionId === session.id && transcript.active && activeTurnId
    ? transcript.active
    : undefined;
  const liveTurnId = liveTurn ? activeTurnId : undefined;

  const cached = conversationViewCache.get(session.id);
  // Also verify turn identities. Older builds persisted a different id than
  // the live row, so blindly restoring such a snapshot would keep delete and
  // retry actions broken until the webview was fully reloaded.
  const cacheMatchesSession = cached
    && cached.turns.size === sessionTurnIds.size
    && [...cached.turns.keys()].every((turnId) => sessionTurnIds.has(turnId));
  if (!liveTurn && cached && cached.signature === signature && cacheMatchesSession) {
    elements.result.replaceChildren(...cached.nodes);
    for (const turn of cached.turns.values()) turn.questions?.resume();
    restoreCachedAgentRenders(cached);
    transcript.clear();
    for (const [turnId, turn] of cached.turns) transcript.set(turnId, turn);
    transcript.active = cached.activeTurnId ? transcript.get(cached.activeTurnId) : [...transcript.values()].at(-1);
    conversationViewCache.put(session.id, cached);
    browser.renderedId = session.id;
    browser.renderedSignature = signature;
    elements.resultSection.classList.remove("hidden");
    finishConversationLoading();
    syncResultToggle();
    syncJumpToLatest();
    scrollResultToBottom();
    return;
  }

  if (!liveTurn) {
    if (agentRunTimer) clearInterval(agentRunTimer);
    agentRunTimer = undefined;
  }
  clearInputError();
  for (const turn of transcript.values()) turn.questions?.suspend();
  elements.result.replaceChildren();
  transcript.clear();
  transcript.active = undefined;
  const renderGeneration = browser.beginRender();
  let latestTurn: OutputTurnElements | undefined;
  for (const [index, record] of session.turns.entries()) {
    // Keep all historical payload parsing lazy. The newest turn is hydrated
    // after the browser paints the loading viewport; older turns parse their
    // response only when the user expands them.
    const latest = index === session.turns.length - 1;
    const turn = transcript.create(record.id, record.input, record.createdAt, {
      lazy: true,
      open: latest,
      sessionId: session.id,
      mode: record.mode,
      ...(record.executePlan ? { executePlan: true, ...(record.planPath ? { planPath: record.planPath } : {}) } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.spillPath ? { spill: true } : {})
    });
    // Closed history rows need their final status before deferred hydration.
    if (turn.planExecutionStatus) turn.planExecutionStatus.textContent = planExecutionLabel(record.process, record.error, record.planOutcome);
    turn.hydrate = () => hydrateStoredTurn(record, turn);
    if (latest) latestTurn = turn;
  }
  if (liveTurn && liveTurnId) {
    elements.result.append(liveTurn.disclosure);
    transcript.set(liveTurnId, liveTurn);
    transcript.active = liveTurn;
  }
  // Set these before scheduling the correction: scrollResultToBottom rejects
  // callbacks that no longer belong to the visible conversation.
  browser.renderedId = session.id;
  browser.renderedSignature = signature;
  elements.resultSection.classList.remove("hidden");
  syncResultToggle();
  syncJumpToLatest();
  // Let the empty viewport paint first. This prevents a large restored turn
  // from blocking wheel/touch input for the duration of Markdown rendering.
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (!browser.isCurrentRender(renderGeneration, session.id)) return;
      // The live row may have arrived during the deferred paint. Historical
      // hydration has its own trace state, so both can remain visible.
      latestTurn?.hydrate?.();
      finishConversationLoading();
      syncResultToggle();
      syncJumpToLatest();
      scrollResultToBottom();
    }, 0);
  });
}

function renderOutputSessionRef(sessionId: string, signature: string, switchId?: number, hostInitiated = false): void {
  if (browser.renderedId === sessionId && browser.renderedSignature === signature) {
    return;
  }
  if (browser.renderedId && browser.renderedId !== sessionId) cacheRenderedConversation();
  const cached = conversationViewCache.get(sessionId);
  if (!cached || cached.signature !== signature) {
    vscode.postMessage({ type: "outputSessionRefMiss", sessionId, signature, ...(switchId !== undefined ? { switchId } : {}), ...(hostInitiated ? { hostInitiated: true as const } : {}) });
    return;
  }
  elements.result.replaceChildren(...cached.nodes);
  for (const turn of cached.turns.values()) turn.questions?.resume();
  restoreCachedAgentRenders(cached);
  transcript.clear();
  for (const [turnId, turn] of cached.turns) transcript.set(turnId, turn);
  transcript.active = cached.activeTurnId ? transcript.get(cached.activeTurnId) : [...transcript.values()].at(-1);
  conversationViewCache.put(sessionId, cached);
  browser.renderedId = sessionId;
  browser.renderedSignature = signature;
  elements.resultSection.classList.remove("hidden");
  finishConversationLoading();
  syncResultToggle();
  syncJumpToLatest();
  scrollResultToBottom();
}

function persistComposerDraft(): void {
  if (!browser.activeId || restoringDraft) return;
  // The store drops attachments whose @ reference no longer appears in the
  // editor, so removing one directly does not resurrect its chip later.
  drafts.save(browser.activeId, editor.source, attachments.all());
}

function restoreComposerDraft(sessionId: string): void {
  const draft = drafts.draft(sessionId);
  restoringDraft = true;
  try {
    attachments.clear();
    editor.setValue(draft?.source ?? "");
    for (const attachment of draft?.attachments ?? []) {
      attachments.add(attachment.relativePath, attachment.webviewUri, attachment.name);
    }
  } finally {
    restoringDraft = false;
  }
  updateRunState();
}

function scheduleComposerDraftRestore(sessionId: string, switchId?: number): void {
  requestAnimationFrame(() => {
    if (browser.activeId !== sessionId) return;
    if (switchId !== undefined && switchId !== browser.switchId) return;
    restoreComposerDraft(sessionId);
  });
}

function clearSubmittedInput(): void {
  editor.setValue("");
  // The chips stand for references that just left the composer with the turn,
  // so they go with it. The files stay on disk because the recorded turn and
  // its history entry still point at them.
  attachments.clear();
  persistComposerDraft();
}

elements.run.addEventListener("click", run);
elements.dismissInputError.addEventListener("click", () => {
  clearInputError();
  editor.focus();
});
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
  // The host answers with a planContext message (and an error when it refuses),
  // so the toolbar reports the wait from the click onwards.
  if (browser.activeId) pendingBuilds.set(browser.activeId, activePlanPath);
  // A conflicting assessment gets the one-click correction; a Build here would only
  // be refused by the host.
  if (planProjectContext?.planPath === activePlanPath && planProjectContext.assessment === "conflict") {
    vscode.postMessage({ type: "correctPlan", planPath: activePlanPath });
  } else {
    vscode.postMessage({ type: "buildPlan", planPath: activePlanPath });
  }
  updateRunState();
});
elements.result.addEventListener("click", openOutputLink);
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : undefined;
  const button = target?.closest<HTMLButtonElement>("button.markdown-code-copy[data-copy]");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  void clipboard.write(button.dataset.copy ?? "").then((success) => {
    if (!success) return;
    button.classList.replace("codicon-copy", "codicon-check");
    window.setTimeout(() => button.classList.replace("codicon-check", "codicon-copy"), 900);
  });
});
elements.resultToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleResultDetails();
});
elements.result.addEventListener("toggle", hydrateOutputTurnOnOpen, true);
elements.result.addEventListener("toggle", syncResultToggle, true);
// Expanding a command's output or a stored turn changes the height under the
// reader. A following reader keeps the newest output in view; one who scrolled
// away is left where they are.
elements.result.addEventListener("toggle", () => scroll.pin(), true);
elements.result.addEventListener("toggle", (event) => {
  const process = event.target instanceof HTMLDetailsElement
    && event.target.classList.contains("output-turn-section")
    && event.target.dataset.turnSection === "process"
    ? event.target
    : undefined;
  if (!process || process !== transcript.active?.processDisclosure || !executing) return;
  if (process.open) {
    scroll.setFollowing(true);
    scroll.pin();
  } else {
    scroll.setFollowing(false);
    scroll.cancelScheduled();
  }
}, true);
elements.resultBody.addEventListener("scroll", () => {
  scroll.onScroll();
}, { passive: true });
elements.resultBody.addEventListener("pointerdown", (event) => {
  // Overlay scrollbars report no width through offsetWidth/clientWidth, even
  // though their thumb still receives pointer input. The controller keeps a
  // narrow fallback hit strip so releasing that thumb at the track end snaps.
  scroll.beginPointerGesture(event);
}, { passive: true });
const endResultScrollGesture = (event: PointerEvent): void => {
  // A drag whose height was measured before the last batch can stop short of
  // the real end. Releasing against the track's end still means "newest
  // output", so the controller snaps with the height of this frame.
  scroll.endPointerGesture(event);
};
// On the window: a drag that ends outside the panel must still end the gesture.
window.addEventListener("pointerup", endResultScrollGesture, { passive: true });
window.addEventListener("pointercancel", endResultScrollGesture, { passive: true });
elements.resultBody.addEventListener("wheel", (event) => {
  // Wheeling up is a deliberate move into earlier output. Wheeling down is
  // handled by the scroll handler, so returning to the end resumes following.
  scroll.onWheel(event.deltaY);
}, { passive: true });
elements.resultBody.addEventListener("touchstart", () => {
  scroll.beginTouchGesture();
}, { passive: true });
elements.resultBody.addEventListener("touchend", () => {
  scroll.endTouchGesture();
}, { passive: true });
// #result-body is focusable so the jump control can hand the reader a keyboard
// scroller; these are the keys that move it.
elements.resultBody.addEventListener("keydown", (event) => {
  scroll.onKeydown(event);
});
jumpToLatest.addEventListener("click", () => {
  scroll.followToBottom();
  elements.resultBody.focus({ preventScroll: true });
});
jumpToTop.addEventListener("click", () => {
  scroll.jumpToTop();
});
elements.problems.addEventListener("click", () => editor.goToFirstDiagnostic());
elements.mcpAssistantClose.addEventListener("click", () => mcp.requestClose());
elements.mcpAssistantGenerate.addEventListener("click", () => mcp.generate());
elements.mcpAssistantSave.addEventListener("click", () => mcp.save());
elements.createResource.addEventListener("click", () => vscode.postMessage({ type: "openResourceCreator" }));
elements.resourceTarget.addEventListener("click", () => sendResourceAction(activeResource()?.draft || activeResource()?.target ? "previewResource" : "chooseResource"));
elements.resourceChoose.addEventListener("click", () => {
  const choose = (): void => sendResourceAction("chooseResource");
  if (activeResource()?.draft) openConfirmationDialog("Discard the current resource draft and select another resource?", choose);
  else choose();
});
elements.resourcePreview.addEventListener("click", () => sendResourceAction("previewResource"));
elements.resourceSave.addEventListener("click", () => sendResourceAction("saveResource"));

// Target selection owns drops only on the Plan/Resource target controls.
// The editor itself keeps handling file drops as references in the input.
const planTargetGroup = elements.planTarget.closest<HTMLElement>(".plan-target-group");
const resourceTargetGroup = elements.resourceTarget.closest<HTMLElement>(".plan-target-group");
function targetSelectionLocked(): boolean {
  return composerSelectionLocked() || (!activeResource() && planStatus === "running");
}
function bindTargetFileSelection(target: HTMLElement | null, kind: "plan" | "resource"): (() => void) | undefined {
  if (!target) return undefined;
  const canSelect = (): boolean => kind === "resource" ? !!activeResource() : !activeResource() && inputMode === "plan";
  return bindFileDropTarget(target, {
    dragover: (event) => {
      if (!canSelect() || !isFileDrag(event)) return false;
      event.preventDefault();
      const effect = targetSelectionLocked() ? "none" : fileSelectionDropEffect(event.dataTransfer!.effectAllowed);
      event.dataTransfer!.dropEffect = effect;
      target.classList.toggle("file-drop-shift", event.shiftKey && effect !== "none");
      return true;
    },
    drop: (event) => {
      target.classList.remove("file-drop-shift");
      if (!canSelect() || !isFileDrag(event)) return false;
      event.preventDefault();
      // Dropping without Shift on the target control is intentionally a no-op.
      if (!event.shiftKey || targetSelectionLocked()) return true;
      const paths = droppedFilePaths(event.dataTransfer);
      if (paths.length !== 1) {
        renderError(new Error(paths.length ? "Drop one target file at a time." : "The dropped file did not include a path. Drag a file from the VS Code Explorer."));
        return true;
      }
      const resource = activeResource();
      const sessionId = browser.activeId;
      if (kind === "resource" && !sessionId) return true;
      const submit = (): void => {
        if (kind === "resource" && (browser.activeId !== sessionId || activeResource() !== resource)) return;
        if (targetSelectionLocked()) return;
        clearInputError();
        if (kind === "resource" && sessionId) {
          resourceErrors.delete(sessionId);
          resourcePending.add(sessionId);
        }
        vscode.postMessage({ type: "selectDroppedFile", target: kind, path: paths[0]!, ...(sessionId ? { sessionId } : {}) });
        updateRunState();
      };
      if (resource?.draft) openConfirmationDialog("Discard the current resource draft and select another resource?", submit);
      else submit();
      return true;
    },
    leave: () => target.classList.remove("file-drop-shift")
  });
}
const removePlanTargetFileDrop = bindTargetFileSelection(planTargetGroup, "plan");
const removeResourceTargetFileDrop = bindTargetFileSelection(resourceTargetGroup, "resource");
elements.mcpAssistantDialog.addEventListener("click", (event) => {
  if (event.target === elements.mcpAssistantDialog) mcp.requestClose();
});
elements.mcpAssistantDialog.addEventListener("cancel", (event) => {
  // Native dialog Esc dispatches `cancel` before closing. Intercept it while
  // active so Esc behaves exactly like the close button and backdrop click.
  if (!mcp.busy) return;
  event.preventDefault();
  mcp.requestClose();
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
for (const button of [elements.resourceSourceDescribe, elements.resourceSourceImport]) {
  button.addEventListener("click", () => {
    if (composerSelectionLocked()) return;
    const next = button.dataset.resourceSource;
    if (next !== "describe" && next !== "import") return;
    resourceSource = next;
    renderResourceControls();
    updateRunState();
    editor.focus();
  });
}
elements.composerMore.addEventListener("click", (event) => {
  event.stopPropagation();
  closeComposerMenus();
  const controls = elements.composerMore.closest(".composer-controls");
  const open = !controls?.classList.contains("show-extra");
  controls?.classList.toggle("show-extra", open);
  elements.composerMore.setAttribute("aria-expanded", String(open));
  if (open) {
    controls?.querySelector<HTMLButtonElement>(".composer-extras .composer-menu:not([hidden]) > button")?.focus();
  }
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
  if (elements.composerMore.getAttribute("aria-expanded") === "true") elements.composerMore.focus();
  closeComposerExtras();
  closeComposerMenus();
});
elements.inputShell.addEventListener("paste", (event) => {
  const file = findImageItem(event.clipboardData)?.getAsFile();
  if (!file) return;
  event.preventDefault();
  event.stopPropagation();
  void readImageData(file)
    .then((image) => vscode.postMessage({ type: "pasteImage", ...image }))
    .catch(renderError);
}, true);

window.addEventListener("message", (event: MessageEvent<WebviewResponse>) => {
  const message = event.data;
  if (clipboard.accept(message) || fileSearch.accept(message) || projectReferences.accept(message) || fileDrop.accept(message)) return;
  if (message.type === "turnRenamed") {
    if (browser.renderedId === message.sessionId) {
      transcript.get(message.turnId)?.title.rename(message.title, message.displayTitle);
    }
    conversationViewCache.get(message.sessionId)?.turns.get(message.turnId)?.title.rename(message.title, message.displayTitle);
  }
  if (message.type === "state") {
    lastSidebarState = message.state;
    const themeKey = JSON.stringify([message.state.theme, message.state.diagnostics]);
    if (themeKey !== renderedThemeKey) {
      renderedThemeKey = themeKey;
      applySidebarTheme(message.state);
    }
    // Controls are conversation-scoped, unlike the theme above.
    renderAgentControls(message.state);
  }
  if (message.type === "inputKind") {
    inputKind = message.kind;
    updateRunState();
  }
  if (message.type === "insertFileReferences") {
    editor.insertFileReferences(message.expressions);
  }
  if (message.type === "insertAnnotations") {
    // The annotation tab composed this block; keep the caret in Input so the
    // next keystroke continues the message the user is writing.
    if (message.previous) editor.replaceText(message.previous, message.text);
    else editor.insertText(message.text);
    persistComposerDraft();
    editor.focus();
  }
  if (message.type === "imageAttachment") {
    const waiting = message.requestId === undefined ? undefined : pendingFormImages.get(message.requestId);
    if (message.requestId !== undefined) pendingFormImages.delete(message.requestId);
    if (waiting) waiting(message.relativePath);
    else {
      attachments.add(message.relativePath, message.webviewUri, message.name);
      editor.insertFileReferences([`@${message.relativePath}`]);
    }
  }
  if (message.type === "outputSession") {
    if (message.switchId !== undefined && message.switchId !== browser.switchId) return;
    // History can delete a turn in another tab. Do not keep that tab's stale
    // DOM just because its snapshot must not replace the visible conversation.
    if (message.session.id !== browser.activeId) conversationViewCache.delete(message.session.id);
    // A pre-click payload can arrive after the local tab selection.  It has
    // no switch id to reject, so also require it to match the visible tab.
    if (!message.hostInitiated && browser.activeId && message.session.id !== browser.activeId) return;
    // A live row may have been restored before a delayed historical payload.
    // Rebuilding the session in that case would silently remove the running
    // turn from the pane.
    if (executing && transcript.active && activeTurnId && message.session.id === browser.activeId
      && elements.resultBody.dataset.loading !== "true") return;
    renderOutputSession(message.session);
  }
  if (message.type === "outputSessionRef") {
    if (message.switchId !== undefined && message.switchId !== browser.switchId) return;
    if (!message.hostInitiated && browser.activeId && message.sessionId !== browser.activeId) return;
    if (executing && transcript.active && activeTurnId && message.sessionId === browser.activeId) return;
    renderOutputSessionRef(message.sessionId, message.signature, message.switchId, message.hostInitiated === true);
  }
  if (message.type === "activeConversation") {
    if (message.switchId !== undefined && message.switchId !== browser.switchId) return;
    // Messages emitted by refreshes before a click have no switch id.  Once
    // the tab press has committed locally, an older active-id must not undo
    // that selection (and trigger another layout/scroll pass).
    if (!message.hostInitiated && message.switchId === undefined && browser.activeId && message.activeId !== browser.activeId) return;
    // History actions (Continue/Fork) activate a conversation from the host,
    // without going through selectConversation(). Clear the previous tab's
    // execution state before its historical DOM is restored; otherwise the
    // old live row can be appended to the newly selected conversation.
    const activeChanged = browser.activeId !== message.activeId;
    if (activeChanged) {
      executing = false;
      stopping = false;
      activeTurnId = undefined;
      activeExecutionSessionId = undefined;
      clearVisibleConversation();
    }
    browser.activeId = message.activeId;
    if (activeChanged) scheduleComposerDraftRestore(message.activeId, message.switchId);
    if (message.resource) resourceSessions.set(message.activeId, message.resource);
    else resourceSessions.delete(message.activeId);
    for (const tab of elements.conversationTabs.querySelectorAll<HTMLElement>(".conversation-tab")) {
      const active = tab.dataset.sessionId === message.activeId;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    if (lastSidebarState) renderAgentControls({ ...lastSidebarState, agentSelection: message.selection });
    activePlanPath = message.planPath;
    planStatus = message.planStatus;
    planProjectContext = message.projectContext;
    renderPlanToolbar();
  }
  if (message.type === "conversations") {
    if (message.switchId !== undefined && message.switchId !== browser.switchId) return;
    if (!message.hostInitiated && message.switchId === undefined && browser.activeId && message.activeId !== browser.activeId) return;
    if (message.resource) resourceSessions.set(message.activeId, message.resource);
    else resourceSessions.delete(message.activeId);
    renderConversations(message.sessions, message.activeId);
    if (message.selection && lastSidebarState) {
      renderAgentControls({ ...lastSidebarState, agentSelection: message.selection });
    }
    if (message.planStatus) {
      activePlanPath = message.planPath;
      planStatus = message.planStatus;
      planProjectContext = message.projectContext;
      renderPlanToolbar();
    }
  }
  if (message.type === "planContext") {
    // The host answers a Build with planContext: "running" once it accepts the
    // plan, or the unchanged status when it refuses it. Either way the wait that
    // Build was reporting is over and the host's own state takes over.
    for (const [sessionId, path] of pendingBuilds) {
      if (path === message.path) pendingBuilds.delete(sessionId);
    }
    activePlanPath = message.path;
    planStatus = message.status;
    planProjectContext = message.projectContext;
    renderPlanToolbar();
  }
  if (message.type === "resourceContext") {
    resourceSessions.set(message.sessionId, message.resource);
    if (message.busy) resourcePending.add(message.sessionId);
    else resourcePending.delete(message.sessionId);
    if (message.sessionId === browser.activeId && sidebarState) renderAgentControls(sidebarState);
  }
  if (message.type === "mcpAssistant") mcp.open();
  if (message.type === "mcpProgress") mcp.progress(message.requestId, message.event);
  if (message.type === "mcpToolsDiscovered") mcp.toolsDiscovered(message.requestId, message.tools);
  if (message.type === "mcpGenerated") mcp.generated(message.requestId, message.server);
  if (message.type === "mcpCreated") mcp.created(message.name);
  if (message.type === "execution") {
    // A background turn changes the session while its DOM may be cached.
    // Drop that snapshot so returning to the tab renders the new turn once.
    conversationViewCache.delete(message.sessionId);
    // The turn this build was waiting for has run; the toolbar shows its result.
    pendingBuilds.delete(message.sessionId);
  }
  if (message.type === "execution" && message.sessionId === browser.activeId) {
    transcript.select(message.turnId);
    const planResult = message.response.executions.find((execution) => execution.result.kind === "plan" && execution.result.executePlan)?.result;
    if (transcript.active?.planExecutionStatus && !transcript.active.planExecutionStatus.hidden) transcript.active.planExecutionStatus.textContent = planExecutionLabel([], undefined, planResult?.kind === "plan" ? planResult.planOutcome : undefined);
    renderResult(message.response);
  }
  if (message.type === "executionFailed") {
    conversationViewCache.delete(message.sessionId);
    pendingBuilds.delete(message.sessionId);
  }
  if (message.type === "executionFailed" && message.sessionId === browser.activeId) {
    transcript.select(message.turnId);
    if (transcript.active?.planExecutionStatus && !transcript.active.planExecutionStatus.hidden) transcript.active.planExecutionStatus.textContent = planExecutionLabel([], message.message, message.planOutcome);
    renderOutputError(message.message);
  }
  if (message.type === "agentEvent" && message.sessionId === browser.activeId) {
    renderAgentEvent(message.event);
    if (scroll.consumeForcedInitialScroll()) {
      scrollResultToBottom();
    } else {
      pinResultToBottom();
    }
    syncJumpToLatest();
  }
  if (message.type === "agentEvents"
    && (message.switchId === undefined || message.switchId === browser.switchId)
    && message.sessionId === browser.activeId) {
    queueAgentEvents(message.sessionId, message.events);
  }
  if (message.type === "focusAgentInput" && message.sessionId === browser.activeId) {
    if (agentEventBatchFrame !== undefined) cancelAnimationFrame(agentEventBatchFrame);
    flushAgentEventBatches();
    const turn = transcript.get(message.turnId);
    if (turn) {
      setSectionOpen(elements.resultHeading, elements.resultBody, true);
      turn.hydrate?.();
      turn.disclosure.open = true;
      // The host is asking the reader to answer a card, and focusRequest brings
      // that card to the middle of the viewport. Following the stream would
      // pull the view straight back to the end, away from the question.
      if (turn.questions.focusRequest(message.kind, message.requestId)) scroll.setFollowing(false);
    }
  }
  if (message.type === "executing"
    && (message.switchId === undefined || message.switchId === browser.switchId)
    && (message.sessionId === browser.activeId || mcp.owns(message.turnId, message.value))
  ) {
    // MCP manifest generation belongs to the dialog, not to a conversation turn.
    if (mcp.updateExecution(message.turnId, message.value)) return;
    executing = message.value;
    if (message.value) {
      if (message.switchId !== undefined) {
        // The row is appended after the restored conversation's initial
        // scroll correction. Keep the replay pinned to the newest event.
        scroll.forceInitialBottom();
        scrollResultToBottom();
      }
      activeTurnId = message.turnId;
      activeExecutionSessionId = message.sessionId;
      stopping = false;
      const existingTurn = transcript.get(message.turnId);
      if (existingTurn) {
        transcript.active = existingTurn;
      } else {
        transcript.create(message.turnId, message.source ?? "Dext turn", Date.now(), {
          mode: message.mode,
          ...(message.executePlan ? { executePlan: true } : {}),
          ...(message.planPath ? { planPath: message.planPath } : {})
        });
        resetAgentTrace();
        startAgentProgress(message.startedAt);
      }
      transcript.active?.todos.setRunning(true);
      transcript.active?.questions?.setRunning(true);
      elements.resultSection.classList.remove("hidden");
      setSectionOpen(elements.resultHeading, elements.resultBody, true);
      syncJumpToLatest();
    } else {
      scroll.consumeForcedInitialScroll();
      if (activeTurnId === message.turnId) activeTurnId = undefined;
      if (activeExecutionSessionId === message.sessionId) activeExecutionSessionId = undefined;
      stopping = false;
      transcript.select(message.turnId);
      finishAgentProgress();
      if (transcript.active) {
        transcript.active.processDisclosure.open = false;
        transcript.active.outputDisclosure.open = true;
        // Collapsing the process timeline and opening the stored output change
        // the height around the reader; a following reader keeps the reply end.
        pinResultToBottom();
      }
      syncJumpToLatest();
    }
    updateRunState();
  }
  if (message.type === "error") {
    // A refused request will never send the state message its control was
    // waiting for, so the pending wait ends here.
    if (message.sessionId) pendingBuilds.delete(message.sessionId);
    else pendingBuilds.clear();
    pendingFormImages.clear();
    if (message.sessionId && resourceSessions.has(message.sessionId)) {
      resourcePending.delete(message.sessionId);
      resourceErrors.set(message.sessionId, message.message);
      if (message.sessionId !== browser.activeId) return;
    }
    renderInputError(message.message);
    // A rejected request still owns whatever it disabled when it was sent, such
    // as Plan's Build button, so re-render instead of waiting for a state message.
    updateRunState();
    mcp.fail(message.message);
  }
  if (message.type === "setInput") {
    editor.setValue(message.source);
    setSectionOpen(elements.inputHeading, elements.inputBody, true);
    editor.focus();
  }
  if (message.type === "focusEditor" || message.type === "focusInput") editor.focus();
  if (message.type === "triggerSuggest") editor.triggerSuggest();
  if (message.type === "triggerParameterHints") editor.triggerParameterHints();
});

window.addEventListener("unload", () => {
  removePlanTargetFileDrop?.();
  removeResourceTargetFileDrop?.();
  scroll.dispose();
  clipboard.dispose();
  fileDrop.dispose();
  editor.destroy();
});

updateRunState();
syncResultToggle();
vscode.postMessage({ type: "ready" });
