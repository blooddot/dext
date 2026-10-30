import { z } from "zod";
import { projectModelRelationSchema, projectModelSchema, projectModelNodeSchema, type ProjectModel, type ProjectModelNode, type ProjectModelRelation } from "../contracts/projectModel.js";
import type { StructureSummary } from "./indexing/projectStructure.js";
import { structureCandidates, validateOwnership } from "./indexing/projectStructureKnowledge.js";
import type { ProjectInitializationOutput, ProjectInitializationProgressListener } from "../contracts/lifecycle.js";
import { parseProjectModel, projectModelIntent, validateProjectModel } from "../knowledge/projectModel.js";
import { reconcileNativeProject } from "../knowledge/projectModelEvolution.js";
import { jsonCandidates } from "../../../shared/protocol/resultBoundary.js";
import { compareProjectEvidencePaths, type ProjectAiProvider } from "./generation/projectAiGeneration.js";
import { projectModelQuality, withProjectQuality } from "./generation/projectModelQuality.js";
import { type ProjectStore, projectContentHash, type ProjectFileHost } from "./persistence/projectStore.js";
import { commitProjectMigration } from "./persistence/projectMigration.js";

export type ProjectBootstrapRoute = "existing" | "legacy" | "documents" | "code" | "empty";
const durable = (path: string) => /(?:^|\/)(?:adr|architecture|contracts?|design|specifications?)(?:\/|[.-])/i.test(path) && /\.md$/i.test(path)
  && !/(?:^|\/)(?:plans|vendor|node_modules|dist)(?:\/|$)|\.plan\.md$|(?:readme|changelog|roadmap)/i.test(path);

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|rs|py|go|java|kt|cs|cpp|c)$/i;

/** Text budget for one initialization run; the Project evidence settings decide it. */
export interface ProjectBootstrapBudget { files: number; chars: number; fileChars: number }
const DEFAULT_BUDGET: ProjectBootstrapBudget = { files: 600, chars: 600_000, fileChars: 16_000 };

/** One request stays bounded however large the run budget is. */
const STAGE_CHARS = 30_000;

/** Bumped with the stage plan: a checkpoint from another plan must not be resumed. */
const PROMPT_VERSION = "project-bootstrap-7";

/** Source text explains a module, so it is read before documentation and configuration. */
const compareBootstrapPaths = (left: string, right: string): number =>
  Number(guidancePath(right)) - Number(guidancePath(left))
  || Number(SOURCE_FILE.test(right)) - Number(SOURCE_FILE.test(left))
  || compareProjectEvidencePaths(left, right);

export function detectProjectBootstrap(input: { model?: ProjectModel; legacy: boolean; paths: readonly string[] }): ProjectBootstrapRoute {
  if (input.model) return "existing";
  if (input.legacy) return "legacy";
  if (input.paths.some(durable)) return "documents";
  if (input.paths.some(path => SOURCE_FILE.test(path))) return "code";
  return "empty";
}

/** The schema has one body owner per node, and models mix the variants; keep only the owner's fields. */
function normalizeBodies<T>(value: T, sources: ReadonlyMap<string, string>): T {
  const nodes = (value as { nodes?: Array<{ body?: unknown }> } | null)?.nodes;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const body = node.body as { kind?: unknown; text?: unknown; path?: unknown } | undefined;
    if (typeof body === "string") node.body = { kind: "inline", text: body };
    // A document body's hash is ours to compute; a model-supplied one is never trusted.
    else if (body && typeof body === "object") node.body = body.kind === "document" && typeof body.path === "string" && sources.has(body.path)
      ? { kind: "document", path: body.path, contentHash: projectContentHash(sources.get(body.path)!) }
      : { kind: "inline", text: typeof body.text === "string" ? body.text : `Adopted document: ${typeof body.path === "string" ? body.path : "unreadable"}` };
  }
  return value;
}

const guidancePath = (path: string): boolean => durable(path)
  || /(?:^|\/)(?:readme|agents?|claude|contributing)[^/]*\.md$/i.test(path)
  || /(?:^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml)$/i.test(path);

/** One bounded model call. `module` marks a stage whose node identity and edges are already decided. */
interface BootstrapStage { instructions: string; sources: Map<string, string>; module?: { id: string; paths: string[] }; areas?: true }

