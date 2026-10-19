import { applyEdits, format } from "jsonc-parser/lib/esm/main.js";

/** Format object/array output without changing its data or string values. */
export function formatJsonOutput(text: string): string | undefined {
  const source = text.trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null) return undefined;
    // Format whitespace only: preserve number precision, duplicate keys and
    // string escapes. The original source remains the copy payload.
    return applyEdits(source, format(source, undefined, { insertSpaces: true, tabSize: 2, eol: "\n" }));
  } catch {
    return undefined;
  }
}
