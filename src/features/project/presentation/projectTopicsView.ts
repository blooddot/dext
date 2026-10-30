import type { ProjectQualityIssue } from "../contracts/projectIntent.js";
import { renderProjectMarkdown } from "./projectMarkdown.js";
import type { ArchitectureViewInput } from "../contracts/projectArchitectureTypes.js";
import type { ProjectDiagram } from "../contracts/projectDiagram.js";
import { readingOrder, topicFingerprint, type ProjectTopic, type ProjectTopicCheck } from "../knowledge/projectTopics.js";
import { renderDecisions, renderRules } from "./projectArchitectureNotes.js";

export const escapeProjectHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
const esc = escapeProjectHtml;
export interface ProjectReaderData {
  topics: readonly ProjectTopic[];
  checks: readonly ProjectTopicCheck[];
  diagrams: readonly ProjectDiagram[];
  brief: string;
  gallery: boolean;
  selectedDiagramId?: string;
  terms?: readonly { canonical: string; definition?: string }[];
  architecture?: ArchitectureViewInput;
}

export function topicDiagrams(topic: ProjectTopic, diagrams: readonly ProjectDiagram[]): ProjectDiagram[] {
  if (topic.analysisState === "outline") return [];
  const sectionIds = new Set(topic.sections?.map((section) => section.id) ?? []);
  return [
    ...(topic.diagram?.nodes.length ? [topic.diagram] : []),
    ...diagrams.filter((diagram) => diagram.id !== topic.diagram?.id && (diagram.metadata?.topicId === topic.id || topic.diagrams.some((item) => item.id === diagram.id)
      || diagram.nodes.some((node) => node.semanticIds.includes(topic.id) || node.semanticIds.some((id) => sectionIds.has(id)))))
  ];
}

export function readerDiagramFrame(diagrams: readonly ProjectDiagram[], selected?: string): string {
  if (!diagrams.length) return '<p class="project-help">No diagram is recorded for this topic yet.</p>';
  const viewLabel = (diagram: ProjectDiagram): string => diagram.metadata?.structureMap ? "Structure map"
    : diagram.metadata?.classMap ? "Type map"
      : diagram.metadata?.derived ? "From this explanation" : diagram.title;
  return `<figure class="project-reader-figure"><div class="project-reader-diagram-tools"><label>View <select data-reader-view>${diagrams.map((diagram, index) => `<option value="${esc(diagram.id)}"${diagram.id === selected || (!selected && index === 0) ? " selected" : ""}>${esc(viewLabel(diagram))}</option>`).join("")}</select></label><button type="button" data-reader-zoom="out" aria-label="Zoom out" disabled>−</button><button type="button" data-reader-zoom="in" aria-label="Zoom in" disabled>+</button><button type="button" data-reader-zoom="fit" disabled>Fit</button><button type="button" data-reader-fullscreen>Expand</button><button type="button" data-reader-screen aria-pressed="false" title="Show diagram fullscreen (Esc to exit)">Fullscreen</button><button type="button" data-reader-export disabled>Export SVG</button></div>`
    + '<div class="project-reader-playback" data-reader-playback hidden><button type="button" data-reader-play>Play steps</button><button type="button" data-reader-next>Next step</button><span data-reader-play-status role="status"></span></div><p class="project-help" data-reader-render-status role="status">Rendering diagram…</p><div class="project-reader-canvas" data-reader-canvas></div><figcaption>Select a step or a connection to read its explanation and source.</figcaption>'
    + '<section class="project-reader-inspector" data-reader-inspector hidden aria-live="polite"></section><details class="project-reader-source"><summary>Diagram model</summary><pre data-reader-diagram-source></pre></details></figure>';
}

