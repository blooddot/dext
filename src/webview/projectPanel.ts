import type { KnowledgeSuggestion } from "../core/projectKnowledgeReview.js";
import type { ProjectObject } from "../core/projectKnowledge.js";
import type { ProjectInitializationStatus } from "../projectService.js";
import { renderArchitectureView, type ArchitectureViewInput } from "./projectArchitectureView.js";

export type ProjectPanelPage = "overview" | "knowledge" | "architecture";

export const PROJECT_PANEL_PAGES: readonly ProjectPanelPage[] = ["overview", "knowledge", "architecture"];

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export interface ProjectOverviewData {
  name: string;
  root: string;
  languages: readonly string[];
  objects: number;
  accepted: number;
  drafts: number;
  needsVerification: number;
  initialization: { status: ProjectInitializationStatus; aiAvailable: boolean; scannedFiles: number };
  scanRoots?: readonly string[];
}

export interface ProjectPanelData {
  overview: ProjectOverviewData;
  /** Long-term objects only. Conversation runs never reach this view. */
  objects: readonly ProjectObject[];
  drafts?: readonly KnowledgeSuggestion[];
  architecture: ArchitectureViewInput;
}

const PAGE_LABELS: Record<ProjectPanelPage, string> = { overview: "Overview", knowledge: "Knowledge", architecture: "Architecture" };

export function renderProjectNav(page: ProjectPanelPage): string {
  const items = PROJECT_PANEL_PAGES.map((item) =>
    `<button type="button" role="tab" data-project-page="${item}" aria-selected="${item === page}">${PAGE_LABELS[item]}</button>`).join("");
  return `<nav class="project-nav" role="tablist" aria-label="Project views">${items}</nav>`;
}

function renderOverview(overview: ProjectOverviewData): string {
  const initialization = overview.initialization;
  return `<section class="project-overview" data-project-section="overview">`
    + `<h2>${escapeHtml(overview.name)}</h2>`
    + `<p class="project-help">Project uses the opened workspace folder as its root. It scans production source files and skips dependencies, build output, tests, fixtures, coverage, and temporary folders by default. Use <strong>Knowledge</strong> for accepted project facts and <strong>Architecture</strong> for detected module dependencies. Add or change source files, then reopen Project to refresh the scan.</p>`
    + (initialization.status === "idle" ? `<button type="button" class="project-initialize" data-project-initialize>Initialize project knowledge</button><div class="project-scan-progress" data-project-scan-progress hidden role="status"><span></span>Scanning project files…</div>` : "")
    + `<dl class="project-facts">`
    + `<dt>Workspace</dt><dd>${escapeHtml(overview.root)}</dd>`
    + `<dt>Scan folders</dt><dd>${overview.scanRoots?.length ? escapeHtml(overview.scanRoots.join(", ")) : ". (workspace root)"}</dd>`
    + `<dt>Languages</dt><dd>${overview.languages.length ? escapeHtml(overview.languages.join(", ")) : "Not detected yet"}</dd>`
    + `<dt>Objects</dt><dd>${overview.objects} (${overview.accepted} accepted, ${overview.drafts} drafts, ${overview.needsVerification} need verification)</dd>`
    + `<dt>Initialization</dt><dd>${escapeHtml(initialization.status)}; ${initialization.aiAvailable ? "AI drafts available" : "facts only"}; ${initialization.scannedFiles} files scanned</dd>`
    + `<button type="button" class="project-scan-folders" data-project-choose-roots>Choose scan folders</button>`
    + `</dl></section>`;
}

