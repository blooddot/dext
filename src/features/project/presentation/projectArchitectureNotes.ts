import type { ArchitectureViewInput, ProjectArchitectureDecision } from "../contracts/projectArchitectureTypes.js";
import type { ArchitectureViolation } from "../knowledge/projectArchitecture.js";

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function renderRules(input: ArchitectureViewInput): string {
  const rules = input.rules ?? [];
  const violations = input.violations ?? [];
  const baseline = input.baselineViolations ?? [];
  const note = input.rulesNote;
  if (!rules.length && !violations.length && !baseline.length && !note) return "";
  const ruleRows = rules.map((rule) => `<li class="architecture-rule"><code>${escapeHtml(rule.id)}</code> `
    + `${escapeHtml(rule.type)} ${escapeHtml(rule.from)}${rule.to ? ` &rarr; ${escapeHtml(rule.to)}` : ""}`
    + `${rule.reason ? ` &mdash; ${escapeHtml(rule.reason)}` : ""}</li>`).join("");
  // Without a baseline there is nothing to compare against, so the current violations are reported
  // as what they are instead of being labelled "new".
  const heading = baseline.length ? `New violations (${violations.length})` : `Violations (${violations.length})`;
  return `<section class="architecture-rules"><h3>Rules</h3>${ruleRows ? `<ul>${ruleRows}</ul>` : ""}`
    + (note ? `<p class="architecture-empty">${escapeHtml(note)}</p>` : "")
    + `<h4>${heading}</h4>${renderViolations(violations)}`
    + (baseline.length ? `<h4>Existing baseline violations (${baseline.length})</h4>${renderViolations(baseline)}` : "")
    + `</section>`;
}

function renderViolations(violations: readonly ArchitectureViolation[]): string {
  if (!violations.length) return `<p class="architecture-empty">None.</p>`;
  return `<ul class="architecture-violations">${violations.map((violation) =>
    `<li><code>${escapeHtml(violation.ruleId)}</code> ${escapeHtml(violation.nodeIds.join(" -> "))}: ${escapeHtml(violation.reason)}</li>`).join("")}</ul>`;
}

export function renderDecisions(decisions: readonly ProjectArchitectureDecision[]): string {
  if (!decisions.length) return "";
  return `<section class="architecture-decisions"><h3>Design decisions</h3>${decisions.map((decision) =>
    `<article class="architecture-decision"><h4>${escapeHtml(decision.title)}</h4><p>${escapeHtml(decision.detail)}</p></article>`).join("")}</section>`;
}

