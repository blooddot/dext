import type { CompletionBackend, CompletionOutcome } from "./completionBackend.js";
import type { CompletionRequest, CompletionSettings } from "./completionProvider.js";
import { assembleContext, completionExampleSnippet, fingerprint, type CompletionSnippet } from "./completionContext.js";
import { completionCandidate, scoreCompletion } from "./completionCandidate.js";
import { completionBudget } from "./completionProfiles.js";
import { adaptationKey, adaptationPolicy } from "./completionAdaptation.js";
import { CompletionMemory } from "./completionMemory.js";

export interface CompletionQualityCase extends CompletionRequest {
  id: string;
  category: string;
  expected: string[];
  reply: string;
  related?: CompletionSnippet[];
}
export interface CompletionSequence {
  id: string; root: string; scope: string; later: string;
  feedback: string[]; restart?: boolean; clear?: boolean;
  evaluateRoot?: string; evaluateScope?: string;
  sources?: { path: string; text: string; currentText?: string; ignored?: boolean }[];
}
export interface EvaluationRow {
  id: string; category: string; outcome: CompletionOutcome;
  score: ReturnType<typeof scoreCompletion> | "failed";
  candidate: string; modelText: string; elapsedMs: number; inputChars: number;
  round?: number; mode?: "off" | "session" | "workspace"; sequence?: string;
}

/** Shared with the CLI and the editor. Credentials belong to the injected backend. */
export async function evaluateCompletionCase(backend: CompletionBackend, settings: CompletionSettings,
  test: CompletionQualityCase, policy = { examples: 1, output: 1 }, signal?: AbortSignal): Promise<EvaluationRow> {
  const at = performance.now();
  const request = assembleContext({ ...test, uri: "file:///fixture/current.ts", workspace: "file:///fixture", backendScope: settings.model },
    (test.related ?? []).map((snippet) => ({ ...snippet, score: snippet.score * (snippet.kind === "example" ? policy.examples : 1) })), settings);
  const result = await backend.generate({ ...settings, maxTokens: completionBudget(settings, request, policy.output) }, request, signal);
  const candidate = completionCandidate(result.text, request);
  return { id: test.id, category: test.category, outcome: result.outcome,
    score: result.outcome === "success" || result.outcome === "empty" ? scoreCompletion(test, candidate, test.expected) : "failed",
    candidate: candidate?.text ?? "", modelText: result.text, elapsedMs: performance.now() - at,
    inputChars: request.prefix.length + request.suffix.length + (request.context?.length ?? 0) };
}

export interface EvaluationOptions {
  backend: CompletionBackend;
  settings: CompletionSettings;
  cases: readonly CompletionQualityCase[];
  sequences?: readonly CompletionSequence[];
  kind: "quality" | "performance" | "adaptation";
  repeat: number;
  signal?: AbortSignal;
  onRow?: (row: EvaluationRow, total: number) => void;
}

export function evaluationSampleCount(options: Pick<EvaluationOptions, "repeat" | "kind" | "cases" | "sequences">): number {
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 1000) throw new Error("Evaluation repeat must be between 1 and 1000.");
  if (!options.cases.length || (options.kind === "adaptation" && !options.sequences?.length)) throw new Error("Evaluation cases are missing.");
  const count = options.repeat * (options.kind === "performance" ? 1 : options.kind === "adaptation" ? options.sequences!.length * 3 : options.cases.length);
  if (count > 1000) throw new Error("Evaluation exceeds the 1000-request limit.");
  return count;
}

/** Isolated evaluation stores never read, train, clear or overwrite the user's memory. */
export function evaluationSequenceContext(sequence: CompletionSequence, mode: "off" | "session" | "workspace", model: string, test: CompletionQualityCase) {
  const data = new Map<string, unknown>();
  const store = { get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined, update: (key: string, value: unknown) => { data.set(key, structuredClone(value)); return Promise.resolve(); } };
  let memory = new CompletionMemory(store, mode, () => 1_000_000);
  return (async () => {
    try {
      const key = adaptationKey(sequence.scope + model, "typescript", true);
      for (const signal of sequence.feedback) {
        if (signal !== "retained" && signal !== "undone" && signal !== "modified") throw new Error("Invalid evaluation feedback.");
        memory.record(sequence.root, key, signal);
      }
      for (const source of sequence.sources ?? []) memory.addExample(sequence.root, {
        path: source.path, offset: 0, length: source.text.length, hash: fingerprint(source.text), updated: 1_000_000
      });
      await memory.flush();
      if (sequence.restart) { memory.dispose(); memory = new CompletionMemory(store, mode, () => 1_000_000); }
      if (sequence.clear) await memory.clear(sequence.root);
      const root = sequence.evaluateRoot ?? sequence.root;
      const examples = memory.examples(root).slice(0, 4).flatMap((reference) => {
        const source = sequence.sources?.find((item) => item.path === reference.path);
        if (!source || source.ignored) return [];
        const snippet = completionExampleSnippet(reference, (source.currentText ?? source.text).slice(reference.offset, reference.offset + reference.length), test,
          `file:///fixture/${reference.path}`, 1);
        return snippet ? [snippet] : [];
      });
      return { policy: adaptationPolicy(memory.bucket(root,
        adaptationKey((sequence.evaluateScope ?? sequence.scope) + model, "typescript", true))), examples };
    } finally { memory.dispose(); }
  })();
}