const ROOT_STAGE = "Draft the graph root only: one 'project' node stating purpose, scope and non-goals, and one 'architecture' node stating module boundaries, dependency edges and invariants, linked by a 'contains' relation. Create no module nodes yet; the directory list below is an overview, not a node per directory. Write each body as Markdown with '## Responsibility' (what it owns), '## Design' (the decisions and invariants behind the code) and '## Boundary' ('- Allowed:' and '- Forbidden:' dependencies).";
const MODEL_GUIDANCE = "Build a native Project normative model: goals, then architecture, then modules/contracts and their explicit relationships. Do not mirror the directory tree. Read guidance before specifications, configuration and source evidence. Third-party sources are supporting evidence. All generated content is draft. Do not create Plan nodes. Adopt durable documents in place rather than copying them. Return a JSON object matching the supplied schema. Evidence outside this bounded package is unknown.";
const PROSE_GUIDANCE = "Explain one responsibility the indexed structure already decided: what it owns and why it is shaped this way. Read guidance before source. All generated content is draft. Never invent module ids, files or relationships; the index owns those. Groups that belong to one responsibility share the same title so they merge into one node.";
/**
 * One responsibility has one name per layer: what the interface calls it, what the code calls it, and
 * this record. The code name wins a conflict, so a title always lands on a real symbol.
 */
const LABEL_LANGUAGE = "Every 'title' is a short English label of 2-5 words that already exists in the project, never a sentence and never a directory path. Prefer the code's own name for the responsibility (package, module, public type or entry symbol): when the interface calls it something else, the code name still wins the title and the interface name is documented in the body. Use the interface name only when the code has none, and never invent a product name, so a project without a UI is still mapped by its code name. Every body is written in Simplified Chinese.";
const NAME_MAPPING = "Record the mapping once, in the first '## Responsibility' bullet of a node body or in an area 'description', as '**Names**: <interface name> → <public symbol or entry file>' (without an interface: '<code name> → <files>'); the title is the code name on that line, so the interface label, the code symbol and this record all name the same responsibility.";
const PROSE_STAGE = "Return exactly {\"title\": \"<responsibility name>\", \"body\": \"<Markdown with ## Responsibility, ## Design and ## Boundary ('- Allowed:' / '- Forbidden:')>\"}. Name the responsibility, never the directory.";
const STRUCTURE_GUIDANCE = "Group the known modules into developer-facing functional areas: 'areas', each with an English 'title', a Simplified Chinese 'description' and the exact 'moduleIds' it contains. Assign EVERY module id to exactly ONE area (usually 3-8 areas for a medium project, fewer for a small one). Grouping is navigation, not merging or a change of ownership: never invent module ids, never leave a module out, and do not repeat one area per module or use directory names as the taxonomy.";

/**
 * Thinkrail imports a codebase by writing one spec node at a time; the same shape applies here as
 * bounded stages, largest evidence first: goals and architecture, then module batches. Each stage is
 * small enough to finish, is checkpointed on its own, and advances the bar by completed stages.
 */
function bootstrapStages(sources: ReadonlyMap<string, string>): BootstrapStage[] {
  const stages: BootstrapStage[] = [{ instructions: `${MODEL_GUIDANCE} ${LABEL_LANGUAGE} ${ROOT_STAGE}`, sources: new Map([...sources].filter(([path]) => guidancePath(path))) }];
  let batch = new Map<string, string>(), size = 0;
  const flush = (): void => { if (batch.size) stages.push({ instructions: `${MODEL_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING} Draft one node per genuine responsibility visible in these files, named by responsibility rather than directory, with 'paths' holding its files. Link each new node to a known node where the code shows it and reuse the known ids. Never create one node per file. Write each body as Markdown with '## Responsibility', '## Design' and '## Boundary' ('- Allowed:' / '- Forbidden:'). Reference only ids listed in 'known' or created in this response.`, sources: batch }); batch = new Map(); size = 0; };
  for (const [path, text] of sources) {
    if (batch.size >= 25 || size + text.length > STAGE_CHARS) flush();
    batch.set(path, text); size += text.length;
  }
  flush();
  return stages;
}

interface StructureGroup { id: string; paths: string[] }

