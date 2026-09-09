import { randomUUID } from "node:crypto";
import type { CompletionRequest } from "./completionProvider.js";

export interface CompletionCandidate {
  id: string;
  text: string;
  replaceBefore: number;
  replaceAfter: number;
  original: string;
}

/** Deterministic fixture scoring checks the complete edited result, not a keyword. */
export function scoreCompletion(request: CompletionRequest, candidate: CompletionCandidate | undefined, expected: readonly string[]): "valid" | "wrong" | "empty" | "missed" {
  const original = request.prefix + request.suffix;
  if (!candidate) return expected.includes(original) ? "empty" : "missed";
  const applied = request.prefix.slice(0, request.prefix.length - candidate.replaceBefore) + candidate.text + request.suffix.slice(candidate.replaceAfter);
  return expected.includes(applied) ? "valid" : "wrong";
}
export function completionCandidate(text: string, request: CompletionRequest): CompletionCandidate | undefined {
  if (!text.trim() || text.length > 32_768 || /<\/?(?:before|after)_cursor>/.test(text)
    || /^\s*(?:Here(?:'s| is)|Sure[,!]|I (?:cannot|can't)|Explanation:)/i.test(text)) return undefined;
  let value = text;
  const head = /[\p{L}\p{N}_$]/u.test(request.prefix.at(-1) ?? "")
    ? /[\p{L}\p{N}_$]+$/u.exec(request.prefix.slice(-256))?.[0] ?? "" : "";
  const tail = /^[\p{L}\p{N}_$]+/u.exec(request.suffix.slice(0, 256))?.[0] ?? "";
  // Chat models sometimes return the whole identifier rather than its missing tail.
  if (head.length > 1 && value.startsWith(head) && /^[\p{L}\p{N}_$]+/u.test(value)) value = value.slice(head.length);
  if (!value.trim()) return undefined;
  const firstLine = value.split("\n")[0]!;
  let replaceAfter = 0;
  if (tail && /^[\p{L}\p{N}_$]+/u.test(firstLine)) {
    const word = /^[\p{L}\p{N}_$]+/u.exec(firstLine)![0];
    if (word.endsWith(tail)) replaceAfter = tail.length;
  }
  if (value === request.suffix.slice(0, replaceAfter)) return undefined;
  return { id: randomUUID(), text: head + value, replaceBefore: head.length, replaceAfter,
    original: head + request.suffix.slice(0, replaceAfter) };
}
