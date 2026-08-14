import "../../media/styles.css";
import type {
  FieldDefinition,
  AgentStreamEvent,
  InputExecutionResponse,
  PatchChange,
  RuntimeResponse,
  WorkflowStepResponse
} from "../core/types.js";
import type { SidebarState, WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import { parseDroppedFiles } from "./chatAttachments.js";
import { ClipboardClient } from "./clipboardClient.js";
import { DextCodeEditor } from "./codeEditor.js";
import { LanguageRequestBroker } from "./languageClient.js";
import { formatDuration } from "./duration.js";

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
  inputShell: element<HTMLElement>("input-shell"),
  codeEditor: element<HTMLElement>("code-editor"),
  attachFiles: element<HTMLButtonElement>("attach-files"),
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
  clearOutput: element<HTMLButtonElement>("clear-output")
};

const broker = new LanguageRequestBroker((request) => vscode.postMessage(request));
const clipboard = new ClipboardClient((request) => vscode.postMessage(request));
let executing = false;
let hasErrors = false;
let problemCounts = { errors: 0, warnings: 0 };
  let inputKind: "empty" | "workflow" | "invalid" = "empty";
let dropPosition: number | undefined;
let agentStream: HTMLElement | undefined;
let agentTrace: HTMLDetailsElement | undefined;
let agentStreamRunActive = false;
let agentRunStartedAt = 0;
let agentRunTimer: ReturnType<typeof setInterval> | undefined;
let agentProgress: HTMLElement | undefined;
let agentProgressState: "Thinking" | "Worked" = "Thinking";
let agentCommandIds = new Set<string>();
let agentEditedUris = new Set<string>();
const agentGroups = new Map<"reasoning" | "files" | "tool", { disclosure: HTMLDetailsElement; body: HTMLElement }>();

const editor = new DextCodeEditor({
  parent: elements.codeEditor,
  broker,
  clipboard,
  onRun: run,
  onOpenFileReference: (reference) => vscode.postMessage({ type: "openFileReference", reference }),
  onDiagnosticsChanged(counts) {
    problemCounts = counts;
    hasErrors = counts.errors > 0;
    updateRunState();
  },
  onInputKindChanged(kind) {
    inputKind = kind;
    updateRunState();
  },
  onError: renderError
});

function updateRunState(): void {
  elements.run.disabled = executing || hasErrors || inputKind === "empty" || inputKind === "invalid";
  elements.runLabel.textContent = "Run";
  const parts = [
    problemCounts.errors ? `${problemCounts.errors} error${problemCounts.errors === 1 ? "" : "s"}` : "",
    problemCounts.warnings ? `${problemCounts.warnings} warning${problemCounts.warnings === 1 ? "" : "s"}` : ""
  ].filter(Boolean);
  elements.problems.textContent = parts.join(" · ") || "No problems";
  elements.problems.disabled = parts.length === 0;
  elements.problems.classList.toggle("has-problems", parts.length > 0);
}

function run(): void {
  const source = editor.source.trim();
  if (!source || elements.run.disabled) return;
  vscode.postMessage({ type: "executeInput", source });
}

function defaultValue(field: FieldDefinition): string {
  if (field.multiple) return `[${defaultValue({ ...field, multiple: false })}]`;
  if (field.default !== undefined) {
    return typeof field.default === "string" ? `"${field.default}"` : String(field.default);
  }
  if (field.type === "context") return "ref.selection";
  if (field.type === "result") return "edit_result";
  if (field.type === "number") return "0";
  if (field.type === "boolean") return "False";
  if (field.type === "enum") return `"${field.values?.[0] ?? ""}"`;
  return '""';
}

function methodTemplate(method: SidebarState["methods"][number]): string {
  const args = method.input
    .filter((field) => field.required)
    .map((field) => `${field.name}=${defaultValue(field)}`);
  return `${method.id}(${args.join(", ")})`;
}