export async function runCompletionEvaluation(options: EvaluationOptions) {
  const planned = evaluationSampleCount(options);
  // Validate references before spending any requests.
  if (options.kind === "adaptation") for (const sequence of options.sequences!) {
    if (!options.cases.some((item) => item.id === sequence.later)) throw new Error("Unknown held-out evaluation case.");
    if (sequence.feedback.some((item) => !["retained", "undone", "modified"].includes(item))) throw new Error("Invalid evaluation feedback.");
  }
  const rows: EvaluationRow[] = [];
  let stopReason = "complete";
  let consecutiveErrors = 0;
  const run = async (test: CompletionQualityCase, round: number, sequence?: CompletionSequence, mode?: "off" | "session" | "workspace") => {
    if (options.signal?.aborted) { stopReason = "cancelled"; return false; }
    const learned = sequence && mode ? await evaluationSequenceContext(sequence, mode, options.settings.model, test) : undefined;
    const startedAt = performance.now();
    let row: EvaluationRow;
    try {
      row = await evaluateCompletionCase(options.backend, options.settings,
        learned ? { ...test, related: [...(test.related ?? []), ...learned.examples] } : test, learned?.policy, options.signal);
    } catch {
      // Backend adapters are expected to return outcomes, but a thrown failure
      // must still count as an attempted sample and must never expose raw errors.
      row = { id: test.id, category: test.category, outcome: options.signal?.aborted ? "cancelled" : "error",
        score: "failed", candidate: "", modelText: "", elapsedMs: performance.now() - startedAt, inputChars: 0 };
    }
    Object.assign(row, { round }, sequence && mode ? { sequence: sequence.id, mode } : {});
    rows.push(row); options.onRow?.(row, planned);
    if (["unauthenticated", "rate_limited", "unavailable", "cancelled"].includes(row.outcome)) {
      stopReason = row.outcome; return false;
    }
    consecutiveErrors = row.outcome === "error" ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 3) { stopReason = "consecutive_errors"; return false; }
    return true;
  };
  outer: for (let round = 0; round < options.repeat; round++) {
    if (options.kind === "adaptation") {
      for (const sequence of options.sequences!) {
        const modes = ["off", "session", "workspace"] as const;
        // Rotate order to reduce backend drift; each mode starts from independent state.
        for (let offset = 0; offset < modes.length; offset++) {
          if (!await run(options.cases.find((item) => item.id === sequence.later)!, round, sequence, modes[(round + offset) % 3])) break outer;
        }
      }
    } else {
      const cases = options.kind === "performance" ? [options.cases[round % options.cases.length]!] : options.cases;
      for (const test of cases) if (!await run(test, round)) break outer;
    }
  }
  return { planned, attempted: rows.length, stopReason, rows, summaries: summarizeEvaluation(rows),
    limitation: "Exact-edit fixture scoring requires review. Recorded weak feedback is replayed; this alone does not establish learning benefit. Timing excludes editor display." };
}

export function summarizeEvaluation(rows: readonly EvaluationRow[]) {
  const groups = [...new Set(rows.map((row) => row.mode ?? "current"))];
  return groups.map((mode) => {
    const samples = rows.filter((row) => (row.mode ?? "current") === mode);
    const times = samples.map((row) => row.elapsedMs).sort((a, b) => a - b);
    return { mode, samples: samples.length,
      counts: Object.fromEntries(["valid", "wrong", "empty", "missed", "failed"].map((score) => [score, samples.filter((row) => row.score === score).length])),
      p50Ms: times[Math.ceil(times.length * .5) - 1] ?? null, p95Ms: times[Math.ceil(times.length * .95) - 1] ?? null };
  });
}
