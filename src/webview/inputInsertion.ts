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

function quotedString(source: string, start: number): QuotedString | undefined {
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
  return undefined;
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

function coreInputString(source: string, from: number, to: number): QuotedString | undefined {
  const calls = /\b(?:ask|agent)\s*\(/g;
  for (const match of source.matchAll(calls)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingParenthesis(source, open);
    if (close === undefined) continue;
    let index = open + 1;
    let depth = 0;
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
      const value = quotedString(source, index);
      if (name === "input" && value && from >= value.bodyStart && to <= value.bodyEnd) return value;
      if (value) {
        index = value.end;
        continue;
      }
      for (; index < close; index += 1) {
        if (source[index] === '"' || source[index] === "'" || source[index] === "f" || source[index] === "F") {
          const end = quotedString(source, index);
          if (end) {
            index = end.end - 1;
            continue;
          }
        }
        if (source[index] === "(") depth += 1;
        else if (source[index] === ")") depth -= 1;
        else if (source[index] === "," && depth === 0) {
          index += 1;
          break;
        }
      }
    }
  }
  return undefined;
}

function interpolationText(expressions: readonly string[]): string {
  return expressions.map((expression) => `{${expression}}`).join(" ");
}

function escapedFormatLiteral(value: string): string {
  return value.replaceAll("{", "{{").replaceAll("}", "}}");
}

/** Converts only a ask/agent input literal at the insertion point.
 * Plain strings elsewhere remain literal text, even if they spell ref.file(). */
export function coreInputReferenceInsertion(
  source: string,
  from: number,
  to: number,
  expressions: readonly string[]
): SourceReplacement | undefined {
  if (!expressions.length) return undefined;
  const value = coreInputString(source, from, to);
  if (!value) return undefined;
  const relativeFrom = from - value.bodyStart;
  const before = source.slice(value.bodyStart, from);
  const after = source.slice(to, value.bodyEnd);
  const prefix = needsInlinePrefix(source[from - 1] ?? "") ? " " : "";
  const suffix = to === value.bodyEnd || !needsInlineSuffix(source[to] ?? "") ? "" : " ";
  const inserted = interpolationText(expressions);
  const body = value.formatted
    ? `${before}${prefix}${inserted}${suffix}${after}`
    : `${escapedFormatLiteral(before)}${prefix}${inserted}${suffix}${escapedFormatLiteral(after)}`;
  const literal = `f${value.quote}${body}${value.quote}`;
  return {
    from: value.literalStart,
    to: value.end,
    text: literal,
    cursorOffset: (value.bodyStart - value.literalStart) + (value.formatted ? 0 : 1)
      + (value.formatted ? relativeFrom : escapedFormatLiteral(before).length)
      + prefix.length + inserted.length
  };
}

function hasFormatReplacement(body: string): boolean {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "{") {
      if (body[index + 1] === "{") {
        index += 1;
        continue;
      }
      return true;
    }
    if (body[index] === "}") {
      if (body[index + 1] !== "}") return true;
      index += 1;
    }
  }
  return false;
}

/** When the final reference interpolation is removed, restore the concise
 * normal string form. Invalid f-strings intentionally remain untouched. */
export function normalizeCoreInputStrings(source: string): string {
  const replacements: SourceReplacement[] = [];
  const calls = /\b(?:ask|agent)\s*\(/g;
  for (const match of source.matchAll(calls)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const close = closingParenthesis(source, open);
    if (close === undefined) continue;
    const argumentsSource = source.slice(open + 1, close);
    const found = /\binput\s*=\s*/.exec(argumentsSource);
    if (!found) continue;
    const start = open + 1 + found.index + found[0].length;
    const value = quotedString(source, start);
    if (!value?.formatted || hasFormatReplacement(source.slice(value.bodyStart, value.bodyEnd))) continue;
    const body = source.slice(value.bodyStart, value.bodyEnd).replaceAll("{{", "{").replaceAll("}}", "}");
    replacements.push({
      from: value.literalStart,
      to: value.end,
      text: `${value.quote}${body}${value.quote}`,
      cursorOffset: 0
    });
  }
  return replacements.reduceRight((result, replacement) => (
    `${result.slice(0, replacement.from)}${replacement.text}${result.slice(replacement.to)}`
  ), source);
}
