import type { ProjectObject } from "./projectKnowledge.js";
import { searchableProjectObjectValues } from "./projectKnowledge.js";

/**
 * A reference from a conversation or Input to a project object.
 *
 * `objectId` is the stable identity and never changes when the object is renamed. The name fields
 * are a display snapshot only, so an old conversation keeps rendering after a rename while still
 * resolving to the current object.
 */
export interface ProjectObjectReference {
  objectId: string;
  canonicalName: string;
  displayName?: string;
  label?: string;
}

/** Visible source token. The label is a snapshot; the encoded ID is authoritative. */
export function formatProjectReference(reference: ProjectObjectReference): string {
  const encode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `#${encode(reference.canonicalName)}[${encode(reference.objectId)}]`;
}

export interface ProjectReferenceOccurrence {
  start: number;
  end: number;
  expression: string;
  reference: ProjectObjectReference;
}

export function projectReferenceOccurrences(source: string): ProjectReferenceOccurrence[] {
  const results: ProjectReferenceOccurrence[] = [];
  for (const match of source.matchAll(/#([^\s#[\]"'`(){}]+)\[([^\s[\]"'`(){}]+)\]/g)) {
    const start = match.index;
    // A Markdown heading, URL fragment, file range, C# name, or hashtag is not a Project token.
    if (/[\p{L}\p{N}_./@#%+-]/u.test(source[start - 1] ?? "")) continue;
    try {
      const canonicalName = decodeURIComponent(match[1]!);
      const objectId = decodeURIComponent(match[2]!);
      if (!canonicalName || !objectId || Array.from(canonicalName + objectId).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) continue;
      results.push({ start, end: start + match[0].length, expression: match[0], reference: { canonicalName, objectId } });
    } catch { /* Malformed percent escapes remain ordinary user text. */ }
  }
  return results;
}

/** Lookup metadata for explicit user selection. No descriptions or knowledge are sent to a CLI. */
export interface ProjectReferenceCandidate {
  objectId: string;
  canonicalName: string;
  displayName?: string;
  aliases: string[];
  kind: string;
  token: string;
}

export function createProjectObjectReference(object: ProjectObject, label?: string): ProjectObjectReference {
  return {
    objectId: object.id,
    canonicalName: object.canonicalName,
    ...(object.displayName ? { displayName: object.displayName } : {}),
    ...(label ? { label } : {})
  };
}

/** Resolves a reference by stable ID. A stale display name never redirects the lookup. */
export function resolveProjectObjectReference(reference: ProjectObjectReference, objects: readonly ProjectObject[]): ProjectObject | undefined {
  return objects.find((object) => object.id === reference.objectId);
}

export interface ProjectObjectSearchResult {
  object: ProjectObject;
  matchedName: string;
  exact: boolean;
}

/**
 * Searches the English canonical name, the Chinese display name, and every alias together.
 * An empty query returns every object in stable name order.
 */
export function searchProjectObjects(objects: readonly ProjectObject[], query: string): ProjectObjectSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  const results: ProjectObjectSearchResult[] = [];
  for (const object of objects) {
    const names = [object.canonicalName, object.displayName ?? "", ...object.aliases].filter(Boolean);
    const match = needle
      ? names.find((name) => name.toLocaleLowerCase().includes(needle))
      : names[0];
    if (!match) continue;
    results.push({ object, matchedName: match, exact: names.some((name) => name.toLocaleLowerCase() === needle) });
  }
  return results.sort((left, right) =>
    Number(right.exact) - Number(left.exact)
    || left.object.canonicalName.localeCompare(right.object.canonicalName));
}

export interface ProjectObjectRename {
  canonicalName?: string;
  displayName?: string;
  aliases?: readonly string[];
}

/**
 * Applies a rename while preserving the stable id, kind, provenance and every other field, so
 * references held by older conversations keep pointing at the same object.
 */
export function renameProjectObject(object: ProjectObject, rename: ProjectObjectRename): ProjectObject {
  const aliases = rename.aliases ? [...rename.aliases] : object.aliases;
  const previousNames = searchableProjectObjectValues(object);
  const canonicalName = rename.canonicalName ?? object.canonicalName;
  const displayName = rename.displayName ?? object.displayName;
  // Keep the previous names searchable so old conversations and Input text still resolve.
  const remembered = [...new Set([...aliases, ...previousNames])].filter(Boolean);
  return {
    ...object,
    id: object.id,
    canonicalName,
    ...(displayName ? { displayName } : {}),
    aliases: remembered,
    version: object.version + 1
  };
}

/** How many references still resolve after a rename. Used to pin the rename invariant in tests. */
export function referencesAfterRename(
  references: readonly ProjectObjectReference[],
  objectsAfter: readonly ProjectObject[]
): { resolved: number; unresolved: ProjectObjectReference[] } {
  const unresolved = references.filter((reference) => !resolveProjectObjectReference(reference, objectsAfter));
  return { resolved: references.length - unresolved.length, unresolved };
}
