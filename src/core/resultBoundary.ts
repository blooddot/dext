import type { z } from "zod";

/**
 * The single tolerant boundary between raw Agent text and a Dext result.
 *
 * CLI providers are instructed to return JSON-only, but models still add
 * narration, markdown fences, or trailing commentary. This module accepts those
 * wrappers without weakening the contract: every candidate must parse as a JSON
 * object, and the runtime still validates the object against zod afterwards.
 */
export interface AgentResultCandidate {
  value: Record<string, unknown>;
  /** Where the candidate came from, for diagnostics only. */
  source: "whole" | "fence" | "brace";
}

interface TextCandidate {
  text: string;
  source: AgentResultCandidate["source"];
}

function balancedObjects(text: string): string[] {
  const candidates: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function textCandidates(text: string): TextCandidate[] {
  const trimmed = text.trim();
  const candidates: TextCandidate[] = [];
  if (trimmed) candidates.push({ text: trimmed, source: "whole" });
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/gi)) {
    if (match[1]?.trim()) candidates.push({ text: match[1].trim(), source: "fence" });
  }
  for (const object of balancedObjects(trimmed)) candidates.push({ text: object, source: "brace" });
  return candidates;
}

/** Text itself, every fenced block, then every balanced object starting at each
 * `{`. Trying each `{` fixes the old scanners that only inspected the first. */
export function jsonCandidates(text: string): string[] {
  return [...new Set(textCandidates(text).map((candidate) => candidate.text))];
}

function parseObject(candidate: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** All JSON objects found in the text, in candidate order and without
 * duplicates. */
export function agentResultCandidates(raw: string): AgentResultCandidate[] {
  const found: AgentResultCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of textCandidates(raw)) {
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    const value = parseObject(candidate.text);
    if (value) found.push({ value, source: candidate.source });
  }
  return found;
}

export interface ParseAgentResultOptions {
  /** Optional diagnostics sink; called once when several matching candidates
   * exist and the last one wins. */
  onDiagnostic?: (message: string) => void;
}

/**
 * Picks the result object for `kind` from any raw Agent text.
 *
 * - objects pass through unchanged;
 * - strings are scanned for wrapping narration/fences;
 * - the first object whose `kind` matches (or that has no `kind`) wins as soon
 *   as it is structurally valid;
 * - when several objects carry the same matching `kind` (or none does), the
 *   last one wins because the final answer normally sits at the end of the
 *   message.
 *
 * Returns `undefined` when no JSON object can be recovered; zod validation
 * stays with the caller so it can produce structured diagnostics.
 */
export function parseAgentResult(
  kind: string,
  raw: unknown,
  options: ParseAgentResultOptions = {}
): Record<string, unknown> | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return undefined;
  const matches = agentResultCandidates(raw).filter((candidate) => {
    const candidateKind = candidate.value.kind;
    return candidateKind === undefined || candidateKind === kind;
  });
  if (!matches.length) return undefined;
  const withKind = matches.filter((candidate) => candidate.value.kind === kind);
  const pool = withKind.length ? withKind : matches;
  if (pool.length > 1) {
    options.onDiagnostic?.(
      `Agent output contained ${pool.length} candidates for kind '${kind}'; using the last one.`
    );
  }
  return pool[pool.length - 1]!.value;
}

const MAX_DIAGNOSTIC_CHARS = 400;
const MAX_DIAGNOSTIC_ISSUES = 8;

/** Formats zod issues as `path: message`, bounded in both count and length so a
 * fixing prompt cannot be flooded by a pathological schema. */
export function formatDiagnostics(error: unknown): string {
  const issues = extractIssues(error);
  if (!issues.length) return error instanceof Error ? error.message : String(error);
  const lines = issues.slice(0, MAX_DIAGNOSTIC_ISSUES).map((issue) => {
    const path = issue.path?.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  let text = lines.join("\n");
  const more = issues.length > MAX_DIAGNOSTIC_ISSUES
    ? `... and ${issues.length - MAX_DIAGNOSTIC_ISSUES} more issue(s).`
    : "";
  if (text.length > MAX_DIAGNOSTIC_CHARS) {
    const suffix = more ? `\n${more}` : "...";
    text = `${text.slice(0, Math.max(0, MAX_DIAGNOSTIC_CHARS - suffix.length))}${suffix}`;
    return text;
  }
  return more ? `${text}\n${more}` : text;
}

function extractIssues(error: unknown): { path?: readonly (string | number | symbol)[]; message: string }[] {
  if (typeof error !== "object" || error === null) return [];
  const record = error as { issues?: unknown };
  if (!Array.isArray(record.issues)) return [];
  return record.issues.filter((issue): issue is { path?: readonly (string | number | symbol)[]; message: string } =>
    typeof issue === "object" && issue !== null && typeof (issue as { message?: unknown }).message === "string"
  );
}

/** Non-throwing zod validation used by callers that need a diagnostic string
 * rather than an exception (workflowRuntime, result repair assertions). */
export function safeValidate<T extends z.ZodType>(
  schema: T,
  value: unknown
): { success: true; data: z.infer<T> } | { success: false; diagnostics: string } {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { success: true, data: parsed.data }
    : { success: false, diagnostics: formatDiagnostics(parsed.error) };
}
