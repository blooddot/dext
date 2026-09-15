import type { FactValidation } from "./projectKnowledgeValidation.js";

export interface ReviewChange {
  uri: string;
  kind: "created" | "modified" | "deleted" | "unassigned";
  moduleId?: string;
}

export interface ReviewHookSummary {
  source: string;
  name?: string;
  status: "running" | "passed" | "failed" | "cancelled" | "unknown";
  text?: string;
}

export type ReviewAcceptance = "not_required" | "pending" | "accepted" | "rejected";

/** Identifies one execution attempt. A retry always gets a new runId. */
export interface RunIdentity {
  sessionId: string;
  turnId: string;
  runId: string;
  attempt: number;
}

/** A user decision on one run. Keyed by run so it can never leak into another run or Build. */
export interface ReviewFeedback {
  sessionId: string;
  turnId: string;
  runId: string;
  decision: Exclude<ReviewAcceptance, "not_required" | "pending">;
  note?: string;
  at: number;
}

export interface TurnReview {
  runId: string;
  sessionId: string;
  turnId: string;
  mode: "agent" | "plan" | "ask" | "code";
  attempt: number;
  /** Long-term knowledge version this review was computed against. */
  projectVersion?: number;
  /** Plan content version plus the Build run that produced it, for Plan reviews. */
  planVersion?: string;
  buildRunId?: string;
  changes: ReviewChange[];
  factValidation: FactValidation[];
  hookSummaries: ReviewHookSummary[];
  semanticSuggestions: string[];
  acceptance: ReviewAcceptance;
  createdAt: number;
}

export function reviewRequiresUserAcceptance(review: TurnReview): boolean {
  return review.mode === "agent" || review.mode === "plan" ? review.acceptance === "pending" : false;
}

/** A retry starts a fresh attempt and run identity instead of reusing the previous one. */
export function nextRunIdentity(previous: RunIdentity | undefined, sessionId: string, turnId: string, runId: string): RunIdentity {
  return { sessionId, turnId, runId, attempt: (previous?.attempt ?? 0) + 1 };
}

/**
 * A historical conclusion no longer speaks for the current version once content, rules, or
 * bindings changed. The old review is preserved; it is only marked as not current.
 */
export function reviewRepresentsVersion(review: TurnReview, projectVersion: number): boolean {
  return review.projectVersion === undefined || review.projectVersion === projectVersion;
}

export function markReviewSuperseded(review: TurnReview): TurnReview {
  return review.acceptance === "accepted" ? { ...review, acceptance: "pending" } : review;
}
