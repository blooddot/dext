import type { ArchitectureModule, ArchitectureRelation, ArchitectureRelationSource, ArchitectureRule, ArchitectureViolation } from "../core/projectArchitecture.js";
import type { DiagramAdapterChoice } from "../core/projectDiagramRegistry.js";
import type { ProjectDiagramKind } from "../core/projectDiagram.js";

export interface ArchitectureDecision {
  id: string;
  title: string;
  detail: string;
}

export interface ArchitectureViewInput {
  /** Indicates that the graph is a semantic AI model rather than a raw import scan. */
  semanticSource?: "ai" | "code";
  modules: readonly ArchitectureModule[];
  relations: readonly ArchitectureRelation[];
  rules?: readonly ArchitectureRule[];
  decisions?: readonly ArchitectureDecision[];
  violations?: readonly ArchitectureViolation[];
  /** Violations that already existed before the current change, kept separate from new ones. */
  baselineViolations?: readonly ArchitectureViolation[];
  /** Scan limitations, listed as separate rows so an unresolved file is never hidden in prose. */
  coverage?: readonly string[];
  /** Semantic Project diagram metadata. Kept optional for compatibility with scan-only projects. */
  diagramKind?: ProjectDiagramKind;
  adapter?: {
    currentId?: string;
    choices: readonly DiagramAdapterChoice[];
    fallback?: readonly string[];
    recommendation?: string;
  };
  diagramVersions?: readonly { id: string; adapterId: string; version: number; status: string; updatedAt?: number }[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

/**
 * Manual relations come from a user declaration, such as a Tauri IPC contract. Static detection
 * comes from the scanners. They are never merged into one undifferentiated list.
 */
export function relationSourceLabel(source: ArchitectureRelationSource): string {
  switch (source) {
    case "declared": return "Manual (declared)";
    case "detected": return "Static detection";
    case "inferred": return "Inferred";
    default: return "Unknown";
  }
}

export function isManualRelation(relation: ArchitectureRelation): boolean {
  return relation.source === "declared";
}

function layout(modules: readonly ArchitectureModule[], width: number, height: number): Map<string, { x: number; y: number }> {
  const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(modules.length))));
  const rows = Math.max(1, Math.ceil(modules.length / columns));
  // Each node is 176px wide. Keep enough room on both sides for the 88px
  // half-width (plus a small visual gutter), otherwise the first and last
  // nodes are clipped by the SVG viewport.
  const horizontalInset = Math.min(104, Math.max(20, width / 2 - 1));
  const verticalInset = 24;
  const positions = new Map<string, { x: number; y: number }>();
  modules.forEach((module, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.set(module.id, {
      x: columns === 1 ? width / 2 : horizontalInset + (column * (width - (horizontalInset * 2))) / (columns - 1),
      y: rows === 1 ? height / 2 : verticalInset + (row * (height - (verticalInset * 2))) / (rows - 1)
    });
  });
  return positions;
}

function renderSvg(input: ArchitectureViewInput): string {
  const allModules = [...input.modules].sort((left, right) => left.id.localeCompare(right.id));
  // Keep the relation table complete, but bound the overview graph so a large project remains
  // readable. The graph is a map; the table below is the authoritative full result.
  const degree = new Map<string, number>();
  for (const relation of input.relations) {
    degree.set(relation.from, (degree.get(relation.from) ?? 0) + 1);
    degree.set(relation.to, (degree.get(relation.to) ?? 0) + 1);
  }
  const modules = allModules
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 24);
  if (!modules.length) {
    return `<div class="architecture-graph-empty" role="status">No source modules were detected yet. Open a workspace containing TypeScript, Python, or Rust files, then reopen Project to scan it.</div>`;
  }
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(modules.length))));
  const width = Math.max(760, columns * 220);
  const height = Math.max(180, 90 + Math.ceil(modules.length / columns) * 90);
  const positions = layout(modules, width, height - 40);
  const nodes = modules.map((module) => {
    const point = positions.get(module.id)!;
    return `<g class="architecture-node" data-module-id="${escapeHtml(module.id)}">`
      + `<rect x="${(point.x - 88).toFixed(1)}" y="${(point.y - 18).toFixed(1)}" width="176" height="36" rx="6"></rect>`
      + `<text x="${point.x.toFixed(1)}" y="${(point.y + 4).toFixed(1)}" text-anchor="middle">${escapeHtml(module.name.length > 24 ? `${module.name.slice(0, 22)}…` : module.name)}</text></g>`;
  }).join("");
  const edges = input.relations.map((relation) => {
    const from = positions.get(relation.from);
    const to = positions.get(relation.to);
    if (!from || !to) return "";
    const manual = isManualRelation(relation);
    return `<line class="architecture-edge ${manual ? "manual" : "detected"}" data-source="${relation.source}" `
      + `x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}"></line>`;
  }).join("");
  return `<svg class="architecture-graph" role="img" aria-label="Module dependency graph overview" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`
    + `<g class="architecture-edges">${edges}</g><g class="architecture-nodes">${nodes}</g></svg>`;
}

