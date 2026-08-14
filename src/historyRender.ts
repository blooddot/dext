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

export function escapeHtml(value: string): string {
  return value.replace(/[&><"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  })[character] ?? character);
}

function chevron(): string {
  return `<i class="disclosure-chevron codicon codicon-chevron-right"></i>`;
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

function resultText(result: DextResult): string {
  if (result.kind === "chat" || result.kind === "text" || result.kind === "explain" || result.kind === "print") return result.text;
  if (result.kind === "edit" || result.kind === "review" || result.kind === "apply") return result.summary;
  if (result.kind === "terminal") return [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.kind === "code") return result.code;
  if (result.kind === "patch") return result.changes.map((change) => `${change.uri}\n- ${change.before}\n+ ${change.after}`).join("\n\n");
  if (result.kind === "plan") return result.steps.map((step) => `${step.title}${step.detail ? `: ${step.detail}` : ""}`).join("\n");
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
  if (result.kind === "review") {
    return `<p>${escapeHtml(result.summary)}</p>${result.findings.map((finding) => `<div class="finding ${finding.severity}">${escapeHtml(finding.message)}</div>`).join("")}`;
  }
  if (result.kind === "apply") return `<p><span class="result-state">${escapeHtml(result.status)}</span>: ${escapeHtml(result.summary)}</p>`;
  if (result.kind === "plan") return `<ol>${result.steps.map((step) => `<li>${escapeHtml(step.title)}${step.detail ? `<small>${escapeHtml(step.detail)}</small>` : ""}</li>`).join("")}</ol>`;
  if (result.kind === "code") return `<pre class="code-text">${escapeHtml(result.code)}</pre>`;
  const text = resultText(result);
  return text ? `<p>${escapeHtml(text)}</p>` : "";
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

function eventGroup(label: string, events: readonly AgentStreamEvent[]): string {
  if (!events.length) return "";
  return `<details class="history-disclosure process-group"><summary>${chevron()}<span>${escapeHtml(label)}</span><span class="history-meta">${events.length}</span></summary><div class="disclosure-body">${events.map((event) => event.phase === "tool"
    ? `<details class="history-disclosure process-event"><summary>${chevron()}<span>${escapeHtml((event.title ?? event.text.split(/\r?\n/, 1)[0] ?? "Command").slice(0, 180))}</span></summary>${event.title === event.text ? "" : `<pre>${escapeHtml(event.text)}</pre>`}</details>`
    : processMessage(event.text)).join("")}</div></details>`;
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

function process(events: readonly AgentStreamEvent[]): string {
  const reasoning = events.filter((event) => event.phase === "reasoning" || event.phase === "message");
  const tools = events.filter((event) => event.phase === "tool");
  return eventGroup("Thought", reasoning) + eventGroup(`Ran ${tools.length} command${tools.length === 1 ? "" : "s"}`, tools);
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

export function renderHistoryRecord(record: DextHistoryRecord): string {
  const response = parsedResponse(record);
  const firstLine = record.input.split(/\r?\n/, 1)[0]!.slice(0, 140);
  const duration = response?.executions.reduce((total, item) => total + item.durationMs, 0) ?? 0;
  const processHtml = process(record.process);
  const outputHtml = record.error
    ? `<pre class="error">${escapeHtml(record.error)}</pre>`
    : response ? output(response) : `<pre>${escapeHtml(record.output)}</pre>`;
  const outputCopy = record.error || (response ? outputText(response) : record.output);
  return `<details class="history-record"><summary>${chevron()}<span>${escapeHtml(dateLabel(record.createdAt))}</span><span class="history-summary-input">${escapeHtml(firstLine)}</span><span class="history-meta">${duration ? formatDuration(duration) : ""}</span></summary><div class="history-record-body"><details class="history-disclosure"><summary>${chevron()}<span>Input</span>${copyButton(record.input)}</summary><pre class="dext-source">${highlightDext(record.input)}</pre></details>${processHtml ? `<details class="history-disclosure"><summary>${chevron()}<span>Process</span></summary><div class="disclosure-body">${processHtml}</div></details>` : ""}<details class="history-disclosure" open><summary>${chevron()}<span>Output</span>${copyButton(outputCopy)}</summary><div class="disclosure-body">${outputHtml}</div></details></div></details>`;
}

export function renderHistorySession(session: DextHistorySession): string {
  const firstInput = session.turns[0]?.input.split(/\r?\n/, 1)[0]?.slice(0, 140) ?? "Dext conversation";
  const count = `${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}`;
  return `<details class="history-session"><summary>${chevron()}<span>${escapeHtml(dateLabel(session.createdAt))}</span><span class="history-summary-input">${escapeHtml(firstInput)}</span><span class="history-meta">${count}</span></summary><div class="history-session-body">${session.turns.map(renderHistoryRecord).join("")}</div></details>`;
}

function color(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

export function historyTokenStyles(theme?: EditorTokenTheme): string {
  return `.tok-keyword{color:${color(theme?.keyword, "var(--vscode-symbolIcon-keywordForeground, #c586c0)")}}.tok-string,.tok-string2{color:${color(theme?.string, "var(--vscode-symbolIcon-stringForeground, #ce9178)")}}.tok-number{color:${color(theme?.number, "var(--vscode-symbolIcon-numberForeground, #b5cea8)")}}.tok-bool,.tok-atom{color:${color(theme?.boolean, "var(--vscode-symbolIcon-booleanForeground, #569cd6)")}}.tok-comment{color:${color(theme?.comment, "var(--vscode-descriptionForeground)")}}.tok-variableName,.tok-definition{color:${color(theme?.variable, "var(--vscode-editor-foreground)")}}.tok-propertyName{color:${color(theme?.property, "var(--vscode-symbolIcon-propertyForeground, #9cdcfe)")}}.tok-typeName,.tok-className{color:${color(theme?.type, "var(--vscode-symbolIcon-classForeground, #4ec9b0)")}}.tok-operator{color:${color(theme?.operator, "var(--vscode-editor-foreground)")}}.tok-punctuation{color:${color(theme?.punctuation, "var(--vscode-editor-foreground)")}}`;
}
