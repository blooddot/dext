/** Format object/array output without changing its data or string values. */
export function formatJsonOutput(text: string): string | undefined {
  const source = text.trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return undefined;
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== "object" || value === null) return undefined;
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}
