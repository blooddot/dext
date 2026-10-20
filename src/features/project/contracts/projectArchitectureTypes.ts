import type { ArchitectureRule, ArchitectureViolation } from "../knowledge/projectArchitecture.js";
import type { ProjectEvidenceSummary } from "./evidence.js";
import type { ProjectDiagramKind } from "./projectDiagram.js";

export interface ProjectArchitectureDecision {
  id: string;
  title: string;
  detail: string;
}

export interface ProjectDiagramSummary {
  id: string;
  title: string;
  kind: ProjectDiagramKind;
  version: number;
  updatedAt: number;
  review?: string;
}

export interface ArchitectureViewInput {
  /** Everything the Archify viewer can display, architecture first. */
  diagrams: readonly ProjectDiagramSummary[];
  /** Preferred saved diagram when restoring the gallery. */
  selected?: ProjectDiagramSummary;
  /** True when no valid saved intent exists; saved diagrams stay viewable. */
  knowledgeUninitialized?: boolean;
  generating?: boolean;
  generationError?: string;
  engine?: { id: string; version: string; available: boolean; reason?: string };
  decisions?: readonly ProjectArchitectureDecision[];
  rules?: readonly ArchitectureRule[];
  violations?: readonly ArchitectureViolation[];
  baselineViolations?: readonly ArchitectureViolation[];
  /** Why declared rules could not be evaluated against a diagram. */
  rulesNote?: string;
  coverage?: readonly string[];
  /** What the last evidence read actually handed the model. */
  evidence?: ProjectEvidenceSummary;
}
