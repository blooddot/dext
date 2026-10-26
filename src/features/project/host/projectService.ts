import type { ProjectInitializationDependencies, ProjectInitializationHydration, ProjectInitializationProgressListener, ProjectInitializationState, ProjectInitializationTask } from "../contracts/lifecycle.js";
export type { ProjectInitializationDependencies, ProjectInitializationHydration, ProjectInitializationOutput, ProjectInitializationPhase, ProjectInitializationProgress, ProjectInitializationProgressListener, ProjectInitializationState, ProjectInitializationStatus, ProjectInitializationTask } from "../contracts/lifecycle.js";

function initializationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostics = error && typeof error === "object" && "diagnostics" in error && Array.isArray(error.diagnostics)
    ? error.diagnostics.filter((item): item is string => typeof item === "string").slice(0, 4)
    : [];
  return diagnostics.length ? `${message} ${diagnostics.join(" ")}` : message;
}

/**
 * Runs the explicit `Initialize Knowledge` flow: build the local structure index with bounded
 * supporting excerpts, generate with AI, validate, then save. Cancelling, failing, or a missing AI
 * never fakes success and never blocks development; a retry starts a clean run whose late
 * predecessor cannot overwrite state.
 */
export class ProjectInitializationService {
  private state: ProjectInitializationState = { status: "uninitialized" };
  private controller: AbortController | undefined;
  private activeTask: ProjectInitializationTask | undefined;
  private readonly listeners = new Set<(state: ProjectInitializationState) => void>();
  private readonly now: () => number;

  constructor(private readonly dependencies: ProjectInitializationDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  subscribe(listener: (state: ProjectInitializationState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) {
      // A view can be closed while a long initialization is still reporting. Progress is a
      // notification, not part of the result, so a failed render must not abort the run.
      try { listener(snapshot); } catch { /* The run continues; its persisted state remains the truth. */ }
    }
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
        diagramsGenerated: diagramCount
      });
      return;
    }
    this.replaceState({
      status: "uninitialized",
      intentGenerated: false,
      diagramsGenerated: diagramCount,
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
      phase: "preparing",
      message: "Preparing the local structure index…"
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
      onProgress({ phase: "generating", message: "Calling the project AI to build the project model…" });
      const output = await this.dependencies.generate(evidence, signal, onProgress, onOutput);
      assertActive();
      onProgress({ phase: "saving", message: "Validating and saving the generated result…" });
      await this.dependencies.persist(output, signal, onProgress);
      assertActive();
      this.replaceState({
        ...this.state,
        status: "completed",
        finishedAt: this.now(),
        phase: "saving",
        intentGenerated: output.intent !== undefined,
        diagramsGenerated: output.diagrams?.length ?? 0
      });
      return this.snapshot;
    } catch (error) {
      // A cancelled older run may finish after its retry; it must never overwrite the new run.
      if (!current()) return { status: "cancelled", intentGenerated: false, diagramsGenerated: 0 };
      this.replaceState({
        ...this.state,
        status: signal.aborted ? "cancelled" : "failed",
        finishedAt: this.now(),
        ...(signal.aborted ? {} : { error: initializationErrorMessage(error) })
      });
      return this.snapshot;
    }
  }
}
