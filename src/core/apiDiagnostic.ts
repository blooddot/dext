/** Offsets are UTF-16, zero-based, end-exclusive positions in the original file. */
export interface DextDiagnostic {
  path: string;
  apiId?: string;
  severity: "error" | "warning";
  code: string;
  message: string;
  from: number;
  to: number;
}

export class ApiSourceError extends Error {
  constructor(message: string, readonly from: number, readonly to: number, readonly code = "dext/signature") {
    super(message);
  }
}

/** One-based line and column for a file offset, so every surface reports the
 * same coordinates the editor's squiggle uses. */
export function diagnosticPosition(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, Math.max(0, Math.min(offset, source.length)));
  return { line: prefix.split("\n").length, column: prefix.length - prefix.lastIndexOf("\n") };
}

/**
 * The single plain-text rendering of a diagnostic. Problems, the Output
 * channel, resource validation and a failed API call all print this, so a
 * position is never lost by a consumer that only received `message`.
 *
 * `source` is the file the offsets came from. Without it the position is
 * omitted rather than guessed.
 */
export function formatDiagnostic(diagnostic: DextDiagnostic, source?: string): string {
  const location = source === undefined
    ? ""
    : (() => { const { line, column } = diagnosticPosition(source, diagnostic.from); return `:${line}:${column}`; })();
  return `${diagnostic.path}${location}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
}

/** A stable key for de-duplicating diagnostics that several roots produce. */
export function diagnosticKey(diagnostic: DextDiagnostic): string {
  return `${diagnostic.path}:${diagnostic.from}:${diagnostic.to}:${diagnostic.code}:${diagnostic.message}`;
}

/** Preserve a boundary map through dedenting, CRLF normalization and trimming. */
export function apiBodySource(value: string, fileOffset: number): { source: string; offset: (position: number) => number } {
  const prefix = /^\s*:\s*\r?\n/.exec(value)?.[0].length ?? 0;
  const lines = value.slice(prefix).split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const indent = nonEmpty.length ? Math.min(...nonEmpty.map((line) => /^\s*/.exec(line)![0].length)) : 0;
  const positions: number[] = [];
  let source = "";
  let cursor = prefix;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const removed = Math.min(indent, line.length);
    for (let column = removed; column < line.length; column += 1) {
      positions.push(fileOffset + cursor + column);
      source += line[column];
    }
    cursor += line.length;
    if (index < lines.length - 1) {
      positions.push(fileOffset + cursor);
      source += "\n";
      cursor += value[cursor] === "\r" ? 2 : 1;
    }
  }
  positions.push(fileOffset + cursor);
  const start = source.length - source.trimStart().length;
  const end = source.trimEnd().length;
  return {
    source: source.trim(),
    offset: (position) => positions[Math.min(Math.max(start, start + position), Math.max(start, end))] ?? fileOffset
  };
}
