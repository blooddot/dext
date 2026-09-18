import * as vscode from "vscode";
import { isAbsolute, resolve } from "node:path";
import type { ProjectFileHost, ProjectDefinition, ProjectSaveResult } from "./projectStore.js";
import type { ProjectEditorDataSource } from "./projectEditorProvider.js";
import { KnowledgeDraftQueue } from "./core/projectKnowledgeReview.js";
import type { ProjectInitializationState, ProjectInitializationProgressListener } from "./projectService.js";
import { ProjectInitializationService } from "./projectService.js";
import {
  buildProjectEvidencePackage,
  compareProjectEvidencePaths,
  isExcludedProjectEvidencePath,
  isProjectEvidencePath,
  projectEvidenceFileKind,
  ProjectAiGenerationService,
  summarizeProjectEvidence,
  type ProjectAiActivityEvent,
  type ProjectAiProvider,
  type ProjectEvidenceFileInput,
  type ProjectEvidencePackage,
  type ProjectEvidenceSummary,
  type ProjectKnowledgeReference
} from "./core/projectAiGeneration.js";
import { validateProjectDiagram, type ProjectDiagram, type ProjectDiagramKind } from "./core/projectDiagram.js";
import { validateProjectIntent, type ProjectIntent } from "./core/projectIntent.js";
import type { ProjectObject } from "./core/projectKnowledge.js";
import type { ArchifyIdMapping, ArchifyRepository } from "./core/archifyAdapter.js";
import type { ProjectDiagramAdapterRegistry } from "./core/projectDiagramRegistry.js";
import type { ProjectArchitectureDecision, ProjectDiagramNodeDetail, ProjectDiagramSummary } from "./webview/projectArchitectureView.js";
import type { ProjectAiLimits } from "./projectAiLimits.js";
import { architectureRuleReport, type ArchitectureRule } from "./core/projectArchitecture.js";
import type { ProjectPanelData } from "./webview/projectPanel.js";
import type { DiagramValidationIssue } from "./core/projectDiagram.js";
import { DiagramTaskRegistry, isAllowedEvidencePath, isDiagramExportPayload, resolveDiagramTarget } from "./projectDiagramViewer.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const PROJECT_EVIDENCE_EXCLUDE = "**/{node_modules,out,dist,build,.git,target,coverage,.vscode-test,.npm-cache,.tmp-tb}/**";
export const PROJECT_README_GLOB = "**/{README,README.md,README.txt,readme,readme.md,readme.txt}";
export const PROJECT_DOCUMENT_GLOB = "**/*.{md,mdx,rst,txt}";
export const PROJECT_MANIFEST_GLOB = "**/{package.json,Cargo.toml,Cargo.lock,pyproject.toml,go.mod,pom.xml}";
export const PROJECT_SOURCE_GLOB = "**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,py,rs,go,java,kt,kts,rb,cs,php,swift,c,h,cpp,hpp}";

export interface ProjectEvidenceReadOptions {
  requirement?: string;
  /** Total evidence files; the AI evidence package applies its own stricter budget afterwards. */
  maxFiles?: number;
  /** Source-text candidates read after documentation and manifests. */
  maxSourceFiles?: number;
  maxFileBytes?: number;
  /** Characters per file handed to the AI evidence package. */
  maxFileChars?: number;
  /** Total characters the AI evidence package may serialize. */
  maxEvidenceChars?: number;
  /**
   * Workspace-relative globs that limit which files are evidence. Empty keeps the built-in set
   * (README, documentation, manifests, then source). This is the replacement for the removed
   * `scan.roots` profile: a reader who configured `["src"]` there can now write `["src/**"]`.
   */
  include?: readonly string[];
  /** Depth preset the host applied, recorded in the evidence summary. */
  preset?: string;
}

function relativePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  const prefix = root.path.replace(/\/$/, "") + "/";
  if (!uri.path.startsWith(prefix)) return undefined;
  return decodeURIComponent(uri.path.slice(prefix.length));
}

/**
 * Reads only bounded documentation, manifests and source text when the user explicitly starts
 * initialization or diagram generation. It never constructs an AST, runs a parser or scans files
 * in the background, and it keeps the same exclusion/path/size/cancellation guarantees.
 */
