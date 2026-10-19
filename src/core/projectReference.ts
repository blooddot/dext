
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
