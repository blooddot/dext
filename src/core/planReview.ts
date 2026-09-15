import type { ReviewChange, TurnReview } from "./turnReview.js";

export interface PlanTaskAssociation {
  taskId: string;
  taskText: string;
  changes: ReviewChange[];
}

export interface PlanReview {
  runId: string;
  planVersion: string;
  attempt: number;
  reviews: TurnReview[];
  /** Reliable task associations. Only proven expectations appear here. */
  taskGroups: PlanTaskAssociation[];
  /** Changes a task genuinely shares with another task. Listed separately, never force-assigned. */
  sharedChanges: ReviewChange[];
  noTaskIdChanges: ReviewChange[];
  acceptance: "pending" | "accepted" | "rejected";
  finalizedAt?: number;
}

export interface PlanReviewOptions {
  attempt?: number;
  taskAssociations?: readonly PlanTaskAssociation[];
  /** Whether the initial change list had no traceable task owner. */
  noTaskIdChanges?: readonly ReviewChange[];
}

/** A change is attributed by file, so a file created in one round and edited later stays one unit. */
function changeKey(change: ReviewChange): string {
  return change.uri;
}

export function buildPlanReview(
  runId: string,
  planVersion: string,
  reviews: readonly TurnReview[],
  unassignedChanges: readonly string[] = [],
  options: PlanReviewOptions = {}
): PlanReview {
  const declared = options.noTaskIdChanges ?? unassignedChanges.map((uri) => ({ uri, kind: "unassigned" as const }));
  return {
    runId,
    planVersion,
    attempt: options.attempt ?? 1,
    reviews: [...reviews],
    taskGroups: (options.taskAssociations ?? []).map((group) => ({ ...group, changes: [...group.changes] })),
    sharedChanges: [],
    noTaskIdChanges: [...declared],
    acceptance: "pending"
  };
}

/** Every distinct change observed across the whole Build, in stable order. */
export function aggregatePlanChanges(review: PlanReview): ReviewChange[] {
  const seen = new Map<string, ReviewChange>();
  for (const turn of review.reviews) for (const change of turn.changes) seen.set(changeKey(change), change);
  return [...seen.values()].sort((left, right) => left.uri.localeCompare(right.uri) || left.kind.localeCompare(right.kind));
}

/**
 * Groups changes by task using explicitly recorded associations only. A change owned by more than
 * one task becomes a shared change, and anything with no association stays unattributed instead of
 * being inferred from the agent's task checkmarks.
 */
export function associatePlanChanges(
  review: PlanReview,
  associations: readonly PlanTaskAssociation[]
): PlanReview {
  const ownerCounts = new Map<string, number>();
  for (const group of associations) for (const change of group.changes) {
    const key = changeKey(change);
    ownerCounts.set(key, (ownerCounts.get(key) ?? 0) + 1);
  }
  const attributed = new Set(ownerCounts.keys());
  const shared = aggregatePlanChanges(review).filter((change) => (ownerCounts.get(changeKey(change)) ?? 0) > 1);
  const unattributed = aggregatePlanChanges(review).filter((change) => !attributed.has(changeKey(change)));
  const declared = review.noTaskIdChanges.filter((change) => !attributed.has(changeKey(change)));
  const seen = new Set<string>();
  return {
    ...review,
    taskGroups: associations.map((group) => ({ ...group, changes: [...group.changes] })),
    sharedChanges: shared,
    noTaskIdChanges: [...declared, ...unattributed].filter((change) => {
      const key = changeKey(change);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
  };
}

/** Adds one more executed round to the same Build instead of starting a new review. */
export function appendPlanReviewRun(review: PlanReview, turn: TurnReview): PlanReview {
  return { ...review, reviews: [...review.reviews, turn] };
}

/**
 * A Build finalizes once at least one round produced a review. Intermediate task reviews never
 * block continuation; only the user's decision on the final Review does.
 */
export function canFinalizePlanReview(review: PlanReview): boolean {
  return review.reviews.length > 0;
}

export function pendingAcceptanceCount(review: PlanReview): number {
  return review.reviews.filter((turn) => turn.acceptance === "pending").length;
}

export function finalizePlanReview(review: PlanReview, decision: "accepted" | "rejected", now = Date.now()): PlanReview {
  if (!canFinalizePlanReview(review)) return review;
  return { ...review, acceptance: decision, finalizedAt: now };
}

export function planReviewSummary(review: PlanReview): { changedFiles: number; failedHooks: number; pendingAcceptance: number } {
  const changedFiles = new Set(review.reviews.flatMap((item) => item.changes.map((change) => change.uri))).size;
  const failedHooks = review.reviews.reduce((total, item) => total + item.hookSummaries.filter((hook) => hook.status === "failed").length, 0);
  const pendingAcceptance = pendingAcceptanceCount(review);
  return { changedFiles, failedHooks, pendingAcceptance };
}