export async function readWorkspaceEvidence(
  root: vscode.Uri,
  knowledge: { objects?: readonly ProjectObject[]; intent?: ProjectIntent },
  options: ProjectEvidenceReadOptions,
  onProgress?: ProjectInitializationProgressListener,
  signal?: AbortSignal
): Promise<ProjectEvidencePackage> {
  const maxFiles = Math.max(1, options.maxFiles ?? 600);
  const maxSourceFiles = Math.max(0, options.maxSourceFiles ?? 600);
  const maxFileBytes = Math.max(1024, options.maxFileBytes ?? 262_144);
  const excluded = PROJECT_EVIDENCE_EXCLUDE;
  const files: ProjectEvidenceFileInput[] = [];
  const coverage: string[] = [];
  // A configured scope replaces the built-in globs instead of extending them: that is how a reader
  // says "only this part of the tree is evidence". Invalid entries are dropped so a scope can never
  // escape the workspace root.
  const include = (options.include ?? [])
    .filter((pattern): pattern is string => typeof pattern === "string")
    .map((pattern) => pattern.trim())
    .filter((pattern) => {
      const normalized = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
      return normalized === "" || isProjectEvidencePath(normalized);
    })
    .slice(0, 20);
  const patterns = include.length
    ? include
    : [PROJECT_README_GLOB, PROJECT_DOCUMENT_GLOB, PROJECT_MANIFEST_GLOB, PROJECT_SOURCE_GLOB];
  onProgress?.({ phase: "preparing", message: include.length ? "Reading the configured evidence scope…" : "Searching README, documentation, manifests and necessary source…" });
  // Listing candidates is cheap; reading them is not. A wide window is ordered by project evidence
  // rank before the read limit applies, so vendored readmes or tooling folders cannot occupy the
  // slots the project's own documentation and code need.
  const candidateLimit = Math.min(4_000, Math.max(maxFiles, maxSourceFiles) * 8);
  const pathOf = (uri: vscode.Uri): string => relativePath(root, uri) ?? uri.path;
  const byEvidenceRank = (left: vscode.Uri, right: vscode.Uri): number => compareProjectEvidencePaths(pathOf(left), pathOf(right));
  const found: vscode.Uri[] = [];
  for (const pattern of patterns) {
    if (signal?.aborted) throw new Error("Project initialization was cancelled.");
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), excluded, candidateLimit);
    for (const uri of uris) if (!found.some((candidate) => candidate.path === uri.path)) found.push(uri);
  }
  if (signal?.aborted) throw new Error("Project initialization was cancelled.");
  const foundDocuments = found.filter((uri) => projectEvidenceFileKind(pathOf(uri)) !== "source");
  const sources = found.filter((uri) => projectEvidenceFileKind(pathOf(uri)) === "source");
  // Documentation keeps its precedence, but a source reserve protects code when documentation
  // fills the window. Once documentation is satisfied the remaining slots go to source, so the
  // inventory can name every module the window can afford instead of stopping at half.
  const sourceReserve = Math.min(sources.length, maxSourceFiles, Math.max(0, Math.floor(maxFiles / 2)));
  const documentSlots = Math.min(foundDocuments.length, Math.max(0, maxFiles - sourceReserve));
  const sourceSlots = Math.min(sources.length, maxSourceFiles, Math.max(0, maxFiles - documentSlots));
  const pending = [
    ...foundDocuments.sort(byEvidenceRank).slice(0, documentSlots),
    ...sources.sort(byEvidenceRank).slice(0, sourceSlots)
  ];
  const readSourceCount = pending.filter((uri) => projectEvidenceFileKind(pathOf(uri)) === "source").length;
  if (foundDocuments.length > pending.length - readSourceCount) coverage.push(`Documentation exceeds the limit: only ${pending.length - readSourceCount} of ${foundDocuments.length} documentation candidates were read.`);
  if (sources.length > readSourceCount) coverage.push(`Source text exceeds the limit: only ${readSourceCount} of ${sources.length} source candidates were read.`);
  let processed = 0;
  onProgress?.({ phase: "preparing", completed: 0, total: pending.length, message: "Reading bounded text evidence…" });
  for (const uri of pending) {
    if (signal?.aborted) throw new Error("Project initialization was cancelled.");
    const path = relativePath(root, uri);
    processed += 1;
    try {
      if (!path || !isProjectEvidencePath(path) || isExcludedProjectEvidencePath(path)) continue;
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxFileBytes) { coverage.push(`${path}: exceeds the per-file read limit; skipped.`); continue; }
      const content = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
      files.push({ path, content });
    } catch {
      if (path) coverage.push(`${path}: could not be read; skipped.`);
    } finally {
      onProgress?.({ phase: "preparing", completed: processed, total: pending.length, message: `Read ${processed} / ${pending.length} files` });
    }
  }
  const knowledgeReferences = buildKnowledgeReferences(knowledge);
  return buildProjectEvidencePackage({
    projectName: root.path.split("/").filter(Boolean).pop() ?? "Project",
    files,
    ...(knowledge.objects ? { objects: knowledge.objects } : {}),
    knowledge: knowledgeReferences,
    ...(options.requirement ? { requirement: options.requirement } : {}),
    ...(include.length ? { scope: include } : {}),
    ...(options.preset ? { preset: options.preset } : {}),
    coverage
  }, {
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxFileChars !== undefined ? { maxFileChars: options.maxFileChars } : {}),
    ...(options.maxEvidenceChars !== undefined ? { maxTotalChars: options.maxEvidenceChars } : {})
  });
}

function buildKnowledgeReferences(knowledge: { objects?: readonly ProjectObject[]; intent?: ProjectIntent }): ProjectKnowledgeReference[] {
  const references: ProjectKnowledgeReference[] = [];
  for (const object of knowledge.objects ?? []) {
    if (object.confirmation !== "accepted") continue;
    references.push({ id: object.id, kind: "object", name: object.canonicalName, ...(object.description ? { description: object.description } : {}) });
  }
  const intent = knowledge.intent;
  if (intent) {
    const add = (kind: ProjectKnowledgeReference["kind"], items: readonly unknown[]): void => {
      for (const raw of items) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as { id?: unknown; canonicalName?: unknown; displayName?: unknown; description?: unknown; purpose?: unknown; summary?: unknown };
        if (typeof item.id !== "string" || !item.id) continue;
        const name = typeof item.displayName === "string" ? item.displayName : typeof item.canonicalName === "string" ? item.canonicalName : item.id;
        const description = [item.description, item.purpose, item.summary].find((value): value is string => typeof value === "string" && value.length > 0);
        references.push({ id: item.id, kind, name, ...(description ? { description } : {}) });
      }
    };
    add("capability", intent.capabilities);
    add("context", intent.contexts);
    add("flow", intent.flows);
    add("term", intent.terms);
    add("constraint", intent.constraints);
    add("decision", intent.decisions);
  }
  return references;
}