function renderMethods(state: SidebarState): void {
  editor.applyTheme(state.theme);
  elements.methods.replaceChildren();
  elements.methodCount.textContent = String(state.methods.length);
  type NamespaceNode = { methods: typeof state.methods; children: Map<string, NamespaceNode> };
  const root: NamespaceNode = { methods: [], children: new Map() };
  for (const method of state.methods) {
    const parts = method.id.split(".");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) { child = { methods: [], children: new Map() }; node.children.set(part, child); }
      node = child;
    }
    node.methods.push(method);
  }
  const collectSources = (node: NamespaceNode): Set<string> => {
    const sources = new Set<string>(node.methods.map((method) => method.source === "builtin" ? "builtin" : "project"));
    for (const child of node.children.values()) {
      for (const source of collectSources(child)) sources.add(source);
    }
    return sources;
  };
  const renderNode = (node: NamespaceNode, parent: HTMLElement, prefix = ""): void => {
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
      const sourceName = sources.length === 1 ? sources[0] : undefined;
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
    if (!prefix) {
      const source = document.createElement("span");
      source.className = "method-source-inline";
      source.textContent = method.source === "builtin" ? "builtin" : "project";
      identity.append(name, source);
    } else {
      identity.append(name);
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
  const title = open ? "Collapse API namespaces" : "Expand API namespaces";
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
  setSectionOpen(heading, body, heading.getAttribute("aria-expanded") !== "true");
}

function renderAgentControls(state: SidebarState): void {
  const profile = document.getElementById("agent-profile") as HTMLSelectElement | null;
  const model = document.getElementById("agent-model") as HTMLSelectElement | null;
  const reasoning = document.getElementById("agent-reasoning") as HTMLSelectElement | null;
  const speed = document.getElementById("agent-speed") as HTMLSelectElement | null;
  if (!profile || !model || !reasoning || !speed) return;
  profile.replaceChildren(new Option("Agent default", ""));
  for (const item of state.agentProfiles) profile.append(new Option(item.label, item.id));
  profile.value = state.agentSelection.profileId ?? "";
  const selected = state.agentProfiles.find((item) => item.id === profile.value);
  model.replaceChildren(new Option("Model default", ""));
  type ModelOption = { id: string; label: string; reasoningEfforts: string[]; speedTiers: string[]; serviceTiers: string[]; defaultReasoningEffort?: string };
  const options: ModelOption[] = selected?.modelOptions
    ? selected.modelOptions
    : (selected?.models ?? []).map((item): ModelOption => ({ id: item, label: item, reasoningEfforts: [], speedTiers: [], serviceTiers: [] }));
  for (const item of options) model.append(new Option(item.label, item.id));
  model.value = state.agentSelection.model ?? "";
  const selectedModel = options.find((item) => item.id === model.value);
  reasoning.replaceChildren(new Option("Reasoning default", ""));
  for (const effort of selectedModel?.reasoningEfforts ?? []) reasoning.append(new Option(effort, effort));
  const selectedReasoning: string = state.agentSelection.reasoningEffort ?? "";
  const defaultReasoning: string = selectedModel?.defaultReasoningEffort ?? "";
  let resolvedReasoning: string = defaultReasoning;
  if (selectedModel?.reasoningEfforts.includes(selectedReasoning)) resolvedReasoning = selectedReasoning;
  reasoning.value = resolvedReasoning;
  speed.replaceChildren(new Option("Speed default", ""));
  for (const tier of selectedModel?.speedTiers ?? []) speed.append(new Option(tier === "standard" ? "Standard" : tier, tier));
  speed.value = state.agentSelection.speed ?? "";
}

function submitAgentSelection(): void {
  const profile = document.getElementById("agent-profile") as HTMLSelectElement | null;
  const model = document.getElementById("agent-model") as HTMLSelectElement | null;
  const reasoning = document.getElementById("agent-reasoning") as HTMLSelectElement | null;
  const speed = document.getElementById("agent-speed") as HTMLSelectElement | null;
  if (!profile || !model || !reasoning || !speed) return;
  vscode.postMessage({ type: "agentSelection", selection: {
    profileId: profile.value,
    model: model.value,
    reasoningEffort: reasoning.value,
    speed: speed.value,
    serviceTier: ""
  } });
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

function renderExecution(response: RuntimeResponse): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(resultHeading(response));
  const result = response.result;
  if (result.kind === "chat" || result.kind === "text") {
    fragment.append(copyableText(result.text));
  } else if (result.kind === "explain") {
    fragment.append(copyableText(result.text));
  } else if (result.kind === "edit") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.summary;
    fragment.append(paragraph);
    for (const change of result.patch.changes) {
      const file = document.createElement("div");
      file.className = "patch-file";
      file.textContent = change.uri;
      fragment.append(file);
    }
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
    for (const change of result.changes) {
      const file = document.createElement("div");
      file.className = "patch-file";
      const uri = document.createElement("div");
      uri.className = "patch-uri";
      uri.textContent = change.uri;
      file.append(uri, codeBlock(`- ${change.before}\n+ ${change.after}`));
      fragment.append(file);
    }
  }
  return fragment;
}

