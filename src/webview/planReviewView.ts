import type { PlanReview, PlanTaskAssociation } from "../core/planReview.js";
import { aggregatePlanChanges, pendingAcceptanceCount } from "../core/planReview.js";
import type { ReviewChange } from "../core/turnReview.js";

function escapeHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export interface PlanReviewViewOptions {
  expanded?: boolean;
}

function renderChanges(label: string, changes: readonly ReviewChange[]): string {
  if (!changes.length) return "";
  return `<section class="plan-review-group" data-plan-review-group="${escapeHtml(label)}">`
    + `<h4>${escapeHtml(label)}</h4><ul>${changes.map((change) =>
      `<li data-change-uri="${escapeHtml(change.uri)}"><button type="button" data-review-diff="${escapeHtml(change.uri)}">${escapeHtml(change.kind)} ${escapeHtml(change.uri)}</button></li>`).join("")}</ul></section>`;
}

function renderTaskGroups(groups: readonly PlanTaskAssociation[]): string {
  if (!groups.length) return `<p class="plan-review-empty">No change could be reliably tied to a task.</p>`;
  return groups.map((group) => `<section class="plan-review-task" data-task-id="${escapeHtml(group.taskId)}">`
    + `<h4>${escapeHtml(group.taskId)} — ${escapeHtml(group.taskText)}</h4>`
    + (group.changes.length
      ? `<ul>${group.changes.map((change) => `<li data-change-uri="${escapeHtml(change.uri)}"><button type="button" data-review-diff="${escapeHtml(change.uri)}">${escapeHtml(change.kind)} ${escapeHtml(change.uri)}</button></li>`).join("")}</ul>`
      : `<p class="plan-review-empty">No proven change.</p>`)
    + `</section>`).join("");
}

/**
 * Renders the Plan Build review: per-task groups, shared and unattributed changes kept separate,
 * and one aggregate acceptance action for the whole Build.
 */
export function renderPlanReview(review: PlanReview, options: PlanReviewViewOptions = {}): string {
  const all = aggregatePlanChanges(review);
  const pending = pendingAcceptanceCount(review);
  return `<details class="plan-review" data-plan-review="1" data-plan-version="${escapeHtml(review.planVersion)}" data-build-run="${escapeHtml(review.runId)}"${options.expanded ? " open" : ""}>`
    + `<summary>Plan build review &middot; ${all.length} changed file${all.length === 1 ? "" : "s"} &middot; ${review.reviews.length} round${review.reviews.length === 1 ? "" : "s"}`
    + `${review.acceptance === "pending" ? " &middot; awaiting acceptance" : ` &middot; ${escapeHtml(review.acceptance)}`}</summary>`
    + `<section class="plan-review-tasks"><h3>Task associations</h3>${renderTaskGroups(review.taskGroups)}</section>`
    + renderChanges("Shared across tasks", review.sharedChanges)
    + renderChanges("Unattributed changes", review.noTaskIdChanges)
    + `<section class="plan-review-acceptance"><h3>Final acceptance</h3><p>${pending} round${pending === 1 ? "" : "s"} awaiting acceptance.</p>`
    + (review.acceptance === "pending"
      ? `<div class="plan-review-actions"><button type="button" data-plan-review-accept="${escapeHtml(review.runId)}">Accept build review</button>`
        + `<button type="button" data-plan-review-reject="${escapeHtml(review.runId)}">Request changes</button></div>`
      : `<p class="plan-review-decision">Decision: ${escapeHtml(review.acceptance ?? "pending")}</p>`)
    + `</section></details>`;
}
