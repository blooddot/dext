import type { InputReferenceProjection } from "../core/fileReference.js";
export { inputReferenceProjections } from "../core/fileReference.js";

export interface FileReferenceRemovalEdit {
  from: number;
  to: number;
  insert: string;
}

function whitespaceBefore(source: string, offset: number): number {
  while (offset > 0 && /[ \t]/.test(source[offset - 1] ?? "")) offset -= 1;
  return offset;
}

function whitespaceAfter(source: string, offset: number, maximum = Number.POSITIVE_INFINITY): number {
  let count = 0;
  while (offset < source.length && count < maximum && /[ \t]/.test(source[offset] ?? "")) {
    offset += 1;
    count += 1;
  }
  return offset;
}

function hasAdjacentText(source: string, offset: number, direction: -1 | 1): boolean {
  const character = source[offset + (direction < 0 ? -1 : 0)] ?? "";
  // Quotes and Dext syntax delimiters frame an input value but are not user
  // text; retaining a space beside them after a chip removal is just noise.
  return Boolean(character) && !/[ \t\r\n"'`()\x5B\x5D{},=]/.test(character);
}

/** Removes a chip and its artificial separators. Text on both sides keeps one
 * ordinary space, so deleting an attachment cannot join the following words. */
export function fileReferenceRemovalEdit(
  source: string,
  projection: InputReferenceProjection
): FileReferenceRemovalEdit {
  const from = whitespaceBefore(source, projection.interpolationStart);
  const to = whitespaceAfter(source, projection.interpolationEnd);
  const hasTextBefore = hasAdjacentText(source, from, -1);
  const hasTextAfter = hasAdjacentText(source, to, 1);
  return { from, to, insert: hasTextBefore && hasTextAfter ? " " : "" };
}
