import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as vscode from "vscode";
import { z } from "zod";
import type { ProjectInitializationProgressListener } from "../../contracts/lifecycle.js";
import { attachProjectStructure, buildProjectEvidencePackage, compareProjectEvidencePaths, isExcludedProjectEvidencePath, isProjectEvidencePath, PROJECT_BUILD_CONFIG_PATH, projectEvidenceFileKind, type ProjectEvidenceFileInput, type ProjectKnowledgeReference } from "../generation/projectAiGeneration.js";
import type { ProjectEvidenceReadOptions } from "../projectPanelDataSource.js";
import { buildStructureIndex, PROJECT_STRUCTURE_VERSION, structureCacheSchema, type StructureInput } from "./projectStructure.js";
import { structureDependencies, structureEntryFamily } from "./projectStructureGraph.js";
import { browserBuildEntries, runtimeEvidenceCandidates, runtimeEvidenceWindows } from "./projectStructureKnowledge.js";

export async function indexedRelatedPaths(cachePath: string | undefined, preferred: ReadonlySet<string>): Promise<string[]> {
  if (!cachePath) return [];
  try {
    const cached = z.object({ version: z.literal(PROJECT_STRUCTURE_VERSION), dependencies: z.array(z.object({ from: z.string(), to: z.string().optional(), status: z.enum(["resolved", "unresolved"]) })) }).parse(JSON.parse(await readFile(cachePath, "utf8")));
    return cached.dependencies.flatMap(edge => preferred.has(edge.from) && edge.status === "resolved" && edge.to ? [edge.to] : []);
  } catch { return []; }
}

