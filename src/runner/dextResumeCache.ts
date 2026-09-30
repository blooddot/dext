/**
 * Call-level replay for Code runs.
 *
 * A run records every API call it makes — in order, with the arguments it used and
 * the response it received. When the user retries after a failure, those recordings
 * are handed back to a fresh kernel: a call whose (index, method, arguments) still
 * matches returns the recorded response instead of running again, so the work that
 * already succeeded is not repeated.
 *
 * This is the durable-execution model Temporal-style: replay only works while the
 * calls line up. Anything the recording cannot see — `Date.now()`, `Math.random()`,
 * `process.env`, a direct `fs` read — can make the second run take a different path,
 * and then the recorded responses would be attached to the wrong calls. That case is
 * a hard error, never a silent reuse.
 *
 * `src/runner/dextRuntime.mjs` implements the matching half in the kernel; the two
 * digests must agree, and `test/dextResume.test.ts` proves it by replaying a real run.
 */

export interface DextReplayEntry {
  method: string;
  arguments: Record<string, unknown>;
  response: unknown;
}

export const CHANGED_SINCE_STOPPED =
  "The Code file or a value it reads changed since it stopped, so the recorded calls no longer line up. Retry to run it from the start.";

export class DextReplayMismatchError extends Error {
  readonly code = "CHANGED_SINCE_STOPPED";

  constructor(message = CHANGED_SINCE_STOPPED) {
    super(message);
    this.name = "DextReplayMismatchError";
  }
}

/** JSON with sorted object keys, so two equal argument objects always hash alike. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Identity of one call: the same call in two runs has the same fingerprint. */
export function replayFingerprint(method: string, args: unknown): string {
  return `${method}(${stableStringify(args)})`;
}

/** What one attempt recorded, plus what a retry should replay. */
export class DextResumeCache {
  private readonly recorded: DextReplayEntry[] = [];

  constructor(private readonly replayEntries: readonly DextReplayEntry[] = []) {}

  /** Responses from the previous attempt, in call order. */
  get replay(): readonly DextReplayEntry[] {
    return this.replayEntries;
  }

  /** Calls this attempt actually performed, in call order. */
  get entries(): readonly DextReplayEntry[] {
    return this.recorded;
  }

  record(method: string, args: Record<string, unknown>, response: unknown): void {
    this.recorded.push({ method, arguments: args, response });
  }

  /** One line per call, for diagnostics; never contains response payloads. */
  describe(): string {
    return this.recorded.map((entry, index) => `${index + 1}. ${replayFingerprint(entry.method, entry.arguments)}`).join("\n");
  }
}
