import type { StructureGraphFacts } from "../host/indexing/projectStructureGraph.js";
import type { StructureSummary } from "../host/indexing/projectStructure.js";
import type { ProjectObject } from "./projectKnowledge.js";


export interface ProjectEvidenceFileInput {
  /** Workspace-relative file path. Absolute paths and traversal are never sent. */
  path: string;
  content: string;
  kind?: "readme" | "document" | "manifest" | "source";
  symbols?: readonly string[];
  /** One-based start of a host-selected excerpt; content remains the full file for hashing. */
  excerptStartLine?: number;
  excerptEndLine?: number;
}


/** Existing Project knowledge offered to the model as stable semantic references. */
export interface ProjectKnowledgeReference {
  id: string;
  kind: "object" | "capability" | "context" | "flow" | "step" | "term" | "constraint" | "decision" | "c4";
  name: string;
  description?: string;
}


export interface ProjectEvidenceInput {
  inventory?: readonly ProjectEvidenceInventoryEntry[];
  projectName?: string;
  preferredPaths?: readonly string[];
  /** Index runtime evidence has already been prioritized by boundary coverage. */
  preserveSourceOrder?: boolean;
  /** Explicit disjoint windows, each retaining its original file hash and line range. */
  allowMultipleExcerpts?: boolean;
  files: readonly ProjectEvidenceFileInput[];
  objects?: readonly ProjectObject[];
  knowledge?: readonly ProjectKnowledgeReference[];
  /** Only present for on-demand diagram generation. */
  requirement?: string;
  /** Host-provided coverage notes, such as file limits or skipped directories. */
  coverage?: readonly string[];
  /** Scope globs the host actually applied; empty means the built-in set. */
  scope?: readonly string[];
  /** Depth preset the host applied, when it configured one. */
  preset?: string;
}


export interface ProjectEvidenceLimits {
  maxFiles?: number;
  maxFileChars?: number;
  maxSourceFileChars?: number;
  maxTotalChars?: number;
  maxObjects?: number;
  maxKnowledge?: number;
  maxRequirementChars?: number;
  maxSymbolsPerFile?: number;
  maxInventoryEntries?: number;
}


export interface ProjectEvidenceFile {
  path: string;
  kind: NonNullable<ProjectEvidenceFileInput["kind"]>;
  text: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  symbols: string[];
}


/**
 * The cheap half of the evidence: every candidate is listed by path, kind, size and declared
 * symbols, so the model knows the whole module surface, while only the excerpt half spends the text
 * budget. A path is citable on its own; a line number still requires a supplied excerpt.
 */
export interface ProjectEvidenceInventoryEntry {
  contentHash?: string;
  path: string;
  kind: NonNullable<ProjectEvidenceFileInput["kind"]>;
  lines: number;
  symbols?: readonly string[];
}


export interface ProjectEvidencePackage {
  /** Complete local module map; split into bounded batches before any AI request. */
  structure?: StructureSummary;
  /** Compact static-import facts; only present when a completed structure cache exists. */
  graph?: StructureGraphFacts;
  schemaVersion: 2;
  projectName: string;
  files: ProjectEvidenceFile[];
  /** Every candidate the host handed over, including files without an excerpt. */
  inventory: ProjectEvidenceInventoryEntry[];
  /** What the host chose to read, so one run stays reproducible and explainable. */
  selection: ProjectEvidenceSelection;
  /** Accepted knowledge objects, bounded and redacted. */
  objects: Array<Pick<ProjectObject, "id" | "canonicalName" | "displayName" | "aliases" | "description" | "confirmation" | "version" | "evidence">>;
  /** Existing semantic ids that diagrams may reference without redefining them. */
  knowledge: ProjectKnowledgeReference[];
  /** User requirement for on-demand diagram generation. */
  requirement?: string;
  coverage: string[];
  /** `files` counts candidates that received no excerpt, not candidates missing from the inventory. */
  omitted: { files: number; objects: number; knowledge: number };
  inputHash: string;
  /** Serialized character count, including package metadata, for budget enforcement. */
  characterCount: number;
}


/** Initialization evidence: the complete local structure index plus bounded supporting excerpts. */
export interface IndexedProjectEvidence extends ProjectEvidencePackage {
  structure: StructureSummary;
}


/** The scope and budgets one evidence read used. */
export interface ProjectEvidenceSelection {
  /** Explicit scope globs; empty means the built-in README/documentation/manifest/source set. */
  scope: string[];
  preset?: string;
  files: number;
  fileChars: number;
  evidenceChars: number;
}


/**
 * The persisted, bounded record of one evidence read: enough for a reader to see what the model was
 * given, and for a later run to explain a different diagram.
 */
export interface ProjectEvidenceSummary {
  /** Structure facts this read computed and attached; only a full index build produces them. */
  structure?: { files: number; modules: number; parsed: number; cached: number; failed: number; unsupported: number };
  /** The index summary persisted with the last completed project model; a bounded read cannot attach structure. */
  structureIndex?: ProjectStructureIndexSummary;
  version: 1;
  trigger: "initialize" | "diagram";
  generatedAt: number;
  inputHash: string;
  selection: ProjectEvidenceSelection;
  inventory: { total: number; withSymbols: number; byKind: Record<string, number> };
  excerpts: { total: number; truncated: number; byKind: Record<string, number> };
  omitted: { files: number; objects: number; knowledge: number };
  coverage: string[];
  /** Ranked candidates, so the surface the model was told about stays inspectable. */
  paths: string[];
  /** Candidates that received text, so the reader knows which claims can carry line numbers. */
  excerpted: string[];
}


/** Counts of a locally indexed structure map, independent of any model input. */
export interface ProjectStructureIndexSummary {
  hash?: string;
  files: number;
  parsed: number;
  modules: number;
  failed: number;
  unsupported: number;
}
