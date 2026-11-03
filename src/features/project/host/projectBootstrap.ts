import { z } from "zod";
import { projectModelRelationSchema, projectModelSchema, projectModelNodeSchema, type ProjectModel, type ProjectModelNode, type ProjectModelRelation } from "../contracts/projectModel.js";
import { projectC4Schema } from "../contracts/projectIntent.js";
import type { StructureSummary } from "./indexing/projectStructure.js";
import { structureCandidates, deriveStructureHierarchy, mergeEvidence, validateEntryPoints, validateOwnership, validateStructureHierarchy, responsibilityDraftSchema, responsibilityMergeSchema, type StructureCandidate } from "./indexing/projectStructureKnowledge.js";
import type { ProjectInitializationOutput, ProjectInitializationProgressListener } from "../contracts/lifecycle.js";
import { parseProjectModel, projectModelIntent, validateProjectModel } from "../knowledge/projectModel.js";
import { reconcileNativeProject } from "../knowledge/projectModelEvolution.js";
import { jsonCandidates } from "../../../shared/protocol/resultBoundary.js";
import { compareProjectEvidencePaths, PROJECT_BUILD_CONFIG_PATH, type ProjectAiProvider } from "./generation/projectAiGeneration.js";
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
const PROMPT_VERSION = "project-bootstrap-12";

/** Guidance and build configuration define boundaries, so they are read before documentation and source. */
const compareBootstrapPaths = (left: string, right: string): number =>
  Number(runtimeBoundarySource(right)) - Number(runtimeBoundarySource(left))
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
interface BootstrapStage { instructions: string; sources: Map<string, string>; module?: { id: string; paths: string[] }; c4?: true }

const ROOT_STAGE = "Draft the graph root only: return exactly {\"project\":{\"title\":...,\"body\":...},\"architecture\":{\"title\":...,\"body\":...}}. The project states purpose, scope and non-goals; architecture states module boundaries, dependency edges and invariants. The host owns node ids, kinds and relationships. Create no module nodes yet; the directory list below is an overview, not a node per directory. Write each body as Markdown with '## Responsibility' (what it owns), '## Design' (the decisions and invariants behind the code) and '## Boundary' ('- Allowed:' and '- Forbidden:' dependencies).";
const MODEL_GUIDANCE = "Build a native Project normative model: goals, then architecture, then modules/contracts and their explicit relationships. Do not mirror the directory tree. Read guidance before specifications, configuration and source evidence. Third-party sources are supporting evidence. All generated content is draft. Do not create Plan nodes. Adopt durable documents in place rather than copying them. Return a JSON object matching the supplied schema. Evidence outside this bounded package is unknown.";
const PROSE_GUIDANCE = "Explain one responsibility the indexed structure already decided: what it owns and why it is shaped this way. Read guidance before source. All generated content is draft. Never invent module ids, files or relationships; the index owns those.";
/**
 * One responsibility has one name per layer: what the interface calls it, what the code calls it, and
 * this record. The code name wins a conflict, so a title always lands on a real symbol.
 */
const LABEL_LANGUAGE = "Every 'title' is a short English label of 2-5 words that already exists in the project, never a sentence and never a directory path. Prefer the code's own name for the responsibility (package, module, public type or entry symbol): when the interface calls it something else, the code name still wins the title and the interface name is documented in the body. Use the interface name only when the code has none, and never invent a product name, so a project without a UI is still mapped by its code name. Every body is written in Simplified Chinese.";
const NAME_MAPPING = "Record the mapping once, in the first '## Responsibility' bullet of a node body or in an area 'description', as '**Names**: <interface name> → <public symbol or entry file>' (without an interface: '<code name> → <files>'); the title is the code name on that line, so the interface label, the code symbol and this record all name the same responsibility.";
const PROSE_STAGE = "Return exactly {\"title\": \"<responsibility name>\", \"body\": \"<Markdown with ## Responsibility, ## Design and ## Boundary ('- Allowed:' / '- Forbidden:')>\"}. Name the responsibility, never the directory.";
/** Candidates only schedule reads; the AI proposes responsibilities, the index decides what may merge. */
const RESPONSIBILITY_GUIDANCE = "Identify developer-facing responsibilities from the complete file facts below. Return exactly {\"contexts\":[{\"canonicalName\",\"purpose\",\"uncertainties\",\"sourceFiles\",\"entryPoints\"}]}. Candidate groups are scheduling hints from names and static dependencies, NOT knowledge modules: split unrelated files inside a candidate and merge related files across candidates when the facts support it. Assign EVERY supplied path to exactly one context. A helper, contract or single function is not automatically its own topic; keep supporting code with the feature it serves. Do not merge unrelated files merely because they share a directory, a format or a suffix. Name responsibilities, never directories. Put open questions in uncertainties, not in the purpose.";
const RESPONSIBILITY_MERGE_GUIDANCE = "Consolidate provisional responsibility outlines from different evidence batches. Return exactly {\"contexts\":[{\"canonicalName\",\"purpose\",\"uncertainties\",\"sourceFiles\",\"entryPoints\"}]}. Merge outlines only when they describe one coherent responsibility that a developer would study together; keep distinct capabilities separate. You may move a file between outlines when its declared consumers or dependencies support it. Assign EVERY supplied path to exactly one context and never claim a path outside them.";
const RESPONSIBILITY_FALLBACK = "The proposal was rejected twice, so the candidate boundaries are kept as temporary responsibilities; the run reports them for review.";
const responsibilitySchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(200), purpose: z.string().max(1000).default(""),
  paths: z.array(z.string().min(1)).min(1), entryPoints: z.array(z.string().min(1)).default([]), uncertainties: z.array(z.string().min(1)).default([]) }).strict();
