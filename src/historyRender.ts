import { uiResultText } from "./uiInteractionPresentation.js";
import { readHistoryResponse } from "./historyResponse.js";
import { renderTurnSection, renderTurnInput, renderTurnMarkdown, renderTurnResult, renderTurnMessage, turnHtmlAdapter } from "./turnComponents.js";
import { formatJsonOutput } from "./webview/jsonOutput.js";
import { parser } from "@lezer/python";
import { highlightCode } from "@lezer/highlight";
import MarkdownIt from "markdown-it";
import { markdownCodeCopy } from "./markdownCopy.js";
import { latestAgentTodos, renderAgentTodos, planExecutionLabel } from "./agentTodoPresentation.js";
import type { AgentStreamEvent, DextResult, InputExecutionResponse, RuntimeResponse, WorkflowStepResponse } from "./core/types.js";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { DextHistoryRecord, DextHistorySession } from "./historyStore.js";
import {
  TURN_RENAME_ACTION, TURN_FORK_ACTION, TURN_COPY_ACTION, TURN_DELETE_ACTION, presentTurn,
  type TurnSectionPresentation
} from "./turnPresentation.js";
import { agentMessageCopyText, presentAgentMessage } from "./agentMessagePresentation.js";
import { presentDiff } from "./diffPresentation.js";
import type { PatchChange } from "./core/types.js";
import { dextClassHighlighter, dextTokenStyles, shouldHighlightInput } from "./dextTokenTheme.js";
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

// Process events are also shown in the live conversation, where Markdown owns
// paragraph and soft-break layout. History must use the same interpretation:
// rendering the stored source with pre-wrap turns Markdown's blank lines into
// unusually large gaps after a conversation is reopened.
const processMarkdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true
});
processMarkdown.use(markdownCodeCopy);