/** Resolves a pinned git revision and remote URL locally; no parser or source scan is involved. */
export async function discoverArchifyRepository(root: vscode.Uri): Promise<ArchifyRepository | undefined> {
  try {
    const dotGit = vscode.Uri.joinPath(root, ".git");
    let gitDirectory: vscode.Uri;
    try {
      const stat = await vscode.workspace.fs.stat(dotGit);
      if (stat.type === vscode.FileType.File) {
        const pointer = textDecoder.decode(await vscode.workspace.fs.readFile(dotGit));
        const match = /gitdir:\s*(.+)/i.exec(pointer);
        if (!match) return undefined;
        const target = match[1]!.trim();
        gitDirectory = vscode.Uri.file(isAbsolute(target) ? target : resolve(root.fsPath, target));
      } else {
        gitDirectory = dotGit;
      }
    } catch { return undefined; }
    const head = (await vscode.workspace.fs.readFile(vscode.Uri.joinPath(gitDirectory, "HEAD"))).toString().trim();
    let revision: string;
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      try {
        revision = (await vscode.workspace.fs.readFile(vscode.Uri.joinPath(gitDirectory, ...ref.split("/")))).toString().trim();
      } catch {
        const packed = textDecoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(gitDirectory, "packed-refs")));
        const line = packed.split(/\r?\n/).find((entry) => entry.endsWith(` ${ref}`));
        revision = line?.split(" ")[0] ?? "";
      }
    } else {
      revision = head;
    }
    if (!/^[a-fA-F0-9]{40}$/.test(revision)) return undefined;
    let remote: string | undefined;
    try {
      const config = textDecoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(gitDirectory, "config")));
      const match = /\[remote\s+"origin"\][\s\S]*?url\s*=\s*(\S+)/i.exec(config);
      remote = match?.[1]?.trim();
    } catch { /* no remote configured */ }
    if (!remote) return undefined;
    const provider = /github\.com/i.test(remote) ? "github" as const : /gitee\.com/i.test(remote) ? "gitee" as const : undefined;
    return { root: root.fsPath, url: remote, revision, ...(provider ? { provider } : {}) };
  } catch {
    return undefined;
  }
}

/** Implements {@link ProjectFileHost} over the VS Code file system rooted at the workspace folder. */
export class VscodeProjectFileHost implements ProjectFileHost {
  constructor(private readonly root: vscode.Uri) {}

  private uri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...relativePath.split("/").filter(Boolean));
  }

  async readFile(relativePath: string): Promise<string | undefined> {
    try {
      return textDecoder.decode(await vscode.workspace.fs.readFile(this.uri(relativePath)));
    } catch {
      // A missing or unreadable project file falls back to defaults upstream.
      return undefined;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, ...segments.slice(0, -1)));
    }
    await vscode.workspace.fs.writeFile(this.uri(relativePath), textEncoder.encode(content));
  }

  async deleteFile(relativePath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(relativePath));
    } catch {
      // Deleting an already-removed object is not an error.
    }
  }

  async listDirectory(relativeDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(relativeDir));
      return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
    } catch {
      return [];
    }
  }
}

export interface ProjectPanelDataSourceOptions {
  name: string;
  root: string;
  rootUri: vscode.Uri;
  store: {
    readObjects(): Promise<ProjectObject[]>;
    /** Only the fields the panel reads; a partial store double stays valid. */
  readArchitecture(): Promise<{ decisions: ProjectArchitectureDecision[]; diagramId?: string | undefined; rules?: readonly ArchitectureRule[] | undefined }>;
    readDefinition?(): Promise<ProjectDefinition>;
    writeDefinition?(next: ProjectDefinition, expectedVersion: number): Promise<ProjectSaveResult<ProjectDefinition>>;
    readIntent?(): Promise<ProjectIntent | undefined>;
    writeIntent?(intent: ProjectIntent): Promise<void>;
    readDiagrams?(): Promise<readonly ProjectDiagram[]>;
    writeDiagram?(diagram: ProjectDiagram): Promise<void>;
    readInitialization?(): Promise<{ markedInitialized: boolean; hasIntent: boolean; diagramCount: number }>;
    /** The last evidence record, so a reloaded page still explains what the model was given. */
    readEvidenceSummary?(): Promise<ProjectEvidenceSummary | undefined>;
    writeEvidenceSummary?(summary: ProjectEvidenceSummary): Promise<void>;
  };
  /** Reads bounded text evidence only when the user explicitly initializes or generates a diagram. */
  readEvidence(options: { requirement?: string }, signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<ProjectEvidencePackage>;
  diagramRegistry?: ProjectDiagramAdapterRegistry;
  projectAiProvider?: ProjectAiProvider;
  aiCli?: readonly { id: string; label: string; models?: readonly {
    id: string;
    label: string;
    group?: string;
    reasoningEfforts?: readonly string[];
    speedTiers?: readonly string[];
    serviceTiers?: readonly string[];
  }[] }[];
  openEvidence?: (path: string, line?: number) => Promise<void>;
  /** Live AI budgets, read per run so a settings change applies without reloading the window. */
  projectAiLimits?: () => ProjectAiLimits;
  now?: () => number;
}

export interface ProjectPanelMessage { type: string;[key: string]: unknown }

const DIAGRAM_KIND_RANK: Record<ProjectDiagramKind, number> = {
  architecture: 0, workflow: 1, sequence: 2, data_flow: 3, lifecycle: 4
};

export function describeProjectDiagram(diagram: ProjectDiagram): ProjectDiagramSummary {
  return {
    id: diagram.id,
    title: diagram.title,
    kind: diagram.kind,
    version: diagram.version,
    updatedAt: diagram.updatedAt,
    ...(diagram.review ? { review: diagram.review } : {})
  };
}

function sortProjectDiagrams(diagrams: readonly ProjectDiagram[]): ProjectDiagram[] {
  return [...diagrams].sort((left, right) => DIAGRAM_KIND_RANK[left.kind] - DIAGRAM_KIND_RANK[right.kind]
    || right.updatedAt - left.updatedAt
    || left.title.localeCompare(right.title));
}

/**
 * The removed source scanner left a `scan` profile behind in `.dext/project.json`. It is preserved
 * on disk but never read by the scanner, so a reader who configured `scan.roots` is told that the
 * roots now act as the evidence scope until `dext.project.evidenceInclude` replaces them.
 */
export function legacyScanRoots(definition: ProjectDefinition | undefined): string[] {
  const scan = (definition as { scan?: { roots?: unknown } } | undefined)?.scan;
  const roots = scan && typeof scan === "object" ? scan.roots : undefined;
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0).slice(0, 10)
    : [];
}