interface BootstrapResponsibility { id: string; name: string; purpose: string; paths: string[]; entryPoints: string[]; uncertainties: string[] }

/** Runtime boundaries are a separate interpretation of configuration and guidance, never of a directory tree. */
const C4_STAGE = "Draft the runtime architecture only when the supplied build configuration, guidance and entry-point excerpts support it. Return {\"c4\":{\"systemId\":...,\"elements\":[...],\"relationships\":[...]}} or {} when no boundary is supported. The focal system is this project. An element is a 'person', an external 'system', or a runtime 'container' (UI/webview, host/server, worker/subprocess or data store). Use a short English 'name' and a Simplified Chinese 'description'. A directory, package or module is not a container. Set each container's 'parentId' to the focal system and its 'contextIds' to the exact module ids from 'known' that implement it. Give the focal system a relationship to each person and external system it exchanges data with, and connect each container to the system or another container it actually talks to. External systems require evidence of a separate ownership/deployment boundary. Cite a supplied path and, for read excerpts, a visible line in every element and relationship. Omit unsupported boundaries.";
const c4EnvelopeSchema = z.object({ c4: projectC4Schema.optional() }).strict();
const c4EnvelopeJson = JSON.stringify(z.toJSONSchema(c4EnvelopeSchema));

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

/** Candidates are scheduling hints with bounded facts; the AI proposes responsibilities from them. */
const candidateFacts = (candidate: StructureCandidate): unknown => ({
  candidate: candidate.id,
  files: candidate.files.map(file => ({ path: file.path, declarations: file.symbols.slice(0, 8).map(symbol => symbol.name),
    dependencies: file.dependencies.filter(edge => edge.to && !edge.typeOnly).map(edge => edge.to), consumers: file.consumers ?? [] }))
});