function renderProcessMarkdown(source: string): string {
  return processMarkdown.render(source);
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

/** Thin host adapter; shared components own section structure and result dispatch. */
function historyTurnSection(section: TurnSectionPresentation, body: string, options: { open?: boolean } = {}): string {
  return renderTurnSection(turnHtmlAdapter, section, [{ html: body }], options.open).disclosure.html;
}

function markdownOutput(text: string): string {
  return renderTurnMarkdown(turnHtmlAdapter,
    { html: `<div class="markdown-body">${renderProcessMarkdown(text)}</div>` },
    { html: copyButton(text) }
  ).html;
}

function jsonOutput(text: string): string {
  const formatted = formatJsonOutput(text);
  if (!formatted) return markdownOutput(text);
  return renderTurnMarkdown(turnHtmlAdapter,
    { html: `<div class="markdown-body">${renderProcessMarkdown("```json\n" + formatted + "\n```")}</div>` },
    { html: copyButton(formatted) }).html;
}

/** High-frequency conversation actions stay visible on hover; the complete
 * action set remains available from the native context menu. */
function historyActionButton(icon: string, command: string, label: string, sessionId: string, turnId?: string): string {
  const target = turnId ? ` data-turn-id="${escapeHtml(turnId)}"` : "";
  return `<button class="history-session-action icon-button compact" type="button" data-history-command="${escapeHtml(command)}" data-session-id="${escapeHtml(sessionId)}"${target} title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i class="codicon codicon-${icon}"></i></button>`;
}

function historyTurnActions(sessionId: string, turnId: string): string {
  return `<span class="history-turn-actions">${[
    historyActionButton(TURN_RENAME_ACTION.icon, "dext.history.renameTurn", TURN_RENAME_ACTION.label, sessionId, turnId),
    historyActionButton(TURN_FORK_ACTION.icon, "dext.history.forkFromTurn", TURN_FORK_ACTION.label, sessionId, turnId),
    historyActionButton(TURN_COPY_ACTION.icon, "dext.history.copyTurn", TURN_COPY_ACTION.label, sessionId, turnId),
    historyActionButton(TURN_DELETE_ACTION.icon, "dext.history.deleteTurn", TURN_DELETE_ACTION.label, sessionId, turnId)
  ].join("")}</span>`;
}

function historySessionActions(session: DextHistorySession, favorite: boolean): string {
  const favoriteCommand = favorite ? "dext.history.removeFavorite" : "dext.history.addFavorite";
  const favoriteLabel = favorite ? "Remove from favorites" : "Add to favorites";
  const favoriteIcon = favorite ? "star-full" : "star-empty";
  const archiveCommand = session.archivedAt ? "dext.history.unarchiveConversation" : "dext.history.archiveConversation";
  const archiveLabel = session.archivedAt ? "Restore conversation" : "Archive conversation";
  const archiveIcon = session.archivedAt ? "inbox" : "archive";
  return [
    historyActionButton("debug-continue", "dext.history.continueConversation", "Continue in Dext", session.id),
    historyActionButton(TURN_RENAME_ACTION.icon, "dext.history.renameConversation", "Rename conversation", session.id),
    historyActionButton(TURN_FORK_ACTION.icon, "dext.history.forkConversation", "Fork conversation", session.id),
    historyActionButton("copy", "dext.history.copyConversation", "Copy conversation as Markdown", session.id),
    historyActionButton(favoriteIcon, favoriteCommand, favoriteLabel, session.id),
    historyActionButton(archiveIcon, archiveCommand, archiveLabel, session.id),
    historyActionButton("trash", "dext.history.deleteConversation", "Delete conversation", session.id)
  ].join("");
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
    dextClassHighlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => { html += "\n"; }
  );
  return html;
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

function plainTerminalClass(line: string): string | undefined {
  if (/^\s*(?:[>$]|PS [^>]*>)\s+/.test(line)) return "ansi-cyan";
  if (/\b(?:fail(?:ed|ure)?|errors?|fatal)\b|[✗×]/i.test(line)) return "ansi-red";
  if (/\b(?:pass(?:ed)?|success(?:ful)?|succeed(?:ed)?|ok)\b|✓/i.test(line)) return "ansi-green";
  if (/^\s*(?:RUN|Test Files|Tests|Snapshots|Start|Duration)\b/.test(line)) return "ansi-bright-blue";
  return undefined;
}

/** Render terminal ANSI SGR sequences as safe, theme-aware HTML. */
export function highlightTerminal(source: string): string {
  const content = source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
  const active = new Set<string>();
  let foreground: string | undefined;
  let html = "";
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const ansi = new RegExp(
    `${escape}(?:\\[([0-9;]*)m|\\[[0-?]*[ -/]*[@-~]|\\][^${bell}]*(?:${bell}|${escape}\\\\))`,
    "g"
  );
  const hasAnsi = content.includes(escape);
  let cursor = 0;
  const appendText = (value: string): void => {
    if (!value) return;
    const text = escapeHtml(value);
    if (active.size === 0 && !foreground) {
      if (hasAnsi) {
        html += text;
      } else {
        html += value.split("\n").map((line) => {
          const className = plainTerminalClass(line);
          return className ? `<span class="${className}">${escapeHtml(line)}</span>` : escapeHtml(line);
        }).join("\n");
      }
      return;
    }
    const style = foreground ? ` style="color:${foreground}"` : "";
    html += `<span class="${[...active].join(" ")}"${style}>${text}</span>`;
  };

  for (const match of content.matchAll(ansi)) {
    appendText(content.slice(cursor, match.index));
    const codes = match[1] === undefined ? [] : (match[1] ? match[1].split(";").map(Number) : [0]);
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index] ?? 0;
      if (code === 0) {
        active.clear();
        foreground = undefined;
      } else if (code === 1) active.add("ansi-bold");
      else if (code === 2) active.add("ansi-dim");
      else if (code === 3) active.add("ansi-italic");
      else if (code === 4) active.add("ansi-underline");
      else if (code === 22) { active.delete("ansi-bold"); active.delete("ansi-dim"); }
      else if (code === 23) active.delete("ansi-italic");
      else if (code === 24) active.delete("ansi-underline");
      else if (code === 39) { for (const color of ANSI_COLOR_CLASSES) active.delete(color); foreground = undefined; }
      else {
        const color = ANSI_COLORS.get(code);
        if (color) {
          for (const existing of ANSI_COLOR_CLASSES) active.delete(existing);
          active.add(color);
          foreground = undefined;
        } else if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes[index + 2] !== undefined) {
          if (code === 38) foreground = ansi256Color(codes[index + 2]!);
          index += 2;
        } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes[index + 4] !== undefined) {
          if (code === 38) {
            const [red, green, blue] = codes.slice(index + 2, index + 5);
            foreground = `rgb(${red}, ${green}, ${blue})`;
          }
          index += 4;
        }
      }
    }
    cursor = match.index + match[0].length;
  }
  appendText(content.slice(cursor));
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

