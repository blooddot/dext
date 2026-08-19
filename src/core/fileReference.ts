import type { Range } from "./types.js";

export interface DextFileReference {
  expression: string;
  payload: string;
}

export interface ParsedFileReference {
  path: string;
  range?: Range;
}

export interface FileReferenceOccurrence {
  start: number;
  end: number;
  expression: string;
  payload: string;
}

export interface ContextReferenceOccurrence extends FileReferenceOccurrence {
  kind: "file" | "dir" | "symbol" | "selection" | "activeFile";
}

/** A reference token is a readable workspace-relative file path. It is source
 * text, not a second input type: `@src/file.ts#L1,1-L2,1`. */
export interface InputReferenceProjection {
  reference: ContextReferenceOccurrence;
  interpolationStart: number;
  interpolationEnd: number;
}

export type InputReferenceDisplayPart =
  | { kind: "text"; value: string }
  | { kind: "ref"; reference: ContextReferenceOccurrence };

const RANGE_FRAGMENT = /#L(\d+),(\d+)-L(\d+),(\d+)$/;
const AT_TOKEN_CANDIDATE = /@[^\s@#"'`(){}[\],]+(?:#L\d+,\d+-L\d+,\d+)?/g;
const INPUT_REFERENCE_OPEN = "\uE000";
const INPUT_REFERENCE_CLOSE = "\uE001";

interface LegacyMarker {
  kind: "file" | "dir" | "symbol" | "selection" | "activeFile";
  payload: string;
}

function decodeReferenceString(value: string): string | undefined {
  let decoded = "";
  let escaped = false;
  for (const character of value) {
    if (!escaped) {
      if (character === "\\") escaped = true;
      else decoded += character;
      continue;
    }
    const replacement = ({ "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t" } as const)[character];
    if (replacement === undefined) return undefined;
    decoded += replacement;
    escaped = false;
  }
  return escaped ? undefined : decoded;
}

function comparePositions(left: Range["start"], right: Range["start"]): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}

export function parseFileReference(value: string): ParsedFileReference {
  const match = RANGE_FRAGMENT.exec(value);
  if (!match) return { path: value };
  const values = match.slice(1).map(Number);
  const [startLine, startCharacter, endLine, endCharacter] = values;
  if (
    startLine === undefined
    || startCharacter === undefined
    || endLine === undefined
    || endCharacter === undefined
    || values.some((entry) => !Number.isSafeInteger(entry) || entry < 1)
  ) {
    return { path: value };
  }
  const range: Range = {
    start: { line: startLine - 1, character: startCharacter - 1 },
    end: { line: endLine - 1, character: endCharacter - 1 }
  };
  if (comparePositions(range.start, range.end) > 0) {
    throw new Error("ref.file range start must not be after its end.");
  }
  return { path: value.slice(0, match.index), range };
}

function validWorkspaceRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[\p{L}\p{N}_.-]+$/u.test(segment))) return false;
  const name = segments.at(-1)!;
  // This rejects plain @mentions while allowing a root-level filename and a
  // nested workspace path. Dext attachments always point at a file.
  return segments.length > 1 || /\.[\p{L}\p{N}_-]+$/u.test(name);
}

/** Finds only legal readable @workspace/path#range references. The boundary
 * check intentionally rejects emails and ordinary @mentions. */
export function atReferenceOccurrences(source: string): ContextReferenceOccurrence[] {
  const values: ContextReferenceOccurrence[] = [];
  for (const match of source.matchAll(AT_TOKEN_CANDIDATE)) {
    const start = match.index ?? 0;
    const previous = source[start - 1] ?? "";
    if (previous && /[\p{L}\p{N}_.+-]/u.test(previous)) continue;
    const expression = match[0];
    if (!expression) continue;
    const payload = expression.slice(1);
    let parsed: ParsedFileReference;
    try {
      parsed = parseFileReference(payload);
    } catch {
      continue;
    }
    if (!validWorkspaceRelativePath(parsed.path)) continue;
    // Do not silently chip only the path portion of a malformed #range.
    if (source[start + expression.length] === "#") continue;
    values.push({ kind: "file", start, end: start + expression.length, expression, payload });
  }
  return values;
}

/** @deprecated Kept as a stable editor integration name. */
export function inputReferenceProjections(source: string): InputReferenceProjection[] {
  return atReferenceOccurrences(source).map((reference) => ({
    reference,
    interpolationStart: reference.start,
    interpolationEnd: reference.end
  }));
}

/** Presentation extracts real @tokens from readable source. Historical marker
 * data is normalized first so old entries remain viewable without generating
 * new private markers. */
