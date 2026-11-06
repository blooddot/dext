import { parse as parseYaml } from "yaml";

/** The split of a Markdown document into optional YAML front matter and body.
 * Shared by SKILL.md and command templates so both understand folded (`>`)
 * and quoted scalars instead of a line regex. */
export interface FrontMatter {
  present: boolean;
  /** The raw YAML text, empty when there is no front matter. */
  source: string;
  /** Parsed mapping; empty when absent or invalid. */
  data: Record<string, unknown>;
  /** The document after the closing delimiter. */
  body: string;
  diagnostics: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Parses the leading `---` block of a Markdown file. A malformed block is a
 * diagnostic, never a thrown error: the caller decides whether the skill is
 * still installable from its body. */
export function splitFrontMatter(source: string): FrontMatter {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) {
    return { present: false, source: "", data: {}, body: text, diagnostics: [] };
  }
  const end = /^(?:---|\.\.\.)[ \t]*$/m.exec(text.slice(4));
  if (!end) {
    return {
      present: true,
      source: text.slice(4),
      data: {},
      body: "",
      diagnostics: ["Front matter is not closed by a --- line."]
    };
  }
  const yamlSource = text.slice(4, 4 + end.index).replace(/\n$/, "");
  const body = text.slice(4 + end.index + end[0].length).replace(/^\n/, "");
  try {
    const parsed: unknown = parseYaml(yamlSource);
    if (parsed === null || parsed === undefined) {
      return { present: true, source: yamlSource, data: {}, body, diagnostics: [] };
    }
    const data = record(parsed);
    if (!data) {
      return {
        present: true,
        source: yamlSource,
        data: {},
        body,
        diagnostics: ["Front matter must be a YAML mapping."]
      };
    }
    return { present: true, source: yamlSource, data, body, diagnostics: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Command and skill authors commonly write an unquoted description with a
    // colon, which YAML reads as a nested mapping. Those simple `key: value`
    // headers are still safe to read; anything more complex stays invalid.
    if (/Nested mappings are not allowed|mapping values are not allowed/i.test(message)) {
      const loose = looseFrontMatter(yamlSource);
      if (loose) return { present: true, source: yamlSource, data: loose, body, diagnostics: [] };
    }
    return {
      present: true,
      source: yamlSource,
      data: {},
      body,
      diagnostics: [`Invalid YAML front matter: ${message}`]
    };
  }
}

/** Top-level scalar lines only. Indented YAML is refused so a malformed block
 * cannot be mistaken for a parsed one. */
function looseFrontMatter(source: string): Record<string, string> | undefined {
  const data: Record<string, string> = {};
  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) return undefined;
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match) return undefined;
    let value = match[2]!.trim();
    if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value) data[match[1]!] = value;
  }
  return Object.keys(data).length ? data : undefined;
}

/** A scalar front-matter field. Lists, mappings and numbers are not valid
 * `name`/`description` values even though YAML accepts them. */
function scalar(data: Record<string, unknown>, key: string, diagnostics: string[]): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    diagnostics.push(`Front matter '${key}' must be a string, not ${typeof value}.`);
    return undefined;
  }
  diagnostics.push(`Front matter '${key}' must be a single string value.`);
  return undefined;
}

function heading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

/** The first ordinary paragraph, used when front matter has no description.
 * Headings, list items, quotes and fences are not descriptions. */
function paragraph(body: string): string | undefined {
  const lines = body.split("\n");
  let collecting = false;
  const parts: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (collecting) break;
      continue;
    }
    if (/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>|```|~~~|\|)/.test(line)) {
      if (collecting) break;
      continue;
    }
    collecting = true;
    parts.push(line);
  }
  return parts.length ? parts.join(" ") : undefined;
}

export interface SkillMetadata {
  title: string;
  description: string;
  body: string;
  frontMatter: Record<string, unknown>;
  hasFrontMatter: boolean;
  name?: string;
  license?: string;
  diagnostics: string[];
}

/** Reads SKILL.md metadata. Folded and quoted scalars are YAML values, so
 * `description: >` no longer renders as a literal `>`. */
export function parseSkillMetadata(source: string, fallback: string): SkillMetadata {
  const frontMatter = splitFrontMatter(source);
  const diagnostics = [...frontMatter.diagnostics];
  let name = scalar(frontMatter.data, "name", diagnostics);
  let described = scalar(frontMatter.data, "description", diagnostics);
  const license = scalar(frontMatter.data, "license", diagnostics);
  // Older Dext skills used bare `name:`/`description:` lines without the
  // delimiters. Keep reading those, but never let them override real front
  // matter or an H1.
  if (!frontMatter.present) {
    name ??= /^\s*name\s*:\s*["']?(.+?)["']?\s*$/mi.exec(source)?.[1]?.trim() || undefined;
    described ??= /^\s*description\s*:\s*["']?(.+?)["']?\s*$/mi.exec(source)?.[1]?.trim() || undefined;
  }
  const title = name ?? heading(frontMatter.body) ?? fallback;
  const description = described ?? paragraph(frontMatter.body) ?? "Standard project skill.";
  return {
    title,
    description,
    body: frontMatter.body.trim(),
    frontMatter: frontMatter.data,
    hasFrontMatter: frontMatter.present,
    ...(name ? { name } : {}),
    ...(license ? { license } : {}),
    diagnostics
  };
}
