import "../../media/styles.css";
import type { AttachmentView } from "../attachmentStore.js";
import type { FieldDefinition, RuntimeResponse } from "../core/types.js";
import type { SidebarState, WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import {
  attachmentForComposerDelete,
  composerParts,
  normalizeComposerPoint,
  removeComposerAttachment,
  selectedComposerAttachments,
  serializeComposerParts
} from "./chatComposer.js";
import { ClipboardClient } from "./clipboardClient.js";
import { DextCodeEditor } from "./codeEditor.js";
import { LanguageRequestBroker } from "./languageClient.js";
import { parseDroppedFiles } from "./chatAttachments.js";
import {
  createFileReferenceChip,
  fileReferenceChipDescriptor
} from "./fileReferenceChip.js";

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
  codeMode: element<HTMLButtonElement>("code-mode"),
  chatMode: element<HTMLButtonElement>("chat-mode"),
  codePanel: element<HTMLElement>("code-panel"),
  chatPanel: element<HTMLElement>("chat-panel"),
  chatComposer: element<HTMLElement>("chat-composer"),
  codeEditor: element<HTMLElement>("code-editor"),
  chatInput: element<HTMLElement>("chat-input"),
  attachFiles: element<HTMLButtonElement>("attach-files"),
  run: element<HTMLButtonElement>("run"),
  runState: element<HTMLElement>("run-state"),
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
let mode: "code" | "chat" = "code";
let executing = false;
let hasErrors = false;
let attachments = new Map<string, AttachmentView>();
let chatPastePending = false;
let savedChatRange: Range | undefined;
const pendingAttachmentRemovals = new Set<string>();

const editor = new DextCodeEditor({
  parent: elements.codeEditor,
  broker,
  clipboard,
  onRun: run,
  onOpenFileReference: (reference) => vscode.postMessage({ type: "openFileReference", reference }),
  onDiagnosticsChanged(value) {
    hasErrors = value;
    updateRunDisabled();
  },
  onError: renderError
});

function updateRunDisabled(): void {
  elements.run.disabled = executing || (mode === "code" && hasErrors);
}

function setMode(nextMode: "code" | "chat"): void {
  mode = nextMode;
  const code = mode === "code";
  elements.codeMode.classList.toggle("active", code);
  elements.chatMode.classList.toggle("active", !code);
  elements.codeMode.setAttribute("aria-selected", String(code));
  elements.chatMode.setAttribute("aria-selected", String(!code));
  elements.codePanel.classList.toggle("hidden", !code);
  elements.chatPanel.classList.toggle("hidden", code);
  if (code) {
    requestAnimationFrame(() => editor.focus());
  } else {
    focusChatInput();
  }
  updateRunDisabled();
}

function triggerCodeAction(action: "suggest" | "parameterHints"): void {
  setMode("code");
  requestAnimationFrame(() => {
    if (action === "suggest") editor.triggerSuggest();
    else editor.triggerParameterHints();
  });
}

function nodeInsideAttachment(node: Node): boolean {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return Boolean(element?.closest("[data-attachment-id]"));
}

function captureChatRange(): void {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return;
  const range = selection.getRangeAt(0);
  const inside = range.commonAncestorContainer === elements.chatInput
    || elements.chatInput.contains(range.commonAncestorContainer);
  if (!inside || nodeInsideAttachment(range.startContainer) || nodeInsideAttachment(range.endContainer)) {
    return;
  }
  const saved = range.cloneRange();
  if (saved.collapsed) {
    const point = normalizeComposerPoint(elements.chatInput, saved.startContainer, saved.startOffset);
    saved.setStart(point.container, point.offset);
    saved.collapse(true);
  }
  savedChatRange = saved;
}

function chatRange(): Range {
  if (
    savedChatRange
    && savedChatRange.startContainer.isConnected
    && savedChatRange.endContainer.isConnected
    && elements.chatInput.contains(savedChatRange.commonAncestorContainer)
  ) {
    return savedChatRange.cloneRange();
  }
  const range = document.createRange();
  range.selectNodeContents(elements.chatInput);
  range.collapse(false);
  return range;
}

function selectChatRange(range: Range): void {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  savedChatRange = range.cloneRange();
}

function focusChatInput(): void {
  elements.chatInput.focus();
  selectChatRange(chatRange());
}

function insertChatNode(node: Node): Range {
  const range = chatRange();
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  return range;
}

function insertAttachmentAtChatRange(node: Node): void {
  const range = insertChatNode(node);
  const caret = document.createTextNode("\u200B");
  node.parentNode?.insertBefore(caret, node.nextSibling);
  range.setStartAfter(caret);
  range.collapse(true);
  selectChatRange(range);
}

function removeAttachmentToken(token: HTMLElement): void {
  removeComposerAttachment(elements.chatInput, token);
}

function removeOrphanedChatCarets(): void {
  const walker = document.createTreeWalker(elements.chatInput, NodeFilter.SHOW_TEXT);
  const carets: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.textContent === "\u200B") carets.push(node);
  }
  for (const node of carets) {
    const previous = node.previousSibling;
    if (!(previous instanceof HTMLElement) || !previous.dataset.attachmentId) node.remove();
  }
}

