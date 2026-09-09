import type { MemoryBucket } from "./completionMemory.js";
import { fingerprint } from "./completionContext.js";

export function adaptationKey(scope: string, language: string, singleLine: boolean): string {
  return fingerprint(JSON.stringify([scope, language, singleLine ? "line" : "block"]));
}
export function adaptationPolicy(bucket: MemoryBucket) {
  const samples = bucket.retained + bucket.undone + bucket.modified;
  if (samples < 20) return { examples: 1, output: 1, samples };
  // A bounded heuristic over observable outcomes, not an acceptance probability.
  const adjustment = Math.max(-0.2, Math.min(0.2, (bucket.retained - 2 * bucket.undone - bucket.modified) / (samples + 20) * 0.2));
  return { examples: 1 + adjustment, output: 1 + adjustment, samples };
}