/** Indexed import neighborhoods are the deterministic module seed; the AI only names and explains them. */
const structureGroups = (summary: StructureSummary): StructureGroup[] => structureCandidates(summary)
  .map(candidate => ({ id: `module:${slug(candidate.files[0]!.path)}`, paths: candidate.files.map(file => file.path) }));

function structureStages(groups: readonly StructureGroup[], sources: ReadonlyMap<string, string>): BootstrapStage[] {
  return [
    { instructions: `${MODEL_GUIDANCE} ${LABEL_LANGUAGE} ${ROOT_STAGE}`, sources: new Map([...sources].filter(([path]) => guidancePath(path))) },
    ...groups.map(group => {
      const staged = new Map<string, string>();
      let size = 0;
      for (const path of group.paths) {
        const text = sources.get(path);
        if (text === undefined) continue;
        if (staged.size && size + text.length > STAGE_CHARS) break;
        staged.set(path, text); size += text.length;
      }
      return { instructions: `${PROSE_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING} ${PROSE_STAGE}`, sources: staged, module: { id: group.id, paths: group.paths } };
    }),
    // Last, because it needs the finished module list; it authors no prose.
    ...(groups.length ? [{ instructions: `${STRUCTURE_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING}`, sources: new Map<string, string>(), areas: true as const }] : [])
  ];
}

/** `contains` and `depends_on` come from the index, never from the model, so a module edge cannot dangle. */
function structureRelations(summary: StructureSummary, nodes: readonly ProjectModelNode[]): ProjectModelRelation[] {
  const present = new Set(nodes.map(node => node.id)), owner = new Map<string, string>(), edges: ProjectModelRelation[] = [];
  const add = (from: string, to: string, kind: "contains" | "depends_on"): void => {
    if (from === to || !present.has(from) || !present.has(to) || edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) return;
    edges.push(projectModelRelationSchema.parse({ id: `${from}--${kind}--${to}`, from, to, kind, origin: "detected", review: "draft", freshness: "needs_verification" }));
  };
  add("project", "architecture", "contains");
  // Ownership comes from the nodes, so a responsibility merged across groups keeps its edges.
  for (const node of nodes) if (node.kind === "module") { add("project", node.id, "contains"); for (const path of node.paths) owner.set(path, node.id); }
  for (const file of summary.modules.flatMap(module => module.members)) {
    const from = owner.get(file.path); if (!from) continue;
    for (const dependency of file.dependencies) { const to = dependency.to ? owner.get(dependency.to) : undefined; if (to) add(from, to, "depends_on"); }
  }
  return edges;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);

/**
 * Identity is keyed on kind + normalized name, not on the id a model invents (GraphRAG merges
 * extracted entities on the normalized title for the same reason), so two batches cannot create the
 * same concept twice, and an edge written by one batch still resolves when another names it.
 */
const nodeKey = (node: ProjectModelNode): string => node.body.kind === "document"
  ? `document:${slug(node.body.path)}`
  : node.kind === "project" || node.kind === "architecture" ? node.kind : `${node.kind}:${slug(node.title)}`;

/** Later stages may add nodes and edges but never rewrite an existing id, so a batch cannot clobber the root. */
function mergeProjectModel(target: ProjectModel, part: ProjectModel): void {
  const keys = new Set(target.nodes.map(nodeKey));
  for (const node of part.nodes) {
    const key = nodeKey(node);
    if (keys.has(key)) continue;
    keys.add(key);
    target.nodes.push({ ...node, review: "draft", freshness: "needs_verification" });
  }
  const seen = new Set(target.relations.map(edge => `${edge.kind}\u0000${edge.from}\u0000${edge.to}`));
  for (const edge of part.relations) {
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
    if (seen.has(key)) continue;
    target.relations.push({ ...edge, review: "draft", freshness: "needs_verification" }); seen.add(key);
  }
}

/**
 * Rewrites edge endpoints to the surviving node ids by the same name key, so a batch that referred to
 * a module by its own invented id keeps a working edge; an edge that still names nothing real is
 * dropped, because it carries no information.
 */