function insertChatText(text: string): void {
  if (!text) return;
  selectChatRange(insertChatNode(document.createTextNode(text)));
}

function attachmentElement(id: string): HTMLElement | undefined {
  return [...elements.chatInput.querySelectorAll<HTMLElement>("[data-attachment-id]")]
    .find((element) => element.dataset.attachmentId === id);
}

function createAttachmentToken(attachment: AttachmentView): HTMLElement {
  const descriptor = fileReferenceChipDescriptor(attachment.label, attachment.uri);
  const chip = createFileReferenceChip({ document, ...descriptor });
  chip.dataset.attachmentId = attachment.id;
  chip.contentEditable = "false";
  return chip;
}

function requestAttachmentRemoval(token: HTMLElement, restoreCaret = false): void {
  const id = token.dataset.attachmentId;
  if (!id) return;
  attachments.delete(id);
  const point = removeComposerAttachment(elements.chatInput, token);
  if (point && restoreCaret) {
    const range = document.createRange();
    range.setStart(point.container, point.offset);
    range.collapse(true);
    selectChatRange(range);
  }
  if (!pendingAttachmentRemovals.has(id)) {
    pendingAttachmentRemovals.add(id);
    vscode.postMessage({ type: "removeAttachment", attachmentId: id });
  }
}

function attachmentEventToken(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-attachment-id]") ?? undefined
    : undefined;
}

function attachmentRemoveTarget(target: EventTarget | null): HTMLElement | undefined {
  return target instanceof Element && target.closest(".attachment-remove")
    ? attachmentEventToken(target)
    : undefined;
}

function syncAttachments(next: AttachmentView[]): void {
  for (const id of pendingAttachmentRemovals) {
    if (!next.some((attachment) => attachment.id === id)) pendingAttachmentRemovals.delete(id);
  }
  const nextAttachments = new Map(next
    .filter((attachment) => !pendingAttachmentRemovals.has(attachment.id))
    .map((attachment) => [attachment.id, attachment]));
  attachments = nextAttachments;
  for (const token of elements.chatInput.querySelectorAll<HTMLElement>("[data-attachment-id]")) {
    const id = token.dataset.attachmentId;
    if (id && !nextAttachments.has(id)) removeAttachmentToken(token);
  }
  for (const attachment of nextAttachments.values()) {
    if (!attachmentElement(attachment.id)) insertAttachmentAtChatRange(createAttachmentToken(attachment));
  }
}

async function pasteChatInput(): Promise<void> {
  if (chatPastePending) return;
  captureChatRange();
  chatPastePending = true;
  try {
    const result = await clipboard.read("chat");
    if (!result || result.contextAttached || result.text.length === 0) return;
    insertChatText(result.text);
  } finally {
    chatPastePending = false;
    focusChatInput();
  }
}

function run(): void {
  if (elements.run.disabled) return;
  if (mode === "code") {
    const source = editor.source.trim();
    if (source) vscode.postMessage({ type: "executeCode", source });
  } else {
    const serialized = serializeComposerParts(composerParts(elements.chatInput));
    const message = serialized.message.trim();
    if (message || serialized.attachmentIds.length) {
      vscode.postMessage({
        type: "executeChat",
        message,
        attachmentIds: serialized.attachmentIds
      });
    }
  }
}