function plainInputSource(source: string): string {
  return inputReferenceDisplayParts(source).map((part) => part.kind === "ref"
    ? inputReferenceChip(part.reference)
    : escapeHtml(part.value)
  ).join("");
}

function renderedInputSource(source: string, mode?: DextHistoryRecord["mode"]): string {
  const normalized = normalizeInputReferenceSource(source);
  if (!shouldHighlightInput(normalized, mode)) return plainInputSource(normalized);
  const parts = inputReferenceDisplayParts(normalized);
  const references = parts.filter((part): part is Extract<typeof part, { kind: "ref" }> => part.kind === "ref");
  if (!references.length) return highlightDext(normalized);

  // Keep references as widgets while highlighting the complete source. A
  // placeholder is a valid Python identifier in every context where a
  // readable @path token can occur (including inside a string), so Lezer can
  // still classify the surrounding Dext syntax correctly. Replace the
  // placeholder after highlighting to avoid breaking token spans.
  const placeholders = references.map((_, index) => `__dext_reference_${index}__`);
  const highlightedSource = parts.map((part) => part.kind === "ref"
    ? placeholders[references.indexOf(part)]!
    : part.value
  ).join("");
  let html = highlightDext(highlightedSource);
  references.forEach((part, index) => {
    html = html.replaceAll(escapeHtml(placeholders[index]!), inputReferenceChip(part.reference));
  });
  return html;
}

function resultText(result: DextResult): string {
  if (result.kind === "ask" || result.kind === "plan" || result.kind === "skill" || result.kind === "print" || result.kind === "agent") return result.text;
  if (result.kind === "apply") return result.summary;
  if (result.kind === "terminal") return [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.kind === "patch") return result.changes.map((change) => `${change.uri}\n- ${change.before}\n+ ${change.after}`).join("\n\n");
  return uiResultText(result);
}

function resultBody(result: DextResult): string {
  return renderTurnResult({
    ...turnHtmlAdapter,
    markdown: (text) => ({ html: markdownOutput(text) }),
    json: (text) => ({ html: jsonOutput(text) }),
    terminal: (text, stderr) => ({ html: `<pre class="terminal-text${stderr ? " terminal-stderr" : ""}">${highlightTerminal(text)}</pre>` }),
    patch: (change) => ({ html: renderFileChange(change) }),
    plan: (path) => ({ html: planLink(path) })
  }, result).map((node) => node.html).join("");
}

// History opens the plan document; building it belongs to the live composer.
function planLink(planPath: string): string {
  const title = escapeHtml(planPath);
  const label = escapeHtml(`Plan: ${planPath.split("/").pop() ?? planPath}`);
  return `<div class="plan-actions"><span class="attachment-chip history-file-reference" title="${title}"><button class="attachment-open" type="button" title="Open ${label}" aria-label="Open ${label}" data-open-file-reference="${title}"><i class="codicon codicon-checklist"></i><span class="attachment-label">${label}</span></button></span></div>`;
}

function execution(response: RuntimeResponse): string {
  return `<section class="history-execution execution-result">${resultBody(response.result)}</section>`;
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
  return renderTurnMessage({
    ...turnHtmlAdapter,
    prose: (text) => ({ html: `<div class="markdown-body">${renderProcessMarkdown(text)}</div>` }),
    code: (text) => ({ html: `<pre>${escapeHtml(text)}</pre>` }),
    patch: (change) => ({ html: renderFileChange(change) })
  }, presentAgentMessage(text)).map((node) => node.html).join("");
}

function commandLabel(event: AgentStreamEvent): string {
  return (event.title ?? event.text.split(/\r?\n/, 1)[0] ?? "Command").slice(0, 180);
}