export function readerTopicArticle(topic: ProjectTopic, data: ProjectReaderData): string {
  const check = data.checks.find((item) => item.id === topic.id && item.fingerprint === topicFingerprint(topic));
  const warning = check?.state === "changed" || check?.state === "missing" || topic.analysisState === "stale";
  const sections = topic.sections?.length ? topic.sections : topic.steps.map((title, index) => ({ id: `${topic.id}/step/${index}`, title, description: "", evidence: [], relatedTopicIds: [] }));
  const list = (items: readonly string[]) => `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;
  const landscape = data.topics.find((item) => item.kind === "system_context"), units = data.topics.find((item) => item.kind === "containers");
  const crumbs = landscape && units ? `<nav class="project-reader-breadcrumb" aria-label="Architecture levels"><button data-reader-topic="${esc(landscape.id)}">Project landscape</button> / <button data-reader-topic="${esc(units.id)}">Runtime units</button>${topic.kind === "context" || topic.kind === "flow" ? ` / ${esc(topic.title)}` : ""}</nav>` : "";
  // Prose, diagram and tail are siblings: a wide editor docks the diagram beside the explanation
  // and narrow editors keep this reading order.
  const steps = topic.analysisState !== "outline" && (topic.kind === "flow" || topic.diagram?.metadata?.topicAnalysis === 1) && sections.length
    ? `<div class="project-reader-steps"><h3>${topic.kind === "flow" ? "Follow the flow" : "Inside this module"}</h3>${sections.map((section, index) => `<section class="project-reader-step" data-reader-section="${esc(section.id)}"><button type="button" data-reader-step="${esc(section.id)}"><span>${index + 1}</span>${esc(section.title)}</button>${section.description ? `<div class="project-markdown">${renderProjectMarkdown(section.description)}</div>` : ""}</section>`).join("")}</div>` : "";
  return `<div class="project-reader-prose">${crumbs}<header class="project-reader-heading">${topic.area ? `<p class="project-reader-kind">${esc(topic.area.title)}</p>${topic.area.description ? `<div class="project-help project-reader-area-note">${renderProjectMarkdown(topic.area.description)}</div>` : ""}` : ""}<p class="project-reader-kind">${topic.kind === "flow" ? "How it works" : topic.kind === "structure" ? "Structure map" : topic.kind === "types" ? "Type map" : topic.kind === "system_context" ? "System context · C4 level 1" : topic.kind === "containers" ? "Runtime boundaries · C4 level 2" : "Responsibility boundary"}</p><h2>${esc(topic.title)}</h2><div class="project-markdown" data-reader-section="${esc(topic.id)}">${renderProjectMarkdown(topic.description)}</div>`
    + `<button type="button" data-project-norm="${esc(topic.id)}">Edit this norm</button>`
    + (topic.kind === "context" ? ` <button type="button" data-project-plan="${esc(topic.id)}">Plan a change</button>` : "")
    + `<p data-topic-check="${esc(topic.id)}" class="project-reader-warning"${warning ? "" : " hidden"}>${warning ? "Sources changed or disappeared. This explanation and its diagrams need review." : ""}</p></header>`
    + (topic.kind === "context" || topic.kind === "flow" ? `<section class="project-reader-analysis"><p data-reader-analysis-state>${topic.analysisState === "outline" ? "Not analyzed · module outline only" : warning ? "Needs update · saved analysis remains available" : "Generated · saved explanation"}</p><button type="button" data-topic-diagram="${esc(topic.id)}">${topic.analysisState === "outline" ? "Analyze this module" : "Update module analysis"}</button><p class="project-help">Read this module's sources to generate its explanation and diagram together. Selecting a module does not start AI.</p></section>` : "")
    // Review signals belong to the module they question, above its diagram rather than below it.
    + (topic.qualityIssues?.length ? renderProjectQuality(topic.qualityIssues, topic) : (topic.qualityWarnings?.length ? '<details class="project-reader-warning" open><summary>Ownership needs review' + qualityCopyButton('Copy', topic.qualityWarnings.join('\n\n'), 'Ownership needs review', topic.title) + '</summary>' + list(topic.qualityWarnings) + '</details>' : ''))
    + `</div>`
    + readerDiagramFrame(topicDiagrams(topic, data.diagrams))
    + `<div class="project-reader-tail">${steps}`
    + (topic.entryPoints.length ? `<section><h3>${topic.kind === "flow" ? "When it starts" : topic.kind === "structure" ? "Most connected files" : topic.kind === "types" ? "Type declaration files" : "Where to start in the code"}</h3>${list(topic.entryPoints)}</section>` : "")
    + (topic.sourceFiles?.length ? `<details class="project-reader-support"><summary>Files in this module · ${topic.sourceFiles.length}</summary>${list(topic.sourceFiles)}</details>` : "")
    + (topic.uncertainties?.length ? `<details class="project-reader-support"><summary>Questions to verify</summary>${list(topic.uncertainties)}</details>` : "")
    + (topic.previousAnalyses?.length ? `<section class="project-reader-related"><h3>Earlier module analyses</h3><p class="project-help">Module boundaries changed. These saved analyses overlap this module and need review; they do not describe the new boundary yet.</p>${topic.previousAnalyses.map(item => `<button type="button" data-reader-diagram="${esc(item.id)}">${esc(item.title)}</button>`).join("")}</section>` : "")
    + (topic.responsibilities.length || topic.constraints.length ? `<details class="project-reader-support"><summary>${topic.kind === "flow" ? "Outcomes and constraints" : "Responsibilities and constraints"}</summary>${list(topic.responsibilities)}${topic.constraints.length ? `<h4>Constraints</h4>${list(topic.constraints)}` : ""}</details>` : "")
    + `<details class="project-reader-support"><summary>Sources and freshness · ${topic.evidence.length} references</summary><p class="project-help">${check ? `Last checked ${esc(new Date(check.checkedAt).toLocaleString())} · ${esc(check.state)}. Unchanged files do not establish semantic correctness.` : "These are saved source references. Check them against the current files before relying on the explanation."}</p><button type="button" data-project-check-knowledge>Check sources</button><p data-project-check-status role="status"></p><ul class="project-topic-evidence">${topic.evidence.map((entry, index) => `<li><button type="button" data-topic-evidence="${esc(topic.id)}" data-evidence-index="${index}">${esc(entry.path)}${entry.line ? `:${entry.line}` : ""}${entry.symbol ? ` · ${esc(entry.symbol)}` : ""}</button>${entry.note ? `<small>${esc(entry.note)}</small>` : ""}<small data-topic-file="${esc(topic.id)}" data-file-index="${index}">${esc(check?.files[index]?.state ?? "")}</small></li>`).join("")}</ul></details>`
    + (topic.relatedTopics?.length ? `<section class="project-reader-related"><h3>Continue exploring</h3>${topic.relatedTopics.map((related) => `<button type="button" data-reader-topic="${esc(related.id)}">${esc(related.title)} →</button>`).join("")}</section>` : "")
    + `</div>`;
}

