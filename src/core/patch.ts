import type { PatchChange, PatchResult, Range } from "./types.js";

function position(value: unknown): { line: number; character: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return Number.isInteger(item.line) && Number.isInteger(item.character)
    ? { line: item.line as number, character: item.character as number }
    : undefined;
}

function range(value: unknown): Range | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const start = position(item.start);
  const end = position(item.end);
  return start && end ? { start, end } : undefined;
}

export function patchResultFrom(value: unknown): PatchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("code.apply requires a Dext result containing a patch.");
  }
  const record = value as Record<string, unknown>;
  const candidate = record.kind === "patch" ? record : record.patch;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("code.apply requires a Dext result containing a patch.");
  }
  const patch = candidate as Record<string, unknown>;
  if (patch.kind !== "patch" || typeof patch.title !== "string" || !Array.isArray(patch.changes)) {
    throw new Error("code.apply requires a Dext result containing a patch.");
  }
  const changes: PatchChange[] = patch.changes.map((change) => {
    if (typeof change !== "object" || change === null || Array.isArray(change)) {
      throw new Error("code.apply requires a valid patch result.");
    }
    const item = change as Record<string, unknown>;
    if (typeof item.uri !== "string" || typeof item.before !== "string" || typeof item.after !== "string") {
      throw new Error("code.apply requires a valid patch result.");
    }
    const changeRange = range(item.range);
    return {
      uri: item.uri,
      before: item.before,
      after: item.after,
      ...(changeRange ? { range: changeRange } : {}),
      ...(Number.isInteger(item.documentVersion) ? { documentVersion: item.documentVersion as number } : {}),
      ...(typeof item.contentHash === "string" ? { contentHash: item.contentHash } : {})
    };
  });
  return { kind: "patch", title: patch.title, changes };
}