function renderRelations(relations: readonly ArchitectureRelation[]): string {
  if (!relations.length) return `<p class="architecture-empty">No module relations were detected or declared.</p>`;
  const rows = relations.map((relation) => `<li class="architecture-relation" data-source="${relation.source}">`
    + `<span class="relation-source">${escapeHtml(relationSourceLabel(relation.source))}</span>`
    + `<span class="relation-path">${escapeHtml(relation.from)} &rarr; ${escapeHtml(relation.to)}</span>`
    + (relation.file ? `<span class="relation-evidence">${escapeHtml(relation.file)}${relation.line ? `:${relation.line}` : ""}</span>` : "")
    + (relation.reason ? `<span class="relation-reason">${escapeHtml(relation.reason)}</span>` : "")
    + `</li>`).join("");
  return `<ul class="architecture-relations">${rows}</ul>`;
}

function renderRules(rules: readonly ArchitectureRule[], violations: readonly ArchitectureViolation[], baseline: readonly ArchitectureViolation[]): string {
  if (!rules.length && !violations.length && !baseline.length) return "";
  const ruleRows = rules.map((rule) => `<li class="architecture-rule"><code>${escapeHtml(rule.id)}</code> `
    + `${escapeHtml(rule.type)} ${escapeHtml(rule.from)}${rule.to ? ` &rarr; ${escapeHtml(rule.to)}` : ""}`
    + `${rule.reason ? ` &mdash; ${escapeHtml(rule.reason)}` : ""}</li>`).join("");
  return `<section class="architecture-rules"><h3>Rules</h3>${ruleRows ? `<ul>${ruleRows}</ul>` : ""}`
    + `<h4>New violations (${violations.length})</h4>${renderViolations(violations)}`
    + `<h4>Existing baseline violations (${baseline.length})</h4>${renderViolations(baseline)}</section>`;
}

function renderViolations(violations: readonly ArchitectureViolation[]): string {
  if (!violations.length) return `<p class="architecture-empty">None.</p>`;
  return `<ul class="architecture-violations">${violations.map((violation) =>
    `<li><code>${escapeHtml(violation.ruleId)}</code> ${escapeHtml(violation.moduleIds.join(" -> "))}: ${escapeHtml(violation.reason)}</li>`).join("")}</ul>`;
}

function renderDecisions(decisions: readonly ArchitectureDecision[]): string {
  if (!decisions.length) return "";
  return `<section class="architecture-decisions"><h3>Design decisions</h3>${decisions.map((decision) =>
    `<article class="architecture-decision"><h4>${escapeHtml(decision.title)}</h4><p>${escapeHtml(decision.detail)}</p></article>`).join("")}</section>`;
}

function renderAdapterControls(input: ArchitectureViewInput): string {
  if (!input.adapter) return "";
  const kind = input.diagramKind ?? "architecture";
  const choices = input.adapter.choices;
  const options = choices.map((choice) => `<option value="${escapeHtml(choice.id)}"${choice.id === input.adapter?.currentId ? " selected" : ""}${!choice.available || !choice.supported ? " disabled" : ""}>`
    + `${escapeHtml(choice.id)}${choice.version ? ` (${escapeHtml(choice.version)})` : ""}${!choice.available || !choice.supported ? ` — ${escapeHtml(choice.reason ?? "unavailable")}` : ""}</option>`).join("");
  const fallback = input.adapter.fallback?.length ? `<p class="diagram-adapter-fallback">Fallback: ${input.adapter.fallback.map(escapeHtml).join(" → ")}</p>` : "";
  return `<section class="diagram-adapter-controls" data-diagram-kind="${escapeHtml(kind)}">`
    + `<label>Renderer <select data-project-adapter-select aria-label="Diagram adapter">${options}</select></label>`
    + `<button type="button" data-project-diagram-action="auto">Use recommended</button>`
    + `<button type="button" data-project-diagram-action="regenerate">Regenerate</button>`
    + `<button type="button" data-project-diagram-action="receipt">Validation receipt</button>`
    + `<span class="diagram-adapter-recommendation">${escapeHtml(input.adapter.recommendation ?? "Choose a renderer suited to this diagram.")}</span>`
    + fallback + `</section>`;
}

function renderDiagramVersions(versions: NonNullable<ArchitectureViewInput["diagramVersions"]>): string {
  if (!versions.length) return "";
  return `<section class="diagram-versions"><h3>Diagram versions</h3><ul>${versions.map((version) =>
    `<li data-diagram-version-id="${escapeHtml(version.id)}"><strong>${escapeHtml(version.adapterId)} v${version.version}</strong> · ${escapeHtml(version.status)}${version.updatedAt ? ` · ${new Date(version.updatedAt).toLocaleString()}` : ""}</li>`).join("")}</ul></section>`;
}