function commandRow(event: AgentStreamEvent, className = "process-command"): string {
  return `<details class="history-disclosure ${className}"><summary>${chevron()}<span>${escapeHtml(commandLabel(event))}</span></summary><pre class="terminal-text">${highlightTerminal(event.text)}</pre></details>`;
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
    const body = lone ? `<pre class="terminal-text">${highlightTerminal(firstTool.text)}</pre>` : tools.map((event) => commandRow(event)).join("");
    html.push(`<details class="history-disclosure process-event process-command-group"><summary>${chevron()}<span>${escapeHtml(label)}</span></summary><div class="disclosure-body">${body}</div></details>`);
    tools = [];
    groupId = undefined;
  };
  for (const event of events) {
    if (event.phase === "status" || event.phase === "todo" || event.phase === "input") continue;
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
    html.push(`<section class="process-message agent-stream-item agent-trace-message"><div class="agent-stream-text">${processMessage(event.text)}</div>${copyButton(agentMessageCopyText(presentAgentMessage(event.text)))}</section>`);
  }
  flushTools();
  return html.join("");
}

function inputHistory(events: readonly AgentStreamEvent[]): string {
  const interactions = new Map(events.flatMap((event) => event.uiInteraction ? [[event.uiInteraction.requestId, event.uiInteraction] as const] : []));
  const forms = [...interactions.values()].map((state) => {
    const fields = state.form.fields.map((field) => `<p><strong>${escapeHtml(field.label)}</strong>: ${escapeHtml(field.secret ? "Answer hidden" : uiResultText(state.answers?.[field.id]))}</p>`).join("");
    return `<section class="agent-input-card"><strong>${escapeHtml(state.form.title)} — ${state.status === "submitted" ? "Submitted" : "Closed"}</strong>${fields}</section>`;
  }).join("");
  const requests = new Map(events.flatMap((event) => event.userInput ? [[event.userInput.id, event.userInput] as const] : []));
  return forms + [...requests.values()].map((request) => {
    const status = request.status === "answered" ? "Answered" : "Closed";
    const questions = request.questions.map((question) => {
      const answer = request.status === "answered" ? question.isSecret ? "Answer submitted"
        : request.answers?.[question.id]?.answers.join(", ") ?? "Answer submitted" : "No answer submitted";
      return `<div class="agent-input-question"><strong>${escapeHtml(question.question)}</strong><p class="agent-input-answer">${escapeHtml(answer)}</p></div>`;
    }).join("");
    return `<section class="agent-input-card"><div class="agent-input-header"><strong>Question</strong><span class="agent-input-status">${status}</span></div>${questions}</section>`;
  }).join("");
}