/** Local indexing covers the entire discovered scope. Only AI excerpts have a character budget. */
export async function readProjectStructureEvidence(root: vscode.Uri, candidates: readonly vscode.Uri[], knowledge: readonly ProjectKnowledgeReference[], options: ProjectEvidenceReadOptions,
  onProgress?: ProjectInitializationProgressListener, signal?: AbortSignal) {
  const pathOf = (uri: vscode.Uri) => decodeURIComponent(uri.path.slice(root.path.replace(/\/$/, "").length + 1));
  const found = candidates.filter(uri => isProjectEvidencePath(pathOf(uri)) && !isExcludedProjectEvidencePath(pathOf(uri))).sort((a, b) => compareProjectEvidencePaths(pathOf(a), pathOf(b)));
  const evidenceChars = Math.min(options.maxEvidenceChars ?? 120_000, 120_000);
  const excerpts: ProjectEvidenceFileInput[] = [];
  let excerptChars = 0;
  let cache;
  if (options.structureCachePath) {
    try { cache = structureCacheSchema.parse(JSON.parse(await readFile(options.structureCachePath, "utf8"))); } catch { /* Rebuild missing, old or corrupt caches. */ }
  }
  let completed = 0;
  const boundaryPaths = new Set<string>();
  const browserEntries = new Set<string>();
  const buildGaps: string[] = [];
  async function* inputs(): AsyncGenerator<StructureInput> {
    for (const uri of found) {
      signal?.throwIfAborted();
      const path = pathOf(uri);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > (options.maxFileBytes ?? 2_000_000)) { yield { path, issue: "Exceeds the per-file indexing size limit" }; continue; }
        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const kind = projectEvidenceFileKind(path);
        if (PROJECT_BUILD_CONFIG_PATH.test(path)) {
          const entries = browserBuildEntries(content);
          entries.paths.forEach(entry => browserEntries.add(entry.replace(/^\.\//, "")));
          buildGaps.push(...entries.gaps.map(gap => path + ": " + gap));
        }
        // Background excerpts are selected here; runtime source reads follow the complete index.
        if (kind !== "source" && excerptChars < evidenceChars / 3) {
          const text = content.slice(0, Math.min(options.maxFileChars ?? 8000, 8000, evidenceChars / 3 - excerptChars));
          excerpts.push({ path, content, kind, excerptStartLine: 1, excerptEndLine: Math.max(1, text.split("\n").length - Number(text.length < content.length)) }); excerptChars += text.length;
        }
        if (/\b(?:acquireVsCodeApi|postMessage|onDidReceiveMessage|handleMessage|run\w*Process)\s*\(|\bextensionUri\b|\b__dextApi\b/.test(content)) boundaryPaths.add(path);
        // Build scripts provide deployment evidence, not application knowledge ownership.
        if (!PROJECT_BUILD_CONFIG_PATH.test(path)) yield { path, content };
      } catch (error) {
        signal?.throwIfAborted();
        // Parser failures occur outside this generator and must propagate to the caller.
        yield { path, issue: error instanceof Error ? `Could not read file: ${error.message}` : "Could not read file" };
      } finally {
        completed++;
        onProgress?.({ phase: "preparing", completed, total: found.length, message: "Indexing project structure (JS/TS, Rust, Python)…" });
      }
    }
  }
  const index = await buildStructureIndex(inputs(), { ...(cache ? { cache } : {}), ...(options.structureAssetsPath ? { assetsPath: options.structureAssetsPath } : {}), ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  const byPath = new Map(found.map(uri => [pathOf(uri), uri]));
  const sourceBudget = Math.floor(evidenceChars * 0.15);
  // Overview needs boundary coverage, not the module-analysis preset's long excerpts.
  const sourceExcerptChars = Math.min(options.maxFileChars ?? 8000, 900, Math.max(64, Math.floor(sourceBudget / 3) - 300));
  let sourceChars = 0;
  const sourceIssues: string[] = [...buildGaps];
  const primary: ProjectEvidenceFileInput[] = [];
  const supplemental: ProjectEvidenceFileInput[] = [];
  const deployment: Array<ProjectEvidenceFileInput & { category: string }> = [];
  const addExcerpt = (excerpt: ProjectEvidenceFileInput, budget = sourceBudget): boolean => {
    if (excerpts.some(item => item.path === excerpt.path && item.excerptStartLine === excerpt.excerptStartLine && item.excerptEndLine === excerpt.excerptEndLine)) return true;
    const text = excerpt.content.split("\n").slice(excerpt.excerptStartLine! - 1, excerpt.excerptEndLine).join("\n");
    const cost = Math.min(sourceExcerptChars, text.length) + 300;
    if (sourceChars + cost > budget) return false;
    excerpts.push(excerpt); sourceChars += cost; return true;
  };
  const fileByPath = new Map(index.cache.files.map(file => [file.path, file]));
  const entryPaths = new Set<string>();
  const entryFamilies = new Map<string, string[]>();
  for (const entry of browserEntries) {
    if (!fileByPath.has(entry)) { sourceIssues.push("Browser build entry not indexed in configured scope: " + entry); continue; }
    // Follow indexed local dependencies of small startup entries to their actual message handlers.
    const family = structureEntryFamily(index.graph, entry);
    for (const path of family) if (boundaryPaths.has(path) || path === entry) entryPaths.add(path);
    entryFamilies.set(entry, family);
  }
  const runtimeCandidates = [...new Set([...entryPaths].flatMap(path => fileByPath.get(path) ?? []).concat(runtimeEvidenceCandidates(index.cache.files)))];
  for (const candidate of [...runtimeCandidates, ...index.cache.files.filter(file => boundaryPaths.has(file.path) && !runtimeCandidates.includes(file))]) {
    signal?.throwIfAborted();
    try {
      const uri = byPath.get(candidate.path)!;
      if ((await vscode.workspace.fs.stat(uri)).size > (options.maxFileBytes ?? 2_000_000)) continue;
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      if (createHash("sha256").update(content).digest("hex") !== candidate.hash) {
        sourceIssues.push(`Source changed during indexing: ${candidate.path}; runtime excerpt omitted.`); continue;
      }
      for (const window of runtimeEvidenceWindows(content, candidate, sourceExcerptChars)) {
        const excerpt = { path: candidate.path, content, kind: "source" as const, excerptStartLine: window.startLine, excerptEndLine: window.endLine, category: window.category };
        (window.category !== "primary" && window.category !== "transport" ? deployment : window.primary ? primary : supplemental).push(excerpt);
      }
    } catch {
      signal?.throwIfAborted();
      sourceIssues.push(`Could not reread runtime evidence: ${candidate.path}.`);
    }
  }
  // One nearest communication window per role and actual build entry, before duplicates.
  // A small startup module can delegate to a reader; its dependency path remains explicit.
  const priority: typeof deployment = [];
  for (const category of ["client", "send", "receive"]) for (const family of entryFamilies.values()) {
    const match = deployment.filter(item => item.category === category && family.includes(item.path))
      .sort((a, b) => family.indexOf(a.path) - family.indexOf(b.path))[0];
    if (match) priority.push(match);
  }
  const packagedLauncher = (item: ProjectEvidenceFileInput) => Number(/(?:process\.execPath|sys\.executable)[\s\S]*["']bin\//.test(item.content.split("\n").slice(item.excerptStartLine! - 1, item.excerptEndLine).join("\n")));
  deployment.sort((a, b) => packagedLauncher(b) - packagedLauncher(a) || compareProjectEvidencePaths(a.path, b.path));
  for (const category of ["launcher", "deployment", "dispatch", "host-receive"]) {
    const dispatch = priority.find(item => item.category === "dispatch");
    const candidates = deployment.filter(item => item.category === category && !entryPaths.has(item.path));
    if (category === "host-receive" && dispatch) {
      const targets = new Set(structureDependencies(index.graph, dispatch.path, { typeOnly: false }));
      candidates.sort((a, b) => Number(targets.has(b.path)) - Number(targets.has(a.path)));
    }
    const match = candidates[0];
    if (match) priority.push(match);
  }
  const processTransport = (item: ProjectEvidenceFileInput) => fileByPath.get(item.path)?.imports.some(edge => !edge.typeOnly && /child_process|subprocess|std::process/.test(edge.specifier)) ? 1 : 0;
  supplemental.sort((a, b) => processTransport(b) - processTransport(a));
  const transportLaunches = primary.filter(item => supplemental.some(other => other.path === item.path));
  const ordered = [...priority, ...transportLaunches, ...supplemental, ...primary, ...deployment];
  for (const excerpt of ordered) if (!addExcerpt(excerpt)) sourceIssues.push(`Runtime window omitted by budget: ${excerpt.path}:${excerpt.excerptStartLine}.`);
  for (const entry of browserEntries) if (!excerpts.some(item => item.path === entry)) sourceIssues.push("Browser startup excerpt omitted by budget or unsupported entry: " + entry);
  if (options.structureCachePath) {
    const target = options.structureCachePath, temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temporary, JSON.stringify({ ...index.cache, dependencies: index.dependencies, summary: index.summary }), "utf8");
      signal?.throwIfAborted();
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  const coverage = [
    `Local index: ${index.summary.parsed} source files, ${index.summary.modules.length} modules; ${index.summary.cached} reused, ${index.summary.failed} issues, ${index.summary.unsupported} unsupported files.`,
    "Static imports are code dependencies, not runtime calls. Dynamic imports, macros and unresolved references remain unverified.",
    "Runtime boundary excerpts are selected from the complete index within a text budget; omitted boundaries remain unverified.", ...sourceIssues
  ];
  const packaged = buildProjectEvidencePackage({ projectName: root.path.split("/").at(-1) ?? "Project", files: excerpts, preserveSourceOrder: true, allowMultipleExcerpts: true, knowledge, scope: options.include ?? [], coverage,
    ...(options.preset ? { preset: options.preset } : {}) }, { maxTotalChars: Math.floor(evidenceChars / 2), maxFiles: Math.max(1, excerpts.length), maxFileChars: Math.min(options.maxFileChars ?? 8000, 8000), maxSourceFileChars: sourceExcerptChars });
  const fileOrder = new Map([...new Set(packaged.files.map(file => file.path))].map((path, index) => [path, index]));
  packaged.files.sort((left, right) => fileOrder.get(left.path)! - fileOrder.get(right.path)! || left.startLine - right.startLine);
  const omittedRuntime = excerpts.filter(file => file.kind === "source" && !packaged.files.some(excerpt => excerpt.path === file.path && excerpt.startLine === file.excerptStartLine));
  if (omittedRuntime.length) packaged.coverage.push(`Runtime excerpts omitted by packaging budget: ${omittedRuntime.map(file => file.path).join(", ")}. These boundaries remain unverified.`);
  const startupGaps = sourceIssues.filter(issue => issue.startsWith("Browser "));
  for (const gap of startupGaps) if (!packaged.coverage.includes(gap)) packaged.coverage.push(gap);
  packaged.selection.evidenceChars = evidenceChars;
  return attachProjectStructure(packaged, index.summary);
}
