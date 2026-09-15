import type { ProjectObject } from "./core/projectKnowledge.js";
import { applyKnowledgeSuggestion, isSuggestionSafeForAcceptedObject, type KnowledgeDecision, type KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import { reviewRepresentsVersion, type ReviewAcceptance, type TurnReview } from "./core/turnReview.js";
import type { TurnReviewStore } from "./turnReviewStore.js";

/** Long-term project sink used by the adoption bridge. Accepting a Review never writes here. */
export interface ReviewKnowledgeSink {
  load(objectId: string): Promise<ProjectObject | undefined>;
  save(object: ProjectObject): Promise<void>;
  remove(objectId: string): Promise<void>;
  navigate(objectId: string): Promise<void> | void;
  /** Drafts the project service produced for one run. Absent when no source is connected. */
  suggestions?(sessionId: string, turnId: string): Promise<readonly KnowledgeSuggestion[]>;
}

export type ReviewFeedbackStatus = "accepted" | "rejected" | "not_found" | "stale";

export interface ReviewFeedbackResult {
  status: ReviewFeedbackStatus;
  review?: TurnReview;
}

export interface KnowledgeAdoptionResult {
  status: "adopted" | "not_applicable" | "stale";
  object?: ProjectObject;
  navigated: boolean;
}

export interface ReviewAcceptanceCard {
  runId: string;
  acceptance: Exclude<ReviewAcceptance, "not_required">;
  title: string;
  changes: string[];
  canAccept: boolean;
}

/**
 * Drives per-turn Review actions. Every lookup is keyed by session + turn + run, so feedback for
 * one run can never land on another run, an older attempt, or a different Build.
 */
export class TurnReviewController {
  constructor(
    private readonly store: TurnReviewStore,
    private readonly knowledge?: ReviewKnowledgeSink
  ) {}

  find(sessionId: string, turnId: string, runId: string): TurnReview | undefined {
    return this.store.get(sessionId, turnId, runId);
  }

  /**
   * Records the user's decision on one run. A review bound to an older project version is refused
   * as stale instead of silently accepting an out-of-date conclusion.
   */
  submitFeedback(
    sessionId: string,
    turnId: string,
    runId: string,
    decision: Exclude<ReviewAcceptance, "not_required" | "pending">,
    options: { note?: string; currentProjectVersion?: number; now?: number } = {}
  ): ReviewFeedbackResult {
    const review = this.store.get(sessionId, turnId, runId);
    if (!review) return { status: "not_found" };
    if (options.currentProjectVersion !== undefined && !reviewRepresentsVersion(review, options.currentProjectVersion)) {
      return { status: "stale", review };
    }
    if (review.acceptance === "not_required") return { status: "not_found", review };
    const updated: TurnReview = { ...review, acceptance: decision };
    this.store.put(updated);
    return { status: decision, review: updated };
  }

  /** File references a host can open for a diff jump. Only existing records are returned. */
  diffTargets(sessionId: string, turnId: string, runId: string): string[] {
    const review = this.store.get(sessionId, turnId, runId);
    if (!review) return [];
    return [...new Set(review.changes.map((change) => change.uri))];
  }

  /** Ask turns and turns with no development change do not produce an acceptance card. */
  acceptanceCard(sessionId: string, turnId: string, runId: string): ReviewAcceptanceCard | undefined {
    const review = this.store.get(sessionId, turnId, runId);
    if (!review) return undefined;
    if (review.mode === "ask" || review.acceptance === "not_required" || !review.changes.length) return undefined;
    const changed = review.changes;
    if (!changed.length && !review.factValidation.length && !review.hookSummaries.length) return undefined;
    const failed = review.hookSummaries.some((hook) => hook.status === "failed");
    return {
      runId: review.runId,
      acceptance: review.acceptance,
      title: review.mode === "plan" ? "Plan build review" : "Turn review",
      changes: changed.map((change) => `${change.kind} ${change.uri}`),
      canAccept: review.acceptance === "pending" && !failed
        && !review.factValidation.some((fact) => fact.kind === "missing" || fact.kind === "changed")
    };
  }

  /**
   * Adoption bridge: applies one AI knowledge suggestion to the project and navigates to the
   * object. Accepting the code Review is a separate action and never adopts every suggestion.
   */
  async adoptKnowledgeSuggestion(
    suggestion: KnowledgeSuggestion,
    decision: KnowledgeDecision,
    now = Date.now()
  ): Promise<KnowledgeAdoptionResult> {
    if (!this.knowledge) return { status: "not_applicable", navigated: false };
    const current = suggestion.objectId !== undefined ? await this.knowledge.load(suggestion.objectId) : undefined;
    if (current && !isSuggestionSafeForAcceptedObject(suggestion, current)) return { status: "stale", navigated: false };
    const applied = applyKnowledgeSuggestion(current, suggestion, decision, now);
    if (suggestion.kind === "remove" && decision !== "rejected") {
      if (!suggestion.objectId) return { status: "not_applicable", navigated: false };
      await this.knowledge.remove(suggestion.objectId);
      return { status: "adopted", navigated: false };
    }
    if (!applied) return { status: "not_applicable", navigated: false };
    await this.knowledge.save(applied);
    await this.knowledge.navigate(applied.id);
    return { status: "adopted", object: applied, navigated: true };
  }
}