function resolveRelations(model: ProjectModel): string[] {
  const byKey = new Map<string, string>();
  for (const node of model.nodes) {
    for (const alias of [nodeKey(node), slug(node.id), slug(node.title), slug(node.canonicalName)]) if (alias) byKey.set(alias, node.id);
  }
  const resolve = (value: string): string | undefined => (model.nodes.some(node => node.id === value) ? value : byKey.get(slug(value)) ?? byKey.get(value.toLowerCase()));
  const dropped: string[] = [], kept = new Map<string, ProjectModelRelation>();
  for (const edge of model.relations) {
    const from = resolve(edge.from), to = resolve(edge.to);
    if (!from || !to) { dropped.push(edge.id); continue; }
    const id = `${from}--${edge.kind}--${to}`;
    if (kept.has(id)) { dropped.push(edge.id); continue; }
    kept.set(id, { ...edge, id, from, to });
  }
  model.relations = [...kept.values()];
  return dropped;
}

/**
 * Thinkrail can leave a dangling link in one file and fix it later because every node is its own file;
 * our draft is one graph, so a single unresolvable edge rejects the whole commit. A generated draft is
 * therefore repaired into a graph that always validates, and what was dropped is reported back.
 */
function sanitizeDraft(model: ProjectModel): string[] {
  const dropped: string[] = [];
  const nodes = new Map<string, ProjectModelNode>(), documents = new Set<string>();
  for (const node of model.nodes) {
    const duplicateDocument = node.body.kind === "document" && documents.has(node.body.path.toLowerCase());
    if (duplicateDocument || nodes.has(node.id) || /\.plan\.md$/i.test(node.id)) { dropped.push(node.id); continue; }
    if (node.body.kind === "document") documents.add(node.body.path.toLowerCase());
    nodes.set(node.id, node);
  }
  const relations = new Map<string, ProjectModelRelation>();
  for (const edge of model.relations) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || relations.has(edge.id)) { dropped.push(edge.id); continue; }
    relations.set(edge.id, edge);
  }
  // A containment cycle makes the tree unreadable; the edge that closes it is the redundant one.
  for (;;) {
    const parents = new Map<string, ProjectModelRelation[]>();
    for (const edge of relations.values()) if (edge.kind === "contains") parents.set(edge.to, [...parents.get(edge.to) ?? [], edge]);
    const active = new Set<string>(), done = new Set<string>();
    let culprit: ProjectModelRelation | undefined;
    const visit = (id: string): boolean => {
      if (done.has(id)) return false;
      active.add(id);
      for (const edge of parents.get(id) ?? []) if (active.has(edge.from) || visit(edge.from)) culprit ??= edge;
      active.delete(id); done.add(id);
      return false;
    };
    for (const id of parents.keys()) visit(id);
    if (!culprit) break;
    relations.delete(culprit.id); dropped.push(culprit.id);
  }
  model.nodes = [...nodes.values()]; model.relations = [...relations.values()];
  return dropped;
}

/** One stage's prose: the id, files and edges already exist, only the explanation is missing. */
const proseSchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1) }).strict();

/**
 * A prose stage answers JSON, but a model that replies with the Markdown body alone has still done
 * the work; failing the whole run over a missing envelope throws away every finished stage.
 */
function readProse(text: string, fallbackTitle: string): z.infer<typeof proseSchema> {
  try { return proseSchema.parse(parseJsonObject(text)); } catch { /* A body-only answer. */ }
  const body = text.replace(/^\s*```(?:json|markdown|md)?[^\n]*\n([\s\S]*?)\n?```\s*$/, "$1").trim();
  if (!body) throw new Error("Project AI returned an empty module explanation; nothing was saved.");
  return { title: fallbackTitle, body };
}

/** The module stage's files are exactly the sources it was given, so their hashes identify the stage. */
const stageEvidence = (stage: BootstrapStage) => [...stage.sources].map(([path, text]) => ({ path, contentHash: projectContentHash(text) }));

/**
 * Zero change: a saved module is reused while every file it was written from is still in the stage and
 * unchanged. A file added to or removed from the module changes the stage, so the prose is re-drafted.
 */
function reusableModule(previous: ProjectModel | undefined, stage: BootstrapStage): ProjectModelNode | undefined {
  if (!previous || !stage.module) return undefined;
  const node = previous.nodes.find((candidate) => candidate.id === stage.module!.id && candidate.body.kind === "inline");
  if (!node?.evidence.length || node.evidence.length !== stage.sources.size) return undefined;
  return node.evidence.every((entry) => stage.sources.has(entry.path) && projectContentHash(stage.sources.get(entry.path)!) === entry.contentHash) ? node : undefined;
}

