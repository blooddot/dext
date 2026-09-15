import * as vscode from "vscode";
import type { ProjectFileHost, ProjectDefinition, ProjectSaveResult } from "./projectStore.js";
import type { ProjectEditorDataSource } from "./projectEditorProvider.js";
import type { KnowledgeSuggestion } from "./core/projectKnowledgeReview.js";
import type { ProjectInitializationState, ProjectInitializationProgressListener, ProjectInitializationProgress } from "./projectService.js";
import type { ProjectPanelData } from "./webview/projectPanel.js";
import type { ArchitectureScanResult } from "./core/projectArchitecture.js";
import { runArchitectureScan } from "./core/projectArchitectureWorker.js";
import { ProjectInitializationService } from "./projectService.js";
import { buildProjectEvidencePackage, ProjectAiGenerationService, type ProjectAiProvider, type ProjectAiActivityEvent } from "./core/projectAiGeneration.js";
import type { ProjectIntent } from "./core/projectIntent.js";
import type { ProjectDiagram, ProjectDiagramKind } from "./core/projectDiagram.js";
import type { ProjectDiagramAdapterRegistry } from "./core/projectDiagramRegistry.js";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// VS Code glob patterns do not support nested brace alternatives.
export const PROJECT_SOURCE_GLOB = "**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,py,rs}";
export const PROJECT_MANIFEST_GLOB = "**/{Cargo.toml,Cargo.lock}";
/**
 * Project architecture is about production modules by default. Tests and generated fixtures can
 * contain imports that make the graph noisy, so they are opt-in through a future scan profile.
 */
export const PROJECT_SCAN_EXCLUDE = "**/{node_modules,out,dist,build,.git,target,coverage,.vscode-test,.npm-cache,.tmp-tb,test,tests,__tests__,fixtures}/**";

export async function scanWorkspaceProject(root: vscode.Uri, config?: ProjectDefinition["scan"], onProgress?: ProjectInitializationProgressListener, signal?: AbortSignal): Promise<ArchitectureScanResult> {
  onProgress?.({ phase: "scanning", message: "Discovering source files…" });
  const limit = 2000;
  const roots = config?.roots?.length ? config.roots : ["."];
  const excluded = config?.includeTests
    ? PROJECT_SCAN_EXCLUDE.replace("test,tests,__tests__,fixtures/", "")
    : PROJECT_SCAN_EXCLUDE;
  const extra = config?.extraExcludes?.length ? `{${config.extraExcludes.join(",")}}` : "";
  const exclude = extra ? `${excluded},${extra}/**` : excluded;
  const groups = await Promise.all(roots.flatMap((scanRoot) => [PROJECT_SOURCE_GLOB, PROJECT_MANIFEST_GLOB].map((pattern) => {
    const prefix = scanRoot === "." ? "" : `${scanRoot.replace(/\/$/, "")}/`;
    return vscode.workspace.findFiles(new vscode.RelativePattern(root, `${prefix}${pattern}`), exclude, limit + 1);
  })));
  const found = [...new Map(groups.flat().map((uri) => [uri.path, uri])).values()].sort((a, b) => a.path.localeCompare(b.path));
  const pending = found.slice(0, limit);
  let processed = 0;
  onProgress?.({ phase: "scanning", completed: 0, total: pending.length, message: "Reading source files…" });
  const files: Array<{ path: string; content: string }> = [];
  const unsupported: ArchitectureScanResult["unsupported"] = [];
  for (const uri of pending) {
    if (signal?.aborted) throw new Error("Project scan was cancelled.");
    const path = uri.path.slice(root.path.replace(/\/$/, "").length + 1);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 262144) {
        unsupported.push({ path, reason: "File size limit exceeded." });
        continue;
      }
      files.push({ path, content: textDecoder.decode(await vscode.workspace.fs.readFile(uri)) });
    } catch {
      unsupported.push({ path, reason: "File could not be read." });
    } finally {
      processed += 1;
      onProgress?.({ phase: "scanning", completed: processed, total: pending.length, message: `Read ${processed} of ${pending.length} files · ${path}` });
    }
  }
  if (signal?.aborted) throw new Error("Project scan was cancelled.");
  onProgress?.({ phase: "scanning", message: `Analyzing module relationships across ${files.length} readable files…` });
  const result = runArchitectureScan(files, { maxFiles: limit, maxFileBytes: 262144 }, signal).result;
  // Keep the already bounded source excerpts available to the optional Project AI pass. The
  // generation service redacts secrets and applies a stricter evidence budget before prompting.
  result.files = files;
  result.unsupported.push(...unsupported);
  if (found.length > limit) result.coverage = [...(result.coverage ?? []), "File limit exceeded: only the first 2000 files were scanned."];
  return result;
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
  store: {
    readObjects(): Promise<ProjectPanelData["objects"]>;
    readArchitecture(): Promise<{ decisions: Array<{ id: string; title: string; detail: string }> }>;
    readDefinition?(): Promise<ProjectDefinition>;
    writeDefinition?(next: ProjectDefinition, expectedVersion: number): Promise<ProjectSaveResult<ProjectDefinition>>;
  };
  scan(onProgress?: ProjectInitializationProgressListener, signal?: AbortSignal): Promise<ArchitectureScanResult>;
  name: string;
  root: string;
  languages?: () => Promise<readonly string[]>;
  drafts?: () => readonly KnowledgeSuggestion[];
  initialization?: () => ProjectInitializationState;
  status?: () => ProjectInitializationState["status"];
  diagramRegistry?: ProjectDiagramAdapterRegistry;
  readDiagramAdapterPreferences?: () => Promise<unknown>;
  writeDiagramAdapterPreferences?: (preferences: unknown) => Promise<void>;
  exportDiagram?: (kind: string, format?: string) => Promise<void>;
  projectAiProvider?: ProjectAiProvider;
  aiCli?: readonly { id: string; label: string; models?: readonly {
    id: string;
    label: string;
    group?: string;
    reasoningEfforts?: readonly string[];
    speedTiers?: readonly string[];
    serviceTiers?: readonly string[];
  }[] }[];
  readIntent?: () => Promise<ProjectIntent | undefined>;
  writeDiagrams?: (diagrams: readonly ProjectDiagram[]) => Promise<void>;
  readDiagrams?: () => Promise<readonly ProjectDiagram[]>;
  writeIntent?: (intent: ProjectIntent) => Promise<void>;
}