export function readerGalleryArticle(diagram: ProjectDiagram, data: ProjectReaderData): string {
  const related = data.topics.filter((topic) => topicDiagrams(topic, [diagram]).some((item) => item.id === diagram.id) || topic.previousAnalyses?.some(item => item.id === diagram.id));
  return `<header class="project-reader-heading"><p class="project-reader-kind">Saved diagram</p><h2>${esc(diagram.title)}</h2>${related.length ? `<p>Read with ${related.map((topic) => `<button type="button" data-reader-topic="${esc(topic.id)}">${esc(topic.title)}</button>`).join(" ")}</p>` : '<p class="project-help">This saved diagram has no explicit topic link. Its nodes and source references remain available below.</p>'}</header>`
    + (related.some(topic => topic.previousAnalyses?.some(item => item.id === diagram.id)) || (diagram.metadata?.topicAnalysis === 1 && !data.topics.some(topic => topic.id === diagram.metadata?.topicId)) ? '<p class="project-reader-warning">Module boundaries changed. Review this historical analysis against current sources before relying on it.</p>' : "")
    + readerDiagramFrame([diagram], diagram.id);
}

export function readerIntroduction(data: ProjectReaderData): string {
  const notes = data.architecture ? renderRules(data.architecture) + renderDecisions(data.architecture.decisions ?? []) : "";
  const checked = data.checks.filter((check) => data.topics.some((topic) => topic.id === check.id));
  const changed = checked.filter((check) => check.state !== "unchanged").length;
  const freshness = checked.length
    ? `Sources last checked ${new Date(Math.max(...checked.map((check) => check.checkedAt))).toLocaleString()} · ${changed} of ${checked.length} modules changed.`
    : "These summaries are saved drafts. Open a module and select Check sources to compare them with the current files.";
  // Dependencies first: a module that others reuse is read before the modules that build on it.
  const start = readingOrder(data.topics).map((topic, index) => `<button type="button" data-reader-topic="${esc(topic.id)}" data-reading-step="${index + 1}">${index + 1}. ${esc(topic.title)} →</button>`).join("");
  return `<h2>Project introduction</h2><div class="project-reader-intro project-markdown">${renderProjectMarkdown(data.brief || "Choose a topic to explore the project.")}</div><h3>Start here</h3><div class="project-reader-related">${start}</div><p class="project-help" data-project-freshness>${esc(freshness)}</p>`
    + (!data.topics.some((topic) => topic.kind === "system_context") ? '<p class="project-help">System boundaries and runtime units have not been recorded. The project model contains module outlines. Analyze a module to add its detailed explanation and diagram.</p>' : "")
    + (data.terms?.length ? `<details class="project-reader-support"><summary>Glossary · ${data.terms.length}</summary><dl>${data.terms.map((term) => `<dt>${esc(term.canonical)}</dt><dd>${esc(term.definition ?? "")}</dd>`).join("")}</dl></details>` : "")
    + (notes ? `<details class="project-reader-support"><summary>Architecture rules and decisions</summary>${notes}</details>` : "");
}

