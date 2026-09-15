import type { PatchChange } from "./types.js";
import type { FactValidation } from "./projectKnowledgeValidation.js";
import type { ReviewChange, ReviewHookSummary, TurnReview } from "./turnReview.js";

/** A patch change is classified by what the file looked like before and after the run. */
export function reviewChangeKind(change: Pick<PatchChange, "before" | "after">): ReviewChange["kind"] {
  if (!change.before && change.after) return "created";
  if (change.before && !change.after) return "deleted";
  return "modified";
}

/** Lists the files one run touched, deduplicated by uri so a file edited twice is reported once. */
export function reviewChangesFromPatch(changes: readonly PatchChange[]): ReviewChange[] {
  const byUri = new Map<string, ReviewChange>();
  for (const change of changes) {
    if (change.before === change.after) continue;
    const existing = byUri.get(change.uri);
    // A file created and then edited again in the same run stays "created".
    const kind = existing?.kind === "created" ? "created" : reviewChangeKind(change);
    byUri.set(change.uri, { uri: change.uri, kind });
  }
  return [...byUri.values()];
}

export interface TurnReviewInput {
  runId: string;
  sessionId: string;
  turnId: string;
  mode: TurnReview["mode"];
  attempt?: number;
  projectVersion?: number;
  planVersion?: string;
  buildRunId?: string;
  changes?: readonly ReviewChange[];
  factValidation?: readonly FactValidation[];
  hookSummaries?: readonly ReviewHookSummary[];
  semanticSuggestions?: readonly string[];
  acceptance?: TurnReview["acceptance"];
  createdAt?: number;
}

/** Builds a bounded, source-oriented review. It deliberately does not infer a
 * pass from missing hooks or from the agent's prose. */
export function buildTurnReview(input: TurnReviewInput): TurnReview {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    mode: input.mode,
    attempt: input.attempt ?? 1,
    ...(input.projectVersion !== undefined ? { projectVersion: input.projectVersion } : {}),
    ...(input.planVersion !== undefined ? { planVersion: input.planVersion } : {}),
    ...(input.buildRunId !== undefined ? { buildRunId: input.buildRunId } : {}),
    changes: [...(input.changes ?? [])],
    factValidation: [...(input.factValidation ?? [])],
    hookSummaries: [...(input.hookSummaries ?? [])],
    semanticSuggestions: [...(input.semanticSuggestions ?? [])],
    acceptance: input.acceptance ?? (input.mode === "agent" || input.mode === "plan" ? "pending" : "not_required"),
    createdAt: input.createdAt ?? Date.now()
  };
}

export function reviewCanBeAccepted(review: TurnReview): boolean {
  return review.acceptance === "pending"
    && !review.factValidation.some((fact) => fact.kind === "missing" || fact.kind === "changed")
    && !review.hookSummaries.some((hook) => hook.status === "failed");
}