function candidateBatches(candidates: readonly StructureCandidate[]): StructureCandidate[][] {
  const batches: StructureCandidate[][] = [];
  let batch: StructureCandidate[] = [], size = 0;
  for (const candidate of candidates) {
    const chars = JSON.stringify(candidateFacts(candidate)).length;
    if (batch.length && (batch.length >= 12 || size + chars > STAGE_CHARS)) { batches.push(batch); batch = []; size = 0; }
    batch.push(candidate); size += chars;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

const responsibilityId = (paths: readonly string[]): string => `module:${slug([...paths].sort()[0]!)}`;
const responsibilityOf = (value: { canonicalName: string; purpose?: string; sourceFiles: readonly string[]; entryPoints?: readonly string[]; uncertainties?: readonly string[] }): BootstrapResponsibility => ({
  id: responsibilityId(value.sourceFiles), name: value.canonicalName, purpose: value.purpose ?? "",
  paths: [...value.sourceFiles], entryPoints: [...(value.entryPoints ?? [])], uncertainties: [...(value.uncertainties ?? [])]
});

/** The index cap split or joined reads; a candidate is still the boundary when no evidence joins it to another. */
const candidateFallback = (candidates: readonly StructureCandidate[]): BootstrapResponsibility[] => candidates.map(candidate => ({
  id: responsibilityId(candidate.files.map(file => file.path)), name: candidate.files[0]!.path.split("/").pop()!.replace(/\.[^/.]+$/, ""),
  purpose: RESPONSIBILITY_FALLBACK, paths: candidate.files.map(file => file.path), entryPoints: [candidate.files[0]!.path], uncertainties: [RESPONSIBILITY_FALLBACK]
}));

/** Prefer a previous module whose members still overlap this responsibility clearly. */
function reusableIdentity(previous: ProjectModel | undefined, paths: readonly string[]): string | undefined {
  let best: { id: string; score: number } | undefined, tied = false;
  for (const node of previous?.nodes ?? []) {
    if (node.kind !== "module" || !node.paths.length) continue;
    const shared = node.paths.filter(path => paths.includes(path)).length;
    const score = shared / new Set([...node.paths, ...paths]).size;
    if (!shared || score < 0.5) continue;
    if (!best || score > best.score) { best = { id: node.id, score }; tied = false; }
    else if (score === best.score) tied = true;
  }
  return best && !tied ? best.id : undefined;
}

/** Parent modules are directory products, not AI output; their bodies say what they group. */
function hierarchyNodes(hierarchy: ReturnType<typeof deriveStructureHierarchy>, titles: ReadonlyMap<string, string>): ProjectModelNode[] {
  const children = new Map<string, string[]>();
  for (const [child, parent] of hierarchy.parentOf) children.set(parent, [...children.get(parent) ?? [], titles.get(child) ?? child]);
  return hierarchy.parents.map(parent => {
    const members = children.get(parent.id) ?? [];
    return projectModelNodeSchema.parse({ id: parent.id, kind: "module", title: parent.title, canonicalName: parent.title,
      body: { kind: "inline", text: `## Responsibility\n\nDirectory grouping for ${members.length} module(s): ${members.join(", ")}.\n\n## Boundary\n\n- Allowed: the modules it contains.\n- Forbidden: owning source files directly; every file has one leaf owner.` },
      paths: [], properties: { overview: true } });
  });
}


/** The root, module and area stages explain code; only guidance and build configuration define a runtime boundary. */
const runtimeBoundarySource = (path: string): boolean => guidancePath(path) || PROJECT_BUILD_CONFIG_PATH.test(path);
const runtimeKind = (node: ProjectModelNode | undefined): boolean => node?.kind === "person" || node?.kind === "system" || node?.kind === "container";
/** Guidance and build configuration set the stage; entry-point source is where a runtime actually starts. */
const runtimeBoundaryStage = (sources: ReadonlyMap<string, string>, structure: StructureSummary | undefined): BootstrapStage => {
  const staged = new Map([...sources].filter(([path]) => runtimeBoundarySource(path)));
  let size = [...staged.values()].reduce((total, text) => total + text.length, 0);
  for (const path of [...new Set(structure?.modules.flatMap(module => module.entryPoints) ?? [])]) {
    const text = sources.get(path);
    if (text === undefined || staged.has(path)) continue;
    if (size + text.length > STAGE_CHARS) break;
    staged.set(path, text); size += text.length;
  }
  return { instructions: `${MODEL_GUIDANCE} ${LABEL_LANGUAGE} ${C4_STAGE} Return JSON matching this schema: ${c4EnvelopeJson}`, sources: staged, c4: true };
};

/** C4 elements become native nodes; the reader derives its landscape and runtime views from them. */
function mergeProjectC4(model: ProjectModel, c4: z.infer<typeof projectC4Schema>): void {
  const known = new Map(model.nodes.map(node => [node.id, node]));
  const elements = c4.elements.filter(element => !known.has(element.id));
  const ids = new Set(elements.map(element => element.id));
  const project = model.nodes.find(node => node.kind === "project");
  if (project && elements.some(element => element.id === c4.systemId && element.kind === "system")) project.properties = { ...project.properties, c4SystemId: c4.systemId };
  for (const element of elements) {
    const node = projectModelNodeSchema.parse({ id: element.id, kind: element.kind, title: element.name, canonicalName: element.name,
      body: { kind: "inline", text: element.description },
      properties: { ...(element.external ? { external: true } : {}), ...(element.technology ? { technology: element.technology } : {}) },
      evidence: element.evidence, origin: "inferred", review: "draft", freshness: "needs_verification" });
    model.nodes.push(node); known.set(node.id, node);
  }
  const link = (from: string, to: string, kind: "contains" | "communicates" | "maps_to", description = "", evidence: ProjectModelRelation["evidence"] = []): void => {
    const id = `${from}--${kind}--${to}`;
    if (from === to || !known.has(from) || !known.has(to) || model.relations.some(edge => edge.id === id)) return;
    model.relations.push(projectModelRelationSchema.parse({ id, from, to, kind, description, evidence, origin: "inferred", review: "draft", freshness: "needs_verification" }));
  };
  for (const element of elements) {
    if (element.parentId && ids.has(element.parentId)) link(element.parentId, element.id, "contains");
    // Containers point at responsibilities, never at another runtime element.
    for (const id of element.contextIds) {
      const target = known.get(id);
      if (target && (target.kind === "module" || target.kind === "context")) link(element.id, id, "maps_to");
    }
  }
  for (const relation of c4.relationships) if (ids.has(relation.from) && ids.has(relation.to)) link(relation.from, relation.to, "communicates", relation.description, relation.evidence);
}

/** The structure index owns module edges only; C4 interactions are not in the index and must survive. */
function c4Relations(model: ProjectModel): ProjectModelRelation[] {
  const runtime = new Set(model.nodes.filter(runtimeKind).map(node => node.id));
  return model.relations.filter(edge => edge.kind === "maps_to" ? runtime.has(edge.from) : (edge.kind === "contains" || edge.kind === "communicates") && runtime.has(edge.from) && runtime.has(edge.to));
}

/** `contains` and `depends_on` come from the index, never from the model, so a module edge cannot dangle. */
function structureRelations(summary: StructureSummary, nodes: readonly ProjectModelNode[], parentOf: ReadonlyMap<string, string> = new Map()): ProjectModelRelation[] {
  const present = new Set(nodes.map(node => node.id)), owner = new Map<string, string>(), edges: ProjectModelRelation[] = [];
  const add = (from: string, to: string, kind: "contains" | "depends_on"): void => {
    if (from === to || !present.has(from) || !present.has(to) || edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) return;
    edges.push(projectModelRelationSchema.parse({ id: `${from}--${kind}--${to}`, from, to, kind, origin: "detected", review: "draft", freshness: "needs_verification" }));
  };
  const root = nodes.find(node => node.kind === "project")?.id;
  const architecture = nodes.find(node => node.kind === "architecture")?.id;
  if (root && architecture) add(root, architecture, "contains");
  // Ownership comes from the nodes, so a responsibility merged across groups keeps its edges.
  for (const node of nodes) if (node.kind === "module" && node.id !== "architecture") {
    const parent = parentOf.get(node.id) ?? root;
    if (parent) add(parent, node.id, "contains");
    for (const path of node.paths) owner.set(path, node.id);
  }
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
const rootDraftSchema = z.object({ project: proseSchema, architecture: proseSchema }).strict();

/** AI writes root prose; the host preserves identities and builds the graph. */
function readRoot(text: string, sources: ReadonlyMap<string, string>, previous?: ProjectModel): Pick<ProjectModel, "nodes" | "relations"> {
  const draft = rootDraftSchema.parse(parseJsonObject(text));
  const nodes = (["project", "architecture"] as const).map(kind => {
    const saved = previous?.nodes.find(node => node.kind === kind);
    return projectModelNodeSchema.parse({ id: saved?.id ?? kind, kind, title: draft[kind].title, canonicalName: draft[kind].title,
      body: { kind: "inline", text: draft[kind].body }, properties: saved?.properties ?? {},
      evidence: [...sources].map(([path, text]) => ({ path, contentHash: projectContentHash(text) })) });
  });
  const project = nodes[0]!, architecture = nodes[1]!;
  return { nodes, relations: [projectModelRelationSchema.parse({ id: `${project.id}--contains--${architecture.id}`, from: project.id, to: architecture.id, kind: "contains" })] };
}

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

/** Functional areas: navigation over modules whose ids and ownership the index already decided. */

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

const checkpointSchema = z.object({ version: z.literal(1), fingerprint: z.string(), route: z.enum(["existing", "legacy", "documents", "code", "empty"]), stage: z.enum(["candidate", "committed"]), completed: z.number().int().nonnegative(), candidate: projectModelSchema,
  responsibilities: z.array(responsibilitySchema).optional(), prose: z.number().int().nonnegative().optional(), c4: z.boolean().optional() }).strict();
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
  // Candidate groups schedule reads only; files outside the read budget cannot be explained or owned.
  const candidates: StructureCandidate[] = structure ? structureCandidates(structure)
    .map(candidate => ({ ...candidate, files: candidate.files.filter(file => sources.has(file.path)) }))
    .filter(candidate => candidate.files.length) : [];
  const structured = Boolean(drafting && structure && candidates.length);
  const stages = !drafting || structured ? [] : bootstrapStages(sources);
  // shortcut: C4 is drafted only while the model has none, so an update cannot create a second set;
  // delete the runtime-boundary nodes to refresh them.
  if (drafting && !structured && !model?.nodes.some(runtimeKind)) stages.push(runtimeBoundaryStage(sources, structure));
  // The read plan is part of the identity: a checkpoint drafted from different boundaries or prompts
  // must not be resumed, or the same responsibility gets drafted twice.
  const fingerprint = projectContentHash(JSON.stringify({ route, revision: model?.revision ?? null,
    documents: [...sources].map(([path, text]) => [path, projectContentHash(text)]),
    plan: structured ? candidates.map(candidate => candidate.files.map(file => file.path)) : stages.map(stage => [...stage.sources.keys()]),
    prompt: PROMPT_VERSION, schema: 2, ai: options.ai }));
  const rawCheckpoint = await (host.readFileStrict ? host.readFileStrict(PROJECT_BOOTSTRAP_CHECKPOINT_PATH) : host.readFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH));
  let resumed: { model: ProjectModel; completed: number; responsibilities?: BootstrapResponsibility[]; prose?: number; c4?: boolean } | undefined;
  if (rawCheckpoint) {
    try {
      const saved = checkpointSchema.parse(JSON.parse(rawCheckpoint));
      if (saved.fingerprint === fingerprint && saved.stage === "candidate") resumed = { model: parseProjectModel(saved.candidate), completed: saved.completed,
        ...(saved.responsibilities ? { responsibilities: saved.responsibilities } : {}), prose: saved.prose ?? 0, c4: saved.c4 ?? false };
    } catch { /* Invalid candidate is never promoted. */ }
  }
  const writeCheckpoint = async (value: ProjectModel, progressCount: number, extra: { responsibilities?: BootstrapResponsibility[]; prose?: number; c4?: boolean } = {}): Promise<void> => {
    await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "candidate", completed: progressCount, candidate: value,
      ...(extra.responsibilities ? { responsibilities: extra.responsibilities } : {}), ...(extra.prose ? { prose: extra.prose } : {}), ...(extra.c4 ? { c4: true } : {}) }));
  };
  let candidate = resumed?.model;
  let completed = resumed?.completed ?? 0;
  let dropped: string[] = [];
  /** Boundary and runtime decisions the run could not establish, reported instead of looking successful. */
  const boundaryNotes: string[] = [];
  /** Why the optional C4 pass produced nothing, so the run reports it instead of looking successful. */
  let c4Note = "";
  if (!candidate || drafting) {
    if (!drafting) {
      candidate = { schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [projectModelNodeSchema.parse({ id: "project", kind: "project", title: options.name, canonicalName: options.name, body: { kind: "inline", text: "Project intent needs definition and review." }, review: "draft", freshness: "needs_verification" })] };
      if (route !== "empty") for (const [path, content] of sources) if (durable(path)) candidate.nodes.push(projectModelNodeSchema.parse({ id: `document:${projectContentHash(path).slice(0, 20)}`, kind: "contract", title: path, canonicalName: path, body: { kind: "document", path, contentHash: projectContentHash(content) }, origin: "detected", review: "draft", freshness: "needs_verification" }));
      if (route === "documents" && candidate.nodes.length === 1) throw new Error("Durable documents exceed the read budget or could not be read; choose a smaller scope.");
    } else {
      if (!options.provider) throw new Error("Choose an available Project AI provider before importing code.");
      const provider = options.provider;
      candidate ??= { schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [], relations: [] };
      if (structured) {
        let responsibilities = resumed?.responsibilities;
        const proseDone = resumed?.prose ?? 0;
        const c4Done = resumed?.c4 ?? false;
        let reused = 0;
        const total = responsibilities ? responsibilities.length + 2 : candidates.length + 2;
        const ask = async (instructions: string, payload: unknown, schema: Readonly<Record<string, unknown>>, position: { completed: number; total: number }, label: string, attempt = 1) => {
          progress({ phase: "generating", completed: position.completed, total: position.total, message: label });
          let reported = "";
          return provider.generate({ prompt: [instructions, JSON.stringify(payload)].join("\n\n"), responseSchema: schema, inputHash: fingerprint,
            promptVersion: PROMPT_VERSION, attempt, maxOutputTokens: 32_000, onEvent: event => {
              const activity = event.title?.trim() || event.text.trim().slice(0, 160);
              if (!activity || activity === reported) return;
              reported = activity;
              progress({ phase: "generating", completed: position.completed, total: position.total, message: activity });
            } }, signal);
        };
        const payload = (extra: Record<string, unknown>) => ({ known: candidate!.nodes.map(node => ({ id: node.id, kind: node.kind, title: node.title })), omitted: options.paths.length - sources.size, ...extra });
        const readProposals = (text: string, inventory: ReadonlySet<string>, fallback: BootstrapResponsibility[]): { responsibilities: BootstrapResponsibility[]; errors: string[] } => {
          let value: unknown;
          try { value = parseJsonObject(text); } catch (error) { return { responsibilities: fallback, errors: [error instanceof Error ? error.message : String(error)] }; }
          const parsed = responsibilityDraftSchema.safeParse(value);
          if (!parsed.success) return { responsibilities: fallback, errors: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
          const errors = [...validateOwnership(parsed.data.contexts.map(context => ({ name: context.canonicalName, members: context.sourceFiles })), inventory),
            ...validateEntryPoints(parsed.data.contexts.map(context => ({ name: context.canonicalName, members: context.sourceFiles, entryPoints: context.entryPoints })))];
          return errors.length ? { responsibilities: fallback, errors } : { responsibilities: parsed.data.contexts.map(responsibilityOf), errors: [] };
        };
        const candidateOf = new Map<string, number>();
        candidates.forEach((candidate, index) => candidate.files.forEach(file => candidateOf.set(file.path, index)));
        /** Keep candidate boundaries when a proposed merge has no static evidence. */
        const gated = (proposals: BootstrapResponsibility[], fallback: BootstrapResponsibility[]): BootstrapResponsibility[] => {
          const accepted: BootstrapResponsibility[] = [];
          for (const proposal of proposals) {
            const indices = [...new Set(proposal.paths.map(path => candidateOf.get(path)).filter((index): index is number => index !== undefined))];
            if (indices.length < 2) { accepted.push(proposal); continue; }
            const groups = indices.map(index => candidates[index]!.files.map(file => file.path).filter(path => proposal.paths.includes(path)));
            if (mergeEvidence(structure!, groups).allowed) { accepted.push(proposal); continue; }
            boundaryNotes.push(`merge rejected without structural evidence: ${proposal.name}`);
            accepted.push(...fallback.filter(item => item.paths.some(path => proposal.paths.includes(path))));
          }
          return accepted;
        };
        if (!responsibilities) {
          if (!resumed?.model.nodes.some(node => node.kind === "project")) {
            const rootSources = new Map([...sources].filter(([path]) => guidancePath(path)));
            const response = await ask(`${MODEL_GUIDANCE} ${LABEL_LANGUAGE} ${ROOT_STAGE}`,
              { inventory: [...sources.keys()].slice(0, 400), sources: [...rootSources], omitted: options.paths.length - sources.size },
              z.toJSONSchema(rootDraftSchema), { completed: 0, total }, "Drafting goals and architecture…");
            mergeProjectModel(candidate, { ...candidate, ...readRoot(response.text, rootSources, model) });
            completed = 1;
            await writeCheckpoint(candidate, completed);
          }
          const batches = candidateBatches(candidates);
          let provisional: BootstrapResponsibility[] = [];
          for (const [index, batch] of batches.entries()) {
            const inventory = new Set(batch.flatMap(group => group.files.map(file => file.path)));
            const fallback = candidateFallback(batch);
            const request = async (attempt: number, errors: readonly string[] = []) => ask(`${RESPONSIBILITY_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING}`,
              payload({ candidates: batch.map(candidateFacts), inventory: [...inventory], ...(errors.length ? { rejected: errors.slice(0, 6) } : {}) }),
              z.toJSONSchema(responsibilityDraftSchema), { completed: 1, total }, `Identifying responsibilities in batch ${index + 1} of ${batches.length}…`, attempt);
            let read = readProposals((await request(1)).text, inventory, fallback);
            if (read.errors.length) read = readProposals((await request(2, read.errors)).text, inventory, fallback);
            if (read.errors.length) boundaryNotes.push(`responsibility batch ${index + 1}: ${read.errors[0]}`);
            provisional.push(...gated(read.responsibilities, fallback));
          }
          if (batches.length > 1 && provisional.length > 1) {
            const inventory = new Set(provisional.flatMap(item => item.paths));
            const request = async (attempt: number, errors: readonly string[] = []) => ask(`${RESPONSIBILITY_MERGE_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING}`,
              payload({ responsibilities: provisional.map(({ name, purpose, paths, entryPoints, uncertainties }) => ({ canonicalName: name, purpose, paths, entryPoints, uncertainties })),
                ...(errors.length ? { rejected: errors.slice(0, 6) } : {}) }), z.toJSONSchema(responsibilityMergeSchema), { completed: 1, total }, "Consolidating responsibilities across batches…", attempt);
            const readMerge = (text: string): { responsibilities: BootstrapResponsibility[]; errors: string[] } => {
              let value: unknown;
              try { value = parseJsonObject(text); } catch (error) { return { responsibilities: provisional, errors: [error instanceof Error ? error.message : String(error)] }; }
              const parsed = responsibilityMergeSchema.safeParse(value);
              if (!parsed.success) return { responsibilities: provisional, errors: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
              const errors = [...validateOwnership(parsed.data.contexts.map(context => ({ name: context.canonicalName, members: context.sourceFiles })), inventory),
                ...validateEntryPoints(parsed.data.contexts.map(context => ({ name: context.canonicalName, members: context.sourceFiles, entryPoints: context.entryPoints })))];
              return errors.length ? { responsibilities: provisional, errors } : { responsibilities: parsed.data.contexts.map(responsibilityOf), errors: [] };
            };
            let merged = readMerge((await request(1)).text);
            if (merged.errors.length) merged = readMerge((await request(2, merged.errors)).text);
            if (merged.errors.length) boundaryNotes.push(`responsibility consolidation: ${merged.errors[0]}`);
            else provisional = gated(merged.responsibilities, provisional);
          }
          responsibilities = provisional;
          const inventory = new Set(candidates.flatMap(group => group.files.map(file => file.path)));
          const ownership = validateOwnership(responsibilities.map(item => ({ name: item.name, members: item.paths })), inventory);
          if (ownership.length) throw new Error(`The drafted responsibility boundaries are inconsistent: ${ownership.slice(0, 5).join(" ")}`);
          // A reused id must stay unique, or two responsibilities would become one node.
          const ids = new Set<string>();
          responsibilities = responsibilities.map(item => {
            const preferred = reusableIdentity(model, item.paths) ?? item.id;
            const id = ids.has(preferred) ? item.id : preferred;
            ids.add(id);
            return { ...item, id };
          });
          await writeCheckpoint(candidate, 1, { responsibilities });
        }
        const hierarchy = deriveStructureHierarchy(responsibilities.map(item => ({ id: item.id, paths: item.paths })));
        const hierarchyErrors = validateStructureHierarchy(hierarchy, responsibilities.map(item => ({ id: item.id, paths: item.paths })));
        if (hierarchyErrors.length) throw new Error(`The drafted module hierarchy is inconsistent: ${hierarchyErrors.slice(0, 5).join(" ")}`);
        const totalStages = responsibilities.length + 2;
        const names = new Map(responsibilities.map(item => [item.id, item.name]));
        const parentTitle = new Map(hierarchy.parents.map(parent => [parent.id, parent.title]));
        for (let index = proseDone; index < responsibilities.length; index += 1) {
          const item = responsibilities[index]!;
          const staged = new Map<string, string>(); let size = 0;
          for (const path of item.paths) {
            const text = sources.get(path);
            if (text === undefined) continue;
            if (staged.size && size + text.length > STAGE_CHARS) break;
            staged.set(path, text); size += text.length;
          }
          const stage: BootstrapStage = { instructions: "", sources: staged, module: { id: item.id, paths: item.paths } };
          const saved = reusableModule(model, stage);
          if (saved) {
            candidate.nodes.push(saved); reused += 1;
            progress({ phase: "generating", completed: 1 + index + 1, total: totalStages, message: `Reusing ${saved.title} — its sources are unchanged…` });
          } else {
            const parent = hierarchy.parentOf.get(item.id);
            const children = [...hierarchy.parentOf].filter(([, parentId]) => parentId === item.id).map(([child]) => names.get(child) ?? child);
            const response = await ask(`${PROSE_GUIDANCE} ${LABEL_LANGUAGE} ${NAME_MAPPING} ${PROSE_STAGE}`,
              payload({ purpose: item.purpose, ...(parent ? { parent: parentTitle.get(parent) } : {}), ...(children.length ? { children } : {}), paths: item.paths,
                uncertainties: item.uncertainties, sources: [...staged] }),
              z.toJSONSchema(proseSchema), { completed: 1 + index, total: totalStages }, `Drafting ${item.name}…`);
            const prose = readProse(response.text, item.name);
            candidate.nodes.push(projectModelNodeSchema.parse({ id: item.id, kind: "module", title: prose.title, canonicalName: prose.title,
              body: { kind: "inline", text: prose.body }, paths: item.paths, evidence: stageEvidence(stage) }));
          }
          completed = 1 + index + 1;
          await writeCheckpoint(candidate, completed, { responsibilities, prose: index + 1 });
        }
        const titles = new Map(candidate.nodes.filter(node => node.kind === "module").map(node => [node.id, node.title]));
        for (const parent of hierarchyNodes(hierarchy, titles)) if (!candidate.nodes.some(node => node.id === parent.id)) candidate.nodes.push(parent);
        if (!c4Done) {
          if (!model?.nodes.some(runtimeKind) && !candidate.nodes.some(runtimeKind)) {
            const stage = runtimeBoundaryStage(sources, structure);
            const response = await ask(stage.instructions, payload({ sources: [...stage.sources] }), z.toJSONSchema(c4EnvelopeSchema), { completed: totalStages - 1, total: totalStages }, "Drafting runtime boundaries…");
            try {
              const c4 = c4EnvelopeSchema.parse(parseJsonObject(response.text)).c4;
              if (c4) {
                const cited = (entries: ProjectModelRelation["evidence"]): ProjectModelRelation["evidence"] => entries.filter(entry => {
                  const text = sources.get(entry.path);
                  return text !== undefined && (entry.line === undefined || entry.line <= text.split("\n").length);
                });
                const elements = c4.elements.map(element => ({ ...element, evidence: cited(element.evidence) })).filter(element => element.evidence.length);
                const ids = new Set(elements.map(element => element.id));
                const relationships = c4.relationships.filter(relation => ids.has(relation.from) && ids.has(relation.to))
                  .map(relation => ({ ...relation, evidence: cited(relation.evidence) })).filter(relation => relation.evidence.length);
                mergeProjectC4(candidate, { ...c4, elements, relationships });
                c4Note = elements.length ? `runtime boundaries: ${elements.length} nodes` : "runtime boundaries: no supported evidence";
              } else c4Note = "runtime boundaries: no supported boundary";
            } catch (error) {
              c4Note = `runtime boundaries skipped: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
            }
          }
          await writeCheckpoint(candidate, completed, { responsibilities, prose: responsibilities.length, c4: true });
        }
        // The index owns modules, hierarchy and dependency edges; C4 interactions are not in it and must survive.
        candidate.relations = [...structureRelations(structure!, candidate.nodes, hierarchy.parentOf), ...c4Relations(candidate)];
        progress({ phase: "generating", completed: totalStages, total: totalStages,
          message: `Drafted ${candidate.nodes.length} nodes from ${candidates.length} candidate group(s)${reused ? `, reusing ${reused} unchanged module(s)` : ""}.${boundaryNotes.length ? ` Review boundaries: ${boundaryNotes.slice(0, 3).join("; ")}` : ""}${c4Note ? ` ${c4Note}.` : ""}` });
      } else {
      // Fallback without an import index: the AI drafts bounded batches; no structure merge is claimed.
      for (let index = completed; index < stages.length; index += 1) {
        const stage = stages[index]!;
        const label = stage.c4 ? "Drafting runtime boundaries…" : index === 0 ? "Drafting goals and architecture…" : `Drafting responsibility batch ${index} of ${stages.length - 1}…`;
        progress({ phase: "generating", completed: index, total: stages.length, message: label });
        // Every drafted id, so a later batch cannot re-invent a responsibility one character off.
        const known = candidate.nodes.map(node => ({ id: node.id, kind: node.kind, title: node.title }));
        let reported = "";
        const response = await provider.generate({ prompt: [
          stage.instructions,
          JSON.stringify({ ...(stage.c4 ? {} : { existing: model }), known, inventory: index === 0 ? [...sources.keys()].slice(0, 400) : undefined, sources: [...stage.sources], omitted: options.paths.length - sources.size })
        ].join("\n\n"), responseSchema: z.toJSONSchema(stage.c4 ? c4EnvelopeSchema : index === 0 ? rootDraftSchema : draftModelSchema), inputHash: fingerprint, promptVersion: PROMPT_VERSION, attempt: 1, maxOutputTokens: 32_000, onEvent: event => {
          const activity = event.title?.trim() || event.text.trim().slice(0, 160);
          if (!activity || activity === reported) return;
          reported = activity;
          progress({ phase: "generating", completed: index, total: stages.length, message: activity });
        } }, signal);
        // Runtime boundaries are optional: a malformed or unsupported answer never discards the model.
        if (stage.c4) try {
          const c4 = c4EnvelopeSchema.parse(parseJsonObject(response.text)).c4;
          if (c4) {
            // Keep every evidence entry this run actually read; a stale reference alone never drops the boundary.
            const cited = (entries: ProjectModelRelation["evidence"]): ProjectModelRelation["evidence"] => entries.filter(entry => {
              const text = sources.get(entry.path);
              return text !== undefined && (entry.line === undefined || entry.line <= text.split("\n").length);
            });
            const elements = c4.elements.map(element => ({ ...element, evidence: cited(element.evidence) })).filter(element => element.evidence.length);
            const ids = new Set(elements.map(element => element.id));
            const relationships = c4.relationships.filter(relation => ids.has(relation.from) && ids.has(relation.to))
              .map(relation => ({ ...relation, evidence: cited(relation.evidence) })).filter(relation => relation.evidence.length);
            mergeProjectC4(candidate, { ...c4, elements, relationships });
            c4Note = elements.length ? `runtime boundaries: ${elements.length} nodes` : "runtime boundaries: no supported evidence";
          } else c4Note = "runtime boundaries: no supported boundary";
        } catch (error) {
          c4Note = `runtime boundaries skipped: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
        } else if (index === 0) {
          mergeProjectModel(candidate, { ...candidate, ...readRoot(response.text, stage.sources, model) });
        } else {
          const part: ProjectModel = { ...candidate, ...draftModelSchema.parse(normalizeBodies(parseJsonObject(response.text), sources)) };
          // Relations are checked at the end, so a batch may safely mention a node another batch owns.
          mergeProjectModel(candidate, part);
        }
        completed = index + 1;
        await writeCheckpoint(candidate, completed);
      }
      progress({ phase: "generating", completed: stages.length, total: stages.length, message: `Drafted ${candidate.nodes.length} nodes in ${stages.length} stages${c4Note ? ` ${c4Note}.` : ""}` });
      }
      if (!candidate.nodes.length) throw new Error("Project AI returned no nodes; nothing was saved.");
    }
    if (!resumed && !drafting) await writeCheckpoint(candidate, completed);
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
  const merged = reconcileNativeProject(candidate, model);
  // The fresh index decides file ownership first; a node only the older model still knows loses its files to it.
  const owners = new Set<string>(), stale = new Set<string>();
  for (const node of new Map([...candidate.nodes, ...merged.nodes].filter(item => item.kind === "module").map(item => [item.id, item] as const)).values()) {
    const owned = node.paths.filter(path => !owners.has(path));
    for (const path of owned) owners.add(path);
    if (owned.length !== node.paths.length) dropped.push(node.id);
    if (node.paths.length && !owned.length) stale.add(node.id);
    node.paths = owned;
  }
  // Areas are no longer generated: a draft grouping this run did not author leaves with its edges.
  const authored = new Set(candidate.nodes.map(node => node.id));
  for (const node of merged.nodes) {
    if (node.review !== "draft" || authored.has(node.id)) continue;
    if (node.kind === "capability") stale.add(node.id);
    // An overview module this run did not author has no files to keep it in scope.
    if (node.kind === "module" && !node.paths.length) stale.add(node.id);
  }
  // A module that lost every file, or an area the run re-authored, has nothing left to explain.
  if (stale.size) {
    merged.nodes = merged.nodes.filter(node => !stale.has(node.id));
    merged.relations = merged.relations.filter(edge => !stale.has(edge.from) && !stale.has(edge.to));
    for (const node of merged.nodes) if (node.kind === "capability")
      node.properties = { ...node.properties, moduleIds: ((node.properties.moduleIds as string[] | undefined) ?? []).filter(id => !stale.has(id)) };
    dropped.push(...stale);
  }
  progress({ phase: "saving", fraction: 0, message: dropped.length ? `Validating the Project model and its baseline… dropped ${dropped.length} unresolved entry(ies) from the draft.` : "Validating the Project model and its baseline…" });
  const qualityView = projectModelIntent(merged, sources);
  const quality = projectModelQuality(qualityView, structure?.modules.flatMap(module => module.members) ?? []);
  const next = await store.updateProject(withProjectQuality(merged, quality), model?.revision ?? null);
  await host.writeFile(PROJECT_BOOTSTRAP_CHECKPOINT_PATH, JSON.stringify({ version: 1, route, fingerprint, stage: "committed", completed, candidate: next }));
  return { model: next, intent: projectModelIntent(next, sources) };
}
