/** Gitignore-style matching for the files Dext must not send to a model. Only the
 * subset that appears in real ignore files is supported: comments, negation,
 * directory-only patterns, anchoring, `*`, `?`, and `**`. Extended globs and
 * character classes are treated literally rather than half-implemented. */
export interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  pattern: RegExp;
}

function escape(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Builds the matcher for one pattern line. An unanchored pattern matches at any
 * depth, which is what makes `node_modules` in a root ignore file work. */
function toRegExp(line: string): RegExp {
  const anchored = line.startsWith("/");
  const body = anchored ? line.slice(1) : line;
  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (character === "*") {
      if (body[index + 1] === "*") {
        // `**/` spans directories; a bare `**` behaves like `*` within a segment.
        if (body[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escape(character);
  }
  const prefix = anchored || body.includes("/") ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${source}(?:/.*)?$`);
}

export function parseIgnoreRules(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const withoutNegation = negated ? line.slice(1) : line;
    const directoryOnly = withoutNegation.endsWith("/");
    const pattern = directoryOnly ? withoutNegation.slice(0, -1) : withoutNegation;
    if (!pattern) continue;
    rules.push({ negated, directoryOnly, pattern: toRegExp(pattern) });
  }
  return rules;
}

/** Later rules win, which is how gitignore resolves a negation that re-includes
 * a path an earlier pattern excluded. */
export function isIgnored(rules: readonly IgnoreRule[], relativePath: string): boolean {
  const path = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  let ignored = false;
  for (const rule of rules) {
    // A directory-only rule can still exclude a file below it, which is why the
    // pattern allows a trailing path.
    if (!rule.pattern.test(path)) continue;
    ignored = !rule.negated;
  }
  return ignored;
}