function defaultValue(field: FieldDefinition): string {
  if (field.multiple) return `[${defaultValue({ ...field, multiple: false })}]`;
  if (field.default !== undefined) {
    return typeof field.default === "string" ? `"${field.default}"` : String(field.default);
  }
  if (field.type === "context") return "@selection";
  if (field.type === "number") return "0";
  if (field.type === "boolean") return "false";
  if (field.type === "enum") return `"${field.values?.[0] ?? ""}"`;
  return '""';
}

function methodTemplate(method: SidebarState["methods"][number]): string {
  const args = method.input
    .filter((field) => field.required)
    .map((field) => `${field.name}: ${defaultValue(field)}`);
  return `${method.id}(${args.join(", ")})`;
}

function renderMethods(state: SidebarState): void {
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
    row.addEventListener("click", () => {
      setMode("code");
      const value = methodTemplate(method);
      editor.setValue(value, Math.max(0, value.length - 1));
    });
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

function renderResult(response: RuntimeResponse): void {
  elements.result.replaceChildren(resultHeading(response));
  const result = response.result;
  if (result.kind === "text") {
    const paragraph = document.createElement("p");
    paragraph.className = "text-result";
    paragraph.textContent = result.text;
    elements.result.append(paragraph);
  } else if (result.kind === "code") {
    if (result.title) {
      const title = document.createElement("div");
      title.className = "output-title";
      title.textContent = result.title;
      elements.result.append(title);
    }
    elements.result.append(codeBlock(result.code));
  } else if (result.kind === "review") {
    const summary = document.createElement("p");
    summary.className = "text-result";
    summary.textContent = result.summary;
    elements.result.append(summary);
    for (const finding of result.findings) {
      const item = document.createElement("div");
      item.className = `finding ${finding.severity}`;
      const icon = document.createElement("i");
      icon.className = `codicon codicon-${finding.severity}`;
      const content = document.createElement("span");
      content.textContent = finding.message;
      item.append(icon, content);
      elements.result.append(item);
    }
  } else if (result.kind === "plan") {
    const title = document.createElement("div");
    title.className = "output-title";
    title.textContent = result.title;
    const list = document.createElement("ol");
    list.className = "plan-list";
    for (const step of result.steps) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = step.title;
      item.append(name);
      if (step.detail) {
        const detail = document.createElement("small");
        detail.textContent = step.detail;
        item.append(detail);
      }
      list.append(item);
    }
    elements.result.append(title, list);
  } else {
    const title = document.createElement("div");
    title.className = "output-title";
    title.textContent = result.title;
    elements.result.append(title);
    for (const change of result.changes) {
      const file = document.createElement("div");
      file.className = "patch-file";
      const uri = document.createElement("div");
      uri.className = "patch-uri";
      uri.textContent = change.uri;
      file.append(uri, codeBlock(`- ${change.before}\n+ ${change.after}`));
      elements.result.append(file);
    }
  }
  elements.resultSection.classList.remove("hidden");
}

function renderError(message: string): void {
  renderResult({
    invocation: { kind: "invocation", method: "runtime", arguments: [], source: "code" },
    method: { id: "runtime", title: "Runtime", kind: "command", source: "builtin" },
    durationMs: 0,
    result: {
      kind: "review",
      summary: "Execution failed",
      findings: [{ severity: "error", message }]
    }
  });
}

