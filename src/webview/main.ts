import "../../media/styles.css";
import type {
  FieldDefinition,
  AgentStreamEvent,
  InputExecutionResponse,
  PatchChange,
  RuntimeResponse,
  WorkflowStepResponse
} from "../core/types.js";
import { formatMethodSignature } from "../core/methodSignature.js";
import type { SidebarState, WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import { parseDroppedFiles } from "./chatAttachments.js";
import { ClipboardClient } from "./clipboardClient.js";
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
  inputSection: element<HTMLElement>("input-section"),
  inputHeading: element<HTMLElement>("input-heading"),
  inputBody: element<HTMLElement>("input-body"),
  inputShell: element<HTMLElement>("input-shell"),
  codeEditor: element<HTMLElement>("code-editor"),
  attachFiles: element<HTMLButtonElement>("attach-files"),
  modeControl: element<HTMLButtonElement>("mode-control"),
  modeControlValue: element<HTMLElement>("mode-control-value"),
  modeMenu: element<HTMLElement>("mode-menu"),
  agentControl: element<HTMLButtonElement>("agent-control"),
  agentControlValue: element<HTMLElement>("agent-control-value"),
  agentMenu: element<HTMLElement>("agent-menu"),
  modelControl: element<HTMLButtonElement>("model-control"),
  modelControlValue: element<HTMLElement>("model-control-value"),
  modelMenu: element<HTMLElement>("model-menu"),
  run: element<HTMLButtonElement>("run"),
  runLabel: element<HTMLElement>("run-label"),
  problems: element<HTMLButtonElement>("problems"),
  resultSection: element<HTMLElement>("result-section"),
  resultHeading: element<HTMLElement>("result-heading"),
  resultBody: element<HTMLElement>("result-body"),
  methods: element<HTMLElement>("methods"),
  methodsSection: element<HTMLElement>("methods-heading"),
  methodsBody: element<HTMLElement>("methods-body"),
  methodCount: element<HTMLElement>("method-count"),
  methodsToggle: element<HTMLButtonElement>("methods-toggle"),
  configErrors: element<HTMLElement>("config-errors"),
  result: element<HTMLElement>("result"),
  viewHistory: element<HTMLButtonElement>("view-history"),
  clearOutput: element<HTMLButtonElement>("clear-output"),
  inputFullscreen: element<HTMLButtonElement>("input-fullscreen"),
  resultFullscreen: element<HTMLButtonElement>("result-fullscreen"),
  methodsFullscreen: element<HTMLButtonElement>("methods-fullscreen"),
  methodsSectionElement: element<HTMLElement>("methods-section"),
  attachmentBar: element<HTMLElement>("attachment-bar")
};

const broker = new LanguageRequestBroker((request) => vscode.postMessage(request));
const clipboard = new ClipboardClient((request) => vscode.postMessage(request));
let executing = false;
let stopping = false;
let activeTurnId: string | undefined;
let hasErrors = false;
let problemCounts = { errors: 0, warnings: 0 };
let inputKind: "empty" | "workflow" | "invalid" = "empty";
type InputMode = "agent" | "ask" | "code";
let inputMode: InputMode = "agent";
let sidebarState: SidebarState | undefined;
let dropPosition: number | undefined;
let agentStream: HTMLElement | undefined;
let agentTrace: HTMLDetailsElement | undefined;
let agentRunStartedAt = 0;
let agentRunTimer: ReturnType<typeof setInterval> | undefined;
let agentProgress: HTMLElement | undefined;
let agentProgressState = "Thinking";
let agentCommandIds = new Set<string>();
let agentEditedUris = new Set<string>();
const agentGroups = new Map<"reasoning" | "work" | "files" | "tool", { disclosure: HTMLDetailsElement; body: HTMLElement }>();
const imageAttachments = new Map<string, HTMLElement>();
interface OutputTurnElements {
  disclosure: HTMLDetailsElement;
  process: HTMLElement;
  processDisclosure: HTMLDetailsElement;
  output: HTMLElement;
  outputDisclosure: HTMLDetailsElement;
}
const outputTurns = new Map<string, OutputTurnElements>();
let activeTurn: OutputTurnElements | undefined;

const editor = new DextCodeEditor({
  parent: elements.codeEditor,
  broker,
  clipboard,
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
    updateRunState();
  },
  onError: renderError
});