export function renderProjectTopics(topics: readonly ProjectTopic[], checks: readonly ProjectTopicCheck[] = [], options: Partial<Omit<ProjectReaderData, "topics" | "checks">> = {}): string {
  const data: ProjectReaderData = { ...options, topics, checks, diagrams: options.diagrams ?? [], brief: options.brief ?? "", gallery: options.gallery ?? false };
  const selected = data.diagrams.find((diagram) => diagram.id === data.selectedDiagramId) ?? data.diagrams[0];
  const first = topics[0];
  const article = data.gallery && selected ? readerGalleryArticle(selected, data) : first ? readerTopicArticle(first, data)
    : selected ? readerGalleryArticle(selected, data) : '<h2>Project knowledge</h2><p class="project-help">Initialize the project from Overview to create its first explanation.</p>';
  /** Authored functional areas; the index already assigned each module, so no path fallback. */
  const directory = (kind: ProjectTopic["kind"], title: string) => {
    const entries = topics.filter((topic) => topic.kind === kind);
    const buttons = (items: readonly ProjectTopic[]) => items.map(topic => `<button type="button" data-reader-topic="${esc(topic.id)}" data-topic-search="${esc([topic.area?.title ?? "", topic.title, topic.description, ...topic.entryPoints].join(" ").toLowerCase())}">${esc(topic.title)}</button>`).join("");
    const groups = new Map(entries.flatMap(topic => topic.area ? [[topic.area.id, topic.area] as const] : []));
    const content = groups.size ? [...groups.values()].map(area => `<details data-reader-area="${esc(area.id)}"${entries.some(topic => topic.area?.id === area.id && topic.id === first?.id) ? " open" : ""}><summary>${esc(area.title)} <small>(${entries.filter(topic => topic.area?.id === area.id).length})</small></summary>${buttons(entries.filter(topic => topic.area?.id === area.id))}</details>`).join("") + buttons(entries.filter(topic => !topic.area)) : buttons(entries);
    return entries.length ? `${title ? `<h3>${title}</h3>` : ""}${content}` : "";
  };
  return `<section class="project-reader" data-project-reader><template data-project-reader-data>${esc(JSON.stringify(data))}</template>`
    + `<aside class="project-reader-directory"><details class="project-directory-disclosure" open><summary>Browse knowledge</summary><div><label>Explore project<input type="search" data-project-topic-search placeholder="Find a topic…"></label><button type="button" data-reader-home>Project introduction</button>${directory("system_context", "Architecture")}${directory("containers", "")}${directory("structure", "Structure")}${directory("types", "Types")}${directory("context", "Responsibilities")}${directory("flow", "Flows")}<p data-project-topic-empty hidden>No matching topics.</p>`
    + (data.diagrams.length ? `<details class="project-reader-gallery"${data.gallery ? " open" : ""}><summary>All saved diagrams · ${data.diagrams.length}</summary>${data.diagrams.map((diagram) => `<button type="button" data-reader-diagram="${esc(diagram.id)}">${esc(diagram.title)}</button>`).join("")}</details>` : "")
    + `</div></details></aside><div class="project-reader-main"><p class="project-reader-progress" data-reader-progress role="status" hidden></p><article data-reader-article>${article}</article><div class="project-reader-diagram-pane" data-reader-diagram-pane></div></div></section>`;
}


