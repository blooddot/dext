import type { ProjectEvidence, ProjectObject } from "./projectKnowledge.js";

export type FactValidationKind = "present" | "missing" | "changed" | "unknown";
export interface FactValidation {
  objectId: string;
  evidence: ProjectEvidence;
  kind: FactValidationKind;
  reason?: string;
}

export interface FactSnapshot {
  path: string;
  contentHash?: string;
  symbols?: readonly string[];
  imports?: readonly string[];
}

export interface ProjectFactHost {
  snapshot(path: string): Promise<FactSnapshot | undefined>;
}

export async function validateProjectObjectFacts(
  object: ProjectObject,
  host: ProjectFactHost
): Promise<FactValidation[]> {
  const results: FactValidation[] = [];
  for (const evidence of object.evidence) {
    const snapshot = await host.snapshot(evidence.path);
    if (!snapshot) {
      results.push({ objectId: object.id, evidence, kind: "missing", reason: "Evidence file no longer exists." });
      continue;
    }
    if (evidence.contentHash && snapshot.contentHash && evidence.contentHash !== snapshot.contentHash) {
      results.push({ objectId: object.id, evidence, kind: "changed", reason: "Evidence content changed after the knowledge version." });
      continue;
    }
    if (evidence.symbol && snapshot.symbols && !snapshot.symbols.includes(evidence.symbol)) {
      results.push({ objectId: object.id, evidence, kind: "changed", reason: `Symbol '${evidence.symbol}' is no longer present.` });
      continue;
    }
    results.push({ objectId: object.id, evidence, kind: evidence.contentHash || evidence.symbol ? "present" : "unknown" });
  }
  return results;
}

export function affectedProjectObjectIds(objects: readonly ProjectObject[], changedPaths: readonly string[]): Set<string> {
  const changed = new Set(changedPaths.map((path) => path.replaceAll("\\", "/")));
  const affected = new Set<string>();
  for (const object of objects) {
    if (object.paths.some((path) => changed.has(path.replaceAll("\\", "/")))
      || object.evidence.some((evidence) => changed.has(evidence.path.replaceAll("\\", "/")))) affected.add(object.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const object of objects) if (!affected.has(object.id) && object.relatedIds.some((id) => affected.has(id))) {
      affected.add(object.id); grew = true;
    }
  }
  return affected;
}

/**
 * Recomputes validity from fact validation without touching the user's confirmation decision.
 * An accepted object whose evidence changed becomes accepted + stale/needs_verification, never a
 * silent downgrade back to an AI draft.
 */
export function validityAfterFactValidation(object: ProjectObject, facts: readonly FactValidation[]): ProjectObject {
  if (!facts.length || facts.every((fact) => fact.kind === "present")) return object;
  const missing = facts.some((fact) => fact.kind === "missing");
  const changed = facts.some((fact) => fact.kind === "changed");
  const conflicting = missing && changed;
  const validity = conflicting ? "conflicted" : missing ? "stale" : "needs_verification";
  return { ...object, validity };
}

/** @deprecated Use {@link validityAfterFactValidation}; kept for older callers. */
export const statusAfterFactValidation = validityAfterFactValidation;
