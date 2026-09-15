import type { ArchitectureModule, ArchitectureRelation, ArchitectureRelationSource, ArchitectureRule, ArchitectureViolation } from "../core/projectArchitecture.js";

export interface ArchitectureDecision {
  id: string;
  title: string;
  detail: string;
}

export interface ArchitectureViewInput {
  modules: readonly ArchitectureModule[];
  relations: readonly ArchitectureRelation[];
  rules?: readonly ArchitectureRule[];
  decisions?: readonly ArchitectureDecision[];
  violations?: readonly ArchitectureViolation[];
  /** Violations that already existed before the current change, kept separate from new ones. */
  baselineViolations?: readonly ArchitectureViolation[];
  /** Scan limitations, listed as separate rows so an unresolved file is never hidden in prose. */
  coverage?: readonly string[];
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
  const positions = new Map<string, { x: number; y: number }>();
  modules.forEach((module, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.set(module.id, {
      x: columns === 1 ? width / 2 : 20 + (column * (width - 40)) / (columns - 1),
      y: rows === 1 ? height / 2 : 24 + (row * (height - 48)) / (rows - 1)
    });
  });
  return positions;
}

function renderSvg(input: ArchitectureViewInput): string {
  const allModules = [...input.modules].sort((left, right) => left.id.localeCompare(right.id));
  // Keep the relation table complete, but bound the overview graph so a large project remains
  // readable. The graph is a map; the table below is the authoritative full result.
  const modules = allModules.slice(0, 48);
  if (!modules.length) {
    return `<div class="architecture-graph-empty" role="status">No source modules were detected yet. Open a workspace containing TypeScript, Python, or Rust files, then reopen Project to scan it.</div>`;
  }
  const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(modules.length))));
  const width = Math.max(720, columns * 180);
  const height = Math.max(180, 90 + Math.ceil(modules.length / columns) * 90);
  const positions = layout(modules, width, height - 40);
  const nodes = modules.map((module) => {
    const point = positions.get(module.id)!;
    return `<g class="architecture-node" data-module-id="${escapeHtml(module.id)}">`
      + `<rect x="${(point.x - 60).toFixed(1)}" y="${(point.y - 16).toFixed(1)}" width="120" height="32" rx="6"></rect>`
      + `<text x="${point.x.toFixed(1)}" y="${(point.y + 5).toFixed(1)}" text-anchor="middle">${escapeHtml(module.name)}</text></g>`;
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

/** Renders the Architecture page: local SVG, relation list, rules, and design decisions. */
export function renderArchitectureView(input: ArchitectureViewInput): string {
  const coverage = (input.coverage ?? []).filter(Boolean);
  return `<div class="architecture-view" data-architecture-view="1">`
    + `<section class="architecture-graph-section">${renderSvg(input)}${input.modules.length > 48 ? `<p class="architecture-graph-note">Showing 48 of ${input.modules.length} modules in the overview. The complete relation list is shown below.</p>` : ""}</section>`
    + `<section class="architecture-relation-section"><h3>Relations</h3>${renderRelations(input.relations)}</section>`
    + renderRules(input.rules ?? [], input.violations ?? [], input.baselineViolations ?? [])
    + renderDecisions(input.decisions ?? [])
    + (coverage.length
      ? `<section class="architecture-coverage"><h3>Scan coverage</h3><ul>${coverage.map((note) => `<li data-coverage-note="1">${escapeHtml(note)}</li>`).join("")}</ul></section>`
      : "")
    + `</div>`;
}
