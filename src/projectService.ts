import type { ProjectEvidencePackage } from "./core/projectAiGeneration.js";
import { KnowledgeDraftQueue, type KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import type { ProjectIntent } from "./core/projectIntent.js";
import type { ProjectDiagram } from "./core/projectDiagram.js";

/**
 * Knowledge initialization states. `uninitialized` is deliberately distinct from `failed` and
 * `cancelled`: only a valid saved intent/diagram result can become `completed`.
 */
export type ProjectInitializationStatus = "uninitialized" | "running" | "completed" | "cancelled" | "failed";
export type ProjectInitializationPhase = "preparing" | "generating" | "saving";

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
  /** Draft suggestions queued by a legacy propose hook; the AI flow typically produces none. */
  drafts: number;
  error?: string;
}

export interface ProjectInitializationOutput {
  drafts?: KnowledgeSuggestion[];
  intent?: ProjectIntent;
  diagrams?: ProjectDiagram[];
}

export interface ProjectInitializationHydration {
  /** A valid saved Project Intent exists. */
  hasIntent: boolean;
  /** Number of valid saved diagrams; diagrams stay viewable without a knowledge initialization. */
  diagramCount: number;
  /** Legacy `.dext/project.json` flag. Never sufficient on its own. */
  markedInitialized?: boolean;
}

export interface ProjectInitializationDependencies {
  /** Reads a bounded text evidence package only when the user starts initialization. */
  prepareEvidence(signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<ProjectEvidencePackage>;
  /** AI generation; must throw with a clear reason when no provider is available. */
  generate(
    evidence: ProjectEvidencePackage,
    signal: AbortSignal,
    onProgress: ProjectInitializationProgressListener,
    /** Sole text sink for provider activity; the host formats its own structured events into it. */
    onOutput: (text: string) => void
  ): Promise<ProjectInitializationOutput>;
  /** Persists every artifact before the initialization can become completed. */
  persist(output: ProjectInitializationOutput, signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<void>;
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
 * Runs the explicit `Initialize Knowledge` flow: prepare bounded evidence, generate with AI,
 * validate, then save. Cancelling, failing, or a missing AI never fakes success and never blocks
 * development; a retry starts a clean run whose late predecessor cannot overwrite state.
 */
export class ProjectInitializationService {
  private state: ProjectInitializationState = { status: "uninitialized", drafts: 0 };
  private controller: AbortController | undefined;
  private activeTask: ProjectInitializationTask | undefined;
  private readonly listeners = new Set<(state: ProjectInitializationState) => void>();
  private readonly now: () => number;

  constructor(
    private readonly dependencies: ProjectInitializationDependencies,
    private readonly queue: KnowledgeDraftQueue = new KnowledgeDraftQueue()
  ) {
    this.now = dependencies.now ?? Date.now;
  }

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

  get snapshot(): ProjectInitializationState {
    return { ...this.state };
  }

  /**
   * Restores state from persisted data after a restart. A legacy `initialized` flag or scan data
   * alone never counts as success; only a valid intent makes the knowledge model completed.
   */
  hydrate(input: ProjectInitializationHydration): void {
    if (this.state.status === "running") return;
    const diagramCount = Math.max(0, input.diagramCount);
    if (input.hasIntent) {
      this.replaceState({
        status: "completed",
        finishedAt: this.now(),
        intentGenerated: true,
        diagramsGenerated: diagramCount,
        drafts: this.queue.list().length
      });
      return;
    }
    this.replaceState({
      status: "uninitialized",
      intentGenerated: false,
      diagramsGenerated: diagramCount,
      drafts: this.queue.list().length,
      ...(!input.hasIntent && diagramCount > 0 ? { message: "Saved diagrams remain viewable; project knowledge is not initialized yet." } : {})
    });
  }

  /** Idempotent while running: the same in-flight task is returned instead of a second run. */
  start(): ProjectInitializationTask {
    if (this.activeTask && this.state.status === "running") return this.activeTask;
    const controller = new AbortController();
    this.controller = controller;
    this.replaceState({
      status: "running",
      startedAt: this.now(),
      drafts: this.queue.list().length,
      phase: "preparing",
      message: "Preparing bounded text evidence…"
    });
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
        ...(update.message ? { message: update.message } : {})
      });
    };
    const onOutput = (text: string): void => {
      if (!current() || signal.aborted || !text) return;
      this.replaceState({ ...this.state, output: ((this.state.output ?? "") + text).slice(-24_000) });
    };
    const assertActive = (): void => {
      if (signal.aborted || !current()) throw new Error("Project initialization was cancelled.");
    };
    try {
      const evidence = await this.dependencies.prepareEvidence(signal, onProgress);
      assertActive();
      onProgress({ phase: "generating", message: "Calling the project AI to generate the semantic model…" });
      const output = await this.dependencies.generate(evidence, signal, onProgress, onOutput);
      assertActive();
      onProgress({ phase: "saving", message: "Validating and saving the generated result…" });
      await this.dependencies.persist(output, signal, onProgress);
      assertActive();
      for (const draft of output.drafts ?? []) this.queue.enqueue(draft);
      this.replaceState({
        ...this.state,
        status: "completed",
        finishedAt: this.now(),
        phase: "saving",
        drafts: this.queue.list().length,
        intentGenerated: output.intent !== undefined,
        diagramsGenerated: output.diagrams?.length ?? 0
      });
      return this.snapshot;
    } catch (error) {
      // A cancelled older run may finish after its retry; it must never overwrite the new run.
      if (!current()) return { status: "cancelled", drafts: 0, intentGenerated: false, diagramsGenerated: 0 };
      this.replaceState({
        ...this.state,
        status: signal.aborted ? "cancelled" : "failed",
        finishedAt: this.now(),
        drafts: this.queue.list().length,
        ...(signal.aborted ? {} : { error: initializationErrorMessage(error) })
      });
      return this.snapshot;
    }
  }
}
