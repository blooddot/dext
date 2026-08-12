import type { ClipboardReadResult } from "./clipboardClient.js";

function fileStringRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /@file\s*\(\s*"/g;
  for (const match of source.matchAll(pattern)) {
    let offset = (match.index ?? 0) + match[0].length;
    const start = offset;
    while (offset < source.length) {
      if (source[offset] === "\\") offset += 2;
      else if (source[offset] === '"') {
        ranges.push({ start, end: offset });
        break;
      } else offset += 1;
    }
  }
  return ranges;
}

export function codeReferencePasteText(
  source: string,
  selectionStart: number,
  selectionEnd: number,
  result: ClipboardReadResult
): string {
  const reference = result.codeReference;
  if (!reference) return result.text;
  const insideFileString = fileStringRanges(source).some(
    (range) => selectionStart >= range.start && selectionEnd <= range.end
  );
  if (insideFileString) return reference.payload;
  const before = source.slice(0, selectionStart);
  const after = source.slice(selectionEnd);
  if (/@file\s*\(\s*$/.test(before) && /^\s*(?:\)|$)/.test(after)) {
    return `"${reference.payload}"`;
  }
  return reference.expression;
}
