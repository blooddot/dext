export interface InsertionEdit {
  text: string;
  cursorOffset: number;
}

export interface SourceReplacement {
  from: number;
  to: number;
  text: string;
  cursorOffset: number;
}

interface QuotedString {
  literalStart: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
  quote: string;
  formatted: boolean;
}

interface CoreInputArgument {
  valueStart: number;
  valueEnd: number;
  literal?: QuotedString;
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

function quotedString(source: string, start: number, allowUnterminated = false): QuotedString | undefined {
  const formatted = source[start] === "f" || source[start] === "F";
  const quoteStart = formatted ? start + 1 : start;
  const prefix = source.slice(quoteStart, quoteStart + 3);
  const quote = prefix === '"""' || prefix === "'''" ? prefix : source[quoteStart];
  if (quote !== '"' && quote !== "'" && quote !== '"""' && quote !== "'''") return undefined;
  const bodyStart = quoteStart + quote.length;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (source[index] === "\\") {
      escaped = true;
      continue;
    }
    if (source.startsWith(quote, index)) {
      return { literalStart: start, bodyStart, bodyEnd: index, end: index + quote.length, quote, formatted };
    }
  }
  return allowUnterminated
    ? { literalStart: start, bodyStart, bodyEnd: source.length, end: source.length, quote, formatted }
    : undefined;
}

function closingParenthesis(source: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '"' || source[index] === "'" || source[index] === "f" || source[index] === "F") {
      const end = quotedString(source, index);
      if (end) {
        index = end.end - 1;
        continue;
      }
    }
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function argumentEnd(source: string, start: number, limit: number): number {
  let depth = 0;
  for (let index = start; index < limit; index += 1) {
    if (source[index] === '"' || source[index] === "'" || source[index] === "f" || source[index] === "F") {
      const value = quotedString(source, index);
      if (value) {
        index = value.end - 1;
        continue;
      }
    }
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (source[index] === "," && depth === 0) {
      return index;
    }
  }
  return limit;
}

function coreInputArguments(source: string): CoreInputArgument[] {
  const argumentsFound: CoreInputArgument[] = [];
  const calls = /\b(?:ask|agent)\s*\(/g;
  for (const match of source.matchAll(calls)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingParenthesis(source, open) ?? source.length;
    let index = open + 1;
    while (index < close) {
      while (/\s/.test(source[index] ?? "")) index += 1;
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))?.[0];
      if (!name) {
        index += 1;
        continue;
      }
      index += name.length;
      while (/\s/.test(source[index] ?? "")) index += 1;
      if (source[index] !== "=") continue;
      index += 1;
      while (/\s/.test(source[index] ?? "")) index += 1;
      const end = argumentEnd(source, index, close);
      const value = quotedString(source, index, name === "input" && end === source.length);
      if (name === "input") {
        argumentsFound.push({
          valueStart: index,
          valueEnd: end,
          ...(value ? { literal: value } : {})
        });
      }
      index = end + 1;
    }
  }
  return argumentsFound;
}

function coreInputArgument(source: string, from: number, to: number): CoreInputArgument | undefined {
  const candidates = coreInputArguments(source);
  return candidates.find((candidate) => {
    const regionStart = candidate.literal?.literalStart ?? candidate.valueStart;
    // Coordinates around atomic reference Chips may resolve to either quote
    // boundary or the closing parenthesis. Keep that whole input value
    // semantic so an attachment never falls back to a raw expression.
    return from >= regionStart && to <= candidate.valueEnd + 1;
  });
}

function inputReferenceText(expressions: readonly string[]): string {
  return expressions.join(" ");
}

/** Inserts readable @workspace/path tokens into ask/agent string input. */
export function coreInputReferenceInsertion(
  source: string,
  from: number,
  to: number,
  expressions: readonly string[]
): SourceReplacement | undefined {
  if (!expressions.length) return undefined;
  const argument = coreInputArgument(source, from, to);
  if (!argument) return undefined;
  const value = argument.literal;
  if (!value) {
    const inserted = `${inputReferenceText(expressions)} `;
    return {
      from: argument.valueStart,
      to: argument.valueEnd,
      text: `"${inserted}"`,
      cursorOffset: 1 + inserted.length
    };
  }
  const insertionFrom = Math.max(value.bodyStart, Math.min(from, value.bodyEnd));
  const insertionTo = Math.max(insertionFrom, Math.min(to, value.bodyEnd));
  const before = source.slice(value.bodyStart, insertionFrom);
  const after = source.slice(insertionTo, value.bodyEnd);
  const prefix = insertionFrom > value.bodyStart && needsInlinePrefix(source[insertionFrom - 1] ?? "") ? " " : "";
  // Keep the caret outside the following reference token. Without a trailing
  // separator, the next typed letter becomes part of the @path chip.
  const suffix = insertionTo < value.bodyEnd && needsInlineSuffix(source[insertionTo] ?? "")
    ? " "
    : insertionTo === value.bodyEnd ? " " : "";
  const inserted = inputReferenceText(expressions);
  const body = `${before}${prefix}${inserted}${suffix}${after}`;
  const literal = `${value.quote}${body}${value.quote}`;
  return {
    from: value.literalStart,
    to: value.end,
    text: literal,
    cursorOffset: value.quote.length + before.length + prefix.length + inserted.length + suffix.length
  };
}

/** Calculates the exact document change used by CodeMirror file attachment
 * drops. ask/agent input stays semantic; all other code retains the generic
 * inline-reference behavior. */
export function fileReferenceInsertion(
  source: string,
  from: number,
  to: number,
  expressions: readonly string[]
): SourceReplacement {
  const semantic = coreInputReferenceInsertion(source, from, to, expressions);
  if (semantic) return semantic;
  const inline = inlineInsertion(source, from, to, inputReferenceText(expressions));
  const separator = to === source.length && expressions.some((expression) => expression.startsWith("@")) ? " " : "";
  return {
    from,
    to,
    text: `${inline.text}${separator}`,
    cursorOffset: inline.cursorOffset + separator.length
  };
}
