import { parser } from "@lezer/python";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { AgentStreamEvent, DextResult, InputExecutionResponse, RuntimeResponse, WorkflowStepResponse } from "./core/types.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { DextHistoryRecord, DextHistorySession } from "./historyStore.js";
import { formatDuration } from "./webview/duration.js";
import { presentAgentMessage } from "./agentMessagePresentation.js";
import { presentDiff } from "./diffPresentation.js";
import type { AgentMessagePresentation } from "./agentMessagePresentation.js";
import type { PatchChange } from "./core/types.js";
import {
  compactFileReferenceLabel,
  inputReferenceDisplayParts,
  inputReferenceDisplayText,
  normalizeInputReferenceSource,
  type ContextReferenceOccurrence
} from "./core/fileReference.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&><"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  })[character] ?? character);
}

function chevron(): string {
  return `<i class="disclosure-chevron codicon codicon-chevron-right"></i>`;
}

// VS Code reads this attribute to build the native context menu and passes the
// merged object to the invoked command.
function contextAttribute(context: Record<string, string | boolean>): string {
  return `data-vscode-context='${escapeHtml(JSON.stringify(context)).replaceAll("'", "&#39;")}'`;
}

function copyButton(value: string): string {
  return `<button class="copy-button codicon codicon-copy" type="button" data-copy="${escapeHtml(value)}" title="Copy" aria-label="Copy"></button>`;
}

function diffModeSwitch(): string {
  return `<span class="diff-mode-switch" role="group" aria-label="Diff layout"><button class="diff-mode-button active" type="button" data-diff-mode="inline" aria-pressed="true" title="Inline diff">Inline</button><button class="diff-mode-button" type="button" data-diff-mode="split" aria-pressed="false" title="Split diff">Split</button></span>`;
}

function diffSide(line: ReturnType<typeof presentDiff>["rows"][number]["before"], marker: string): string {
  if (!line) return `<span class="diff-side empty"><span class="diff-line-number"></span><span class="diff-marker"></span><span class="diff-code"></span></span>`;
  return `<span class="diff-side ${line.kind}"><span class="diff-line-number">${line.line}</span><span class="diff-marker">${marker}</span><span class="diff-code">${escapeHtml(line.text)}</span></span>`;
}

function renderDiff(change: Pick<PatchChange, "before" | "after">): string {
  const diff = presentDiff(change);
  const inline = diff.rows.flatMap((row) => {
    if (row.before?.kind === "context") return [diffSide(row.before, " ")];
    return [row.before ? diffSide(row.before, "-") : "", row.after ? diffSide(row.after, "+") : ""].filter(Boolean);
  }).join("");
  const split = diff.rows.map((row) => `<span class="diff-split-row">${diffSide(row.before, row.before?.kind === "removed" ? "-" : " ")}${diffSide(row.after, row.after?.kind === "added" ? "+" : " ")}</span>`).join("");
  return `<div class="diff-view" data-diff-view="inline"><div class="diff-inline">${inline}</div><div class="diff-split">${split}</div></div>`;
}

function renderFileChange(change: Pick<PatchChange, "uri" | "before" | "after">): string {
  const name = change.uri.replaceAll("\\", "/").split("/").pop() ?? change.uri;
  const counts = presentDiff(change);
  return `<details class="history-disclosure file-change" data-diff-container><summary>${chevron()}<span>${escapeHtml(name)}</span><span class="history-meta"><span class="diff-added">+${counts.added}</span> <span class="diff-removed">-${counts.removed}</span></span>${diffModeSwitch()}</summary><div class="file-path">${escapeHtml(change.uri)}</div>${renderDiff(change)}</details>`;
}

export function highlightDext(source: string): string {
  let html = "";
  highlightCode(
    source,
    parser.parse(source),
    classHighlighter,
    (text, classes) => { html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text); },
    () => { html += "\n"; }
  );
  return html;
}