function renderKnowledge(objects: readonly ProjectObject[], drafts: readonly KnowledgeSuggestion[]): string {
  const rows = objects.map((object) => {
    const names = [object.canonicalName, object.displayName, ...object.aliases].filter(Boolean).join(" / ");
    return `<li class="project-object" data-object-id="${escapeHtml(object.id)}" data-confirmation="${object.confirmation}" data-validity="${object.validity}">`
      + `<strong>${escapeHtml(names)}</strong>`
      + `<span class="object-kind">${escapeHtml(object.kind)}</span>`
      + `<span class="object-state">${escapeHtml(object.confirmation)} &middot; ${escapeHtml(object.validity)} &middot; ${escapeHtml(object.source)}</span>`
      + (object.description ? `<p>${escapeHtml(object.description)}</p>` : "")
      + (object.behavior.length ? `<ul class="object-behavior">${object.behavior.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "")
      + `</li>`;
  }).join("");
  const draftRows = (drafts ?? []).map((draft) => `<li class="project-draft" data-draft-id="${escapeHtml(draft.id)}">`
    + `<strong>${escapeHtml(draft.proposed.canonicalName ?? draft.objectId ?? draft.id)}</strong>`
    + `<span class="draft-kind">${escapeHtml(draft.kind)}</span>`
    + `<p>${escapeHtml(draft.reason)}</p>`
    + `<div class="draft-actions"><button type="button" data-draft-action="accept" data-draft-id="${escapeHtml(draft.id)}">Accept</button>`
    + `<button type="button" data-draft-action="edit" data-draft-id="${escapeHtml(draft.id)}">Edit</button>`
    + `<button type="button" data-draft-action="reject" data-draft-id="${escapeHtml(draft.id)}">Reject</button></div></li>`).join("");
  return `<section class="project-knowledge" data-project-section="knowledge">`
    + `<h2>Knowledge</h2>`
    + `<h3>Objects</h3>${rows ? `<ul class="project-objects">${rows}</ul>` : `<p class="project-empty">No accepted knowledge yet. Development from Input does not require it.</p>`}`
    + `<h3>AI drafts</h3>${draftRows ? `<ul class="project-drafts">${draftRows}</ul>` : `<p class="project-empty">No pending AI drafts.</p>`}`
    + `</section>`;
}

/**
 * Client script for the Project panel. It only forwards page navigation and draft decisions to the
 * host; all project data is rendered by the host and no conversation run state is requested.
 */
export function projectPanelScript(): string {
  return "<script>(function(){var api=acquireVsCodeApi();"
    + "document.addEventListener(\"click\",function(event){var target=event.target;"
    + "var element=target&&target.closest?target.closest(\"[data-project-page],[data-draft-action],[data-project-initialize],[data-project-choose-roots]\"):null;"
    + "if(!element)return;var page=element.getAttribute(\"data-project-page\");"
    + "if(page){api.postMessage({type:\"projectPage\",page:page});return;}"
    + "if(element.hasAttribute('data-project-initialize')){var b=element;b.disabled=true;b.textContent='Scanning…';var p=document.querySelector('[data-project-scan-progress]');if(p)p.hidden=false;api.postMessage({type:'projectInitialize'});return;}"
    + "if(element.hasAttribute('data-project-choose-roots')){api.postMessage({type:'projectChooseRoots'});return;}"
    + "var action=element.getAttribute(\"data-draft-action\");"
    + "if(action){api.postMessage({type:\"projectDraft\",action:action,id:element.getAttribute(\"data-draft-id\")});}});"
    // Navigating from an adopted suggestion marks the object it wrote.
    + "var focus=document.querySelector('[data-project-focus]');"
    + "if(focus){var id=focus.getAttribute('data-project-focus');"
    + "var row=id?document.querySelector('[data-object-id=\"'+id+'\"]'):null;"
    + "if(row){row.classList.add('project-object-focus');row.scrollIntoView({block:'center'});}}})();</script>";
}

/**
 * Renders one Project page. Only long-term objects, architecture rules, and design decisions are
 * emitted; conversation execution logs, Hook output, and single-run Review never appear here.
 */
export function renderProjectPanel(page: ProjectPanelPage, data: ProjectPanelData, options: { focusObjectId?: string } = {}): string {
  const body = page === "overview" ? renderOverview(data.overview)
    : page === "knowledge" ? renderKnowledge(data.objects, data.drafts ?? [])
      : renderArchitectureView(data.architecture);
  const focus = options.focusObjectId
    ? `<span class="project-focus" data-project-focus="${escapeHtml(options.focusObjectId)}"></span>`
    : "";
  return `<div class="project-panel" data-project-page="${page}">${renderProjectNav(page)}<main class="project-body">${focus}${body}</main></div>${projectPanelScript()}`;
}
