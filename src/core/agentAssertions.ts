import { createHash } from "node:crypto";
import type { PatchChange, Range } from "./types.js";

/**
 * The workspace facts the result assertions need. The core module stays
 * hostless; `application.ts` implements this port with VS Code's workspace API
 * plus the workspace ignore rules.
 */
export interface AgentAssertionSnapshot {
  /** True when this run is allowed to write. Hard workspace-consistency
   * assertions are only enabled for preview runs (`apply=false`), where the
   * apply handler would otherwise fail later with a conflict. */
  apply: boolean;
  /** Maps a patch URI to a workspace-relative POSIX path, or undefined when
   * the URI is unparsable or outside the workspace. */
  resolve(uri: string): string | undefined;
  /** Reads the current content of a workspace-relative path. Undefined means
   * the file could not be read (for example, it does not exist yet). */
  read(relativePath: string): string | undefined | Promise<string | undefined>;
  /** Whether the path is excluded by the workspace ignore rules. */
  isIgnored(relativePath: string): boolean;
}

export interface AgentAssertionResult {
  /** Deterministic violations: the preview would be rejected by `apply`, so the
   * repair predictor must not retry around them. */
  hard: string[];
  /** Suggestions that can be fixed by another formatting attempt. */
  soft: string[];
}

/** Soft threshold for a single file. Copying an entire file to change one line
 * reports a diff far larger than this; the suggestion asks for a minimal edit. */
export const MAX_SOFT_DIFF_LINES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchChanges(result: unknown): PatchChange[] {
  if (!isRecord(result) || !isRecord(result.patch)) return [];
  const changes = result.patch.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter((change): change is PatchChange =>
    isRecord(change)
    && typeof change.uri === "string"
    && typeof change.before === "string"
    && typeof change.after === "string"
  );
}

function positionOffset(content: string, line: number, character: number): number | undefined {
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) return undefined;
  const lines = content.split(/\r?\n/);
  if (line > lines.length || (line === lines.length && character > 0)) return undefined;
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  const length = lines[line]?.length ?? 0;
  if (character > length) return undefined;
  return offset + character;
}

function rangeText(content: string, range: Range): string | undefined {
  const start = positionOffset(content, range.start.line, range.start.character);
  const end = positionOffset(content, range.end.line, range.end.character);
  if (start === undefined || end === undefined || end < start) return undefined;
  return content.slice(start, end);
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Number of lines between the common prefix and suffix of `before`/`after`.
 * This is a cheap approximation of a diff that flags whole-file rewrites
 * without running a full LCS over large files. */
export function changedLineSpan(before: string, after: string): number {
  const left = before.split(/\r?\n/);
  const right = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return (left.length - prefix - suffix) + (right.length - prefix - suffix);
}

/**
 * Evaluates the result-contract assertions for a candidate Agent result.
 *
 * Hard failures are only reported for preview runs; a write-enabled run cannot
 * repair a workspace conflict (the file may already have changed) and skips
 * them. Soft suggestions always run.
 */
export async function evaluate(
  result: unknown,
  snapshot: AgentAssertionSnapshot
): Promise<AgentAssertionResult> {
  const hard: string[] = [];
  const soft: string[] = [];
  for (const change of patchChanges(result)) {
    const path = snapshot.resolve(change.uri);
    if (path === undefined) {
      if (!snapshot.apply) hard.push(`Patch target '${change.uri}' is outside the current workspace.`);
      continue;
    }
    if (snapshot.isIgnored(path)) {
      if (!snapshot.apply) hard.push(`Patch target '${path}' is ignored by the workspace ignore rules.`);
      continue;
    }
    if (change.after === change.before) {
      soft.push(`Patch change for '${path}' has no effect; remove it or change the content.`);
    } else if (changedLineSpan(change.before, change.after) > MAX_SOFT_DIFF_LINES) {
      soft.push(`Patch change for '${path}' rewrites ${changedLineSpan(change.before, change.after)} lines; change only the necessary lines.`);
    }
    if (snapshot.apply) continue;
    const current = await snapshot.read(path);
    if (current === undefined) {
      if (change.before !== "") {
        hard.push(`'${path}' changed after the edit preview was created.`);
      }
      continue;
    }
    const expected = change.range ? rangeText(current, change.range) : current;
    if (expected === undefined) {
      hard.push(`Patch range is outside '${path}'.`);
      continue;
    }
    if (expected !== change.before) {
      hard.push(`'${path}' changed after the edit preview was created.`);
      continue;
    }
    if (change.contentHash && contentHash(expected) !== change.contentHash) {
      hard.push(`'${path}' no longer matches the edit preview.`);
    }
  }
  return { hard, soft };
}