function referenceIcon(reference: ContextReferenceOccurrence): string {
  if (reference.kind === "dir") return "folder";
  if (reference.kind === "symbol") return "symbol-method";
  return "file";
}

/** History keeps readable source for copy/replay and renders @path tokens as
 * Chips in the rendered view. */
function inputReferenceChip(reference: ContextReferenceOccurrence): string {
  const label = compactFileReferenceLabel(reference.payload);
  const title = escapeHtml(reference.payload);
  const open = reference.kind === "file"
    ? ` data-open-file-reference="${title}"`
    : "";
  return `<span class="attachment-chip history-file-reference" title="${title}"><button class="attachment-open" type="button" title="Open ${escapeHtml(label)}" aria-label="Open ${escapeHtml(label)}"${open}><i class="codicon codicon-${referenceIcon(reference)}"></i><span class="attachment-label">${escapeHtml(label)}</span></button></span>`;
}

function renderedInputSource(source: string): string {
  return inputReferenceDisplayParts(source)
    .map((part) => part.kind === "text" ? escapeHtml(part.value) : inputReferenceChip(part.reference))
    .join("");
}

function resultText(result: DextResult): string {
  if (result.kind === "chat" || result.kind === "text" || result.kind === "explain" || result.kind === "print" || result.kind === "agent") return result.text;
  if (result.kind === "edit" || result.kind === "review" || result.kind === "apply") return result.summary;
  if (result.kind === "terminal") return [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.kind === "code") return result.code;
  if (result.kind === "patch") return result.changes.map((change) => `${change.uri}\n- ${change.before}\n+ ${change.after}`).join("\n\n");
  if (result.kind === "plan") return result.steps.map((step) => `${step.title}${step.detail ? `: ${step.detail}` : ""}`).join("\n");
  if (result.kind === "ui") {
    if (result.type === "choice") {
      const selected = result.selected.length ? result.selected.join(", ") : "No selection";
      return result.custom ? `${selected} (custom: ${result.custom})` : selected;
    }
    if (result.type === "confirm") return result.confirmed ? "Confirmed" : "Cancelled";
    return result.value ?? "No input";
  }
  return "";
}

function resultBody(result: DextResult): string {
  if (result.kind === "terminal") {
    const content = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return `<details class="history-disclosure terminal-result"><summary>${chevron()}<span>${escapeHtml(result.command)}</span><span class="history-meta">${escapeHtml(result.status)} · exit ${result.exit_code}</span></summary><div class="disclosure-body"><div class="history-meta">${escapeHtml(result.cwd)}</div>${content ? `<pre class="terminal-text">${escapeHtml(content)}</pre>` : ""}</div></details>`;
  }
  if (result.kind === "edit" || result.kind === "patch") {
    const changes = result.kind === "edit" ? result.patch.changes : result.changes;
    const summary = result.kind === "edit" ? `<p>${escapeHtml(result.summary)}</p>` : "";
    return `${summary}${changes.map(renderFileChange).join("")}`;
  }
  if (result.kind === "agent") {
    const changes = result.patch?.changes ?? [];
    return `${result.text ? `<p>${escapeHtml(result.text)}</p>` : ""}${changes.map(renderFileChange).join("")}`;
  }
  if (result.kind === "review") {
    return `<p>${escapeHtml(result.summary)}</p>${result.findings.map((finding) => `<div class="finding ${finding.severity}">${escapeHtml(finding.message)}</div>`).join("")}`;
  }
  if (result.kind === "apply") return `<p><span class="result-state">${escapeHtml(result.status)}</span>: ${escapeHtml(result.summary)}</p>`;
  if (result.kind === "plan") return `<ol>${result.steps.map((step) => `<li>${escapeHtml(step.title)}${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ""}</li>`).join("")}</ol>`;
  if (result.kind === "code") return `<pre class="code-text">${escapeHtml(result.code)}</pre>`;
  const text = resultText(result);
  const body = text ? `<p>${escapeHtml(text)}</p>` : "";
  // History replays a plan turn read-only: the document opens, but handing it to
  // the Agent belongs to the live composer.
  if (result.kind === "chat" && result.planPath) return `${body}${planLink(result.planPath)}`;
  return body;
}