function parsedResponse(record: DextHistoryRecord): InputExecutionResponse | undefined {
  return readHistoryResponse(record);
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

const TURN_ACTION_HINT = "Right-click for turn actions";
const SESSION_ACTION_HINT = "Right-click for conversation actions";

export function historyTurnTitle(record: DextHistoryRecord): string {
  if (record.title) return record.title;
  const planExecution = parsedResponse(record)?.executions.find((item) => item.result.kind === "plan" && item.result.executePlan);
  const planPath = (record.executePlan ? record.planPath : undefined)
    ?? (planExecution?.result.kind === "plan" ? planExecution.result.planPath : undefined);
  return planPath
    ? `Plan: ${planPath.split("/").pop() ?? planPath}`
    : inputReferenceDisplayText(normalizeInputReferenceSource(record.input)).split(/\r?\n/, 1)[0]!.slice(0, 140);
}

export function renderHistoryRecord(record: DextHistoryRecord, sessionId?: string): string {
  const input = normalizeInputReferenceSource(record.input);
  const response = parsedResponse(record);
  const planExecution = response?.executions.find((item) => item.result.kind === "plan" && item.result.executePlan);
  const executePlan = record.executePlan || !!planExecution;
  const firstLine = historyTurnTitle(record);
  const duration = response?.executions.reduce((total, item) => total + item.durationMs, 0) ?? 0;
  const turn = presentTurn({ source: input, mode: record.mode, hideInput: executePlan, durationMs: duration });
  const processHtml = process(record.process);
  const todoHtml = renderAgentTodos(latestAgentTodos(record.process)) + inputHistory(record.process);
  const outputHtml = record.error
    ? `<pre class="error">${escapeHtml(record.error)}</pre>`
    : response ? output(response) : `<pre>${escapeHtml(record.output)}</pre>`;
  const context = sessionId
    ? ` ${contextAttribute({
      webviewSection: "turn",
      sessionId,
      turnId: record.id,
      preventDefaultContextMenuItems: true
    })}`
    : "";
  const hint = sessionId ? ` title="${TURN_ACTION_HINT}"` : "";
  const target = sessionId ? ` data-session-id="${escapeHtml(sessionId)}" data-turn-id="${escapeHtml(record.id)}"` : "";
  const inputHtml = turn.input
    ? historyTurnSection(turn.input, renderTurnInput(turnHtmlAdapter,
      { html: `<pre class="dext-source">${renderedInputSource(turn.input.source, record.mode)}</pre>` },
      { html: copyButton(turn.input.source) }).html)
    : "";
  const planOutcome = record.planOutcome ?? (planExecution?.result.kind === "plan" ? planExecution.result.planOutcome : undefined);
  const planStatusHtml = executePlan ? `<span class="plan-status">${planExecutionLabel(record.process, record.error, planOutcome)}</span>` : "";
  const processSummary = historyTurnSection(turn.process, processHtml);
  const outputSection = historyTurnSection(turn.output, outputHtml, { open: true });
  return `<details class="history-record"${target}${context}><summary${hint}>${chevron()}<span class="history-summary-input${record.title ? " named" : ""}">${escapeHtml(firstLine)}</span>${planStatusHtml}<span class="history-meta history-record-time">${escapeHtml(dateLabel(record.createdAt))}</span>${sessionId ? historyTurnActions(sessionId, record.id) : ""}</summary><div class="history-record-body">${inputHtml}${todoHtml}${processSummary}${outputSection}</div></details>`;
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
  /** Render only the session row; the turn body can be requested on demand. */
  lazy?: boolean;
}

export function renderHistorySessionBody(session: DextHistorySession): string {
  return session.turns.map((turn) => renderHistoryRecord(turn, session.id)).join("\n");
}

export function renderHistorySession(session: DextHistorySession, view: HistorySessionView = {}): string {
  const favorite = view.favorite === true;
  const count = `${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}`;
  const context = contextAttribute({
    webviewSection: "session",
    sessionId: session.id,
    dextFavorite: favorite,
    ...(session.archivedAt ? { dextArchived: true } : {}),
    preventDefaultContextMenuItems: true
  });
  const star = favorite
    ? `<i class="history-favorite codicon codicon-star-full" title="Favorite" aria-label="Favorite"></i>`
    : "";
  const label = view.name ?? conversationTitle(session);
  const body = view.lazy
    ? `<div class="history-lazy-placeholder">Expand to load conversation turns.</div>`
    : renderHistorySessionBody(session);
  const lazyAttributes = view.lazy ? ` data-history-lazy="true" data-history-session-id="${escapeHtml(session.id)}"` : "";
  return `<details class="history-session${favorite ? " favorite" : ""}${session.archivedAt ? " archived" : ""}"${lazyAttributes} ${context}><summary title="${SESSION_ACTION_HINT}">${chevron()}${star}<span class="history-summary-input${view.name ? " named" : ""}">${escapeHtml(label)}</span><span class="history-meta">${count}</span><span class="history-meta history-session-time">${escapeHtml(dateLabel(session.createdAt))}</span><span class="history-session-actions">${historySessionActions(session, favorite)}</span></summary><div class="history-session-body">${body}</div></details>`;
}

export function historyTurnMarkdown(record: DextHistoryRecord, index = 0): string {
  const response = parsedResponse(record);
  const answer = record.error || (response ? outputText(response) : record.output);
  return [
    `## Turn ${index + 1}${record.title ? ` — ${record.title}` : ""} — ${dateLabel(record.createdAt)}`,
    "### Input",
    inputReferenceDisplayText(normalizeInputReferenceSource(record.input)),
    record.error ? "### Error" : "### Output",
    answer
  ].join("\n\n");
}

export function conversationMarkdown(session: DextHistorySession): string {
  const turns = session.turns.map(historyTurnMarkdown);
  return [`# Dext conversation — ${dateLabel(session.createdAt)}`, ...turns].join("\n\n");
}

export function historyTokenStyles(theme?: EditorTokenTheme): string {
  return dextTokenStyles(theme);
}
