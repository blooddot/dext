import type { ArchitectureScanResult } from "./core/projectArchitecture.js";
import { KnowledgeDraftQueue, type KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";

export type ProjectInitializationStatus = "idle" | "running" | "completed" | "cancelled" | "failed";

export interface ProjectInitializationState {
  status: ProjectInitializationStatus;
  startedAt?: number;
  finishedAt?: number;
  /** False when the AI proposer was unavailable; the project still works without drafts. */
  aiAvailable: boolean;
  drafts: number;
  scannedFiles: number;
  error?: string;
}

export interface ProjectInitializationDependencies {
  scan(): Promise<ArchitectureScanResult>;
  propose?(scan: ArchitectureScanResult): Promise<KnowledgeSuggestion[]>;
  now?: () => number;
}

export interface ProjectInitializationTask {
  promise: Promise<ProjectInitializationState>;
  cancel(): void;
}

/**
 * Runs the non-blocking `Initialize Knowledge` flow: index and scan sources, then queue AI drafts.
 * Cancelling, failing, or missing AI never blocks development; a retry starts a clean run.
 */
export class ProjectInitializationService {
  private state: ProjectInitializationState = { status: "idle", aiAvailable: true, drafts: 0, scannedFiles: 0 };
  private controller: AbortController | undefined;
  private readonly now: () => number;

  constructor(
    private readonly dependencies: ProjectInitializationDependencies,
    private readonly queue: KnowledgeDraftQueue = new KnowledgeDraftQueue()
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  get snapshot(): ProjectInitializationState {
    return { ...this.state };
  }

  /** Idempotent while running: the same in-flight task is returned instead of a second scan. */
  start(): ProjectInitializationTask {
    if (this.controller && this.state.status === "running") {
      return { promise: Promise.resolve(this.snapshot), cancel: () => this.cancel() };
    }
    const controller = new AbortController();
    this.controller = controller;
    this.state = { status: "running", startedAt: this.now(), aiAvailable: true, drafts: 0, scannedFiles: 0 };
    const promise = this.run(controller.signal);
    return { promise, cancel: () => this.cancel() };
  }

  cancel(): void {
    this.controller?.abort();
    if (this.state.status === "running") this.state = { ...this.state, status: "cancelled", finishedAt: this.now() };
  }

  retry(): ProjectInitializationTask {
    this.cancel();
    return this.start();
  }

  private async run(signal: AbortSignal): Promise<ProjectInitializationState> {
    try {
      const scan = await this.dependencies.scan();
      if (signal.aborted) {
        this.state = { ...this.state, status: "cancelled", finishedAt: this.now() };
        return this.snapshot;
      }
      let aiAvailable = true;
      if (this.dependencies.propose) {
        try {
          const drafts = await this.dependencies.propose(scan);
          if (signal.aborted) {
            this.state = { ...this.state, status: "cancelled", finishedAt: this.now() };
            return this.snapshot;
          }
          for (const draft of drafts) this.queue.enqueue(draft);
        } catch {
          // An unavailable or failing AI proposer degrades to facts only.
          aiAvailable = false;
        }
      }
      this.state = {
        status: "completed",
        ...(this.state.startedAt !== undefined ? { startedAt: this.state.startedAt } : {}),
        finishedAt: this.now(),
        aiAvailable,
        drafts: this.queue.list().length,
        scannedFiles: scan.modules.length
      };
      return this.snapshot;
    } catch (error) {
      this.state = {
        status: "failed",
        ...(this.state.startedAt !== undefined ? { startedAt: this.state.startedAt } : {}),
        finishedAt: this.now(),
        aiAvailable: false,
        drafts: this.queue.list().length,
        scannedFiles: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      return this.snapshot;
    }
  }
}

export interface ProjectScanSchedulerOptions {
  /** File events within this window are merged into one scan. */
  debounceMs?: number;
  /** Upper bound on scans started per window, so keystrokes cannot start a model request each time. */
  maxRequestsPerWindow?: number;
  windowMs?: number;
}

/**
 * Coalesces file events and rate-limits scans. A late scan result is rejected when a newer input
 * version already exists, so an older result can never overwrite newer knowledge.
 */
export class ProjectScanScheduler {
  private readonly pending = new Set<string>();
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private version = 0;
  private scansInWindow = 0;
  private windowStartedAt = Number.NEGATIVE_INFINITY;
  private readonly debounceMs: number;
  private readonly maxRequestsPerWindow: number;
  private readonly windowMs: number;

  constructor(options: ProjectScanSchedulerOptions = {}) {
    this.debounceMs = options.debounceMs ?? 500;
    this.maxRequestsPerWindow = options.maxRequestsPerWindow ?? 4;
    this.windowMs = options.windowMs ?? 60_000;
  }

  get inputVersion(): number {
    return this.version;
  }

  get pendingPaths(): string[] {
    return [...this.pending].sort();
  }

  /** Records a file event. Returns the new input version. */
  notify(path: string, now = Date.now()): number {
    this.pending.add(path.replaceAll("\\", "/"));
    this.version += 1;
    this.lastScanAt = now;
    return this.version;
  }

  /** Returns the coalesced paths once the debounce window passed and the rate limit allows a scan. */
  drain(now = Date.now()): string[] | undefined {
    if (!this.pending.size) return undefined;
    if (now - this.lastScanAt < this.debounceMs) return undefined;
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.scansInWindow = 0;
    }
    if (this.scansInWindow >= this.maxRequestsPerWindow) return undefined;
    this.scansInWindow += 1;
    const paths = this.pendingPaths;
    this.pending.clear();
    return paths;
  }

  /** Begins a scan over the current input version. */
  begin(): number {
    return this.version;
  }

  /** True only when no newer file event arrived while the scan was running. */
  acceptResult(scannedVersion: number): boolean {
    return scannedVersion === this.version;
  }
}