/** The grouping is unchanged while the saved areas cover exactly these modules under the same titles. */
function reusableAreas(previous: ProjectModel | undefined, candidate: ProjectModel): ProjectModelNode[] | undefined {
  if (!previous) return undefined;
  const areas = previous.nodes.filter((node) => node.kind === "capability");
  const covered = new Set(areas.flatMap((node) => (node.properties.moduleIds as string[] | undefined) ?? []));
  const modules = candidate.nodes.filter((node) => node.kind === "module");
  if (!areas.length || covered.size !== modules.length) return undefined;
  return modules.every((module) => covered.has(module.id) && previous.nodes.some((node) => node.id === module.id && node.title === module.title)) ? areas : undefined;
}

/** Functional areas: navigation over modules whose ids and ownership the index already decided. */
const areaSchema = z.object({ areas: z.array(z.object({
  title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(500),
  moduleIds: z.array(z.string().min(1)).min(1)
}).strict()).min(1).max(12) }).strict();

/** Revision and timestamps belong to the host; a stage only authors the graph, and extra keys are ignored. */
const draftModelSchema = projectModelSchema.omit({ schemaVersion: true, revision: true, updatedAt: true }).loose();

/** Models wrap or trail the JSON object; the shared candidate scanner finds it without loosening the schema. */
function parseJsonObject(text: string): unknown {
  for (const candidate of jsonCandidates(text)) {
    try { return JSON.parse(candidate) as unknown; } catch { /* Next candidate. */ }
  }
  // Name what the model actually returned, or the next failure is just as opaque.
  const shown = text.trim().replace(/\s+/g, " ").slice(0, 160);
  throw new Error(`Project AI response did not contain a JSON object${shown ? `: ${shown}` : " (empty response)."}`);
}

const checkpointSchema = z.object({ version: z.literal(1), fingerprint: z.string(), route: z.enum(["existing", "legacy", "documents", "code", "empty"]), stage: z.enum(["candidate", "committed"]), completed: z.number().int().nonnegative(), candidate: projectModelSchema }).strict();
export const PROJECT_BOOTSTRAP_CHECKPOINT_PATH = ".dext/project/bootstrap.checkpoint.json";

export async function readBootstrapCheckpoint(host: ProjectFileHost): Promise<{ stage: string; fraction: number } | undefined> {
  const raw = await (host.readFileStrict ? host.readFileStrict(PROJECT_BOOTSTRAP_CHECKPOINT_PATH) : host.readFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH));
  if (!raw) return undefined;
  try { const checkpoint = checkpointSchema.parse(JSON.parse(raw)); return checkpoint.stage === "candidate" ? { stage: `${checkpoint.route}:candidate`, fraction: 1 } : undefined; } catch { return undefined; }
}