function renderResult(response: InputExecutionResponse): void {
  const preserveStream = agentStreamRunActive && Boolean(agentStream?.isConnected);
  agentStreamRunActive = false;
  if (!preserveStream) elements.result.replaceChildren();
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
    elements.result.append(item);
    if (index < entries.length - 1) item.classList.add("has-next");
  }
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
}

function renderError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  const preserveStream = agentStreamRunActive && Boolean(agentStream?.isConnected);
  agentStreamRunActive = false;
  if (!preserveStream) {
    elements.result.replaceChildren();
    agentStream = undefined;
  }
  const summary = document.createElement("pre");
  summary.className = "error-output";
  summary.textContent = text;
  elements.result.append(summary);
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
  elements.result.append(trace);
  agentTrace = trace;
  agentStream = panel;
  agentProgress = progress;
  updateAgentProgress(agentProgressState);
  return panel;
}

function updateAgentProgress(label: string): void {
  if (!agentProgress) return;
  agentProgressState = label === "Worked" ? "Worked" : "Thinking";
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

function agentGroup(kind: "reasoning" | "files" | "tool"): { disclosure: HTMLDetailsElement; body: HTMLElement } {
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
  label.textContent = kind === "reasoning" ? "Thought briefly" : kind === "files" ? "Edited files" : "Ran commands";
  const body = document.createElement("div");
  body.className = "agent-trace-group-body";
  summary.append(chevron, label);
  disclosure.append(summary, body);
  const order = { reasoning: 0, files: 1, tool: 2 } as const;
  const next = [...panel.querySelectorAll<HTMLElement>(".agent-trace-group")]
    .find((candidate) => order[candidate.dataset.kind as keyof typeof order] > order[kind]);
  disclosure.dataset.kind = kind;
  if (next) panel.insertBefore(disclosure, next);
  else panel.append(disclosure);
  const group = { disclosure, body };
  agentGroups.set(kind, group);
  return group;
}

function updateAgentGroupLabel(kind: "reasoning" | "files" | "tool"): void {
  const label = agentGroups.get(kind)?.disclosure.querySelector<HTMLElement>(".agent-trace-label");
  if (!label) return;
  if (kind === "files") label.textContent = `Edited ${agentEditedUris.size} file${agentEditedUris.size === 1 ? "" : "s"}`;
  if (kind === "tool") label.textContent = `Ran ${agentCommandIds.size} command${agentCommandIds.size === 1 ? "" : "s"}`;
}

function renderAgentEvent(event: AgentStreamEvent): void {
  if (event.phase === "status") return;
  if (event.phase === "reasoning" || event.phase === "message") updateAgentProgress("Thinking");
  const group = agentGroup(event.phase === "tool" ? "tool" : "reasoning");
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
      const body = document.createElement("pre");
      body.className = "agent-stream-text";
      item.append(body);
    }
    item.append(copyButton(event.text));
    panel.append(item);
  }
  const body = item.querySelector<HTMLElement>(".agent-stream-text");
  const eventBody = event.phase === "tool" && event.title === event.text ? "" : event.text;
  if (body) body.textContent = event.replace ? eventBody : `${body.textContent ?? ""}${eventBody}`;
  const summaryLabel = item.querySelector<HTMLElement>(".agent-stream-summary-label");
  if (summaryLabel && event.phase === "tool") summaryLabel.textContent = (event.title ?? summaryLabel.textContent ?? "Command").slice(0, 180);
  const outputCopy = item.querySelector<HTMLButtonElement>(".output-copy");
  if (outputCopy) {
    outputCopy.replaceWith(copyButton(body?.textContent ?? event.text));
  }
  elements.resultSection.classList.remove("hidden");
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
}

function changedLineCounts(change: PatchChange): { added: number; removed: number } {
  const before = change.before.split(/\r?\n/);
  const after = change.after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  return {
    added: Math.max(0, after.length - prefix - suffix),
    removed: Math.max(0, before.length - prefix - suffix)
  };
}

