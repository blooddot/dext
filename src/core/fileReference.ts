import type { Range } from "./types.js";

export interface DextFileReference {
  expression: string;
  payload: string;
}

export interface ParsedFileReference {
  path: string;
  range?: Range;
}

export function compactFileReferenceLabel(value: string): string {
  const parsed = parseFileReference(value);
  const normalized = parsed.path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) || normalized;
  if (!parsed.range) return name;
  const start = parsed.range.start.line + 1;
  const end = parsed.range.end.line + 1;
  return `${name} ${start === end ? start : `${start}-${end}`}`;
}

const RANGE_FRAGMENT = /#L(\d+),(\d+)-L(\d+),(\d+)$/;

function comparePositions(left: Range["start"], right: Range["start"]): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}

export function formatDextFileReference(relativePath: string, range: Range): DextFileReference {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const fragment = `#L${range.start.line + 1},${range.start.character + 1}`
    + `-L${range.end.line + 1},${range.end.character + 1}`;
  const payload = `${normalizedPath}${fragment}`
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return { payload, expression: `@file("${payload}")` };
}

export function parseFileReference(value: string): ParsedFileReference {
  const match = RANGE_FRAGMENT.exec(value);
  if (!match) return { path: value };
  const values = match.slice(1).map(Number);
  const [startLine, startCharacter, endLine, endCharacter] = values;
  if (
    startLine === undefined
    || startCharacter === undefined
    || endLine === undefined
    || endCharacter === undefined
    || values.some((entry) => !Number.isSafeInteger(entry) || entry < 1)
  ) {
    return { path: value };
  }
  const range: Range = {
    start: { line: startLine - 1, character: startCharacter - 1 },
    end: { line: endLine - 1, character: endCharacter - 1 }
  };
  if (comparePositions(range.start, range.end) > 0) {
    throw new Error("@file range start must not be after its end.");
  }
  return { path: value.slice(0, match.index), range };
}