/**
 * Builds the Project tab data from long-term files and a bounded scan. Conversation runs, Hook
 * output, and single-run Review are never read or exposed here.
 */
export function createProjectPanelDataSource(options: ProjectPanelDataSourceOptions): ProjectEditorDataSource {
  let generatedIntent: ProjectIntent | undefined;
  let selectedAiCli: string | undefined;
  let selectedAiModel: string | undefined;
  let selectedAiReasoning: string | undefined;
  let selectedAiSpeed: string | undefined;
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
  // Reuse the most recent architecture scan across page changes and the
  // initialization flow.  A page change must not start a second scan while
  // initialization is still working.
  let latestScan: ArchitectureScanResult | undefined;
  let scanInFlight: Promise<ArchitectureScanResult> | undefined;
  let latestScanProgress: ProjectInitializationProgress | undefined;
  const scanListeners = new Set<ProjectInitializationProgressListener>();
  const getLatestScan = (onProgress?: ProjectInitializationProgressListener, signal?: AbortSignal): Promise<ArchitectureScanResult> => {
    if (latestScan) {
      const count = latestScan.files?.length ?? latestScan.modules.length;
      onProgress?.({ phase: "scanning", completed: count, total: count, message: `Using the completed scan of ${count} files.` });
      return Promise.resolve(latestScan);
    }
    if (onProgress) {
      scanListeners.add(onProgress);
      if (latestScanProgress) onProgress(latestScanProgress);
    }
    if (!scanInFlight) {
      scanInFlight = options.scan((progress) => {
        latestScanProgress = progress;
        for (const listener of scanListeners) listener(progress);
      }, signal).then((scan) => {
        latestScan = scan;
        return scan;
      }).finally(() => { scanInFlight = undefined; scanListeners.clear(); latestScanProgress = undefined; });
    }
    return scanInFlight;
  };
  const initializationService = new ProjectInitializationService({
    scan: getLatestScan,
    generate: async (scan, signal, _onProgress, _onOutput, onEvent) => {
      if (!projectAiProvider) throw new Error("Project AI provider unavailable.");
      const evidence = buildProjectEvidencePackage({ projectName: options.name, scan, files: scan.files ?? [] });
      return new ProjectAiGenerationService(projectAiProvider).generate(evidence, { signal, onEvent: (event: ProjectAiActivityEvent) => { onEvent?.(event); } });
    },
    persist: async (result, signal, onProgress) => {
      if (result.intent && !options.writeIntent) throw new Error("Project Intent storage is unavailable.");
      if (result.diagrams?.length && !options.writeDiagrams) throw new Error("Project diagram storage is unavailable.");
      const canSaveDefinition = options.store.readDefinition !== undefined && options.store.writeDefinition !== undefined;
      const total = Number(Boolean(result.intent)) + (result.diagrams?.length ?? 0) + Number(canSaveDefinition);
      let completed = 0;
      const checkActive = (): void => { if (signal.aborted) throw new Error("Project initialization was cancelled."); };
      const saved = (path: string): void => {
        completed += 1;
        onProgress({ phase: "saving", completed, total, message: `Saved ${path}` });
      };
      onProgress({ phase: "saving", completed, total, message: `Saving ${total} generated project files…` });
      checkActive();
      if (result.intent) {
        await options.writeIntent!(result.intent);
        generatedIntent = result.intent;
        saved(".dext/project-intent.json");
      }
      for (const diagram of result.diagrams ?? []) {
        checkActive();
        await options.writeDiagrams!([diagram]);
        saved(`.dext/diagrams/${encodeURIComponent(diagram.id)}.json`);
      }
      if (canSaveDefinition) {
        checkActive();
        const definition = await options.store.readDefinition!();
        const outcome = await options.store.writeDefinition!({
          ...definition,
          knowledge: { ...definition.knowledge, enabled: true, ...(result.intent ? { initialized: true } : {}) }
        }, definition.version);
        if (outcome.status === "conflict") throw new Error("Project settings changed during initialization. Please retry.");
        saved(".dext/project.json");
      }
    }
  });
  const codeObjects = (scan: ArchitectureScanResult): ProjectPanelData["objects"] => {
    const groups = new Map<string, typeof scan.modules>();
    for (const module of scan.modules) {
      const path = module.paths[0] ?? module.id;
      const parts = path.split("/");
      const area = parts.length > 2 ? parts.slice(0, 2).join("/") : (parts[0] ?? "project");
      groups.set(area, [...(groups.get(area) ?? []), module]);
    }
    return [...groups.entries()].map(([area, modules]) => ({
    id: `code-${area.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module"}`,
    canonicalName: area.replace(/[^A-Za-z0-9._-]/g, "-") || "project",
    displayName: area,
    aliases: [],
    kind: "module" as const,
    description: `${modules.length} source modules in the ${area} area.`,
    behavior: [],
    paths: modules.flatMap((module) => module.paths),
    relatedIds: [],
    source: "code" as const,
    confirmation: "accepted" as const,
    validity: "current" as const,
    ownership: "owned" as const,
    confidence: 1,
    evidence: modules.flatMap((module) => module.paths).slice(0, 5).map((path) => ({ path })),
    version: 0
    }));
  };
  const load = async (scanned?: ArchitectureScanResult): Promise<ProjectPanelData> => {
      if (scanned) latestScan = scanned;
      const scanPromise = scanned ? Promise.resolve(scanned) : getLatestScan();
      const [storedObjects, architecture, scan, definition, persistedIntent, persistedDiagrams] = await Promise.all([
        options.store.readObjects(),
        options.store.readArchitecture(),
        scanPromise,
        options.store.readDefinition?.(),
        options.readIntent?.(),
        options.readDiagrams?.()
      ]);
      if (!generatedIntent && persistedIntent) generatedIntent = persistedIntent;
      const objects = storedObjects.length ? storedObjects : generatedIntent ? [] : codeObjects(scan);
      const persistedArchitecture = persistedDiagrams?.find((diagram) => diagram.kind === "architecture");
      // A valid AI response may contain an intent without an explicit architecture diagram.
      // Keep the Architecture tab semantic in that case by projecting its bounded contexts and
      // dependency declarations into a readable map instead of silently falling back to imports.
      const semanticArchitecture = persistedArchitecture ?? (persistedIntent ? {
        confidence: 0,
        nodes: persistedIntent.contexts.map((context) => ({ id: context.id, label: context.displayName ?? context.canonicalName, evidence: context.evidence })),
        relations: persistedIntent.contexts.flatMap((context) => context.dependsOn.map((dependency, index) => ({ id: `${dependency}-${context.id}-${index}`, from: dependency, to: context.id, label: "depends on", confidence: context.confidence, evidence: context.evidence })))
      } : undefined);
      const architectureModules = semanticArchitecture
        ? semanticArchitecture.nodes.map((node) => ({
          id: node.id,
          name: node.label,
          language: "unknown" as const,
          paths: node.evidence.map((entry) => entry.path),
          source: "inferred" as const
        }))
        : scan.modules;
      const architectureRelations = semanticArchitecture
        ? semanticArchitecture.relations.map((relation) => ({
          from: relation.from,
          to: relation.to,
          source: "inferred" as const,
          confidence: relation.confidence ?? semanticArchitecture.confidence ?? 0,
          ...(relation.label ? { reason: relation.label } : {}),
          ...(relation.evidence[0]?.path ? { file: relation.evidence[0].path } : {}),
          ...(relation.evidence[0]?.line ? { line: relation.evidence[0].line } : {})
        }))
        : scan.relations;
      const snapshot = options.initialization?.() ?? initializationService.snapshot;
      // The in-memory service starts idle on every extension activation. A
      // project that was already initialized must still render as completed
      // until a new run starts; otherwise the button briefly reappears and a
      // completed project can look like it was never scanned.
      const persistedSemanticModel = Boolean(persistedIntent || persistedDiagrams?.length);
      const initialization = snapshot.status === "idle" && (definition?.knowledge.initialized || persistedSemanticModel)
        ? { ...snapshot, status: "completed" as const, aiAvailable: persistedSemanticModel, intentGenerated: Boolean(persistedIntent), diagramsGenerated: persistedDiagrams?.length ?? 0, scannedFiles: snapshot.scannedFiles || scan.modules.length, phase: "saving" as const }
        : snapshot;
      selectedAiCli = definition?.ai.cli && (options.aiCli ?? []).some((candidate) => candidate.id === definition.ai.cli)
        ? definition.ai.cli
        : undefined;
      const selectedProfile = (options.aiCli ?? []).find((candidate) => candidate.id === selectedAiCli);
      selectedAiModel = definition?.ai.model && selectedProfile?.models?.some((model) => model.id === definition.ai.model)
        ? definition.ai.model
        : undefined;
      const selectedModel = selectedProfile?.models?.find((model) => model.id === selectedAiModel);
      selectedAiReasoning = definition?.ai.reasoningEffort && selectedModel?.reasoningEfforts?.includes(definition.ai.reasoningEffort)
        ? definition.ai.reasoningEffort : undefined;
      selectedAiSpeed = definition?.ai.speed && selectedModel?.speedTiers?.includes(definition.ai.speed)
        ? definition.ai.speed : undefined;
      return {
        overview: {
          name: options.name,
          root: options.root,
          languages: (await options.languages?.()) ?? [...new Set(scan.modules.map((module) => module.language))],
          objects: objects.length,
          accepted: objects.filter((object) => object.confirmation === "accepted").length,
          drafts: objects.filter((object) => object.confirmation === "draft").length,
          needsVerification: objects.filter((object) => object.validity !== "current").length,
          initialization: {
            status: initialization.status,
            aiAvailable: initialization.aiAvailable,
            ...(initialization.error ? { error: initialization.error } : {}),
            ...(initialization.phase ? { phase: initialization.phase } : {}),
            ...(initialization.progress !== undefined ? { progress: initialization.progress } : {}),
            ...(initialization.progressTotal !== undefined ? { progressTotal: initialization.progressTotal } : {}),
            ...(initialization.message ? { message: initialization.message } : {}),
            ...(initialization.output ? { output: initialization.output } : {}),
            ...(initialization.startedAt !== undefined ? { startedAt: initialization.startedAt } : {}),
            ...(initialization.finishedAt !== undefined ? { finishedAt: initialization.finishedAt } : {}),
            ...(initialization.intentGenerated !== undefined ? { intentGenerated: initialization.intentGenerated } : {}),
            ...(initialization.diagramsGenerated !== undefined ? { diagramsGenerated: initialization.diagramsGenerated } : {}),
            // An idle panel can show the already loaded architecture scan,
            // while a running/completed initialization must report its own
            // count (including a legitimate value of zero).
            scannedFiles: initialization.status === "idle" ? (initialization.scannedFiles || scan.modules.length) : initialization.scannedFiles
          },
          scanRoots: definition?.scan.roots ?? [],
          ...(options.aiCli?.length ? {
            aiCli: options.aiCli,
            ...(selectedAiCli ? { selectedAiCli } : {}),
            ...(selectedAiModel ? { selectedAiModel } : {})
            ,...(selectedAiReasoning ? { selectedAiReasoning } : {})
            ,...(selectedAiSpeed ? { selectedAiSpeed } : {})
          } : {})
        },
        objects,
        drafts: options.drafts?.() ?? [],
        ...(generatedIntent ? { knowledge: { brief: generatedIntent.brief.summary, contexts: generatedIntent.contexts.map((item) => ({ id: item.id, name: item.displayName ?? item.canonicalName, description: item.purpose, evidence: item.evidence.map((entry) => entry.path) })), terms: generatedIntent.terms.map((item) => ({ id: item.id, canonical: item.canonicalName, aliases: item.aliases, definition: item.definition })), flows: generatedIntent.flows.map((item) => ({ id: item.id, name: item.displayName ?? item.canonicalName, steps: item.steps.map((step) => step.label) })) } } : {}),
          architecture: {
          semanticSource: semanticArchitecture ? "ai" : "code",
          modules: architectureModules,
          relations: architectureRelations,
          decisions: architecture.decisions,
          ...(options.diagramRegistry ? {
            diagramKind: "architecture" as ProjectDiagramKind,
            adapter: {
              ...(options.diagramRegistry.select("architecture") ? { currentId: options.diagramRegistry.select("architecture")!.id } : {}),
              choices: options.diagramRegistry.choices("architecture"),
              fallback: options.diagramRegistry.defaults("architecture"),
              recommendation: "Structurizr 用于 C4 文档，Archify 用于交互探索，draw.io 用于人工编辑。"
            }
          } : {}),
            ...(scan.coverage?.length || scan.unsupported.length
              ? { coverage: [...(scan.coverage ?? []), ...scan.unsupported.map((entry) => `${entry.path}: ${entry.reason}`)] }
            : {}),
            ...(persistedDiagrams?.length ? { diagramVersions: persistedDiagrams.map((diagram) => ({ id: diagram.id, adapterId: "project", version: diagram.version, status: diagram.review ?? "draft", updatedAt: diagram.updatedAt })) } : {})
        }
      };
    };
  return {
    load,
    initialization: () => initializationService.snapshot,
    onInitializationChange: (listener: (state: ProjectInitializationState) => void): (() => void) => initializationService.subscribe(listener),
    invalidateScan: (): void => {
      latestScan = undefined;
      scanInFlight = undefined;
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
    } : {}),
    ...(options.diagramRegistry ? {
      setDiagramAdapter: async (kind: string, adapterId?: string): Promise<void> => {
        if (!(["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as string[]).includes(kind)) throw new Error(`Unsupported diagram kind '${kind}'.`);
        options.diagramRegistry!.setPreference(kind as ProjectDiagramKind, adapterId);
        await options.writeDiagramAdapterPreferences?.(options.diagramRegistry!.exportPreferences());
      }
    } : {}),
    ...(options.exportDiagram ? { exportDiagram: options.exportDiagram } : {}),
    ...(options.store.readDefinition && options.store.writeDefinition ? {
      initialize: async (): Promise<ProjectPanelData> => {
        // Start synchronously so the editor can render the running snapshot
        // before this async method reaches its first await. `load()` has
        // already hydrated the project choice in normal panel interaction.
        const task = initializationService.start();
        const state = await task.promise;
        if (state.status === "failed") throw new Error(state.error ?? "Project initialization failed.");
        const scan = await getLatestScan();
        return load(scan);
      }
    } : {})
  };
}
