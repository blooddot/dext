import { createHash } from "node:crypto";
import * as vscode from "vscode";
import type { ProjectInitializationProgressListener, ProjectInitializationState } from "../contracts/lifecycle.js";
import type { ProjectArchitectureDecision, ProjectDiagramSummary } from "../contracts/projectArchitectureTypes.js";
import { validateProjectDiagram, type ProjectDiagram, type ProjectDiagramKind } from "../contracts/projectDiagram.js";
import { projectEvidenceSettingsSchema, projectPromptLimits, type ProjectEvidenceSettings } from "../contracts/projectEvidenceSettings.js";
import { validateProjectIntent, type ProjectIntent } from "../contracts/projectIntent.js";
import type { ProjectObject } from "../contracts/projectKnowledge.js";
import { projectSettingsSchema, projectWorkspaceSettingsFromDefinition, projectWorkspaceSettingsSchema, type ProjectSettings, type ProjectWorkspaceSettings } from "../contracts/projectSettings.js";
import type { ProjectEditorDataSource, ProjectPanelMessage, ProjectReaderEvidenceRequest, ProjectReaderExportRequest, ProjectReaderRenderRequest } from "../contracts/reader.js";
import { architectureRuleReport, type ArchitectureRule } from "../knowledge/projectArchitecture.js";
import { reconcileProjectModel } from "../knowledge/projectModelEvolution.js";
import { buildProjectTopics, checkProjectTopics, topicDiagramRequirement, topicFingerprint, type ProjectTopicCheck } from "../knowledge/projectTopics.js";
import type { ProjectPanelData } from "../presentation/projectPanel.js";
import type { ArchifyIdMapping } from "./diagrams/archifyAdapter.js";
import type { ProjectDiagramAdapterRegistry } from "./diagrams/projectDiagramRegistry.js";
import { DiagramTaskRegistry, isAllowedEvidencePath, isDiagramExportPayload } from "./diagrams/projectDiagramViewer.js";
import {
isExcludedProjectEvidencePath,
isProjectEvidencePath,
ProjectAiGenerationService,
summarizeProjectEvidence,
type ProjectAiActivityEvent,
type ProjectAiProvider,
type ProjectEvidencePackage,
type ProjectEvidenceSummary
} from "./generation/projectAiGeneration.js";
import { textDecoder } from "./indexing/workspaceEvidence.js";
import type { ProjectDefinition, ProjectSaveResult } from "./persistence/projectStore.js";
import { textEncoder } from "./persistence/vscodeProjectFileHost.js";
import { ProjectInitializationService } from "./projectService.js";


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
  readEvidence(options: { mode?: "index" | "topic"; requirement?: string; preferredPaths?: readonly string[]; modulePaths?: readonly string[] }, signal: AbortSignal, onProgress: ProjectInitializationProgressListener): Promise<ProjectEvidencePackage>;
  evidenceSnapshot?: (path: string) => Promise<{ contentHash: string } | undefined>;
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
  onWorkspaceSettingsChanged?: (settings: ProjectWorkspaceSettings) => Promise<void> | void;
  now?: () => number;
}


