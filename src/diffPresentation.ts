import type { PatchChange } from "./core/types.js";

export interface DiffSide {
  line: number;
  text: string;
  kind: "context" | "removed" | "added";
}

export interface DiffRow {
  before?: DiffSide;
  after?: DiffSide;
}

export interface DiffPresentation {
  added: number;
  removed: number;
  rows: DiffRow[];
}

export function presentDiff(change: Pick<PatchChange, "before" | "after">, contextLines = 3): DiffPresentation {
  const before = change.before.split(/\r?\n/);
  const after = change.after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const rows: DiffRow[] = [];
  const leadingStart = Math.max(0, prefix - contextLines);
  for (let index = leadingStart; index < prefix; index += 1) {
    const text = before[index] ?? "";
    rows.push({
      before: { line: index + 1, text, kind: "context" },
      after: { line: index + 1, text, kind: "context" }
    });
  }

  const removedLines = before.slice(prefix, before.length - suffix);
  const addedLines = after.slice(prefix, after.length - suffix);
  const changedRows = Math.max(removedLines.length, addedLines.length);
  for (let index = 0; index < changedRows; index += 1) {
    const beforeText = removedLines[index];
    const afterText = addedLines[index];
    rows.push({
      ...(beforeText === undefined ? {} : { before: { line: prefix + index + 1, text: beforeText, kind: "removed" as const } }),
      ...(afterText === undefined ? {} : { after: { line: prefix + index + 1, text: afterText, kind: "added" as const } })
    });
  }

  const trailingCount = Math.min(contextLines, suffix);
  for (let index = 0; index < trailingCount; index += 1) {
    const beforeIndex = before.length - suffix + index;
    const afterIndex = after.length - suffix + index;
    const text = before[beforeIndex] ?? "";
    rows.push({
      before: { line: beforeIndex + 1, text, kind: "context" },
      after: { line: afterIndex + 1, text: after[afterIndex] ?? text, kind: "context" }
    });
  }

  return { added: addedLines.length, removed: removedLines.length, rows };
}