elements.codeMode.addEventListener("click", () => setMode("code"));
elements.chatMode.addEventListener("click", () => setMode("chat"));
elements.run.addEventListener("click", run);
elements.reload.addEventListener("click", () => vscode.postMessage({ type: "reload" }));
elements.clearOutput.addEventListener("click", () => {
  elements.result.replaceChildren();
  elements.resultSection.classList.add("hidden");
});
elements.chatInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
    event.preventDefault();
    event.stopPropagation();
    void pasteChatInput();
    return;
  }
  if ((event.key === "Backspace" || event.key === "Delete") && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    if (range && !range.collapsed) {
      const selected = selectedComposerAttachments(elements.chatInput, range);
      if (selected.length) {
        event.preventDefault();
        selected.forEach((token, index) => requestAttachmentRemoval(token, index === selected.length - 1));
        return;
      }
    }
    if (range?.collapsed) {
      const token = attachmentForComposerDelete(
        elements.chatInput,
        range.startContainer,
        range.startOffset,
        event.key === "Backspace" ? "backward" : "forward"
      );
      if (token) {
        event.preventDefault();
        requestAttachmentRemoval(token, true);
        return;
      }
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    run();
  }
});
for (const eventName of ["pointerdown", "mousedown"] as const) {
  elements.chatComposer.addEventListener(eventName, (event) => {
    const token = attachmentRemoveTarget(event.target);
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    requestAttachmentRemoval(token, true);
  });
}
elements.chatComposer.addEventListener("click", (event) => {
  const removeToken = attachmentRemoveTarget(event.target);
  if (removeToken) {
    event.preventDefault();
    event.stopPropagation();
    requestAttachmentRemoval(removeToken, true);
    return;
  }
  const token = attachmentEventToken(event.target);
  const id = token?.dataset.attachmentId;
  if (id) vscode.postMessage({ type: "openAttachment", attachmentId: id });
});
elements.chatInput.addEventListener("paste", (event) => {
  event.preventDefault();
  void pasteChatInput();
});
for (const eventName of ["input", "keyup", "mouseup", "focus"] as const) {
  elements.chatInput.addEventListener(eventName, captureChatRange);
}
document.addEventListener("selectionchange", captureChatRange);
elements.attachFiles.addEventListener("mousedown", captureChatRange);
elements.attachFiles.addEventListener("click", () => {
  vscode.postMessage({ type: "chooseFiles" });
});
elements.chatComposer.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.chatComposer.classList.add("drop-active");
});
elements.chatComposer.addEventListener("dragleave", (event) => {
  if (event.relatedTarget instanceof Node && elements.chatComposer.contains(event.relatedTarget)) return;
  elements.chatComposer.classList.remove("drop-active");
});
elements.chatComposer.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.chatComposer.classList.remove("drop-active");
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const caretPosition = document.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (caretPosition && elements.chatInput.contains(caretPosition.offsetNode)) {
    const range = document.createRange();
    range.setStart(caretPosition.offsetNode, caretPosition.offset);
    range.collapse(true);
    savedChatRange = range;
  }
  const resourceUrlsType = [...transfer.types]
    .find((type) => type.toLowerCase() === "resourceurls") ?? "ResourceURLs";
  const codeFilesType = [...transfer.types]
    .find((type) => type.toLowerCase() === "codefiles") ?? "CodeFiles";
  const items = parseDroppedFiles({
    uriList: transfer.getData("text/uri-list"),
    codeUriList: transfer.getData("application/vnd.code.uri-list"),
    resourceUrls: transfer.getData(resourceUrlsType),
    codeFiles: transfer.getData(codeFilesType),
    plainText: transfer.getData("text/plain")
  });
  if (!items.length) return;
  vscode.postMessage({ type: "dropFiles", items });
});
const attachmentObserver = new MutationObserver(() => {
  removeOrphanedChatCarets();
  for (const [id] of attachments) {
    if (attachmentElement(id)) continue;
    attachments.delete(id);
    vscode.postMessage({ type: "removeAttachment", attachmentId: id });
  }
});
attachmentObserver.observe(elements.chatInput, { childList: true, subtree: true });

window.addEventListener("message", (event: MessageEvent<WebviewResponse>) => {
  const message = event.data;
  if (broker.accept(message)) return;
  if (clipboard.accept(message)) return;
  if (message.type === "state") renderMethods(message.state);
  if (message.type === "attachments") syncAttachments(message.attachments);
  if (message.type === "execution") renderResult(message.response);
  if (message.type === "executing") {
    executing = message.value;
    elements.runState.textContent = executing ? "Running..." : "";
    updateRunDisabled();
  }
  if (message.type === "error") renderError(message.message);
  if (message.type === "focusEditor") {
    if (mode === "code") editor.focus();
    else focusChatInput();
  }
  if (message.type === "showChat") setMode("chat");
  if (message.type === "triggerSuggest") {
    triggerCodeAction("suggest");
  }
  if (message.type === "triggerParameterHints") {
    triggerCodeAction("parameterHints");
  }
});

window.addEventListener("unload", () => {
  broker.dispose();
  clipboard.dispose();
  attachmentObserver.disconnect();
  editor.destroy();
});

vscode.postMessage({ type: "ready" });
