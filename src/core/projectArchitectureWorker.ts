import type { ArchitectureScanResult } from "./projectArchitecture.js";
import { scanProjectArchitecture, type ArchitectureScanOptions } from "./projectArchitectureScanner.js";
import type { SourceFileInput } from "./projectArchitectureTypeScript.js";

export interface ArchitectureWorkerLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  /** Wall-clock budget for one scan. 0 disables the deadline. */
  maxDurationMs?: number;
  now?: () => number;
}

export interface ArchitectureScanCoverage {
  scannedFiles: number;
  skippedFiles: number;
  unparsedFiles: number;
  limitReached: boolean;
  /** Scan-wide limitations reported by a parser, such as unresolved project metadata. */
  notes: string[];
}

export interface ArchitectureWorkerOutcome {
  result: ArchitectureScanResult;
  cancelled: boolean;
  coverage: ArchitectureScanCoverage;
}

export interface ArchitectureScanTask {
  promise: Promise<ArchitectureWorkerOutcome>;
  cancel(): void;
}

const LIMIT_REASONS = ["File limit exceeded.", "File size limit exceeded.", "Scan time limit exceeded."];

function coverageOf(files: readonly SourceFileInput[], result: ArchitectureScanResult, cancelled: boolean): ArchitectureScanCoverage {
  const unparsed = result.unsupported.filter((entry) => !LIMIT_REASONS.includes(entry.reason));
  const skipped = result.unsupported.filter((entry) => LIMIT_REASONS.includes(entry.reason));
  return {
    scannedFiles: cancelled ? 0 : files.length - skipped.length,
    skippedFiles: skipped.length,
    unparsedFiles: unparsed.length,
    limitReached: cancelled || skipped.length > 0,
    notes: [...(result.coverage ?? [])]
  };
}

/** Runs one bounded scan synchronously. Callers that need cancellation use {@link startArchitectureScan}. */
export function runArchitectureScan(
  files: readonly SourceFileInput[],
  limits: ArchitectureWorkerLimits = {},
  signal?: AbortSignal
): ArchitectureWorkerOutcome {
  const now = limits.now ?? Date.now;
  const options: ArchitectureScanOptions = {
    ...(limits.maxFiles !== undefined ? { maxFiles: limits.maxFiles } : {}),
    ...(limits.maxFileBytes !== undefined ? { maxFileBytes: limits.maxFileBytes } : {}),
    ...(limits.maxDurationMs ? { deadline: now() + limits.maxDurationMs } : {}),
    ...(signal ? { signal } : {})
  };
  const result = scanProjectArchitecture(files, options);
  const cancelled = signal?.aborted === true;
  return { result, cancelled, coverage: coverageOf(files, result, cancelled) };
}

/**
 * Starts a cancellable scan. Cancellation is cooperative: it is observed at file boundaries and
 * the partial result is returned with `cancelled: true` rather than throwing.
 */
export function startArchitectureScan(files: readonly SourceFileInput[], limits: ArchitectureWorkerLimits = {}): ArchitectureScanTask {
  const controller = new AbortController();
  const promise = new Promise<ArchitectureWorkerOutcome>((resolve) => {
    // Defer so a caller can cancel before the synchronous scan starts.
    const run = (): void => resolve(runArchitectureScan(files, limits, controller.signal));
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else setTimeout(run, 0);
  });
  return { promise, cancel: () => controller.abort() };
}
