import type { IndexedProjectEvidence } from "./evidence.js";
import type { ProjectDiagram } from "./projectDiagram.js";
import type { ProjectIntent } from "./projectIntent.js";



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
  error?: string;
}


export interface ProjectInitializationOutput {
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
  /** Builds the complete local structure index, plus bounded excerpts, when initialization starts. */
  prepareEvidence(signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<IndexedProjectEvidence>;
  /** AI generation; must throw with a clear reason when no provider is available. */
  generate(
    evidence: IndexedProjectEvidence,
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