export const DIAGRAM_KIND_RANK: Record<ProjectDiagramKind, number> = {
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


export function sortProjectDiagrams(diagrams: readonly ProjectDiagram[]): ProjectDiagram[] {
  return [...diagrams].sort((left, right) => DIAGRAM_KIND_RANK[left.kind] - DIAGRAM_KIND_RANK[right.kind]
    || right.updatedAt - left.updatedAt
    || left.title.localeCompare(right.title));
}


export function effectiveProjectEvidenceSettings(definition: ProjectDefinition | undefined): ProjectEvidenceSettings {
  if (definition?.evidence) return definition.evidence;
  return { depth: "standard", include: [] };
}


export function effectiveProjectWorkspaceSettings(definition: ProjectDefinition | undefined): ProjectWorkspaceSettings {
  return projectWorkspaceSettingsFromDefinition(definition);
}


export function safeFileName(title: string): string {
  const sanitized = [...title].map((character) => /[\\/:*?"<>|]/.test(character) || character.charCodeAt(0) < 32 ? "-" : character).join("");
  return sanitized.trim().slice(0, 80) || "diagram";
}


export function activityLine(event: ProjectAiActivityEvent): string {
  const value = event.text ?? "";
  const title = event.title ?? "";
  return value || title ? `${title && value ? `${title}: ` : title}${value}\n` : "";
}


export function mappingOf(document: unknown): ArchifyIdMapping | undefined {
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
  const listeners = new Set<(message: ProjectPanelMessage) => void>();
  const post = (message: ProjectPanelMessage): void => { for (const listener of listeners) listener(message); };
  /**
   * Persists the evidence record for diagnostics, including unsuccessful generation attempts.
   */
  const captureEvidence = async (trigger: "initialize" | "diagram", packaged: ProjectEvidencePackage): Promise<void> => {
    const summary = summarizeProjectEvidence(packaged, { trigger, generatedAt: (options.now ?? Date.now)() });
    lastEvidence = summary;
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
      if (options.store.readDefinition && !(await options.store.readDefinition()).evidence) {
        throw new Error("Configure and save Evidence reading in Overview > Project settings before building the project index.");
      }
      signal.throwIfAborted();
      const packaged = await options.readEvidence({ mode: "index" }, signal, onProgress);
      await captureEvidence("initialize", packaged);
      return packaged;
    },
    generate: async (evidence, signal, _onProgress, onOutput) => {
      if (!projectAiProvider) throw new Error("Project AI is unavailable: enable and select an available AI CLI in the input area first.");
      const service = new ProjectAiGenerationService(projectAiProvider, projectPromptLimits(evidence.selection.evidenceChars));
      // `onOutput` is the single text sink: one activity event becomes exactly one output line.
      return service.generateIndex(evidence, {
        signal,
        onEvent: (event) => onOutput(activityLine(event))
      });
    },
    persist: async (output, signal, onProgress) => {
      signal.throwIfAborted();
      const intent = output.intent ? reconcileProjectModel(output.intent,
        await options.store.readIntent?.(), await options.store.readDiagrams?.() ?? []) : undefined;
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
  });

  const readDiagrams = async (): Promise<ProjectDiagram[]> => sortProjectDiagrams(await (options.store.readDiagrams?.() ?? []));

  const generateDiagram = async (request: { requirement: string; kind?: string; diagramId?: string; preferredPaths?: readonly string[]; modulePaths?: readonly string[]; topicId?: string; topicBasis?: string }): Promise<void> => {
    if (generating || initializationService.snapshot.status === "running") { post({ type: "projectDiagramGenerateFailed", error: "A diagram generation task is already running." }); return; }
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
      const target = request.diagramId ? diagrams.find((candidate) => candidate.id === request.diagramId)
        : request.topicId ? diagrams.filter(candidate => candidate.metadata?.topicId === request.topicId && candidate.metadata?.topicAnalysis === 1).sort((a,b) => b.updatedAt - a.updatedAt)[0] : undefined;
      if (request.diagramId && !target) throw new Error("The diagram to update does not exist.");
      const evidence = await options.readEvidence({ requirement, ...(request.topicId ? { mode: "topic" as const } : {}), ...(request.preferredPaths ? { preferredPaths: request.preferredPaths } : {}), ...(request.modulePaths ? { modulePaths: request.modulePaths } : {}) }, signal, (progress) => {
        post({ type: "projectDiagramProgress", message: progress.message ?? "Preparing evidence…", phase: progress.phase });
      });
      await captureEvidence("diagram", evidence);
      post({ type: "projectDiagramProgress", message: "Calling the AI to generate the diagram…" });
      const service = new ProjectAiGenerationService(projectAiProvider, projectPromptLimits(evidence.selection.evidenceChars));
      const result = await service.generateDiagram(evidence, {
        requirement,
        ...(request.topicId ? { maxNodes: kind === "workflow" ? 8 : 10, explainTopic: true } : {}),
        ...(kind ? { kind } : {}),
        ...(target ? { target: { id: target.id, title: target.title, kind: target.kind, version: target.version } } : {})
      }, {
        signal: signal,
        onEvent: (event) => post({ type: "projectDiagramProgress", message: activityLine(event).trim() || "Generating diagram…" })
      });
      let diagram = result.diagram;
      if (request.topicId) {
        const current = (await readTopics()).find(topic => topic.id === request.topicId);
        if (!current || current.basis !== request.topicBasis) throw new Error("The project model changed during analysis. Reopen the module and retry.");
        diagram = { ...diagram, nodes: diagram.nodes.map(node => ({ ...node, semanticIds: [...new Set([node.id, ...node.semanticIds])] })),
          metadata: { ...diagram.metadata, topicId: request.topicId, topicAnalysis: 1, topicBasis: request.topicBasis ?? "" } };
      }
      if (!target) {
        const used = new Set(diagrams.map((candidate) => candidate.id));
        if (used.has(diagram.id)) {
          let suffix = 2;
          while (used.has(`${diagram.id}-${suffix}`)) suffix += 1;
          diagram = { ...diagram, id: `${diagram.id}-${suffix}` };
        }
      }
      if (!options.store.writeDiagram) throw new Error("Project diagram storage is unavailable.");
      if (signal.aborted) return;
      await options.store.writeDiagram(diagram);
      if (signal.aborted) return;
      post({ type: "projectDiagramGenerated", diagram: describeProjectDiagram(diagram), document: diagram, topics: await readTopics(), updated: Boolean(target) });
    } catch (error) {
      generationError = error instanceof Error ? error.message : String(error);
      post({ type: "projectDiagramGenerateFailed", error: generationError });
    } finally {
      generating = false;
      tasks.finish("generate", signal);
      post({ type: "projectDiagramGenerating", active: false });
    }
  };

  let topicChecks: ProjectTopicCheck[] = [];
  let checkingKnowledge = false;
  const readTopics = async () => {
    const intent = await options.store.readIntent?.() ?? generatedIntent;
    return intent ? buildProjectTopics(intent, await readDiagrams()) : [];
  };
  const checkKnowledge = async (): Promise<void> => {
    if (checkingKnowledge) return;
    checkingKnowledge = true;
    try {
      let bytes = 0;
      let files = 0;
      const snapshot = options.evidenceSnapshot ?? (async (path: string) => {
        if (!isAllowedEvidencePath(path) || isExcludedProjectEvidencePath(path)) throw new Error("Unsupported evidence path.");
        if (++files > 1000) throw new Error("Evidence file budget exceeded.");
        const uri = vscode.Uri.joinPath(options.rootUri, ...path.split("/"));
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > 262_144 || bytes + stat.size > 32_000_000) throw new Error("Evidence read budget exceeded.");
          bytes += stat.size;
          const content = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
          return { contentHash: createHash("sha256").update(content).digest("hex") };
        } catch (error) {
          if ((error as { code?: string }).code === "FileNotFound") return undefined;
          throw error;
        }
      });
      const checked = await checkProjectTopics(await readTopics(), snapshot, options.now?.() ?? Date.now());
      // A regenerated intent may have arrived while files were being read.
      const current = await readTopics();
      topicChecks = checked.filter((check) => current.some((topic) => topic.id === check.id && topicFingerprint(topic) === check.fingerprint));
      post({ type: "projectKnowledgeChecked", checks: topicChecks });
    } catch (error) {
      post({ type: "projectKnowledgeChecked", error: error instanceof Error ? error.message : String(error) });
    } finally { checkingKnowledge = false; }
  };
  const openTopicEvidence = async (topicId: string, index: number): Promise<void> => {
    if (!Number.isInteger(index) || index < 0) return;
    const entry = (await readTopics()).find((topic) => topic.id === topicId)?.evidence[index];
    if (!entry || !isAllowedEvidencePath(entry.path) || isExcludedProjectEvidencePath(entry.path)) return;
    try { await options.openEvidence?.(entry.path, entry.line); }
    catch { /* Missing sources remain visible in the evidence check. */ }
  };
  const generateTopicDiagram = async (topicId: string): Promise<void> => {
    const topic = (await readTopics()).find((item) => item.id === topicId);
    if (!topic) { post({ type: "projectDiagramGenerateFailed", error: "The saved topic no longer exists. Reopen Knowledge." }); return; }
    if (topic.kind === "system_context" || topic.kind === "containers") { post({ type: "projectDiagramGenerateFailed", error: "Update the project map to refresh its system boundaries and runtime units." }); return; }
    await generateDiagram({ requirement: topicDiagramRequirement(topic), kind: topic.kind === "flow" ? "workflow" : "architecture",
      preferredPaths: [...new Set([...topic.entryPoints.filter(isProjectEvidencePath), ...(topic.sourceFiles ?? topic.evidence.map(entry => entry.path))])],
      ...(topic.sourceFiles ? { modulePaths: topic.sourceFiles } : {}), topicId, ...(topic.basis ? { topicBasis: topic.basis } : {}) });
  };

  const readerDiagram = async (id: string, updatedAt: number) => {
    const saved = await readDiagrams();
    const intent = await options.store.readIntent?.() ?? generatedIntent;
    const derived = intent ? buildProjectTopics(intent).flatMap((topic) => topic.diagram ? [topic.diagram] : []) : [];
    return [...saved, ...derived].find((diagram) => diagram.id === id && diagram.updatedAt === updatedAt);
  };
  const renderReaderDiagram = async (request: ProjectReaderRenderRequest): Promise<void> => {
    const signal = tasks.begin("reader-render");
    try {
      const diagram = await readerDiagram(request.diagramId, request.updatedAt);
      if (!diagram) throw new Error("This diagram changed. Reopen the topic.");
      const adapter = options.diagramRegistry?.list()[0];
      if (!adapter || !adapter.supports(diagram.kind)) throw new Error("The interactive renderer is unavailable.");
      const document = await adapter.transform(diagram, signal);
      if (signal.aborted) return;
      const artifact = await adapter.render(document, { format: "html", operationId: `reader:${request.requestId}`, signal });
      if (signal.aborted) return;
      const receipt = await adapter.validate(document, signal);
      if (receipt.status === "failed") throw new Error(receipt.issues.map((issue) => issue.message).join("; "));
      if (artifact.format !== "html" || typeof artifact.content !== "string" || artifact.content.length > 16 * 1024 * 1024) throw new Error("The interactive render is invalid or too large.");
      if (!signal.aborted) post({ type: "projectReaderRendered", ...request, html: artifact.content, mapping: mappingOf(document) });
    } catch (error) {
      if (!signal.aborted) post({ type: "projectReaderRendered", ...request, error: error instanceof Error ? error.message : String(error) });
    } finally { tasks.finish("reader-render", signal); }
  };
  const openReaderEvidence = async (request: ProjectReaderEvidenceRequest): Promise<void> => {
    if (!Number.isInteger(request.evidenceIndex) || request.evidenceIndex < 0) return;
    const diagram = await readerDiagram(request.diagramId, request.updatedAt);
    const element = request.elementKind === "node" ? diagram?.nodes.find((node) => node.id === request.elementId)
      : diagram?.relations.find((relation) => relation.id === request.elementId);
    const entry = element?.evidence[request.evidenceIndex];
    if (!entry || !isAllowedEvidencePath(entry.path) || isExcludedProjectEvidencePath(entry.path)) return;
    try { await options.openEvidence?.(entry.path, entry.line); } catch { /* Best effort for deleted files. */ }
  };
  const exportReaderDiagram = async (request: ProjectReaderExportRequest): Promise<void> => {
    try {
      const diagram = await readerDiagram(request.diagramId, request.updatedAt);
      if (!diagram) throw new Error("The diagram changed. Reopen the topic before exporting.");
      if (!isDiagramExportPayload("svg", request.content, diagram.version, diagram.version)) throw new Error("Render the diagram before exporting SVG.");
      if (textEncoder.encode(request.content).byteLength > 16 * 1024 * 1024) throw new Error("The SVG export exceeds the 16 MiB limit.");
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(options.rootUri, `${safeFileName(diagram.title)}.svg`), saveLabel: "Export full SVG" });
      if (!target) { post({ type: "projectDiagramExported", format: "svg", cancelled: true }); return; }
      await vscode.workspace.fs.writeFile(target, textEncoder.encode(request.content));
      post({ type: "projectDiagramExported", format: "svg", fileName: target.fsPath.split(/[\\/]/).pop() ?? "" });
    } catch (error) { post({ type: "projectDiagramExportFailed", error: error instanceof Error ? error.message : String(error) }); }
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
    const workspaceSettings = effectiveProjectWorkspaceSettings(definition);
    return {
      overview: {
        ...(intent?.structure ? { structure: intent.structure } : {}),
        ...(intent?.qualityIssues ? { qualityIssues: intent.qualityIssues } : {}),
        name: options.name,
        root: options.root,
        objects: objects.length,
        accepted: objects.filter((object) => object.confirmation === "accepted").length,
        drafts: objects.filter((object) => object.confirmation === "draft").length,
        needsVerification: objects.filter((object) => object.validity !== "current").length,
        initialization,
        ...(options.store.writeDefinition ? { evidenceSettings: effectiveProjectEvidenceSettings(definition), evidenceSettingsVersion: definition?.version ?? 0 } : {}),
        ...(options.store.writeDefinition ? { workspaceSettings, workspaceSettingsVersion: definition?.version ?? 0 } : {}),
        evidenceConfigured: Boolean(definition?.evidence),
        ...(options.aiCli?.length ? {
          aiCli: options.aiCli,
          ...(selectedAiCli ? { selectedAiCli } : {}),
          ...(selectedAiModel ? { selectedAiModel } : {}),
          ...(selectedAiReasoning ? { selectedAiReasoning } : {}),
          ...(selectedAiSpeed ? { selectedAiSpeed } : {})
        } : {})
      },
      objects,
      readerDiagrams: diagrams,
      ...(intent ? {
        knowledge: {
          brief: intent.brief.summary,
          topics: buildProjectTopics(intent, diagrams),
          checks: topicChecks,
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
    checkKnowledge,
    openTopicEvidence,
    generateTopicDiagram,
    openReaderEvidence,
    exportReaderDiagram,
    renderReaderDiagram,
    cancelDiagramWork: (): void => {
      options.diagramRegistry?.cancelAll();
      tasks.cancelAll();
    },
    initialize: async (): Promise<ProjectPanelData> => {
      if (generating) throw new Error("Wait for module analysis to finish before updating the project model.");
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
      setWorkspaceSettings: async (settings: unknown, version: number): Promise<void> => {
        if (generating || initializationService.snapshot.status === "running") throw new Error("Wait for Project generation to finish before saving settings.");
        const next = projectWorkspaceSettingsSchema.parse(settings);
        const definition = await options.store.readDefinition!();
        if (definition.version !== version) throw new Error("Project settings changed. Reopen Overview before saving again.");
        const saved = await options.store.writeDefinition!({
          ...definition,
          paths: { planDirectory: next.planDirectory, apiDirs: next.apiDirs, skillDirs: next.skillDirs, mcpDirs: next.mcpDirs }
        }, version);
        if (saved.status === "conflict") throw new Error("Project settings changed. Reopen Overview before saving again.");
        await options.onWorkspaceSettingsChanged?.(next);
      },
      setProjectSettings: async (settings: unknown, version: number): Promise<void> => {
        if (generating || initializationService.snapshot.status === "running") throw new Error("Wait for Project generation to finish before saving settings.");
        const next = projectSettingsSchema.parse(settings) as ProjectSettings;
        const definition = await options.store.readDefinition!();
        if (definition.version !== version) throw new Error("Project settings changed. Reopen Overview before saving again.");
        const saved = await options.store.writeDefinition!({
          ...definition,
          paths: { planDirectory: next.workspace.planDirectory, apiDirs: next.workspace.apiDirs, skillDirs: next.workspace.skillDirs, mcpDirs: next.workspace.mcpDirs },
          evidence: next.evidence
        }, version);
        if (saved.status === "conflict") throw new Error("Project settings changed. Reopen Overview before saving again.");
        await options.onWorkspaceSettingsChanged?.(next.workspace);
      },
      setEvidenceSettings: async (settings: unknown, version: number): Promise<void> => {
        if (generating || initializationService.snapshot.status === "running") throw new Error("Wait for Project generation to finish before saving settings.");
        const evidence = projectEvidenceSettingsSchema.parse(settings);
        const definition = await options.store.readDefinition!();
        if (definition.version !== version) throw new Error("Project settings changed. Reopen Overview before saving again.");
        const saved = await options.store.writeDefinition!({ ...definition, evidence }, version);
        if (saved.status === "conflict") throw new Error("Project settings changed. Reopen Overview before saving again.");
      },
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
export type { ProjectPanelMessage } from "../contracts/reader.js";
export { discoverArchifyRepository, PROJECT_BUILD_CONFIG_GLOB, PROJECT_DOCUMENT_GLOB, PROJECT_EVIDENCE_EXCLUDE, PROJECT_MANIFEST_GLOB, PROJECT_README_GLOB, PROJECT_SOURCE_GLOB, readWorkspaceEvidence } from "./indexing/workspaceEvidence.js";
export type { ProjectEvidenceReadOptions } from "./indexing/workspaceEvidence.js";
export { VscodeProjectFileHost } from "./persistence/vscodeProjectFileHost.js";