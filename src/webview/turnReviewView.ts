import { reviewPresetPresentation, type ReviewPreset } from "../core/projectContext.js";
import { reviewRequiresUserAcceptance, type ReviewHookSummary, type TurnReview } from "../core/turnReview.js";
import type { KnowledgeSuggestion } from "../core/projectKnowledgeReview.js";

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export interface TurnReviewViewOptions {
  preset?: ReviewPreset;
  /** Expand the review in the conversation; collapsed by default. */
  expanded?: boolean;
  runId?: string;
  /** Drafts the user may adopt one by one. Adopting writes project knowledge, not the code review. */
  knowledgeSuggestions?: readonly KnowledgeSuggestion[];
}

function hookLabel(hook: ReviewHookSummary): string {
  // Only a provider that explicitly exposed a hook identity is shown as a hook result.
  const name = hook.name ? `${hook.source}: ${hook.name}` : hook.source;
  return `${name} — ${hook.status}`;
}

/**
 * Renders one turn Review as a collapsible region. A pure Ask turn or a turn with no development
 * change produces no acceptance card; facts and hooks attach to a real change review.
 */
export function renderTurnReview(review: TurnReview, options: TurnReviewViewOptions = {}): string {
  if (review.mode === "ask" || !review.changes.length) return "";
  const preset = reviewPresetPresentation(options.preset ?? "engineering");
  const changes = review.changes.map((change) =>
    `<li class="turn-review-change" data-change-kind="${change.kind}" data-change-uri="${escapeHtml(change.uri)}">`
    + `<button type="button" data-review-diff="${escapeHtml(change.uri)}">${escapeHtml(change.kind)} ${escapeHtml(change.uri)}</button>`
    + `${change.moduleId ? `<span class="review-module">${escapeHtml(change.moduleId)}</span>` : ""}</li>`).join("");
  const facts = review.factValidation.map((fact) =>
    `<li class="turn-review-fact" data-fact-kind="${fact.kind}">${escapeHtml(fact.evidence.path)}: ${escapeHtml(fact.kind)}`
    + `${fact.reason ? ` — ${escapeHtml(fact.reason)}` : ""}</li>`).join("");
  const hooks = review.hookSummaries.map((hook) => `<li class="turn-review-hook" data-hook-status="${hook.status}">${escapeHtml(hookLabel(hook))}</li>`).join("");
  const suggestions = review.semanticSuggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const drafts = (options.knowledgeSuggestions ?? []).map((suggestion) =>
    `<li class="turn-review-draft" data-suggestion-id="${escapeHtml(suggestion.id)}" data-suggestion-kind="${suggestion.kind}">`
    + `<button type="button" data-adopt-suggestion="${escapeHtml(suggestion.id)}">Adopt</button>`
    + `<span class="review-draft-reason">${escapeHtml(suggestion.reason || suggestion.kind)}</span></li>`).join("");
  const requiresAcceptance = reviewRequiresUserAcceptance(review);
  const controls = requiresAcceptance
    ? `<div class="turn-review-actions">`
      + `<button type="button" data-review-accept="${escapeHtml(review.runId)}">Accept review</button>`
      + `<button type="button" data-review-reject="${escapeHtml(review.runId)}">Request changes</button>`
      + `</div>`
    : "";
  return `<details class="turn-review" data-turn-review="1" data-review-run="${escapeHtml(review.runId)}" data-preset="${preset.id}"${options.expanded ? " open" : ""}>`
    + `<summary>${escapeHtml(preset.title)} &middot; ${review.changes.length} change${review.changes.length === 1 ? "" : "s"}`
    + `${review.acceptance === "pending" ? " &middot; awaiting your decision" : review.acceptance === "not_required" ? "" : ` &middot; ${escapeHtml(review.acceptance)}`}</summary>`
    + `<p class="turn-review-emphasis">${escapeHtml(preset.summary)}</p>`
    + `<ul class="turn-review-highlights">${preset.highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    + `<section class="turn-review-changes"><h4>Changes</h4>${changes ? `<ul>${changes}</ul>` : `<p class="turn-review-empty">No development changes were recorded.</p>`}</section>`
    + `<section class="turn-review-evidence"><h4>Script checks and coverage</h4>${facts ? `<ul>${facts}</ul>` : `<p class="turn-review-empty">No script facts were recorded.</p>`}</section>`
    + (hooks ? `<section class="turn-review-hooks"><h4>Recorded hook results</h4><ul>${hooks}</ul></section>` : "")
    + (suggestions ? `<section class="turn-review-suggestions"><h4>Knowledge suggestions</h4><ul>${suggestions}</ul></section>` : "")
    + (drafts ? `<section class="turn-review-drafts"><h4>Knowledge drafts</h4><ul>${drafts}</ul></section>` : "")
    + controls
    + `</details>`;
}