function qualityCopyButton(title: string, content: string, topicTitle?: string): string {
  const text = (topicTitle ? '# ' + topicTitle + '\n\n' : '') + '## ' + title + '\n\n' + content;
  return `<button type="button" class="project-quality-copy" data-project-quality-copy="${esc(text)}" aria-label="Copy ${esc(title)}" title="Copy descriptions and source paths for AI analysis">Copy</button>`;
}

/** Shared grouping for Overview and Knowledge; legacy issues remain unresolved. */
export function renderProjectQuality(issues: readonly ProjectQualityIssue[], topic?: ProjectTopic): string {
  const groups = [
    { title: "Architecture issues", items: issues.filter(issue => issue.code !== "ownership-review"), open: true },
    { title: "Ownership needs review", items: issues.filter(issue => issue.code === "ownership-review" && (!issue.status || issue.status === "unresolved")), open: true },
    { title: "Explained ownership decisions", items: issues.filter(issue => issue.code === "ownership-review" && (issue.status === "retained" || issue.status === "reassigned")), open: false }
  ];
  return groups.filter(group => group.items.length).map(group => {
    const text = group.items.map((issue, index) => {
      const sources: Array<{ path: string; line?: number }> = issue.evidence ?? issue.sourcePaths.map(path => ({ path }));
      return `${index + 1}. ${issue.message}\n   Code: ${issue.code}${issue.status ? '\n   Status: ' + issue.status : ''}`
        + (issue.reason ? '\n   Reason: ' + issue.reason : '')
        + sources.map(source => '\n   - ' + source.path + (source.line ? ':' + source.line : '')).join('');
    }).join('\n\n');
    return '<details class="project-reader-warning"' + (group.open ? ' open' : '') + '><summary>' + esc(group.title) + ' · ' + group.items.length + qualityCopyButton(group.title, text, topic?.title) + '</summary><ul>' + group.items.map(issue => {
      const sources: Array<{ path: string; line?: number }> = issue.evidence ?? issue.sourcePaths.map(path => ({ path }));
      return '<li>' + esc(issue.message) + (issue.reason ? '<p>' + esc(issue.reason) + '</p>' : '') + '<ul>' + sources.map(source => {
        const index = topic?.evidence.findIndex(item => item.path === source.path && item.line === source.line) ?? -1;
        const label = esc(source.path + (source.line ? ':' + source.line : ''));
        return '<li>' + (topic && index >= 0 ? '<button type="button" data-topic-evidence="' + esc(topic.id) + '" data-evidence-index="' + index + '">' + label + '</button>' : issue.contextIds[0] ? '<button type="button" data-project-page="knowledge" data-project-topic="' + esc(issue.contextIds[0]) + '">' + label + '</button>' : '<code>' + label + '</code>') + '</li>';
      }).join('') + '</ul></li>';
    }).join('') + '</ul></details>';
  }).join('');
}
