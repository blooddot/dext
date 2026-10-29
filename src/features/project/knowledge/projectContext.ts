import type { ProjectIntent } from "../contracts/projectIntent.js";
import type { ProjectModel } from "../contracts/projectModel.js";
import type { ProjectObject } from "../contracts/projectKnowledge.js";
import { formatProjectReference, type ProjectReferenceCandidate } from "./projectReference.js";

/** Read-only picker data. Accepted items remain addressable when their evidence needs review. */
export function searchProjectReferences(options: {
  objects: readonly ProjectObject[];
  model?: ProjectModel;
  intent?: ProjectIntent | undefined;
  query: string;
  limit?: number;
}): ProjectReferenceCandidate[] {
  const candidates: ProjectReferenceCandidate[] = options.model ? options.model.nodes.filter(node => node.review === "accepted" || node.review === "edited").map(node => ({
    objectId: node.id, canonicalName: node.canonicalName, displayName: node.title, aliases: [], kind: node.kind,
    token: formatProjectReference({ objectId: node.id, canonicalName: node.canonicalName })
  })) : options.objects.filter((object) => object.confirmation === "accepted").map((object) => ({
    objectId: object.id, canonicalName: object.canonicalName, aliases: [...object.aliases], kind: object.kind,
    ...(object.displayName ? { displayName: object.displayName } : {}), token: formatProjectReference({ objectId: object.id, canonicalName: object.canonicalName })
  }));
  if (options.intent && !options.model) {
    for (const [kind, items] of [["capability", options.intent.capabilities], ["context", options.intent.contexts], ["term", options.intent.terms]] as const) {
      for (const item of items) {
        if (item.review !== "accepted" && item.review !== "edited") continue;
        candidates.push({ objectId: item.id, canonicalName: item.canonicalName, kind,
          ...(item.displayName ? { displayName: item.displayName } : {}),
          aliases: "aliases" in item ? [...item.aliases] : [], token: formatProjectReference({ objectId: item.id, canonicalName: item.canonicalName }) });
      }
    }
  }
  const query = options.query.trim().toLocaleLowerCase();
  const matches = candidates.map((item) => ({ item, names: [item.canonicalName, item.displayName ?? "", ...item.aliases].map((name) => name.toLocaleLowerCase()) }))
    .filter(({ names }) => !query || names.some((name) => name.includes(query)))
    .sort((left, right) => Number(right.names.includes(query)) - Number(left.names.includes(query)) || left.item.canonicalName.localeCompare(right.item.canonicalName));
  // IDs are the identity shared by all Project views. Avoid duplicate completion entries.
  return [...new Map(matches.map(({ item }) => [item.objectId, item])).values()].slice(0, Math.max(0, Math.min(options.limit ?? 50, 200)));
}
