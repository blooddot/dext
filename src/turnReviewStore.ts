import type { TurnReview } from "./core/turnReview.js";

export interface TurnReviewState {
  reviews: Record<string, TurnReview>;
  maxReviews: number;
}

/**
 * Bounded conversation-run store. It keeps Review attachments keyed by
 * `sessionId:turnId:runId` and never shares a key across runs, so a retry or a later Build cannot
 * inherit an older acceptance. It is intentionally separate from long-lived project knowledge.
 */
export class TurnReviewStore {
  private readonly reviews = new Map<string, TurnReview>();
  constructor(private readonly maxReviews = 200) {}

  private key(review: Pick<TurnReview, "sessionId" | "turnId" | "runId">): string {
    return `${review.sessionId}:${review.turnId}:${review.runId}`;
  }

  put(review: TurnReview): void {
    this.reviews.set(this.key(review), structuredClone(review));
    this.evict();
  }

  get(sessionId: string, turnId: string, runId: string): TurnReview | undefined {
    const review = this.reviews.get(`${sessionId}:${turnId}:${runId}`);
    return review ? structuredClone(review) : undefined;
  }

  /** Returns the review for a run only when its session, turn, and run all match. */
  getForRun(sessionId: string, turnId: string, runId: string): TurnReview | undefined {
    return this.get(sessionId, turnId, runId);
  }

  list(): TurnReview[] {
    return [...this.reviews.values()].map((review) => structuredClone(review));
  }

  /** Removes every run of a conversation without touching project knowledge. */
  deleteSession(sessionId: string): number {
    let removed = 0;
    for (const [key, review] of this.reviews) {
      if (review.sessionId !== sessionId) continue;
      this.reviews.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.reviews.clear();
  }

  get size(): number {
    return this.reviews.size;
  }

  snapshot(): TurnReviewState {
    return { reviews: Object.fromEntries([...this.reviews].map(([key, review]) => [key, structuredClone(review)])), maxReviews: this.maxReviews };
  }

  restore(state: TurnReviewState): void {
    this.reviews.clear();
    for (const review of Object.values(state.reviews)) this.put(review);
  }

  private evict(): void {
    while (this.reviews.size > this.maxReviews) {
      const oldest = [...this.reviews.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
      if (!oldest) return;
      this.reviews.delete(oldest[0]);
    }
  }
}