function openInputReference(reference: ContextReferenceOccurrence): void {
  if (reference.kind === "file") {
    vscode.postMessage({ type: "openFileReference", reference: reference.payload });
  }
}

function updateRunState(): void {
  const codeMode = inputMode === "code";
  elements.run.disabled = executing
    ? stopping || !activeTurnId
    : !editor.source.trim() || (codeMode && (hasErrors || inputKind === "invalid"));
  elements.clearOutput.disabled = executing;
  elements.runLabel.textContent = executing ? (stopping ? "Stopping" : "Stop") : codeMode ? "Run" : "Send";
  const runIcon = elements.run.querySelector<HTMLElement>("i");
  if (runIcon) runIcon.className = `codicon codicon-${executing ? "debug-stop" : "run"}`;
  elements.run.classList.toggle("stopping", stopping);
  const parts = [
    problemCounts.errors ? `${problemCounts.errors} error${problemCounts.errors === 1 ? "" : "s"}` : "",
    problemCounts.warnings ? `${problemCounts.warnings} warning${problemCounts.warnings === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  elements.problems.textContent = codeMode ? parts.join(" · ") || "No problems" : "Code mode only";
  elements.problems.disabled = !codeMode || parts.length === 0;
  elements.problems.classList.toggle("has-problems", codeMode && parts.length > 0);
  elements.inputShell.classList.toggle("conversation-mode", !codeMode);
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
  vscode.postMessage({ type: "executeInput", mode: inputMode, source });
}

type PanelName = "input" | "result" | "methods";

const panels: Record<PanelName, { section: HTMLElement; heading: HTMLElement; body: HTMLElement; button: HTMLButtonElement; label: string }> = {
  input: { section: elements.inputSection, heading: elements.inputHeading, body: elements.inputBody, button: elements.inputFullscreen, label: "Input" },
  result: { section: elements.resultSection, heading: elements.resultHeading, body: elements.resultBody, button: elements.resultFullscreen, label: "Output" },
  methods: { section: elements.methodsSectionElement, heading: elements.methodsSection, body: elements.methodsBody, button: elements.methodsFullscreen, label: "API" }
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
      });
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
      row.addEventListener("click", () => editor.insertInvocation(methodTemplate(method)));
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
  renderAgentControls(state);
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

function renderAgentControls(state: SidebarState): void {
  sidebarState = state;
  inputMode = state.agentSelection.mode ?? inputMode;
  editor.setLanguageEnabled(inputMode === "code");
  const selected = state.agentProfiles.find((item) => item.id === state.agentSelection.profileId)
    ?? state.agentProfiles[0];
  type ModelOption = { id: string; label: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string };
  const options: ModelOption[] = selected?.modelOptions
    ? selected.modelOptions
    : (selected?.models ?? []).map((item): ModelOption => ({ id: item, label: item, reasoningEfforts: [], speedTiers: [], serviceTiers: [] }));
  const selectedModel = options.find((item) => item.id === state.agentSelection.model);
  const modeLabel: Record<InputMode, string> = { agent: "Agent", ask: "Ask", code: "Code" };
  elements.modeControlValue.textContent = modeLabel[inputMode];
  elements.agentControlValue.textContent = selected?.label ?? "Choose";
  elements.modelControlValue.textContent = selectedModel?.label ?? "Default";
  renderComposerMenu(elements.modeMenu, [
    ["agent", "Agent", "codicon-hubot"],
    ["ask", "Ask", "codicon-comment-discussion"],
    ["code", "Code", "codicon-code"]
  ], inputMode, (mode) => {
    inputMode = mode as InputMode;
    submitAgentSelection({});
  });
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
  onSelect: (value: string) => void
): void {
  menu.replaceChildren();
  for (const [value, label, icon] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
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
      value: current.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "Default",
      items: (selectedModel?.reasoningEfforts ?? []).map((item) => [item, item]),
      selected: current.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "",
      onSelect: (reasoningEffort) => submitAgentSelection({ reasoningEffort })
    },
    {
      title: "Speed",
      value: current.speed ?? "Default",
      items: (selectedModel?.speedTiers ?? []).map((item) => [item, item === "standard" ? "Standard" : item]),
      selected: current.speed ?? "",
      onSelect: (speed) => submitAgentSelection({ speed })
    },
    {
      title: "Advanced",
      value: current.serviceTier ?? "Default",
      items: (selectedModel?.serviceTiers ?? []).map((item) => [item, item]),
      selected: current.serviceTier ?? "",
      onSelect: (serviceTier) => submitAgentSelection({ serviceTier })
    }
  ];
  elements.modelMenu.replaceChildren();
  elements.modelMenu.dataset.modelMenuView = "categories";
  for (const category of categories) {
    if (!category.items.length) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option composer-menu-category";
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
      renderModelChoices(elements.modelMenu, category.title, category.items, category.selected, category.onSelect);
    };
    button.addEventListener("click", openChoices);
    button.addEventListener("mouseenter", () => {
      if (!elements.modelMenu.hidden && elements.modelMenu.dataset.modelMenuView === "categories") {
        renderModelChoices(elements.modelMenu, category.title, category.items, category.selected, category.onSelect);
      }
    });
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
  const back = document.createElement("button");
  back.type = "button";
  back.className = "composer-menu-back";
  back.innerHTML = '<i class="codicon codicon-chevron-left"></i><span></span>';
  const label = back.querySelector("span");
  if (label) label.textContent = title;
  back.addEventListener("click", (event) => {
    event.stopPropagation();
    const state = sidebarState;
    if (!state) return;
    const selected = state.agentProfiles.find((item) => item.id === state.agentSelection.profileId)
      ?? state.agentProfiles[0];
    const options = selected?.modelOptions
      ? selected.modelOptions
      : (selected?.models ?? []).map((item) => ({ id: item, label: item, reasoningEfforts: [], speedTiers: [], serviceTiers: [] }));
    renderModelMenu(state, options, options.find((item) => item.id === state.agentSelection.model));
  });
  menu.append(back);
  for (const [value, label] of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "composer-menu-option";
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

function submitAgentSelection(change: Partial<SidebarState["agentSelection"]>): void {
  const selection = sidebarState?.agentSelection;
  closeComposerMenus();
  vscode.postMessage({
    type: "agentSelection", selection: {
      mode: inputMode,
      profileId: change.profileId ?? selection?.profileId ?? "",
      model: change.model ?? selection?.model ?? "",
      reasoningEffort: change.reasoningEffort ?? selection?.reasoningEffort ?? "",
      speed: change.speed ?? selection?.speed ?? "",
      serviceTier: change.serviceTier ?? selection?.serviceTier ?? ""
    }
  });
}

const composerMenus = [
  { control: elements.modeControl, menu: elements.modeMenu },
  { control: elements.agentControl, menu: elements.agentMenu },
  { control: elements.modelControl, menu: elements.modelMenu }
];

function closeComposerMenus(except?: HTMLElement): void {
  for (const item of composerMenus) {
    const open = item.menu === except;
    item.menu.hidden = !open;
    item.control.setAttribute("aria-expanded", String(open));
  }
}

function toggleComposerMenu(menu: HTMLElement): void {
  closeComposerMenus(menu.hidden ? menu : undefined);
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

function terminalText(content: string): DocumentFragment {
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

  const appendText = (value: string): void => {
    if (!value) return;
    if (active.size === 0 && !foreground) {
      fragment.append(document.createTextNode(value));
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
  const paragraph = document.createElement("p");
  paragraph.className = "text-result";
  paragraph.textContent = content;
  wrapper.append(paragraph, copyButton(content));
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
  for (const part of inputReferenceDisplayParts(source)) {
    if (part.kind === "text") {
      pre.append(document.createTextNode(part.value));
      continue;
    }
    const reference = part.reference;
    const descriptor = fileReferenceChipDescriptor(
      compactFileReferenceLabel(reference.payload),
      reference.payload
    );
    pre.append(createFileReferenceChip({
      document,
      ...descriptor,
      modifierClass: "output-file-reference",
      icon: referenceIcon(reference.kind),
      ...(reference.kind === "file"
        ? { onOpen: () => openInputReference(reference) }
        : {})
    }));
  }
  return pre;
}

function createOutputTurn(turnId: string, source: string, createdAt = Date.now()): OutputTurnElements {
  source = normalizeInputReferenceSource(source);
  for (const turn of outputTurns.values()) turn.disclosure.open = false;
  const disclosure = document.createElement("details");
  disclosure.className = "output-turn";
  disclosure.open = true;
  disclosure.dataset.turnId = turnId;
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const time = document.createElement("span");
  time.className = "output-turn-time";
  time.textContent = new Date(createdAt).toLocaleTimeString();
  const title = document.createElement("span");
  title.className = "output-turn-title";
  title.textContent = inputReferenceDisplayText(source).split(/\r?\n/, 1)[0]?.slice(0, 140) || "Dext turn";
  summary.append(chevron, time, title);
  const body = document.createElement("div");
  body.className = "output-turn-body";
  const input = outputTurnSection("Input", false);
  const inputText = renderedInputSource(source);
  const inputCopy = document.createElement("div");
  inputCopy.className = "output-turn-input";
  inputCopy.append(inputText, copyButton(source));
  input.body.append(inputCopy);
  const process = outputTurnSection("Process", true);
  const output = outputTurnSection("Output", true);
  body.append(input.disclosure, process.disclosure, output.disclosure);
  disclosure.append(summary, body);
  elements.result.append(disclosure);
  const turn = {
    disclosure,
    process: process.body,
    processDisclosure: process.disclosure,
    output: output.body,
    outputDisclosure: output.disclosure
  };
  outputTurns.set(turnId, turn);
  activeTurn = turn;
  return turn;
}

function selectOutputTurn(turnId: string): OutputTurnElements | undefined {
  activeTurn = outputTurns.get(turnId);
  return activeTurn;
}

type DiffMode = "inline" | "split";

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
    button.className = `diff-mode-button${mode === "inline" ? " active" : ""}`;
    button.dataset.diffMode = mode;
    button.title = `${label} diff`;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(mode === "inline"));
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
  view.append(inline, split);
  container.append(view);
}

function fileChangeDisclosure(change: PatchChange, className = "agent-file-change"): HTMLDetailsElement {
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
  disclosure.append(summary, path);
  appendDiffView(disclosure, change);
  return disclosure;
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

function renderExecution(response: RuntimeResponse): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(resultHeading(response));
  const result = response.result;
  if (result.kind === "chat" || result.kind === "text") {
    fragment.append(copyableText(result.text));
  } else if (result.kind === "explain") {
    fragment.append(copyableText(result.text));
  } else if (result.kind === "edit" || result.kind === "agent") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.kind === "agent" ? result.text : result.summary;
    fragment.append(paragraph);
    const changes = result.kind === "agent" ? result.patch?.changes ?? [] : result.patch.changes;
    for (const change of changes) fragment.append(fileChangeDisclosure(change, "agent-file-change execution-file-change"));
  } else if (result.kind === "apply") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = `${result.status}: ${result.summary}`;
    fragment.append(paragraph);
  } else if (result.kind === "print") {
    if (result.label) {
      const label = document.createElement("div");
      label.className = "output-title";
      label.textContent = result.label;
      fragment.append(label);
    }
    fragment.append(copyableText(result.text));
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
    const summary = document.createElement("p");
    summary.className = "text-result";
    summary.textContent = result.summary;
    fragment.append(summary);
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
  }
  return fragment;
}

function renderResult(response: InputExecutionResponse): void {
  const target = activeTurn?.output ?? elements.result;
  target.replaceChildren();
  const entries: WorkflowStepResponse[] = response.steps ?? response.executions.map((execution) => ({
    method: execution.method.id,
    state: "success" as const,
    response: execution
  }));
  renderAgentFileChanges(entries);
  for (const [index, step] of entries.entries()) {
    const item = document.createElement("section");
    item.className = "execution-result";
    if (step.response) item.append(renderExecution(step.response));
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
    target.append(item);
    if (index < entries.length - 1) item.classList.add("has-next");
  }
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
}

function renderError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  const target = activeTurn?.output ?? elements.result;
  target.replaceChildren();
  const summary = document.createElement("pre");
  summary.className = "error-output";
  summary.textContent = text;
  target.append(summary);
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
}

function agentStreamPanel(): HTMLElement {
  if (agentStream?.isConnected) return agentStream;
  const trace = document.createElement("details");
  trace.className = "agent-run-disclosure";
  trace.open = true;
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const progress = document.createElement("span");
  progress.className = "agent-progress";
  summary.append(chevron, progress);
  const panel = document.createElement("section");
  panel.className = "agent-stream-panel";
  trace.append(summary, panel);
  (activeTurn?.process ?? elements.result).append(trace);
  agentTrace = trace;
  agentStream = panel;
  agentProgress = progress;
  updateAgentProgress(agentProgressState);
  return panel;
}

function updateAgentProgress(label: string): void {
  if (!agentProgress) return;
  agentProgressState = label;
  const elapsed = agentRunStartedAt ? Math.max(0, Date.now() - agentRunStartedAt) : 0;
  const details = [
    agentEditedUris.size ? `Edited ${agentEditedUris.size} file${agentEditedUris.size === 1 ? "" : "s"}` : "",
    agentCommandIds.size ? `Ran ${agentCommandIds.size} command${agentCommandIds.size === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  agentProgress.textContent = `${agentProgressState} for ${formatDuration(elapsed)}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function startAgentProgress(): void {
  agentRunStartedAt = Date.now();
  agentStreamPanel();
  updateAgentProgress("Thinking");
  agentRunTimer = setInterval(() => updateAgentProgress(agentProgressState), 100);
}

function finishAgentProgress(): void {
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  updateAgentProgress("Worked");
  if (agentTrace) agentTrace.open = false;
}

function agentGroup(kind: "reasoning" | "work" | "files" | "tool"): { disclosure: HTMLDetailsElement; body: HTMLElement } {
  const panel = agentStreamPanel();
  const existing = agentGroups.get(kind);
  if (existing?.disclosure.isConnected) return existing;
  const disclosure = document.createElement("details");
  disclosure.className = `agent-trace-group agent-trace-${kind}`;
  const summary = document.createElement("summary");
  const chevron = document.createElement("i");
  chevron.className = "disclosure-chevron codicon codicon-chevron-right";
  const label = document.createElement("span");
  label.className = "agent-trace-label";
  label.textContent = kind === "reasoning"
    ? "Thought briefly"
    : kind === "work"
      ? "AIOA activity"
      : kind === "files"
        ? "Edited files"
        : "Ran commands";
  const body = document.createElement("div");
  body.className = "agent-trace-group-body";
  summary.append(chevron, label);
  disclosure.append(summary, body);
  const order = { reasoning: 0, work: 1, files: 2, tool: 3 } as const;
  const next = [...panel.querySelectorAll<HTMLElement>(".agent-trace-group")]
    .find((candidate) => order[candidate.dataset.kind as keyof typeof order] > order[kind]);
  disclosure.dataset.kind = kind;
  if (next) panel.insertBefore(disclosure, next);
  else panel.append(disclosure);
  const group = { disclosure, body };
  agentGroups.set(kind, group);
  return group;
}

function updateAgentGroupLabel(kind: "reasoning" | "work" | "files" | "tool"): void {
  const label = agentGroups.get(kind)?.disclosure.querySelector<HTMLElement>(".agent-trace-label");
  if (!label) return;
  if (kind === "files") label.textContent = `Edited ${agentEditedUris.size} file${agentEditedUris.size === 1 ? "" : "s"}`;
  if (kind === "tool") label.textContent = `Ran ${agentCommandIds.size} command${agentCommandIds.size === 1 ? "" : "s"}`;
}

function renderAgentEvent(event: AgentStreamEvent): void {
  if (event.phase === "status") {
    updateAgentProgress(event.text);
    return;
  }
  if (event.phase === "reasoning" || event.phase === "message") updateAgentProgress("Thinking");
  const group = agentGroup(event.group === "aioa-work-log" ? "work" : event.phase === "tool" ? "tool" : "reasoning");
  const panel = group.body;
  if (event.phase === "tool") {
    const commandId = event.id ?? event.title ?? event.text;
    agentCommandIds.add(commandId);
    updateAgentGroupLabel("tool");
    updateAgentProgress(agentProgressState);
  }
  let item = event.id
    ? [...panel.querySelectorAll<HTMLElement>("[data-event-id]")].find((candidate) => candidate.dataset.eventId === event.id)
    : undefined;
  if (!item) {
    item = document.createElement(event.phase === "tool" ? "details" : "div");
    item.className = `agent-stream-item agent-stream-${event.phase}`;
    if (event.id) item.dataset.eventId = event.id;
    if (event.phase === "tool") {
      (item as HTMLDetailsElement).open = false;
      const summary = document.createElement("summary");
      const chevron = document.createElement("i");
      chevron.className = "disclosure-chevron codicon codicon-chevron-right";
      const label = document.createElement("span");
      label.className = "agent-stream-summary-label";
      label.textContent = (event.title ?? event.text.split(/\r?\n/, 1)[0]!).slice(0, 180);
      summary.append(chevron, label);
      item.append(summary);
      const body = document.createElement("pre");
      body.className = "agent-stream-text";
      item.append(body);
    } else {
      const body = document.createElement("div");
      body.className = "agent-stream-text";
      item.append(body);
    }
    item.append(copyButton(event.text));
    panel.append(item);
  }
  const body = item.querySelector<HTMLElement>(".agent-stream-text");
  const eventBody = event.text;
  let copyText = event.text;
  if (body && event.phase !== "tool") {
    const raw = event.replace ? eventBody : `${body.dataset.raw ?? ""}${eventBody}`;
    body.dataset.raw = raw;
    const presentation = presentAgentMessage(raw);
    copyText = agentMessageCopyText(presentation);
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
      content.className = "agent-result-content";
      content.textContent = presentation.text;
      body.replaceChildren(heading, ...(presentation.text ? [content] : []));
      appendAgentPresentationExtras(body, presentation);
    } else {
      body.textContent = raw;
    }
  } else if (body) {
    body.textContent = event.replace ? eventBody : `${body.textContent ?? ""}${eventBody}`;
    copyText = body.textContent ?? event.text;
  }
  const summaryLabel = item.querySelector<HTMLElement>(".agent-stream-summary-label");
  if (summaryLabel && event.phase === "tool") summaryLabel.textContent = (event.title ?? summaryLabel.textContent ?? "Command").slice(0, 180);
  const outputCopy = item.querySelector<HTMLButtonElement>(".output-copy");
  if (outputCopy) {
    outputCopy.replaceWith(copyButton(copyText));
  }
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
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
    const group = agentGroup("files");
    const disclosure = fileChangeDisclosure(change);
    group.body.append(disclosure);
  }
  if (changes.length) {
    updateAgentGroupLabel("files");
    updateAgentProgress(agentProgressState);
  }
}

function resetAgentTrace(): void {
  agentStream = undefined;
  agentTrace = undefined;
  agentProgress = undefined;
  agentProgressState = "Thinking";
  agentCommandIds = new Set<string>();
  agentEditedUris = new Set<string>();
  agentGroups.clear();
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

function renderOutputSession(session: DextHistorySession): void {
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  elements.result.replaceChildren();
  outputTurns.clear();
  activeTurn = undefined;
  for (const record of session.turns) {
    const turn = createOutputTurn(record.id, record.input, record.createdAt);
    resetAgentTrace();
    agentRunStartedAt = Date.now();
    for (const event of record.process) renderAgentEvent(event);
    if (agentTrace) finishAgentProgress();
    turn.processDisclosure.open = false;
    const response = storedResponse(record);
    if (record.error) renderError(record.error);
    else if (response) renderResult(response);
    else if (record.output) turn.output.append(codeBlock(record.output));
  }
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
}

function droppedFiles(transfer: DataTransfer): ReturnType<typeof parseDroppedFiles> {
  const resourceUrlsType = [...transfer.types]
    .find((type) => type.toLowerCase() === "resourceurls") ?? "ResourceURLs";
  const codeFilesType = [...transfer.types]
    .find((type) => type.toLowerCase() === "codefiles") ?? "CodeFiles";
  return parseDroppedFiles({
    uriList: transfer.getData("text/uri-list"),
    codeUriList: transfer.getData("application/vnd.code.uri-list"),
    resourceUrls: transfer.getData(resourceUrlsType),
    codeFiles: transfer.getData(codeFilesType),
    plainText: transfer.getData("text/plain")
  });
}

function findImageItem(data: DataTransfer | null): DataTransferItem | undefined {
  if (!data) return undefined;
  for (const item of data.items) {
    if (item.kind === "file" && item.type.startsWith("image/")) return item;
  }
  return undefined;
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
    editor.removeFileReference(relativePath);
    vscode.postMessage({ type: "deleteImageAttachment", relativePath });
  });
  chip.append(image, remove);
  elements.attachmentBar.append(chip);
  elements.attachmentBar.classList.remove("hidden");
  imageAttachments.set(relativePath, chip);
}

elements.run.addEventListener("click", run);
elements.problems.addEventListener("click", () => editor.goToFirstDiagnostic());
elements.methodsToggle.addEventListener("click", toggleMethodGroups);
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
elements.methodsSection.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  toggleSection(elements.methodsSection, elements.methodsBody);
});
elements.methodsSection.addEventListener("keydown", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleSection(elements.methodsSection, elements.methodsBody);
  }
});
elements.attachFiles.addEventListener("click", () => vscode.postMessage({ type: "chooseFiles" }));
elements.viewHistory.addEventListener("click", () => vscode.postMessage({ type: "viewHistory" }));
elements.clearOutput.addEventListener("click", () => {
  if (!executing) vscode.postMessage({ type: "clearOutput" });
});
for (const item of composerMenus) {
  item.control.addEventListener("click", () => toggleComposerMenu(item.menu));
}
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest(".composer-menu")) return;
  closeComposerMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
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

window.addEventListener("dragenter", (event) => {
  vscode.postMessage({ type: "debugLog", message: `dragenter types=${[...(event.dataTransfer?.types ?? [])].join("|")}` });
}, true);
window.addEventListener("dragover", (event) => {
  const inShell = event.target instanceof Node && elements.inputShell.contains(event.target);
  vscode.postMessage({ type: "debugLog", message: `dragover inShell=${inShell} types=${[...(event.dataTransfer?.types ?? [])].join("|")}` });
  if (!inShell) return;
  event.preventDefault();
  event.stopPropagation();
  dropPosition = editor.positionAtPoint(event.clientX, event.clientY);
  elements.inputShell.classList.add("drop-active");
}, true);
window.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && elements.inputShell.contains(event.relatedTarget)) return;
  elements.inputShell.classList.remove("drop-active");
  dropPosition = undefined;
}, true);
window.addEventListener("drop", (event) => {
  const inShell = event.target instanceof Node && elements.inputShell.contains(event.target);
  vscode.postMessage({ type: "debugLog", message: `drop inShell=${inShell} types=${[...(event.dataTransfer?.types ?? [])].join("|")}` });
  if (!inShell) return;
  event.preventDefault();
  event.stopPropagation();
  elements.inputShell.classList.remove("drop-active");
  const items = event.dataTransfer ? droppedFiles(event.dataTransfer) : [];
  if (items.length) vscode.postMessage({ type: "dropFiles", items });
  else dropPosition = undefined;
}, true);

vscode.postMessage({ type: "debugLog", message: "main.ts loaded (drag diagnostic v2)" });

window.addEventListener("message", (event: MessageEvent<WebviewResponse>) => {
  const message = event.data;
  if (broker.accept(message) || clipboard.accept(message)) return;
  if (message.type === "state") renderMethods(message.state);
  if (message.type === "inputKind") {
    inputKind = message.kind;
    updateRunState();
  }
  if (message.type === "insertFileReferences") {
    editor.insertFileReferences(message.expressions, dropPosition);
    dropPosition = undefined;
  }
  if (message.type === "imageAttachment") {
    addImageAttachment(message.relativePath, message.webviewUri, message.name);
    editor.insertFileReferences([`@${message.relativePath}`]);
  }
  if (message.type === "outputSession") renderOutputSession(message.session);
  if (message.type === "execution") {
    selectOutputTurn(message.turnId);
    renderResult(message.response);
  }
  if (message.type === "executionFailed") {
    selectOutputTurn(message.turnId);
    renderError(message.message);
  }
  if (message.type === "agentEvent") renderAgentEvent(message.event);
  if (message.type === "executing") {
    executing = message.value;
    if (message.value) {
      activeTurnId = message.turnId;
      stopping = false;
      createOutputTurn(message.turnId, message.source ?? "Dext turn");
      resetAgentTrace();
      startAgentProgress();
      elements.resultSection.classList.remove("hidden");
      if (!fullscreenPanel || fullscreenPanel === "result") {
        setSectionOpen(elements.resultHeading, elements.resultBody, true);
      }
    } else {
      if (activeTurnId === message.turnId) activeTurnId = undefined;
      stopping = false;
      selectOutputTurn(message.turnId);
      finishAgentProgress();
      if (activeTurn) {
        activeTurn.processDisclosure.open = false;
        activeTurn.outputDisclosure.open = true;
      }
    }
    updateRunState();
  }
  if (message.type === "error") {
    dropPosition = undefined;
    renderError(message.message);
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
vscode.postMessage({ type: "ready" });