function planLink(planPath: string): string {
  const title = escapeHtml(planPath);
  const label = escapeHtml(planPath.split("/").pop() ?? planPath);
  return `<div class="plan-actions"><span class="attachment-chip history-file-reference" title="${title}"><button class="attachment-open" type="button" title="Open ${label}" aria-label="Open ${label}" data-open-file-reference="${title}"><i class="codicon codicon-checklist"></i><span class="attachment-label">${label}</span></button></span></div>`;
}

function execution(response: RuntimeResponse): string {
  const raw = resultText(response.result);
  return `<section class="history-execution"><div class="execution-heading"><span>${escapeHtml(response.method.id)}</span><span class="history-meta">${formatDuration(response.durationMs)}</span>${raw ? copyButton(raw) : ""}</div>${resultBody(response.result)}</section>`;
}

function steps(response: InputExecutionResponse): WorkflowStepResponse[] {
  return response.steps ?? response.executions.map((item) => ({ method: item.method.id, state: "success", response: item }));
}

function output(response: InputExecutionResponse): string {
  return steps(response).map((step) => step.response
    ? execution(step.response)
    : `<details class="history-disclosure step-result"><summary>${chevron()}<span>${escapeHtml(step.method)}</span><span class="history-meta">${escapeHtml(step.state)}</span></summary>${step.error ? `<pre class="error">${escapeHtml(step.error)}</pre>` : ""}</details>`
  ).join("");
}

function outputText(response: InputExecutionResponse): string {
  return response.executions.map((item) => resultText(item.result)).filter(Boolean).join("\n\n");
}

function processMessage(text: string): string {
  const presentation = presentAgentMessage(text);
  if (!presentation.structured) return `<div class="process-text">${escapeHtml(text)}</div>`;
  const meta = presentation.meta.length
    ? `<span class="process-result-meta">${escapeHtml(presentation.meta.join(" · "))}</span>`
    : "";
  const body = presentation.text
    ? `<div class="process-result-text">${escapeHtml(presentation.text)}</div>`
    : "";
  const details = presentation.details.map((detail) =>
    `<div class="process-result-detail ${detail.tone}">${detail.meta ? `<span class="process-result-detail-meta">${escapeHtml(detail.meta)}</span>` : ""}${escapeHtml(detail.text)}</div>`
  ).join("");
  return `<section class="process-result process-result-${presentation.kind}"><div class="process-result-heading"><span class="process-result-title">${escapeHtml(presentation.title)}</span>${meta}</div>${body}${details}${renderPresentationExtras(presentation)}</section>`;
}

function renderPresentationExtras(presentation: AgentMessagePresentation): string {
  const changes = presentation.changes.map(renderFileChange).join("");
  const references = presentation.references.map((reference) => {
    const name = reference.uri.replaceAll("\\", "/").split("/").pop() ?? reference.uri;
    const meta = [reference.location, reference.symbol].filter(Boolean).join(" · ");
    return `<details class="history-disclosure process-reference"><summary>${chevron()}<span>${escapeHtml(name)}</span>${meta ? `<span class="history-meta">${escapeHtml(meta)}</span>` : ""}</summary><div class="file-path">${escapeHtml(reference.uri)}</div>${reference.content ? `<pre>${escapeHtml(reference.content)}</pre>` : ""}</details>`;
  }).join("");
  const sections = presentation.sections.map((item) => `<details class="history-disclosure process-section ${item.tone}"><summary>${chevron()}<span>${escapeHtml(item.title)}</span></summary><div class="disclosure-body">${item.code ? `<pre>${escapeHtml(item.text)}</pre>` : `<div class="process-text">${escapeHtml(item.text)}</div>`}</div></details>`).join("");
  return changes + references + sections;
}