function appendDiffLines(container: HTMLElement, change: PatchChange): void {
  const before = change.before.split(/\r?\n/);
  const after = change.after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const lines: { kind: "context" | "removed" | "added"; text: string }[] = [];
  for (const text of before.slice(Math.max(0, prefix - 3), prefix)) lines.push({ kind: "context", text });
  for (const text of before.slice(prefix, before.length - suffix)) lines.push({ kind: "removed", text });
  for (const text of after.slice(prefix, after.length - suffix)) lines.push({ kind: "added", text });
  for (const text of after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + 3))) lines.push({ kind: "context", text });
  const diff = document.createElement("pre");
  diff.className = "agent-file-diff";
  for (const line of lines) {
    const row = document.createElement("span");
    row.className = `agent-diff-line ${line.kind}`;
    row.textContent = `${line.kind === "removed" ? "-" : line.kind === "added" ? "+" : " "} ${line.text}\n`;
    diff.append(row);
  }
  container.append(diff);
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
    const disclosure = document.createElement("details");
    disclosure.className = "agent-file-change";
    const summary = document.createElement("summary");
    const chevron = document.createElement("i");
    chevron.className = "disclosure-chevron codicon codicon-chevron-right";
    const name = change.uri.replaceAll("\\", "/").split("/").pop() ?? change.uri;
    const counts = changedLineCounts(change);
    const label = document.createElement("span");
    label.textContent = `${name}  +${counts.added} -${counts.removed}`;
    const path = document.createElement("div");
    path.className = "agent-file-path";
    path.textContent = change.uri;
    summary.append(chevron, label);
    disclosure.append(summary, path);
    appendDiffLines(disclosure, change);
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

elements.run.addEventListener("click", run);
elements.problems.addEventListener("click", () => editor.goToFirstDiagnostic());
elements.methodsToggle.addEventListener("click", toggleMethodGroups);
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
  elements.result.replaceChildren();
  agentStreamRunActive = false;
  resetAgentTrace();
  if (agentRunTimer) clearInterval(agentRunTimer);
  agentRunTimer = undefined;
  setSectionOpen(elements.resultHeading, elements.resultBody, true);
});
document.getElementById("agent-profile")?.addEventListener("change", () => {
  const model = document.getElementById("agent-model") as HTMLSelectElement | null;
  if (model) model.value = "";
  const reasoning = document.getElementById("agent-reasoning") as HTMLSelectElement | null;
  const speed = document.getElementById("agent-speed") as HTMLSelectElement | null;
  if (reasoning) reasoning.value = "";
  if (speed) speed.value = "";
  submitAgentSelection();
});
document.getElementById("agent-model")?.addEventListener("change", () => {
  const reasoning = document.getElementById("agent-reasoning") as HTMLSelectElement | null;
  const speed = document.getElementById("agent-speed") as HTMLSelectElement | null;
  if (reasoning) reasoning.value = "";
  if (speed) speed.value = "";
  submitAgentSelection();
});
document.getElementById("agent-reasoning")?.addEventListener("change", () => {
  submitAgentSelection();
});
document.getElementById("agent-speed")?.addEventListener("change", () => {
  submitAgentSelection();
});
elements.inputShell.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropPosition = editor.positionAtPoint(event.clientX, event.clientY);
  elements.inputShell.classList.add("drop-active");
});
elements.inputShell.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && elements.inputShell.contains(event.relatedTarget)) return;
  elements.inputShell.classList.remove("drop-active");
  dropPosition = undefined;
});
elements.inputShell.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.inputShell.classList.remove("drop-active");
  const items = event.dataTransfer ? droppedFiles(event.dataTransfer) : [];
  if (items.length) vscode.postMessage({ type: "dropFiles", items });
  else dropPosition = undefined;
});

window.addEventListener("message", (event: MessageEvent<WebviewResponse>) => {
  const message = event.data;
  if (broker.accept(message) || clipboard.accept(message)) return;
  if (message.type === "state") renderMethods(message.state);
  if (message.type === "inputKind") {
    inputKind = message.kind;
    updateRunState();
  }
  if (message.type === "insertFileReferences") {
    editor.insertInline(message.expressions.join(" "), dropPosition);
    dropPosition = undefined;
  }
  if (message.type === "execution") renderResult(message.response);
  if (message.type === "agentEvent") renderAgentEvent(message.event);
  if (message.type === "executing") {
    executing = message.value;
    if (message.value) {
      agentStreamRunActive = true;
      elements.result.replaceChildren();
      resetAgentTrace();
      startAgentProgress();
      elements.resultSection.classList.remove("hidden");
      setSectionOpen(elements.resultHeading, elements.resultBody, true);
    } else {
      finishAgentProgress();
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
vscode.postMessage({ type: "ready" });
