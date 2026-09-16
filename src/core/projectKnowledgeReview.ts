import type { ProjectEvidence, ProjectObject } from "./projectKnowledge.js";

export interface KnowledgeSuggestion {
  id: string;
  objectId?: string;
  kind: "create" | "update" | "split" | "merge" | "remove";
  proposed: Partial<Pick<ProjectObject, "canonicalName" | "displayName" | "aliases" | "description" | "behavior" | "paths" | "relatedIds">>;
  evidence: ProjectEvidence[];
  reason: string;
  source: "ai";
  baseVersion?: number;
}

export type KnowledgeDecision = "accepted" | "rejected" | "edited";

export interface KnowledgeDecisionRecord {
  suggestionId: string;
  decision: KnowledgeDecision;
  decidedAt: number;
  edited?: KnowledgeSuggestion["proposed"];
}

export function isSuggestionSafeForAcceptedObject(suggestion: KnowledgeSuggestion, object: ProjectObject): boolean {
  return suggestion.objectId === object.id && suggestion.baseVersion === object.version;
}

function decisionKey(suggestion: Pick<KnowledgeSuggestion, "id" | "baseVersion">): string {
  return `${suggestion.id}@${suggestion.baseVersion ?? "unversioned"}`;
}

/**
 * Holds AI knowledge drafts and the user's decisions for one project version.
 *
 * A suggestion rejected for a given base version is remembered, so the same version never
 * resurfaces the same proposal. A newer base version is a genuinely new proposal and may be
 * enqueued again.
 */
export class KnowledgeDraftQueue {
  private readonly suggestions = new Map<string, KnowledgeSuggestion>();
  private readonly decisions = new Map<string, KnowledgeDecisionRecord>();

  /** Returns false when an identical suggestion was already rejected for the same base version. */
  enqueue(suggestion: KnowledgeSuggestion): boolean {
    const decision = this.decisions.get(decisionKey(suggestion));
    if (decision?.decision === "rejected") return false;
    this.suggestions.set(suggestion.id, structuredClone(suggestion));
    this.decisions.delete(suggestion.id);
    return true;
  }

  list(): KnowledgeSuggestion[] {
    return [...this.suggestions.values()].map((suggestion) => structuredClone(suggestion));
  }

  /**
   * The decision recorded for a draft. Decisions are keyed by draft id plus base version, so a
   * draft that left the queue (a rejected one) is still found by its id: the most recently recorded
   * decision wins, which is the one a newer base version would have replaced.
   */
  decisionFor(suggestionId: string): KnowledgeDecisionRecord | undefined {
    const suggestion = this.suggestions.get(suggestionId);
    if (suggestion) return this.decisions.get(decisionKey(suggestion));
    const direct = this.decisions.get(suggestionId);
    if (direct) return direct;
    let latest: KnowledgeDecisionRecord | undefined;
    for (const record of this.decisions.values()) if (record.suggestionId === suggestionId) latest = record;
    return latest;
  }

  decide(suggestionId: string, decision: KnowledgeDecision, now = Date.now(), edited?: KnowledgeSuggestion["proposed"]): KnowledgeDecisionRecord | undefined {
    const suggestion = this.suggestions.get(suggestionId);
    if (!suggestion) return undefined;
    const record: KnowledgeDecisionRecord = { suggestionId, decision, decidedAt: now, ...(edited ? { edited } : {}) };
    this.decisions.set(decisionKey(suggestion), record);
    if (decision === "rejected") this.suggestions.delete(suggestionId);
    else if (edited) this.suggestions.set(suggestionId, { ...suggestion, proposed: edited });
    return record;
  }

  /** Combines several drafts into one; the originals are removed by their own decisions. */
  merge(ids: readonly string[], merged: Pick<KnowledgeSuggestion, "id" | "proposed" | "reason">): KnowledgeSuggestion | undefined {
    const sources = ids.map((id) => this.suggestions.get(id)).filter((item): item is KnowledgeSuggestion => Boolean(item));
    if (sources.length < 2) return undefined;
    const suggestion: KnowledgeSuggestion = {
      id: merged.id,
      kind: "merge",
      proposed: merged.proposed,
      reason: merged.reason,
      evidence: sources.flatMap((item) => item.evidence),
      source: "ai",
      ...(sources[0]!.baseVersion !== undefined ? { baseVersion: sources[0]!.baseVersion } : {})
    };
    for (const id of ids) this.suggestions.delete(id);
    this.suggestions.set(suggestion.id, suggestion);
    return suggestion;
  }

  /** Splits one draft into several independent drafts. */
  split(id: string, parts: readonly Pick<KnowledgeSuggestion, "id" | "proposed" | "reason">[]): KnowledgeSuggestion[] {
    const source = this.suggestions.get(id);
    if (!source || parts.length < 2) return [];
    this.suggestions.delete(id);
    const created = parts.map((part) => {
      const suggestion: KnowledgeSuggestion = {
        id: part.id,
        kind: "split",
        proposed: part.proposed,
        reason: part.reason,
        evidence: source.evidence,
        source: "ai",
        ...(source.baseVersion !== undefined ? { baseVersion: source.baseVersion } : {})
      };
      this.suggestions.set(suggestion.id, suggestion);
      return suggestion;
    });
    return created;
  }
}

export function applyKnowledgeSuggestion(object: ProjectObject | undefined, suggestion: KnowledgeSuggestion, decision: KnowledgeDecision, now = Date.now()): ProjectObject | undefined {
  if (decision === "rejected") return object;
  const values = suggestion.proposed;
  if (suggestion.kind === "remove") return undefined;
  if (!object) {
    if (suggestion.kind !== "create" || !values.canonicalName) return undefined;
    return {
      id: suggestion.objectId ?? suggestion.id,
      canonicalName: values.canonicalName,
      displayName: values.displayName,
      aliases: values.aliases ?? [],
      kind: "feature",
      description: values.description ?? "",
      behavior: values.behavior ?? [],
      paths: values.paths ?? [],
      relatedIds: values.relatedIds ?? [],
      source: "ai",
      confirmation: decision === "accepted" ? "accepted" : "draft",
      validity: "needs_verification",
      ownership: "candidate",
      confidence: 0.5,
      evidence: suggestion.evidence,
      version: 0
    };
  }
  return {
    ...object,
    ...values,
    // Accepting a suggestion is a user decision; the update still has to be re-validated against
    // the code, so validity starts as needs_verification rather than current.
    source: decision === "accepted" ? "user" : "ai",
    confirmation: decision === "accepted" ? "accepted" : object.confirmation,
    validity: "needs_verification",
    evidence: suggestion.evidence.length ? suggestion.evidence : object.evidence,
    version: object.version + 1,
    // Keep the update deterministic; the timestamp is intentionally not part of the object schema.
    ...(now < 0 ? {} : {})
  };
}