function commandLabel(event: AgentStreamEvent): string {
  return (event.title ?? event.text.split(/\r?\n/, 1)[0] ?? "Command").slice(0, 180);
}

function commandRow(event: AgentStreamEvent, className = "process-command"): string {
  return `<details class="history-disclosure ${className}"><summary>${chevron()}<span>${escapeHtml(commandLabel(event))}</span></summary><pre>${escapeHtml(event.text)}</pre></details>`;
}

function process(events: readonly AgentStreamEvent[]): string {
  const html: string[] = [];
  let tools: AgentStreamEvent[] = [];
  let groupId: string | undefined;
  const flushTools = (): void => {
    const firstTool = tools[0];
    if (!firstTool) return;
    // A lone unnamed command already names itself in the group summary, so only
    // real groups need a nested row per command.
    const lone = !firstTool.groupLabel && tools.length === 1;
    const label = firstTool.groupLabel ?? (lone ? commandLabel(firstTool) : `Ran ${tools.length} commands`);
    const body = lone ? `<pre>${escapeHtml(firstTool.text)}</pre>` : tools.map((event) => commandRow(event)).join("");
    html.push(`<details class="history-disclosure process-event process-command-group"><summary>${chevron()}<span>${escapeHtml(label)}</span></summary><div class="disclosure-body">${body}</div></details>`);
    tools = [];
    groupId = undefined;
  };
  for (const event of events) {
    if (event.phase === "status") continue;
    if (event.phase === "tool") {
      if (event.solo) {
        flushTools();
        html.push(commandRow(event, "process-event process-command-solo"));
        continue;
      }
      if (tools.length && event.groupId !== groupId) flushTools();
      groupId = event.groupId;
      tools.push(event);
      continue;
    }
    flushTools();
    html.push(`<section class="process-message">${processMessage(event.text)}</section>`);
  }
  flushTools();
  return html.join("");
}