/** Renders the Architecture page: local SVG, relation list, rules, and design decisions. */
export function renderArchitectureView(input: ArchitectureViewInput): string {
  const coverage = (input.coverage ?? []).filter(Boolean);
  return `<div class="architecture-view" data-architecture-view="1" data-diagram-kind="${escapeHtml(input.diagramKind ?? "architecture")}">`
    + renderAdapterControls(input)
    + `<div class="architecture-tools"><label>Find node <input type="search" data-project-diagram-search placeholder="Search by stable Project ID or name"></label><button type="button" data-project-diagram-action="focus-selected">Focus selected</button>${input.adapter ? `<label>Export as <select data-project-export-format>${[...new Set(input.adapter.choices.flatMap((choice) => choice.formats))].map((format) => `<option value="${escapeHtml(format)}">${escapeHtml(format)}</option>`).join("")}</select></label>` : ""}<button type="button" data-project-diagram-action="export">Export</button></div>`
    + `<section class="architecture-graph-section"><div class="architecture-graph-heading"><div><h2>Architecture map</h2><p class="architecture-summary">${input.modules.length} modules · ${input.relations.length} relations${input.semanticSource === "ai" ? " · AI semantic model" : " · static code scan"}</p></div><button type="button" class="architecture-fullscreen-button" data-project-diagram-action="fullscreen" aria-label="View architecture map fullscreen" title="View architecture map fullscreen"><i class="codicon codicon-screen-full" aria-hidden="true"></i><span>Fullscreen</span></button></div><div class="architecture-graph-scroll">${renderSvg(input)}</div>${input.modules.length > 24 ? `<p class="architecture-graph-note">Showing the 24 most connected modules. Use the relation list below for the complete dependency inventory.</p>` : ""}</section>`
    + `<section class="architecture-relation-section"><h3>Relations (${input.relations.length})</h3>${renderRelations(input.relations)}</section>`
    + renderRules(input.rules ?? [], input.violations ?? [], input.baselineViolations ?? [])
    + renderDecisions(input.decisions ?? [])
    + renderDiagramVersions(input.diagramVersions ?? [])
    + (coverage.length
      ? `<section class="architecture-coverage"><h3>Scan coverage</h3><ul>${coverage.map((note) => `<li data-coverage-note="1">${escapeHtml(note)}</li>`).join("")}</ul></section>`
      : "")
    + `<script>(function(){var root=document.currentScript&&document.currentScript.parentElement;if(!root)return;var input=root.querySelector('[data-project-diagram-search]');if(input)input.addEventListener('input',function(){var q=(input.value||'').toLowerCase();root.querySelectorAll('[data-module-id]').forEach(function(n){var v=(n.getAttribute('data-module-id')||'').toLowerCase();n.classList.toggle('diagram-node-hidden',!!q&&v.indexOf(q)<0);});root.querySelectorAll('.architecture-relation').forEach(function(n){n.hidden=!!q&&(n.textContent||'').toLowerCase().indexOf(q)<0;});});var graphSection=root.querySelector('.architecture-graph-section');var fullButton=root.querySelector('[data-project-diagram-action="fullscreen"]');var setFullscreenUi=function(active){if(!fullButton)return;fullButton.setAttribute('aria-label',active?'Exit fullscreen architecture map':'View architecture map fullscreen');fullButton.setAttribute('title',active?'Exit fullscreen':'View architecture map fullscreen');var icon=fullButton.querySelector('.codicon');if(icon)icon.className='codicon codicon-screen-'+(active?'normal':'full');var label=fullButton.querySelector('span');if(label)label.textContent=active?'Exit fullscreen':'Fullscreen';};if(document.addEventListener)document.addEventListener('fullscreenchange',function(){setFullscreenUi(document.fullscreenElement===graphSection);});root.addEventListener('change',function(e){var t=e.target;if(t&&t.matches('[data-project-adapter-select]')){var section=t.closest('[data-diagram-kind]');acquireVsCodeApi().postMessage({type:'projectAdapterPreference',kind:section&&section.getAttribute('data-diagram-kind'),adapterId:t.value});}});root.addEventListener('click',function(e){var node=e.target&&e.target.closest('[data-module-id]');if(node){acquireVsCodeApi().postMessage({type:'projectDiagramFocus',kind:(root.getAttribute('data-diagram-kind')||'architecture'),objectId:node.getAttribute('data-module-id')});return;}var t=e.target&&e.target.closest('[data-project-diagram-action]');if(!t)return;if(t.getAttribute('data-project-diagram-action')==='fullscreen'){if(!graphSection)return;if(document.fullscreenElement===graphSection){if(document.exitFullscreen)document.exitFullscreen();}else if(graphSection.requestFullscreen){graphSection.requestFullscreen().catch(function(){graphSection.classList.toggle('architecture-graph-is-fullscreen');setFullscreenUi(graphSection.classList.contains('architecture-graph-is-fullscreen'));});}else{graphSection.classList.toggle('architecture-graph-is-fullscreen');setFullscreenUi(graphSection.classList.contains('architecture-graph-is-fullscreen'));}return;}var section=t.closest('[data-diagram-kind]'),kind=section&&section.getAttribute('data-diagram-kind')||'architecture',format=(root.querySelector('[data-project-export-format]')||{}).value;acquireVsCodeApi().postMessage({type:'projectDiagramAction',action:t.getAttribute('data-project-diagram-action'),kind:kind,format:format});});})();</script></div>`;
}
