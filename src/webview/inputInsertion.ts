export interface InsertionEdit {
  text: string;
  cursorOffset: number;
}

function needsInlinePrefix(character: string): boolean {
  return Boolean(character) && !/\s|[=(:,[]/.test(character);
}

function needsInlineSuffix(character: string): boolean {
  return Boolean(character) && !/\s|[),\]]/.test(character);
}

export function inlineInsertion(
  source: string,
  from: number,
  to: number,
  value: string
): InsertionEdit {
  const prefix = needsInlinePrefix(source[from - 1] ?? "") ? " " : "";
  const suffix = needsInlineSuffix(source[to] ?? "") ? " " : "";
  return {
    text: `${prefix}${value}${suffix}`,
    cursorOffset: prefix.length + value.length
  };
}

export function invocationInsertion(
  source: string,
  from: number,
  to: number,
  value: string
): InsertionEdit {
  const prefix = from > 0 && !/\s/.test(source[from - 1] ?? "") ? "\n" : "";
  const suffix = to < source.length && !/\s/.test(source[to] ?? "") ? "\n" : "";
  return {
    text: `${prefix}${value}${suffix}`,
    cursorOffset: prefix.length + value.length
  };
}