export function inputReferenceDisplayParts(source: string): InputReferenceDisplayPart[] {
  const normalized = normalizeInputReferenceSource(source);
  const parts: InputReferenceDisplayPart[] = [];
  let cursor = 0;
  for (const occurrence of atReferenceOccurrences(normalized)) {
    if (cursor < occurrence.start) parts.push({ kind: "text", value: normalized.slice(cursor, occurrence.start) });
    parts.push({ kind: "ref", reference: occurrence });
    cursor = occurrence.end;
  }
  if (cursor < normalized.length || !parts.length) parts.push({ kind: "text", value: normalized.slice(cursor) });
  return parts;
}

export function inputReferenceDisplayText(source: string): string {
  return inputReferenceDisplayParts(source)
    .map((part) => part.kind === "text" ? part.value : compactFileReferenceLabel(part.reference.payload))
    .join("");
}

export function compactFileReferenceLabel(value: string): string {
  const parsed = parseFileReference(value);
  const normalized = parsed.path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) || normalized;
  if (!parsed.range) return name;
  const start = parsed.range.start.line + 1;
  const end = parsed.range.end.line + 1;
  return `${name} ${start === end ? start : `${start}-${end}`}`;
}

function parseLegacyMarkerPayload(value: string): LegacyMarker | undefined {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<LegacyMarker>;
    return (parsed.kind === "file" || parsed.kind === "dir" || parsed.kind === "symbol" || parsed.kind === "selection" || parsed.kind === "activeFile") && typeof parsed.payload === "string"
      ? { kind: parsed.kind, payload: parsed.payload }
      : undefined;
  } catch {
    return undefined;
  }
}

function legacyMarkerTokens(value: string): string {
  let normalized = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(INPUT_REFERENCE_OPEN, cursor);
    if (start < 0) return normalized + value.slice(cursor);
    normalized += value.slice(cursor, start);
    const end = value.indexOf(INPUT_REFERENCE_CLOSE, start + INPUT_REFERENCE_OPEN.length);
    if (end < 0) return normalized + value.slice(start);
    const marker = parseLegacyMarkerPayload(value.slice(start + INPUT_REFERENCE_OPEN.length, end));
    normalized += marker ? `@${marker.payload}` : value.slice(start, end + INPUT_REFERENCE_CLOSE.length);
    cursor = end + INPUT_REFERENCE_CLOSE.length;
  }
  return normalized;
}

/** Migrates only old ask/agent inline-reference encodings. New source is always
 * a normal string containing readable @path tokens. */
export function normalizeInputReferenceSource(source: string): string {
  let normalized = legacyMarkerTokens(source);
  normalized = normalized.replace(
    /(\b(?:ask|agent)\s*\([\s\S]*?\binput\s*=\s*)[fF](["'])((?:\\.|(?!\2)[\s\S])*?)\2/g,
    (whole, prefix: string, quote: string, body: string) => {
      if (!/\{\s*ref\.(?:file|dir|symbol)\s*\(|\{\s*ref\.(?:selection|active_file)\s*\}/.test(body)) return whole;
      const migrated = body
        .replace(/\{\s*ref\.(?:file|dir|symbol)\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*\)\s*\}/g,
          (_match: string, innerQuote: string, payload: string) => `@${decodeReferenceString(payload) ?? payload}`)
        .replace(/\{\s*ref\.selection\s*\}/g, "@selection")
        .replace(/\{\s*ref\.active_file\s*\}/g, "@active_file")
        .replace(/{{/g, "{")
        .replace(/}}/g, "}");
      return `${prefix}${quote}${migrated}${quote}`;
    }
  );
  // Repair the broken `input="text ref.file("path") text"` representation
  // produced by the previous drag/drop attempt. The scope is deliberately
  // limited to ask/agent input values.
  return normalized.replace(
    /(\b(?:ask|agent)\s*\([\s\S]*?\binput\s*=\s*)"([^"\\]*)\bref\.(?:file|dir|symbol)\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)([^"\\]*)"/g,
    (_whole, prefix: string, before: string, payload: string, after: string) => (
      `${prefix}"${before}@${decodeReferenceString(payload) ?? payload}${after}"`
    )
  );
}

export function formatDextFileReference(relativePath: string, range: Range): DextFileReference {
  const normalizedPath = relativePath.replaceAll("\\", "/");
  const fragment = `#L${range.start.line + 1},${range.start.character + 1}`
    + `-L${range.end.line + 1},${range.end.character + 1}`;
  const payload = `${normalizedPath}${fragment}`;
  return { payload, expression: `@${payload}` };
}

export function formatDextFilePathReference(relativePath: string): DextFileReference {
  const payload = relativePath.replaceAll("\\", "/");
  return { payload, expression: `@${payload}` };
}

export function formatDextDirectoryReference(relativePath: string): DextFileReference {
  const payload = relativePath.replaceAll("\\", "/");
  return { payload, expression: `@${payload}/` };
}
