import { type ProjectPanelData } from "../presentation/projectPanel.js";
import type { ProjectInitializationState } from "./lifecycle.js";

export interface ProjectReaderEvidenceRequest {
  diagramId: string;
  updatedAt: number;
  elementId: string;
  elementKind: "node" | "relation";
  evidenceIndex: number;
}

export interface ProjectReaderExportRequest { diagramId: string; updatedAt: number; content: string }

export interface ProjectReaderRenderRequest { diagramId: string; updatedAt: number; requestId: string }

export interface ProjectEditorDataSource {
  openKnowledgeDocument?(id: string): Promise<void>;
  updateKnowledge?(request: unknown): Promise<void>;
  load(): Promise<ProjectPanelData>;
  /** Host → webview messages (render results, generation progress, export status). */
  subscribe?(listener: (message: ProjectPanelMessage) => void): () => void;
  initialize?(): Promise<ProjectPanelData>;
  /** Pauses a running initialization before it starts saving generated artifacts. */
  pauseInitialization?(): void;
  initialization?(): ProjectInitializationState;
  onInitializationChange?(listener: (state: ProjectInitializationState) => void): () => void;
  setAiCli?(cli?: string): Promise<void> | void;
  setAiModel?(model?: string): Promise<void> | void;
  setAiReasoning?(reasoningEffort?: string): Promise<void> | void;
  setAiSpeed?(speed?: string): Promise<void> | void;
  setProjectSettings?(settings: unknown, version: number): Promise<void>;
  setEvidenceSettings?(settings: unknown, version: number): Promise<void>;
  setWorkspaceSettings?(settings: unknown, version: number): Promise<void>;
  checkKnowledge?(): Promise<void>;
  openTopicEvidence?(topicId: string, index: number): Promise<void>;
  generateTopicDiagram?(topicId: string): Promise<void>;
  openReaderEvidence?(request: ProjectReaderEvidenceRequest): Promise<void>;
  exportReaderDiagram?(request: ProjectReaderExportRequest): Promise<void>;
  renderReaderDiagram?(request: ProjectReaderRenderRequest): Promise<void>;
  /** Cancels in-flight render/generation work when the page closes or the diagram changes. */
  cancelDiagramWork?(): void;
}
export interface ProjectPanelMessage { type: string;[key: string]: unknown }