/** The retired roots as evidence globs, so an old configuration keeps meaning what it said. */
export function legacyScanInclude(definition: ProjectDefinition | undefined): string[] {
  return legacyScanRoots(definition).map((root) => {
    const trimmed = root.trim().replace(/\/+$/, "");
    return trimmed === "" || trimmed === "." ? "**" : `${trimmed}/**`;
  });
}

function safeFileName(title: string): string {
  const sanitized = [...title].map((character) => /[\\/:*?"<>|]/.test(character) || character.charCodeAt(0) < 32 ? "-" : character).join("");
  return sanitized.trim().slice(0, 80) || "diagram";
}

function activityLine(event: ProjectAiActivityEvent): string {
  const value = event.text ?? "";
  const title = event.title ?? "";
  return value || title ? `${title && value ? `${title}: ` : title}${value}\n` : "";
}

/** A card click shows these details in the page, so each payload stays small and self-describing. */
function diagramNodeDetails(diagram: ProjectDiagram): ProjectDiagramNodeDetail[] {
  return diagram.nodes.slice(0, 200).map((node) => ({
    id: node.id,
    label: node.label,
    ...(node.description ? { description: clipText(node.description, 400) } : {}),
    ...(node.role ? { role: node.role } : {}),
    ...(node.semanticIds.length ? { semanticIds: node.semanticIds.slice(0, 12) } : {}),
    evidence: node.evidence.slice(0, 6).map((entry) => ({
      path: entry.path,
      ...(entry.line ? { line: entry.line } : {}),
      ...(entry.note ? { note: clipText(entry.note, 200) } : {})
    })),
    ...(typeof node.confidence === "number" ? { confidence: node.confidence } : {}),
    ...(node.review ? { review: node.review } : {}),
    ...(node.freshness ? { freshness: node.freshness } : {})
  }));
}

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function mappingOf(document: unknown): ArchifyIdMapping | undefined {
  if (!document || typeof document !== "object") return undefined;
  const payload = (document as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") return undefined;
  return (payload as { mapping?: ArchifyIdMapping }).mapping;
}

/**
 * Builds the Project tab data from long-term files and explicit user actions. Opening or refreshing
 * the page never enumerates source files, runs a parser, calls AI or writes `.dext`.
 */
export function createProjectPanelDataSource(options: ProjectPanelDataSourceOptions): ProjectEditorDataSource {
  let generatedIntent: ProjectIntent | undefined;
  let selectedAiCli: string | undefined;
  let selectedAiModel: string | undefined;
  let selectedAiReasoning: string | undefined;
  let selectedAiSpeed: string | undefined;
  let hydrated = false;
  let generating = false;
  let generationError: string | undefined;
  /** Last evidence record of this session, so the page can explain a run without a reload. */
  let lastEvidence: ProjectEvidenceSummary | undefined;
  const tasks = new DiagramTaskRegistry();
  const draftQueue = new KnowledgeDraftQueue();
  const listeners = new Set<(message: ProjectPanelMessage) => void>();
  const post = (message: ProjectPanelMessage): void => { for (const listener of listeners) listener(message); };
  interface RenderedDiagram { version: number; engineVersion: string; html: string; mapping?: ArchifyIdMapping; receipt: { status: string; issues: readonly DiagramValidationIssue[] } }
  /** HTML artifacts are hundreds of kilobytes each, so only the most recently used renders stay
   * cached instead of accumulating one entry per diagram in the project. */
  const MAX_CACHED_RENDERS = 6;
  const rendered = new Map<string, RenderedDiagram>();
  const cacheRender = (diagramId: string, entry: RenderedDiagram): void => {
    rendered.delete(diagramId);
    rendered.set(diagramId, entry);
    while (rendered.size > MAX_CACHED_RENDERS) {
      const oldest = rendered.keys().next().value;
      if (oldest === undefined) break;
      rendered.delete(oldest);
    }
  };
  /**
   * Records what one evidence read handed over, posts it to the page and persists it so the next
   * session can still explain why a diagram looks the way it does.
   */
  const captureEvidence = async (trigger: "initialize" | "diagram", packaged: ProjectEvidencePackage): Promise<void> => {
    const summary = summarizeProjectEvidence(packaged, { trigger, generatedAt: (options.now ?? Date.now)() });
    lastEvidence = summary;
    post({ type: "projectEvidenceSummary", summary });
    try {
      await options.store.writeEvidenceSummary?.(summary);
    } catch {
      // The record is a diagnostic; failing to store it must never fail the run that produced it.
    }
  };

  const projectAiProvider = options.projectAiProvider ? {
    id: options.projectAiProvider.id,
    generate: (request: Parameters<ProjectAiProvider["generate"]>[0], signal: AbortSignal) => options.projectAiProvider!.generate({
      ...request,
      ...(selectedAiCli ? { agent: selectedAiCli } : {}),
      ...(selectedAiModel ? { model: selectedAiModel } : {}),
      ...(selectedAiReasoning ? { reasoningEffort: selectedAiReasoning } : {}),
      ...(selectedAiSpeed ? { speed: selectedAiSpeed } : {})
    }, signal)
  } satisfies ProjectAiProvider : undefined;

  const initializationService = new ProjectInitializationService({
    prepareEvidence: async (signal, onProgress) => {
      const packaged = await options.readEvidence({}, signal, onProgress);
      await captureEvidence("initialize", packaged);
      return packaged;
    },
    generate: async (evidence, signal, _onProgress, onOutput) => {
      if (!projectAiProvider) throw new Error("Project AI is unavailable: enable and select an available AI CLI in the input area first.");
      const service = new ProjectAiGenerationService(projectAiProvider, options.projectAiLimits?.() ?? {});
      // `onOutput` is the single text sink: one activity event becomes exactly one output line.
      return service.generate(evidence, {
        signal,
        onEvent: (event) => onOutput(activityLine(event))
      });
    },
    persist: async (output, signal, onProgress) => {
      const intent = output.intent;
      const diagrams = output.diagrams ?? [];
      if (!intent && !diagrams.length) throw new Error("AI did not return a savable project semantic model.");
      if (intent) {
        const intentErrors = validateProjectIntent(intent);
        if (intentErrors.length) throw new Error(`Generated Project Intent is invalid: ${intentErrors.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`);
      }
      for (const diagram of diagrams) {
        const errors = validateProjectDiagram(diagram).filter((issue) => issue.severity === "error");
        if (errors.length) throw new Error(`Generated diagram '${diagram.id}' is invalid: ${errors.slice(0, 3).map((issue) => issue.message).join("; ")}`);
      }
      const canSaveDefinition = options.store.readDefinition !== undefined && options.store.writeDefinition !== undefined;
      const total = Number(Boolean(intent)) + diagrams.length + Number(canSaveDefinition);
      let completed = 0;
      const saved = (label: string): void => { completed += 1; onProgress({ phase: "saving", completed, total, message: `Saved ${label}` }); };
      const checkActive = (): void => { if (signal.aborted) throw new Error("Project initialization was cancelled."); };
      onProgress({ phase: "saving", completed, total, message: `Saving ${total} generated file${total === 1 ? "" : "s"}…` });
      checkActive();
      if (intent) {
        if (!options.store.writeIntent) throw new Error("Project Intent storage is unavailable.");
        await options.store.writeIntent(intent);
        generatedIntent = intent;
        saved(".dext/project-intent.json");
      }
      for (const diagram of diagrams) {
        checkActive();
        if (!options.store.writeDiagram) throw new Error("Project diagram storage is unavailable.");
        await options.store.writeDiagram(diagram);
        saved(`.dext/diagrams/${diagram.id}.json`);
      }
      if (canSaveDefinition) {
        checkActive();
        const definition = await options.store.readDefinition!();
        const result = await options.store.writeDefinition!({
          ...definition,
          knowledge: { ...definition.knowledge, enabled: true, ...(intent ? { initialized: true } : {}) }
        }, definition.version);
        if (result.status === "conflict") throw new Error("Project settings changed during initialization. Please retry.");
        saved(".dext/project.json");
      }
    },
    ...(options.now ? { now: options.now } : {})
  }, draftQueue);

  const readDiagrams = async (): Promise<ProjectDiagram[]> => sortProjectDiagrams(await (options.store.readDiagrams?.() ?? []));

  const renderDiagram = async (diagramId: string, version?: number, renderOptions: { refresh?: boolean } = {}): Promise<void> => {
    try {
      const diagrams = await readDiagrams();
      const diagram = diagrams.find((candidate) => candidate.id === diagramId);
      if (!diagram) { post({ type: "projectDiagramRenderFailed", diagramId, error: "The diagram no longer exists." }); return; }
      if (version !== undefined && diagram.version !== version) {
        post({ type: "projectDiagramRenderFailed", diagramId, requestedVersion: version, actualVersion: diagram.version, error: "The diagram version changed. Select it again." });
        return;
      }
      const registry = options.diagramRegistry;
      if (!registry) { post({ type: "projectDiagramRenderFailed", diagramId, error: "Archify runtime is not registered." }); return; }
      if (renderOptions.refresh) { rendered.delete(diagramId); registry.cancel(diagramId); }
      const engine = await registry.engineInfo();
      if (!engine.available) { post({ type: "projectDiagramRenderFailed", diagramId, error: engine.reason ?? "Archify runtime is unavailable." }); return; }
      const cached = rendered.get(diagramId);
      if (cached && cached.version === diagram.version && cached.engineVersion === engine.version && !renderOptions.refresh) {
        post({ type: "projectDiagramRendered", diagramId, requestedVersion: version, displayedVersion: cached.version, usedLastGood: false, html: cached.html, mapping: cached.mapping, nodes: diagramNodeDetails(diagram), receipt: cached.receipt, updatedAt: diagram.updatedAt });
        return;
      }
      const outcome = await registry.render(diagram, { format: "html" });
      if (outcome.status === "cancelled") return;
      if (outcome.status === "failed" || !outcome.artifact) {
        if (outcome.usedLastGood && outcome.snapshot && outcome.artifact) {
          // Show the same diagram's last successful render, clearly labelled with its actual version.
          const snapshotDiagram = outcome.snapshot.diagram;
          let mapping: ArchifyIdMapping | undefined;
          try {
            const adapter = registry.list()[0];
            if (adapter) mapping = mappingOf(await adapter.transform(snapshotDiagram));
          } catch { mapping = undefined; }
          post({
            type: "projectDiagramRendered",
            diagramId,
            requestedVersion: diagram.version,
            displayedVersion: snapshotDiagram.version,
            usedLastGood: true,
            html: outcome.artifact.content,
            mapping,
            nodes: diagramNodeDetails(snapshotDiagram),
            receipt: { status: outcome.receipt.status, issues: outcome.receipt.issues },
            updatedAt: snapshotDiagram.updatedAt,
            error: outcome.error
          });
          return;
        }
        post({ type: "projectDiagramRenderFailed", diagramId, requestedVersion: diagram.version, error: outcome.error ?? "Archify rendering failed.", issues: outcome.receipt.issues });
        return;
      }
      let mapping: ArchifyIdMapping | undefined;
      try {
        const adapter = registry.list()[0];
        if (adapter) mapping = mappingOf(await adapter.transform(diagram));
      } catch { mapping = undefined; }
      const receipt = { status: outcome.receipt.status, issues: outcome.receipt.issues };
      const cachedEntry: RenderedDiagram = { version: diagram.version, engineVersion: engine.version, html: outcome.artifact.content as string, receipt };
      if (mapping) cachedEntry.mapping = mapping;
      cacheRender(diagramId, cachedEntry);
      post({ type: "projectDiagramRendered", diagramId, requestedVersion: version, displayedVersion: diagram.version, usedLastGood: false, html: outcome.artifact.content, mapping, nodes: diagramNodeDetails(diagram), receipt, updatedAt: diagram.updatedAt });
    } catch (error) {
      post({ type: "projectDiagramRenderFailed", diagramId, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const generateDiagram = async (request: { requirement: string; kind?: string; diagramId?: string }): Promise<void> => {
    if (generating) { post({ type: "projectDiagramGenerateFailed", error: "A diagram generation task is already running." }); return; }
    const requirement = request.requirement.trim();
    if (!requirement) { post({ type: "projectDiagramGenerateFailed", error: "Describe the business requirement for the diagram first." }); return; }
    const kind = request.kind && (["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as string[]).includes(request.kind)
      ? request.kind as ProjectDiagramKind : undefined;
    if (!projectAiProvider) { post({ type: "projectDiagramGenerateFailed", error: "Project AI is unavailable: select an available AI CLI first." }); return; }
    generating = true;
    generationError = undefined;
    const signal = tasks.begin("generate");
    post({ type: "projectDiagramGenerating", active: true, message: "Reading bounded evidence…" });
    try {
      const diagrams = await readDiagrams();
      const target = request.diagramId ? diagrams.find((candidate) => candidate.id === request.diagramId) : undefined;
      if (request.diagramId && !target) throw new Error("The diagram to update does not exist.");
      const evidence = await options.readEvidence({ requirement }, signal, (progress) => {
        post({ type: "projectDiagramProgress", message: progress.message ?? "Preparing evidence…", phase: progress.phase });
      });
      await captureEvidence("diagram", evidence);
      post({ type: "projectDiagramProgress", message: "Calling the AI to generate the diagram…" });
      const service = new ProjectAiGenerationService(projectAiProvider, options.projectAiLimits?.() ?? {});
      const result = await service.generateDiagram(evidence, {
        requirement,
        ...(kind ? { kind } : {}),
        ...(target ? { target: { id: target.id, title: target.title, kind: target.kind, version: target.version } } : {})
      }, {
        signal: signal,
        onEvent: (event) => post({ type: "projectDiagramProgress", message: activityLine(event).trim() || "Generating diagram…" })
      });
      let diagram = result.diagram;
      if (!target) {
        const used = new Set(diagrams.map((candidate) => candidate.id));
        if (used.has(diagram.id)) {
          let suffix = 2;
          while (used.has(`${diagram.id}-${suffix}`)) suffix += 1;
          diagram = { ...diagram, id: `${diagram.id}-${suffix}` };
        }
      }
      if (!options.store.writeDiagram) throw new Error("Project diagram storage is unavailable.");
      await options.store.writeDiagram(diagram);
      post({ type: "projectDiagramGenerated", diagram: describeProjectDiagram(diagram), updated: Boolean(target) });
      await renderDiagram(diagram.id, diagram.version, { refresh: true });
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
      post({ type: "projectDiagramGenerateFailed", error: generationError });
    } finally {
      generating = false;
      tasks.finish("generate", signal);
      post({ type: "projectDiagramGenerating", active: false });
    }
  };

  const exportDiagram = async (request: { diagramId: string; version?: number; format?: string; content?: string }): Promise<void> => {
    try {
      const format = request.format === "svg" ? "svg" as const : request.format === "html" ? "html" as const : undefined;
      if (!format) { post({ type: "projectDiagramExportFailed", error: `Unsupported export format '${request.format ?? ""}'.` }); return; }
      const resolved = resolveDiagramTarget(await readDiagrams(), request.diagramId, request.version);
      if (!resolved.ok || !resolved.diagram) { post({ type: "projectDiagramExportFailed", error: resolved.reason ?? "The diagram no longer exists." }); return; }
      const diagram = resolved.diagram;
      const cached = rendered.get(diagram.id);
      let content: string;
      if (format === "html") {
        if (!cached || cached.version !== diagram.version) { post({ type: "projectDiagramExportFailed", error: "Render the current diagram version successfully before exporting." }); return; }
        content = cached.html;
      } else {
        if (!cached || !isDiagramExportPayload("svg", request.content, request.version, cached.version)) { post({ type: "projectDiagramExportFailed", error: "The exported content does not match the displayed diagram version." }); return; }
        content = request.content as string;
        if (new TextEncoder().encode(content).byteLength > 16 * 1024 * 1024) { post({ type: "projectDiagramExportFailed", error: "The SVG export exceeds the 16 MiB limit." }); return; }
      }
      if (format === "html" && !isDiagramExportPayload("html", content, request.version, cached?.version)) { post({ type: "projectDiagramExportFailed", error: "The HTML export content is incomplete." }); return; }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(options.rootUri, `${safeFileName(diagram.title)}.${format}`),
        saveLabel: format === "html" ? "Export standalone HTML" : "Export full SVG"
      });
      if (!target) { post({ type: "projectDiagramExported", format, cancelled: true }); return; }
      await vscode.workspace.fs.writeFile(target, textEncoder.encode(content));
      post({ type: "projectDiagramExported", format, fileName: target.fsPath.split(/[\\/]/).pop() ?? "" });
    } catch (error) {
      post({ type: "projectDiagramExportFailed", error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * Opens one evidence entry the clicked node itself declares. The webview can never name an
   * arbitrary path, and the reader chooses when to leave the diagram.
   */
  const openDiagramEvidence = async (diagramId: string, nodeId: string, path: string, line?: number): Promise<void> => {
    try {
      const diagrams = await readDiagrams();
      const diagram = diagrams.find((candidate) => candidate.id === diagramId);
      const node = diagram?.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || !options.openEvidence) return;
      const evidence = node.evidence.find((entry) => entry.path === path && isAllowedEvidencePath(entry.path));
      if (!evidence) return;
      await options.openEvidence(evidence.path, line && line > 0 ? line : evidence.line);
    } catch {
      // Opening evidence is best effort; an unreadable path never breaks the viewer.
    }
  };

  /**
   * Opens a file the evidence record actually lists. The page can never name an arbitrary path: the
   * reader clicks a path the model was given, and only then does Dext leave for the editor.
   */
  const openEvidencePath = async (path: string): Promise<void> => {
    try {
      if (!options.openEvidence || !lastEvidence) return;
      const known = lastEvidence.paths.includes(path) || lastEvidence.excerpted.includes(path);
      if (!known || !isAllowedEvidencePath(path)) return;
      await options.openEvidence(path);
    } catch {
      // Opening a file is best effort; an unreadable path never breaks the page.
    }
  };

  const load = async (): Promise<ProjectPanelData> => {
    const [objects, architecture, definition, persistedIntent, persistedDiagrams, persistedEvidence] = await Promise.all([
      options.store.readObjects(),
      options.store.readArchitecture(),
      options.store.readDefinition?.(),
      options.store.readIntent?.(),
      options.store.readDiagrams?.(),
      options.store.readEvidenceSummary?.()
    ]);
    lastEvidence = persistedEvidence ?? lastEvidence;
    if (!hydrated) {
      hydrated = true;
      const hydration = options.store.readInitialization
        ? await options.store.readInitialization()
        : { markedInitialized: false, hasIntent: Boolean(persistedIntent), diagramCount: persistedDiagrams?.length ?? 0 };
      initializationService.hydrate(hydration);
    }
    if (persistedIntent) generatedIntent = persistedIntent;
    const intent = generatedIntent ?? persistedIntent;
    const diagrams = sortProjectDiagrams(persistedDiagrams ?? []);
    const initialization = initializationService.snapshot;
    const engine = options.diagramRegistry ? await options.diagramRegistry.engineInfo() : undefined;
    const selected = diagrams.find((diagram) => diagram.kind === "architecture") ?? diagrams[0];
    const ruleReport = architectureRuleReport(diagrams, { ...(architecture.diagramId ? { diagramId: architecture.diagramId } : {}), rules: architecture.rules ?? [] });
    selectedAiCli = definition?.ai.cli && (options.aiCli ?? []).some((candidate) => candidate.id === definition.ai.cli)
      ? definition.ai.cli : undefined;
    const selectedProfile = (options.aiCli ?? []).find((candidate) => candidate.id === selectedAiCli);
    selectedAiModel = definition?.ai.model && selectedProfile?.models?.some((model) => model.id === definition.ai.model)
      ? definition.ai.model : undefined;
    const selectedModel = selectedProfile?.models?.find((model) => model.id === selectedAiModel);
    selectedAiReasoning = definition?.ai.reasoningEffort && selectedModel?.reasoningEfforts?.includes(definition.ai.reasoningEffort)
      ? definition.ai.reasoningEffort : undefined;
    selectedAiSpeed = definition?.ai.speed && selectedModel?.speedTiers?.includes(definition.ai.speed)
      ? definition.ai.speed : undefined;
    const retiredScanRoots = legacyScanRoots(definition);
    return {
      overview: {
        name: options.name,
        root: options.root,
        objects: objects.length,
        accepted: objects.filter((object) => object.confirmation === "accepted").length,
        drafts: objects.filter((object) => object.confirmation === "draft").length,
        needsVerification: objects.filter((object) => object.validity !== "current").length,
        initialization,
        ...(retiredScanRoots.length ? { legacyScanRoots: retiredScanRoots } : {}),
        ...(options.aiCli?.length ? {
          aiCli: options.aiCli,
          ...(selectedAiCli ? { selectedAiCli } : {}),
          ...(selectedAiModel ? { selectedAiModel } : {}),
          ...(selectedAiReasoning ? { selectedAiReasoning } : {}),
          ...(selectedAiSpeed ? { selectedAiSpeed } : {})
        } : {})
      },
      objects,
      drafts: draftQueue.list(),
      ...(intent ? {
        knowledge: {
          brief: intent.brief.summary,
          contexts: intent.contexts.map((item) => ({ id: item.id, name: item.displayName ?? item.canonicalName, description: item.purpose, evidence: item.evidence.map((entry) => entry.path) })),
          terms: intent.terms.map((item) => ({ id: item.id, canonical: item.canonicalName, aliases: item.aliases, definition: item.definition })),
          flows: intent.flows.map((item) => ({ id: item.id, name: item.displayName ?? item.canonicalName, steps: item.steps.map((step) => step.label) }))
        }
      } : {}),
      architecture: {
        diagrams: diagrams.map(describeProjectDiagram),
        ...(selected ? { selected: describeProjectDiagram(selected) } : {}),
        ...(lastEvidence ? { evidence: lastEvidence } : {}),
        knowledgeUninitialized: initialization.status === "uninitialized",
        ...(engine ? { engine } : {}),
        ...(generating ? { generating: true } : {}),
        ...(generationError ? { generationError } : {}),
        decisions: architecture.decisions,
        // Declared rules are evaluated against the saved diagram they were authored for, so the page
        // can show boundaries that the diagram currently breaks (and why nothing was evaluated).
        ...(ruleReport ? {
          rules: ruleReport.rules,
          violations: ruleReport.violations,
          ...(ruleReport.note ? { rulesNote: ruleReport.note } : {})
        } : {})
      }
    };
  };

  return {
    load,
    subscribe: (listener: (message: ProjectPanelMessage) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialization: () => initializationService.snapshot,
    onInitializationChange: (listener: (state: ProjectInitializationState) => void): (() => void) => initializationService.subscribe(listener),
    renderDiagram,
    generateDiagram,
    exportDiagram,
    openDiagramEvidence,
    openEvidencePath,
    cancelDiagramWork: (): void => {
      options.diagramRegistry?.cancelAll();
      tasks.cancelAll();
    },
    initialize: async (): Promise<ProjectPanelData> => {
      // Start synchronously so the editor can render the running snapshot before this async method
      // reaches its first await.
      const task = initializationService.start();
      // Keep a rejection handler attached even if the optimistic running render fails before the
      // normal await below.
      void task.promise.catch(() => undefined);
      const state = await task.promise;
      if (state.status === "cancelled") throw new Error("Project initialization was cancelled.");
      if (state.status !== "completed") throw new Error(state.error ?? "Project initialization failed.");
      return load();
    },
    ...(options.store.readDefinition && options.store.writeDefinition ? {
      setAiCli: async (cli?: string): Promise<void> => {
        const definition = await options.store.readDefinition!();
        const valid = !cli || (options.aiCli ?? []).some((candidate) => candidate.id === cli);
        if (!valid) throw new Error("Choose a configured AI CLI.");
        const saved = await options.store.writeDefinition!({
          ...definition,
          ai: cli ? { cli: cli as "codex" | "claude" | "deepseek-harness" } : {}
        }, definition.version);
        if (saved.status === "conflict") throw new Error("Project settings changed before the AI CLI could be saved. Please retry.");
        selectedAiCli = cli;
        selectedAiModel = undefined;
        selectedAiReasoning = undefined;
        selectedAiSpeed = undefined;
      },
      setAiModel: async (model?: string): Promise<void> => {
        const definition = await options.store.readDefinition!();
        const cli = definition.ai.cli;
        const profile = (options.aiCli ?? []).find((candidate) => candidate.id === cli);
        const valid = !model || Boolean(profile?.models?.some((candidate) => candidate.id === model));
        if (!valid) throw new Error("Choose a model provided by the selected AI CLI.");
        const saved = await options.store.writeDefinition!({
          ...definition,
          ai: cli ? { cli, ...(model ? { model } : {}) } : {}
        }, definition.version);
        if (saved.status === "conflict") throw new Error("Project settings changed before the model could be saved. Please retry.");
        selectedAiCli = cli;
        selectedAiModel = model;
        selectedAiReasoning = undefined;
        selectedAiSpeed = undefined;
      },
      setAiReasoning: async (reasoningEffort?: string): Promise<void> => {
        const definition = await options.store.readDefinition!();
        const cli = definition.ai.cli;
        const profile = (options.aiCli ?? []).find((candidate) => candidate.id === cli);
        const model = profile?.models?.find((candidate) => candidate.id === (definition.ai.model ?? selectedAiModel));
        const valid = !reasoningEffort || Boolean(model?.reasoningEfforts?.includes(reasoningEffort));
        if (!valid) throw new Error("Choose a reasoning level provided by the selected model.");
        const ai = cli ? { cli, ...(definition.ai.model ? { model: definition.ai.model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(definition.ai.speed ? { speed: definition.ai.speed } : {}) } : {};
        const saved = await options.store.writeDefinition!({ ...definition, ai }, definition.version);
        if (saved.status === "conflict") throw new Error("Project settings changed before reasoning could be saved. Please retry.");
        selectedAiReasoning = reasoningEffort;
      },
      setAiSpeed: async (speed?: string): Promise<void> => {
        const definition = await options.store.readDefinition!();
        const cli = definition.ai.cli;
        const profile = (options.aiCli ?? []).find((candidate) => candidate.id === cli);
        const model = profile?.models?.find((candidate) => candidate.id === (definition.ai.model ?? selectedAiModel));
        const valid = !speed || Boolean(model?.speedTiers?.includes(speed));
        if (!valid) throw new Error("Choose a speed tier provided by the selected model.");
        const ai = cli ? { cli, ...(definition.ai.model ? { model: definition.ai.model } : {}), ...(definition.ai.reasoningEffort ? { reasoningEffort: definition.ai.reasoningEffort } : {}), ...(speed ? { speed } : {}) } : {};
        const saved = await options.store.writeDefinition!({ ...definition, ai }, definition.version);
        if (saved.status === "conflict") throw new Error("Project settings changed before speed could be saved. Please retry.");
        selectedAiSpeed = speed;
      }
    } : {})
  };
}