/** Invoked only by an explicit Project initialization/update action, never Plan or query. */
export async function bootstrapProject(options: {
  name: string; host: ProjectFileHost; store: ProjectStore; paths: readonly string[];
  provider?: ProjectAiProvider; ai: string; signal: AbortSignal; progress: ProjectInitializationProgressListener;
  /** Deterministic import index; a code import without it falls back to drafting the structure. */
  structure?: () => Promise<StructureSummary | undefined>;
  /** Defaults to the standard evidence preset of the Project settings. */
  budget?: ProjectBootstrapBudget;
}): Promise<ProjectInitializationOutput> {
  const { store, host, signal, progress } = options;
  const budget = options.budget ?? DEFAULT_BUDGET;
  signal.throwIfAborted();
  const model = await store.readModel();
  const legacy = model ? undefined : await store.readLegacySnapshot();
  const route = detectProjectBootstrap({ ...(model ? { model } : {}), legacy: Boolean(legacy?.files.length), paths: options.paths });
  progress({ phase: "preparing", fraction: 0, message: `Project initialization route: ${route}` });
  if (route === "legacy") {
    signal.throwIfAborted(); const migrated = await commitProjectMigration(host, legacy!);
    return { model: migrated, intent: projectModelIntent(migrated) };
  }
  const sources = new Map<string, string>(); let chars = 0;
  for (const path of [...options.paths].sort(compareBootstrapPaths)) {
    if (/(?:^|\/)(?:\.git|node_modules|dist|\.env(?:\.[^/]*)?|\.ssh|\.aws)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i.test(path) || /\.plan\.md$/.test(path)) continue;
    if (sources.size >= budget.files || chars >= budget.chars) break;
    const raw = await (host.readFileStrict ? host.readFileStrict(path) : host.readFile(path));
    if (raw === undefined || raw.includes("\0") || raw.length > budget.fileChars || chars + raw.length > budget.chars) continue;
    sources.set(path, raw); chars += raw.length;
  }
  signal.throwIfAborted();
  // Updating an existing model re-drafts it the same way an import does; accepted norms are protected by reconciliation.
  const drafting = route === "code" || route === "existing" && options.paths.some(path => SOURCE_FILE.test(path));
  const structure = drafting ? await options.structure?.().catch(() => undefined) : undefined;
  // A module whose files were not read cannot be explained, and a stub named after its path is noise.
  const groups = structure ? structureGroups(structure).filter(group => group.paths.some(path => sources.has(path))) : [];
  const stages = !drafting ? [] : groups.length ? structureStages(groups, sources) : bootstrapStages(sources);
  // The stage plan is part of the identity: a checkpoint drafted by a different batching or prompt
  // must not be resumed, or the same responsibility gets drafted (and merged) twice.
  const fingerprint = projectContentHash(JSON.stringify({ route, revision: model?.revision ?? null, documents: [...sources].map(([path, text]) => [path, projectContentHash(text)]), stages: stages.map(stage => [stage.module?.id ?? "", ...[...stage.sources.keys()]]), prompt: PROMPT_VERSION, schema: 1, ai: options.ai }));
  const rawCheckpoint = await (host.readFileStrict ? host.readFileStrict(PROJECT_BOOTSTRAP_CHECKPOINT_PATH) : host.readFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH));
  let resumed: { model: ProjectModel; completed: number } | undefined;
  if (rawCheckpoint) {
    try {
      const saved = checkpointSchema.parse(JSON.parse(rawCheckpoint));
      if (saved.fingerprint === fingerprint && saved.stage === "candidate") resumed = { model: parseProjectModel(saved.candidate), completed: saved.completed };
    } catch { /* Invalid candidate is never promoted. */ }
  }
  const writeCheckpoint = async (candidate: ProjectModel, completed: number): Promise<void> => {
    await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "candidate", completed, candidate }));
  };
  let candidate = resumed?.model;
  let completed = resumed?.completed ?? 0;
  let dropped: string[] = [];
  /** Set when the functional grouping was rejected twice, so the flat tree is explained instead of silent. */
  let ungrouped: string | undefined;
  if (!candidate) {
    if (!drafting) {
      candidate = { schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [projectModelNodeSchema.parse({ id: "project", kind: "project", title: options.name, canonicalName: options.name, body: { kind: "inline", text: "Project intent needs definition and review." }, review: "draft", freshness: "needs_verification" })] };
      if (route !== "empty") for (const [path, content] of sources) if (durable(path)) candidate.nodes.push(projectModelNodeSchema.parse({ id: `document:${projectContentHash(path).slice(0, 20)}`, kind: "contract", title: path, canonicalName: path, body: { kind: "document", path, contentHash: projectContentHash(content) }, origin: "detected", review: "draft", freshness: "needs_verification" }));
      if (route === "documents" && candidate.nodes.length === 1) throw new Error("Durable documents exceed the read budget or could not be read; choose a smaller scope.");
    } else {
      if (!options.provider) throw new Error("Choose an available Project AI provider before importing code.");
      const provider = options.provider;
      candidate = { schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [], relations: [] };
      // A resumed run continues after its last checkpointed stage instead of starting over.
      let reused = 0;
      for (let index = completed; index < stages.length; index += 1) {
        const stage = stages[index]!;
        // Zero change is not re-drafted: a module whose files still hash the same keeps its prose and its
        // review state, and an unchanged grouping keeps its areas. Only what changed reaches the provider.
        const saved = reusableModule(model, stage);
        const savedAreas = stage.areas ? reusableAreas(model, candidate) : undefined;
        if (saved || savedAreas) {
          if (saved) candidate.nodes.push(saved);
          for (const node of savedAreas ?? []) candidate.nodes.push(node);
          reused += 1;
          progress({ phase: "generating", completed: index, total: stages.length, message: saved ? `Reusing ${saved.title} — its sources are unchanged…` : "Reusing the saved functional areas — the modules are unchanged…" });
          completed = index + 1;
          await writeCheckpoint(candidate, completed);
          continue;
        }
        const label = stage.module ? `Drafting ${stage.module.id}…` : stage.areas ? "Grouping modules into functional areas…" : index === 0 ? "Drafting goals and architecture…" : `Drafting responsibility batch ${index} of ${stages.length - 1}…`;
        progress({ phase: "generating", completed: index, total: stages.length, message: label });
        // Every drafted id, so a later batch cannot re-invent a responsibility one character off.
        const known = candidate.nodes.map(node => ({ id: node.id, kind: node.kind, title: node.title }));
        let reported = "";
        const response = await provider.generate({ prompt: [
          stage.instructions,
          JSON.stringify({ existing: model, known, ...(stage.module ? { paths: stage.module.paths } : {}), inventory: index === 0 ? [...sources.keys()].slice(0, 400) : undefined, sources: [...stage.sources], omitted: options.paths.length - sources.size })
        ].join("\n\n"), responseSchema: z.toJSONSchema(stage.module ? proseSchema : stage.areas ? areaSchema : draftModelSchema), inputHash: fingerprint, promptVersion: PROMPT_VERSION, attempt: 1, maxOutputTokens: 32_000, onEvent: event => {
          const activity = event.title?.trim() || event.text.trim().slice(0, 160);
          if (!activity || activity === reported) return;
          reported = activity;
          progress({ phase: "generating", completed: index, total: stages.length, message: activity });
        } }, signal);
        // Relations are checked across all stages at the end, so a batch may safely mention a node
        // another batch owns; only the committed graph has to be closed.
        if (stage.areas) {
          // Navigation, not ownership: a response that drops or duplicates a module leaves the model ungrouped.
          const modules = candidate.nodes.filter(node => node.kind === "module").map(node => ({ id: node.id, title: node.title }));
          // The prompt lists every module with its title, so a model may copy the label instead of the id.
          const titles = new Map<string, string[]>();
          for (const module of modules) titles.set(module.title.toLowerCase(), [...(titles.get(module.title.toLowerCase()) ?? []), module.id]);
          const readAreas = (text: string): { areas: z.infer<typeof areaSchema>["areas"]; errors: string[] } => {
            // A prose answer is a rejected grouping, not a fatal error: the repair round below exists for it.
            let value: unknown;
            try { value = parseJsonObject(text); } catch (error) { return { areas: [], errors: [error instanceof Error ? error.message : String(error)] }; }
            const parsed = areaSchema.safeParse(value);
            if (!parsed.success) return { areas: [], errors: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
            const areas = parsed.data.areas.map(area => ({ ...area, moduleIds: area.moduleIds.map(member => {
              const match = titles.get(member.trim().toLowerCase());
              return match?.length === 1 ? match[0]! : member;
            }) }));
            return { areas, errors: validateOwnership(areas.map(area => ({ name: area.title, members: area.moduleIds })), new Set(modules.map(module => module.id))) };
          };
          let grouping = readAreas(response.text);
          if (grouping.errors.length) {
            // One repair round: naming the mistake and the exact ids is cheaper than drafting every module again.
            progress({ phase: "generating", completed: index, total: stages.length, message: "Repairing the functional grouping…" });
            const retry = await provider.generate({ prompt: [
              `${STRUCTURE_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING}`,
              `The previous grouping was rejected: ${grouping.errors.slice(0, 6).join(" ")}`,
              `Assign every one of these module ids exactly once: ${JSON.stringify(modules)}`
            ].join("\n\n"), responseSchema: z.toJSONSchema(areaSchema), inputHash: fingerprint, promptVersion: PROMPT_VERSION, attempt: 2, maxOutputTokens: 32_000 }, signal);
            grouping = readAreas(retry.text);
          }
          if (grouping.errors.length) ungrouped = grouping.errors[0];
          else for (const area of grouping.areas) candidate.nodes.push(projectModelNodeSchema.parse({
            id: `area:${slug(area.title)}`, kind: "capability", title: area.title, canonicalName: area.title,
            body: { kind: "inline", text: area.description }, properties: { moduleIds: area.moduleIds }
          }));
        } else if (stage.module) {
          // The previous run already accepted a name for this module, so it beats a file name.
          const savedTitle = model?.nodes.find(node => node.id === stage.module!.id || node.paths.some(path => stage.module!.paths.includes(path)))?.title;
          const prose = readProse(response.text, savedTitle ?? stage.module.paths[0]!.split("/").pop()!.replace(/\.[^/.]+$/, ""));
          // The index cap split one responsibility across groups, not the design: the same title is one node.
          const existing = candidate.nodes.find(node => node.kind === "module" && node.title.toLowerCase() === prose.title.toLowerCase());
          if (existing) {
            existing.paths = [...new Set([...existing.paths, ...stage.module.paths])];
            // One responsibility split by the index cap still reads from every one of its files.
            existing.evidence = [...new Map([...existing.evidence, ...stageEvidence(stage)].map((entry) => [entry.path, entry])).values()];
          } else candidate.nodes.push(projectModelNodeSchema.parse({ id: stage.module.id, kind: "module", title: prose.title, canonicalName: prose.title, body: { kind: "inline", text: prose.body }, paths: stage.module.paths, evidence: stageEvidence(stage) }));
        } else {
          const part: ProjectModel = { ...candidate, ...draftModelSchema.parse(normalizeBodies(parseJsonObject(response.text), sources)) };
          // With an index, this stage only contributes the root: module identity belongs to the index.
          mergeProjectModel(candidate, structure && groups.length
            ? { ...part, nodes: part.nodes.filter(node => node.kind === "project" || node.kind === "architecture"), relations: [] }
            : part);
        }
        completed = index + 1;
        await writeCheckpoint(candidate, completed);
      }
      if (!candidate.nodes.length) throw new Error("Project AI returned no nodes; nothing was saved.");
      // The index owns module edges once it exists; model-proposed edges would only duplicate it.
      if (structure && groups.length) {
        candidate.relations = structureRelations(structure, candidate.nodes);
        // Area membership is authored, so its edges are rebuilt from the nodes and survive a resume.
        for (const node of candidate.nodes) {
          if (node.kind !== "capability") continue;
          for (const id of (node.properties.moduleIds as string[] | undefined) ?? []) {
            if (!candidate.nodes.some(item => item.id === id)) continue;
            candidate.relations.push(projectModelRelationSchema.parse({ id: `${node.id}--maps_to--${id}`, from: node.id, to: id, kind: "maps_to", origin: "inferred", review: "draft", freshness: "needs_verification" }));
          }
        }
      }
      progress({ phase: "generating", completed: stages.length, total: stages.length, message: `Drafted ${candidate.nodes.length} nodes in ${stages.length} stages${reused ? `, reusing ${reused} unchanged stage(s)` : ""}.${ungrouped ? ` Modules stay ungrouped: ${ungrouped}` : ""}` });
    }
    if (!resumed) await writeCheckpoint(candidate, completed);
  }
  if (drafting) {
    // Drafting errors are repaired rather than fatal, including on a run resumed after every stage.
    dropped = [...resolveRelations(candidate), ...sanitizeDraft(candidate)];
    const errors = validateProjectModel(candidate);
    if (errors.length) throw new Error(`The drafted Project model is inconsistent: ${errors.slice(0, 5).join(" ")}`);
  }
  signal.throwIfAborted();
  for (const [path, text] of sources) {
    const current = await (host.readFileStrict ? host.readFileStrict(path) : host.readFile(path));
    if (current !== text) throw new Error(`Project source changed during initialization: ${path}`);
  }
  progress({ phase: "saving", fraction: 0, message: dropped.length ? `Validating the Project model and its baseline… dropped ${dropped.length} unresolved entry(ies) from the draft.` : "Validating the Project model and its baseline…" });
  const merged = reconcileNativeProject(candidate, model);
  // Review signals are derived from the committed graph every run; earlier decisions travel as reviews.
  // shortcut: only a run with a fresh structure index re-derives them, so a Knowledge-only edit keeps the last set.
  const qualityView = projectModelIntent(merged, sources);
  const quality = projectModelQuality(qualityView, structure?.modules.flatMap(module => module.members) ?? [], qualityView.qualityIssues ?? []);
  const next = await store.updateProject(withProjectQuality(merged, quality), model?.revision ?? null);
  await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "committed", completed, candidate: next }));
  return { model: next, intent: projectModelIntent(next, sources) };
}
