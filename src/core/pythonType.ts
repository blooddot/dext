/**
 * Translate the Dext signature notation produced by `methodSignature.ts` into
 * Python annotations. The generated reference documents and editor hovers are
 * presented as Python, so TypeScript spellings must not leak into them:
 * optional members drop their `?` marker in favour of `| None`, `T[]` becomes
 * `list[T]`, and scalar names follow Python spellings.
 */

const SCALARS: Readonly<Record<string, string>> = {
  string: "str",
  boolean: "bool",
  number: "float",
  object: "dict",
  undefined: "None"
};

/** Split `source` on `separator` when it appears outside quotes and brackets. */
export function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function matchingBracket(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stringLiteral(source: string, start: number): number {
  const quote = source[start]!;
  let index = start + 1;
  while (index < source.length && !(source[index] === quote && source[index - 1] !== "\\")) index += 1;
  return Math.min(index + 1, source.length);
}

/** Consume every `[]` array suffix that follows `start`. */
function arraySuffix(source: string, start: number, base: string): { text: string; next: number } {
  let text = base;
  let next = start;
  while (source.startsWith("[]", next)) {
    text = `list[${text}]`;
    next += 2;
  }
  return { text, next };
}

/** Convert one `name?: type` shape member, keeping declaration order. */
export function pythonMember(member: string, objectAsDict = true): string {
  const match = /^\s*([A-Za-z_]\w*)(\?)?: ([\s\S]*?)\s*$/.exec(member);
  if (!match) return member.trim();
  return `${match[1]}: ${pythonType(match[3]!, objectAsDict)}${match[2] ? " | None" : ""}`;
}

/** Convert the members of a `{ ... }` shape, split on `;` or `,`. */
export function pythonShapeMembers(inner: string, objectAsDict = true): string[] {
  const separator = splitTopLevel(inner, ";").length > 1 ? ";" : ",";
  return splitTopLevel(inner, separator).map((member) => pythonMember(member, objectAsDict));
}

/**
 * Convert one Dext type expression to Python. `dict[str, object]` keeps the
 * Python meaning of `object` (any value) instead of collapsing to `dict`.
 */
export function pythonType(type: string, objectAsDict = true): string {
  let out = "";
  let index = 0;
  while (index < type.length) {
    const char = type[index]!;
    if (char === '"' || char === "'") {
      const end = stringLiteral(type, index);
      out += type.slice(index, end);
      index = end;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") {
      const close = char === "{" ? "}" : char === "(" ? ")" : "]";
      const end = matchingBracket(type, index, char, close);
      if (end < 0) {
        out += char;
        index += 1;
        continue;
      }
      const inner = type.slice(index + 1, end);
      const body = char === "{" ? `{ ${pythonShapeMembers(inner, objectAsDict).join(", ")} }` : `${char}${pythonType(inner, objectAsDict)}${close}`;
      const suffix = arraySuffix(type, end + 1, body);
      out += suffix.text;
      index = suffix.next;
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(type.slice(index));
    if (identifier) {
      const name = identifier[0];
      let next = index + name.length;
      const scalar = name === "object" && !objectAsDict ? "object" : SCALARS[name] ?? name;
      let converted = scalar;
      // The suffix loop keeps `Name[...]` subscripts and `[]` arrays in order,
      // so `dict[str, object]` and `dict[str, object][]` both survive intact.
      for (;;) {
        if (type.startsWith("[]", next)) {
          converted = `list[${converted}]`;
          next += 2;
          continue;
        }
        if (!type.startsWith("[", next)) break;
        const end = matchingBracket(type, next, "[", "]");
        if (end < 0) break;
        const inner = pythonType(type.slice(next + 1, end), name === "dict" ? false : objectAsDict);
        converted = `${converted}[${inner}]`;
        next = end + 1;
      }
      out += converted;
      index = next;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}
