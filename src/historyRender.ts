import { parser } from "@lezer/python";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import type { AgentStreamEvent, DextResult, InputExecutionResponse, RuntimeResponse, WorkflowStepResponse } from "./core/types.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { DextHistoryRecord } from "./historyStore.js";
import { formatDuration } from "./webview/duration.js";

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
    return `${summary}${changes.map((change) => `<details class="history-disclosure file-change"><summary>${chevron()}<span>${escapeHtml(change.uri.replaceAll("\\", "/").split("/").pop() ?? change.uri)}</span></summary><div class="file-path">${escapeHtml(change.uri)}</div><pre class="diff"><span class="removed">- ${escapeHtml(change.before)}</span>\n<span class="added">+ ${escapeHtml(change.after)}</span></pre></details>`).join("")}`;
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
    : `<div class="process-text">${escapeHtml(event.text)}</div>`).join("")}</div></details>`;
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

function color(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

export function historyTokenStyles(theme?: EditorTokenTheme): string {
  return `.tok-keyword{color:${color(theme?.keyword, "var(--vscode-symbolIcon-keywordForeground, #c586c0)")}}.tok-string,.tok-string2{color:${color(theme?.string, "var(--vscode-symbolIcon-stringForeground, #ce9178)")}}.tok-number{color:${color(theme?.number, "var(--vscode-symbolIcon-numberForeground, #b5cea8)")}}.tok-bool,.tok-atom{color:${color(theme?.boolean, "var(--vscode-symbolIcon-booleanForeground, #569cd6)")}}.tok-comment{color:${color(theme?.comment, "var(--vscode-descriptionForeground)")}}.tok-variableName,.tok-definition{color:${color(theme?.variable, "var(--vscode-editor-foreground)")}}.tok-propertyName{color:${color(theme?.property, "var(--vscode-symbolIcon-propertyForeground, #9cdcfe)")}}.tok-typeName,.tok-className{color:${color(theme?.type, "var(--vscode-symbolIcon-classForeground, #4ec9b0)")}}.tok-operator{color:${color(theme?.operator, "var(--vscode-editor-foreground)")}}.tok-punctuation{color:${color(theme?.punctuation, "var(--vscode-editor-foreground)")}}`;
}