function parsedResponse(record: DextHistoryRecord): InputExecutionResponse | undefined {
  if (record.response) return record.response;
  try {
    const value = JSON.parse(record.output) as InputExecutionResponse;
    return value?.kind === "workflow" && Array.isArray(value.executions) ? value : undefined;
  } catch {
    return undefined;
  }
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

const TURN_ACTION_HINT = "Right-click for turn and conversation actions";
const SESSION_ACTION_HINT = "Right-click for conversation actions";

export function renderHistoryRecord(record: DextHistoryRecord, sessionId?: string): string {
  const input = normalizeInputReferenceSource(record.input);
  const response = parsedResponse(record);
  const firstLine = inputReferenceDisplayText(input).split(/\r?\n/, 1)[0]!.slice(0, 140);
  const duration = response?.executions.reduce((total, item) => total + item.durationMs, 0) ?? 0;
  const processHtml = process(record.process);
  const outputHtml = record.error
    ? `<pre class="error">${escapeHtml(record.error)}</pre>`
    : response ? output(response) : `<pre>${escapeHtml(record.output)}</pre>`;
  const outputCopy = record.error || (response ? outputText(response) : record.output);
  const context = sessionId
    ? ` ${contextAttribute({
      webviewSection: "turn",
      sessionId,
      turnId: record.id,
      preventDefaultContextMenuItems: true
    })}`
    : "";
  // The turn actions are a context menu with no visual affordance of its own,
  // so the row says where to find them.
  const hint = sessionId ? ` title="${TURN_ACTION_HINT}"` : "";
  return `<details class="history-record"${context}><summary${hint}>${chevron()}<span>${escapeHtml(dateLabel(record.createdAt))}</span><span class="history-summary-input">${escapeHtml(firstLine)}</span><span class="history-meta">${duration ? formatDuration(duration) : ""}</span></summary><div class="history-record-body"><details class="history-disclosure"><summary>${chevron()}<span>Input</span>${copyButton(input)}</summary><pre class="dext-source">${renderedInputSource(input)}</pre></details>${processHtml ? `<details class="history-disclosure"><summary>${chevron()}<span>Process</span></summary><div class="disclosure-body">${processHtml}</div></details>` : ""}<details class="history-disclosure" open><summary>${chevron()}<span>Output</span>${copyButton(outputCopy)}</summary><div class="disclosure-body">${outputHtml}</div></details></div></details>`;
}

/** The name a conversation carries until the user renames it: the opening line
 * of its first message, with @ references spelled out. */
export function conversationTitle(session: DextHistorySession): string {
  const first = session.turns[0];
  if (!first) return "New conversation";
  const line = inputReferenceDisplayText(normalizeInputReferenceSource(first.input))
    .split(/\r?\n/, 1)[0]!
    .trim()
    .slice(0, 140);
  return line || "New conversation";
}

export interface HistorySessionView {
  favorite?: boolean;
  name?: string;
}

export function renderHistorySession(session: DextHistorySession, view: HistorySessionView = {}): string {
  const favorite = view.favorite === true;
  const count = `${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}`;
  const context = contextAttribute({
    webviewSection: "session",
    sessionId: session.id,
    dextFavorite: favorite,
    preventDefaultContextMenuItems: true
  });
  const star = favorite
    ? `<i class="history-favorite codicon codicon-star-full" title="Favorite" aria-label="Favorite"></i>`
    : "";
  const label = view.name ?? conversationTitle(session);
  return `<details class="history-session${favorite ? " favorite" : ""}" ${context}><summary title="${SESSION_ACTION_HINT}">${chevron()}${star}<span>${escapeHtml(dateLabel(session.createdAt))}</span><span class="history-summary-input${view.name ? " named" : ""}">${escapeHtml(label)}</span><span class="history-meta">${count}</span></summary><div class="history-session-body">${session.turns.map((turn) => renderHistoryRecord(turn, session.id)).join("")}</div></details>`;
}

export function conversationMarkdown(session: DextHistorySession): string {
  const turns = session.turns.map((record, index) => {
    const response = parsedResponse(record);
    const answer = record.error || (response ? outputText(response) : record.output);
    return [
      `## Turn ${index + 1} — ${dateLabel(record.createdAt)}`,
      "### Input",
      inputReferenceDisplayText(normalizeInputReferenceSource(record.input)),
      record.error ? "### Error" : "### Output",
      answer
    ].join("\n\n");
  });
  return [`# Dext conversation — ${dateLabel(session.createdAt)}`, ...turns].join("\n\n");
}

function color(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

export function historyTokenStyles(theme?: EditorTokenTheme): string {
  return `.tok-keyword{color:${color(theme?.keyword, "var(--vscode-symbolIcon-keywordForeground, #c586c0)")}}.tok-string,.tok-string2{color:${color(theme?.string, "var(--vscode-symbolIcon-stringForeground, #ce9178)")}}.tok-number{color:${color(theme?.number, "var(--vscode-symbolIcon-numberForeground, #b5cea8)")}}.tok-bool,.tok-atom{color:${color(theme?.boolean, "var(--vscode-symbolIcon-booleanForeground, #569cd6)")}}.tok-comment{color:${color(theme?.comment, "var(--vscode-descriptionForeground)")}}.tok-variableName,.tok-definition{color:${color(theme?.variable, "var(--vscode-editor-foreground)")}}.tok-propertyName{color:${color(theme?.property, "var(--vscode-symbolIcon-propertyForeground, #9cdcfe)")}}.tok-typeName,.tok-className{color:${color(theme?.type, "var(--vscode-symbolIcon-classForeground, #4ec9b0)")}}.tok-operator{color:${color(theme?.operator, "var(--vscode-editor-foreground)")}}.tok-punctuation{color:${color(theme?.punctuation, "var(--vscode-editor-foreground)")}}`;
}
