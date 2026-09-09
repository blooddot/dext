import type { CompletionRequest, CompletionSettings } from "./completionProvider.js";

export function completionBudget(settings: CompletionSettings, request: CompletionRequest, multiplier = 1): number {
  const desired = request.singleLine ? 48 : 128;
  return Math.max(1, Math.min(settings.maxTokens, Math.floor(desired * Math.min(1.2, Math.max(0.8, multiplier)))));
}

export const SUFFIX_PROBES: CompletionRequest[] = [
  { prefix: "const result = config.", suffix: ";\n// config has only the field enabled\n", singleLine: true },
  { prefix: "const result = config.", suffix: ";\n// config has only the field retries\n", singleLine: true }
];

export function suffixEvidence(replies: string[]): string {
  if (replies.length !== 2 || replies.some((reply) => !reply.trim())) return "inconclusive";
  return /^enabled\b/.test(replies[0]!) && /^retries\b/.test(replies[1]!)
    ? "observed suffix dependence" : "suffix dependence not observed";
}
