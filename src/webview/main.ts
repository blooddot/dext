import "../../media/styles.css";
import type {
  FieldDefinition,
  InputExecutionResponse,
  RuntimeResponse,
  WorkflowStepResponse
} from "../core/types.js";
import type { SidebarState, WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import { parseDroppedFiles } from "./chatAttachments.js";
import { ClipboardClient } from "./clipboardClient.js";
import { DextCodeEditor } from "./codeEditor.js";
import { LanguageRequestBroker } from "./languageClient.js";

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
  reload: element<HTMLButtonElement>("reload"),
  trust: element<HTMLElement>("trust-status"),
  methods: element<HTMLElement>("methods"),
  methodCount: element<HTMLElement>("method-count"),
  configErrors: element<HTMLElement>("config-errors"),
  resultSection: element<HTMLElement>("result-section"),
  result: element<HTMLElement>("result"),
  clearOutput: element<HTMLButtonElement>("clear-output")
};

const broker = new LanguageRequestBroker((request) => vscode.postMessage(request));
const clipboard = new ClipboardClient((request) => vscode.postMessage(request));
let executing = false;
let hasErrors = false;
let problemCounts = { errors: 0, warnings: 0 };
let inputKind: "empty" | "workflow" | "invalid" = "empty";
let dropPosition: number | undefined;

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
  if (field.type === "patch") return "edit.patch";
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
  for (const method of state.methods) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "method-row";
    row.title = method.description;
    const identity = document.createElement("span");
    identity.className = "method-identity";
    const name = document.createElement("span");
    name.className = "method-name";
    name.textContent = method.id;
    const meta = document.createElement("span");
    meta.className = "method-meta";
    meta.textContent = `${method.kind} | ${method.source} | ${method.output.kind}`;
    identity.append(name, meta);
    const insert = document.createElement("i");
    insert.className = "codicon codicon-add";
    row.append(identity, insert);
    row.addEventListener("click", () => editor.insertInvocation(methodTemplate(method)));
    elements.methods.append(row);
  }
  elements.trust.className = `status-dot ${state.trusted ? "trusted" : "untrusted"}`;
  elements.trust.title = state.trusted ? "Workspace trusted" : "Workspace untrusted";
  elements.configErrors.replaceChildren();
  for (const diagnostic of state.diagnostics) {
    const item = document.createElement("div");
    item.textContent = diagnostic;
    elements.configErrors.append(item);
  }
  editor.refreshLanguageState();
}

function resultHeading(response: RuntimeResponse): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "result-meta";
  heading.textContent = `${response.method.id} | ${Math.round(response.durationMs)} ms`;
  return heading;
}

function codeBlock(content: string): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = content;
  pre.append(code);
  return pre;
}

function renderExecution(response: RuntimeResponse): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(resultHeading(response));
  const result = response.result;
  if (result.kind === "chat" || result.kind === "text") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.text;
    fragment.append(paragraph);
  } else if (result.kind === "explain") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.text;
    fragment.append(paragraph);
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
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.text;
    fragment.append(paragraph);
  } else if (result.kind === "terminal") {
    const summary = document.createElement("p");
    summary.className = "text-result";
    summary.textContent = `${result.status} | exit ${result.exit_code} | ${Math.round(result.duration_ms)} ms | ${result.cwd}`;
    const command = document.createElement("div");
    command.className = "output-title";
    command.textContent = result.command;
    fragment.append(summary, command);
    if (result.stdout) fragment.append(codeBlock(result.stdout));
    if (result.stderr) {
      const stderr = document.createElement("div");
      stderr.className = "finding error";
      stderr.textContent = result.stderr;
      fragment.append(stderr);
    }
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
  elements.result.replaceChildren();
  const entries: WorkflowStepResponse[] = response.steps ?? response.executions.map((execution) => ({
    method: execution.method.id,
    state: "success" as const,
    response: execution
  }));
  for (const [index, step] of entries.entries()) {
    const item = document.createElement("section");
    item.className = "execution-result";
    if (step.response) item.append(renderExecution(step.response));
    else {
      const state = document.createElement("div");
      state.className = `result-meta step-${step.state}`;
      state.textContent = `${step.assignment ? `${step.assignment} = ` : ""}${step.method} | ${step.state}`;
      item.append(state);
      if (step.error) {
        const error = document.createElement("p");
        error.className = "finding error";
        error.textContent = String(step.error);
        item.append(error);
      }
    }
    elements.result.append(item);
    if (index < entries.length - 1) item.classList.add("has-next");
  }
  elements.resultSection.classList.remove("hidden");
}

function renderError(message: unknown): void {
  const text = message instanceof Error ? message.message : String(message);
  elements.result.replaceChildren();
  const summary = document.createElement("p");
  summary.className = "finding error";
  summary.textContent = text;
  elements.result.append(summary);
  elements.resultSection.classList.remove("hidden");
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
elements.reload.addEventListener("click", () => vscode.postMessage({ type: "reload" }));
elements.attachFiles.addEventListener("click", () => vscode.postMessage({ type: "chooseFiles" }));
elements.clearOutput.addEventListener("click", () => {
  elements.result.replaceChildren();
  elements.resultSection.classList.add("hidden");
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
  if (message.type === "executing") {
    executing = message.value;
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
