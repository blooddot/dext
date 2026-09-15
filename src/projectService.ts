import type { ArchitectureScanResult } from "./core/projectArchitecture.js";
import { KnowledgeDraftQueue, type KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import type { ProjectIntent } from "./core/projectIntent.js";
import type { ProjectDiagram } from "./core/projectDiagram.js";

export type ProjectInitializationStatus = "idle" | "running" | "completed" | "cancelled" | "failed";
export type ProjectInitializationPhase = "scanning" | "generating" | "saving";

export interface ProjectInitializationProgress {
  phase: ProjectInitializationPhase;
  /** Work units actually completed in the current phase; absent when no total is known. */
  completed?: number;
  total?: number;
  message?: string;
}
export type ProjectInitializationProgressListener = (progress: ProjectInitializationProgress) => void;

export interface ProjectInitializationState {
  status: ProjectInitializationStatus;
  startedAt?: number;
  finishedAt?: number;
  /** False when the AI proposer was unavailable; the project still works without drafts. */
  aiAvailable: boolean;
  drafts: number;
  scannedFiles: number;
  /** The operation currently executing, including persistence before completion. */
  phase?: ProjectInitializationPhase;
  /** Actual completed work units in the current phase, never an estimated percentage. */
  progress?: number;
  progressTotal?: number;
  message?: string;
  /** Bounded tail of output emitted by the initialization provider. */
  output?: string;
  /** True when the semantic Project Intent was generated for this run. */
  intentGenerated?: boolean;
  /** Number of diagram kinds generated for this run. */
  diagramsGenerated?: number;
  error?: string;
}

export interface ProjectInitializationOutput {
  drafts?: KnowledgeSuggestion[];
  intent?: ProjectIntent;
  diagrams?: ProjectDiagram[];
}

export interface ProjectInitializationDependencies {
  scan(onProgress?: ProjectInitializationProgressListener, signal?: AbortSignal): Promise<ArchitectureScanResult>;
  propose?(scan: ArchitectureScanResult): Promise<KnowledgeSuggestion[]>;
  /** Optional semantic generation hook. Persistence is deliberately owned by the host/store. */
  generate?(scan: ArchitectureScanResult, signal: AbortSignal, onProgress: ProjectInitializationProgressListener, onOutput: (text: string) => void, onEvent?: (event: unknown) => void): Promise<ProjectInitializationOutput>;
  /** Persists every artifact before the initialization can become completed. */
  persist?(output: ProjectInitializationOutput, signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<void>;
  now?: () => number;
}

export interface ProjectInitializationTask {
  promise: Promise<ProjectInitializationState>;
  cancel(): void;
}

function initializationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = error && typeof error === "object" && "diagnostics" in error && Array.isArray(error.diagnostics)
    ? error.diagnostics.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];
  return diagnostics.length ? `${message} ${diagnostics.join(" ")}` : message;
}

/**
 * Runs the non-blocking `Initialize Knowledge` flow: index and scan sources, then queue AI drafts.
 * Cancelling, failing, or missing AI never blocks development; a retry starts a clean run.
 */
export class ProjectInitializationService {
  private state: ProjectInitializationState = { status: "idle", aiAvailable: true, drafts: 0, scannedFiles: 0 };
  private controller: AbortController | undefined;
  private activeTask: ProjectInitializationTask | undefined;
  private readonly listeners = new Set<(state: ProjectInitializationState) => void>();

  subscribe(listener: (state: ProjectInitializationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private replaceState(next: ProjectInitializationState): void {
    this.state = next;
    this.publish();
  }
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
    if (this.activeTask && this.state.status === "running") return this.activeTask;
    const controller = new AbortController();
    this.controller = controller;
    this.replaceState({ status: "running", startedAt: this.now(), aiAvailable: true, drafts: 0, scannedFiles: 0, phase: "scanning", message: "Discovering source files…", intentGenerated: false, diagramsGenerated: 0 });
    const promise = this.run(controller.signal);
    this.activeTask = { promise, cancel: () => { if (this.controller === controller) this.cancel(); } };
    return this.activeTask;
  }

  cancel(): void {
    this.controller?.abort();
    if (this.state.status === "running") this.replaceState({ ...this.state, status: "cancelled", finishedAt: this.now() });
  }

  retry(): ProjectInitializationTask {
    this.cancel();
    return this.start();
  }

  private async run(signal: AbortSignal): Promise<ProjectInitializationState> {
    const current = (): boolean => this.controller?.signal === signal;
    const onProgress: ProjectInitializationProgressListener = (update) => {
      if (!current() || signal.aborted) return;
      const previous = { ...this.state };
      delete previous.progress;
      delete previous.progressTotal;
      delete previous.message;
      const measured = update.completed !== undefined && update.total !== undefined && update.total > 0;
      this.replaceState({
        ...previous,
        phase: update.phase,
        ...(measured ? { progress: Math.max(0, Math.min(update.completed!, update.total!)), progressTotal: update.total } : {}),
        ...(update.message ? { message: update.message } : {}),
        ...(update.phase === "scanning" && update.completed !== undefined ? { scannedFiles: update.completed } : {})
      });
    };
    const onEvent = (event: unknown): void => {
      if (!event || typeof event !== "object") return;
      const value = "text" in event && typeof event.text === "string" ? event.text : "";
      const title = "title" in event && typeof event.title === "string" ? event.title : "";
      const line = value || title ? `${title && value ? `${title}: ` : title}${value}` : "";
      if (line) onOutput(`${line}\n`);
    };
    const onOutput = (text: string): void => {
      if (!current() || signal.aborted || !text) return;
      this.replaceState({ ...this.state, output: ((this.state.output ?? "") + text).slice(-24_000) });
    };
    const assertActive = (): void => {
      if (signal.aborted || !current()) throw new Error("Project initialization was cancelled.");
    };
    try {
      const scan = await this.dependencies.scan(onProgress, signal);
      assertActive();
      this.replaceState({ ...this.state, scannedFiles: scan.files?.length ?? scan.modules.length });
      onProgress({ phase: "generating", message: "Waiting for AI analysis…" });
      let output: ProjectInitializationOutput = {};
      if (this.dependencies.generate) output = await this.dependencies.generate(scan, signal, onProgress, onOutput, onEvent);
      else if (this.dependencies.propose) output = { drafts: await this.dependencies.propose(scan) };
      assertActive();
      if (this.dependencies.persist) {
        onProgress({ phase: "saving", message: "Preparing generated files for saving…" });
        await this.dependencies.persist(output, signal, onProgress);
        assertActive();
      }
      for (const draft of output.drafts ?? []) this.queue.enqueue(draft);
      this.replaceState({
        ...this.state,
        status: "completed",
        finishedAt: this.now(),
        aiAvailable: this.dependencies.generate !== undefined || this.dependencies.propose !== undefined,
        drafts: this.queue.list().length,
        intentGenerated: output.intent !== undefined,
        diagramsGenerated: output.diagrams?.length ?? 0
      });
      return this.snapshot;
    } catch (error) {
      // A cancelled older run may finish after its retry; it must never overwrite the new run.
      if (!current()) return { status: "cancelled", aiAvailable: false, drafts: 0, scannedFiles: 0 };
      const legacyProposerFailure = this.dependencies.generate === undefined && this.dependencies.propose !== undefined && !signal.aborted;
      this.replaceState({
        ...this.state,
        status: signal.aborted ? "cancelled" : legacyProposerFailure ? "completed" : "failed",
        finishedAt: this.now(),
        aiAvailable: false,
        drafts: this.queue.list().length,
        ...(signal.aborted ? {} : { error: initializationErrorMessage(error) })
      });
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
