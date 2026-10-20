import { isAbsolute, posix, resolve } from "node:path";
import * as vscode from "vscode";
import type { ProjectInitializationProgressListener } from "../../contracts/lifecycle.js";
import { type ProjectIntent } from "../../contracts/projectIntent.js";
import type { ProjectObject } from "../../contracts/projectKnowledge.js";
import type { ArchifyRepository } from "../diagrams/archifyAdapter.js";
import {
buildProjectEvidencePackage,
compareProjectEvidencePaths,
isExcludedProjectEvidencePath,
isProjectEvidencePath,
PROJECT_BUILD_CONFIG_PATH,
projectEvidenceFileKind,
type ProjectEvidenceFileInput,
type ProjectEvidencePackage,
type ProjectKnowledgeReference
} from "../generation/projectAiGeneration.js";
import { indexedRelatedPaths, readProjectStructureEvidence } from "./projectStructureHost.js";


export const textDecoder = new TextDecoder();


export const PROJECT_EVIDENCE_EXCLUDE = "**/{node_modules,out,dist,build,.git,target,coverage,.vscode-test,.npm-cache,.tmp-tb,.venv,venv,__pycache__,.pytest_cache,.mypy_cache}/**";

export const PROJECT_README_GLOB = "**/{README,README.md,README.txt,readme,readme.md,readme.txt}";

export const PROJECT_DOCUMENT_GLOB = "**/*.{md,mdx,rst,txt}";

export const PROJECT_MANIFEST_GLOB = "**/{package.json,tsconfig*.json,jsconfig.json,Cargo.toml,Cargo.lock,pyproject.toml,go.mod,pom.xml}";

export const PROJECT_BUILD_CONFIG_GLOB = "**/{esbuild*,vite.config*,webpack.config*,rollup.config*}.{js,mjs,cjs,ts,mts,cts}";

export const PROJECT_SOURCE_GLOB = "**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs,py,rs,go,java,kt,kts,rb,cs,php,swift,c,h,cpp,hpp}";


export interface ProjectEvidenceReadOptions {
  structureAssetsPath?: string;
  structureCachePath?: string;
  mode?: "index" | "topic";
  requirement?: string;
  /** Explicit topic evidence is prioritized within the configured scope and budgets. */
  preferredPaths?: readonly string[];
  /** Exact responsibility membership; avoids pulling unrelated neighbors from a flat directory. */
  modulePaths?: readonly string[];
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


export function relativePath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  const prefix = root.path.replace(/\/$/, "") + "/";
  if (!uri.path.startsWith(prefix)) return undefined;
  return decodeURIComponent(uri.path.slice(prefix.length));
}


/**
 * Reads only bounded documentation, manifests and source text when the user explicitly starts
 * initialization or diagram generation. Index builds parse the configured source scope locally;
 * diagram requests retain bounded excerpts. Nothing runs in the background.
 */
export async function readWorkspaceEvidence(
  root: vscode.Uri,
  knowledge: { objects?: readonly ProjectObject[]; intent?: ProjectIntent },
  options: ProjectEvidenceReadOptions,
  onProgress?: ProjectInitializationProgressListener,
  signal?: AbortSignal
): Promise<ProjectEvidencePackage> {
  const mode = options.mode;
  if (mode === "topic") options = { ...options, maxFiles: Math.min(options.maxFiles ?? 600, 32),
    maxSourceFiles: Math.min(options.maxSourceFiles ?? 600, 28),
    maxFileChars: Math.min(options.maxFileChars ?? 16_000, 12_000),
    maxEvidenceChars: Math.min(options.maxEvidenceChars ?? 600_000, 96_000) };
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
  const candidateLimit = mode === "index" ? undefined : mode ? 4_000 : Math.min(4_000, Math.max(maxFiles, maxSourceFiles) * 8);
  const pathOf = (uri: vscode.Uri): string => relativePath(root, uri) ?? uri.path;
  const preferred = new Set([...(options.preferredPaths ?? []), ...(options.modulePaths ?? [])]);
  const preferredOrder = new Map([...preferred].map((path, index) => [path, index]));
  const related = new Set<string>();
  const cachedText = new Map<string, string>();
  const byEvidenceRank = (left: vscode.Uri, right: vscode.Uri): number => (preferredOrder.get(pathOf(left)) ?? Number.MAX_SAFE_INTEGER) - (preferredOrder.get(pathOf(right)) ?? Number.MAX_SAFE_INTEGER) || Number(related.has(pathOf(right))) - Number(related.has(pathOf(left))) || compareProjectEvidencePaths(pathOf(left), pathOf(right));
  const found: vscode.Uri[] = [];
  const foundPaths = new Set<string>();
  for (const pattern of patterns) {
    if (signal?.aborted) throw new Error("Project initialization was cancelled.");
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), excluded, candidateLimit);
    for (const uri of uris) if (!foundPaths.has(uri.path)) { foundPaths.add(uri.path); found.push(uri); }
  }
  if (signal?.aborted) throw new Error("Project initialization was cancelled.");
  if (mode === "index") {
    // Source scope stays explicit. Ancestor manifests/READMEs provide package and project context.
    const sourcePaths = found.map(pathOf).filter(path => projectEvidenceFileKind(path) === "source");
    const ancestors = new Set<string>();
    for (const path of sourcePaths) {
      let directory = posix.dirname(path);
      while (!ancestors.has(directory)) { ancestors.add(directory); if (directory === ".") break; directory = posix.dirname(directory); }
    }
    for (const pattern of [PROJECT_MANIFEST_GLOB, PROJECT_README_GLOB, PROJECT_BUILD_CONFIG_GLOB]) {
      signal?.throwIfAborted();
      const context = await vscode.workspace.findFiles(new vscode.RelativePattern(root, pattern), excluded);
      for (const uri of context) {
        const path = pathOf(uri), directory = posix.dirname(path);
        if (pattern === PROJECT_BUILD_CONFIG_GLOB && !PROJECT_BUILD_CONFIG_PATH.test(path)) continue;
        if (ancestors.has(directory) && !foundPaths.has(uri.path)) { foundPaths.add(uri.path); found.push(uri); }
      }
    }
    return readProjectStructureEvidence(root, found, buildKnowledgeReferences(knowledge), { ...options, include }, onProgress, signal);
  }
  if (mode === "topic" && preferred.size) {
    const available = new Set(found.map(pathOf));
    for (const path of await indexedRelatedPaths(options.structureCachePath, preferred)) if (available.has(path)) related.add(path);
    for (const uri of found.filter(uri => preferred.has(pathOf(uri))).sort(byEvidenceRank).slice(0, Math.min(8, maxSourceFiles, Math.floor(maxFiles / 2)))) {
      if (signal?.aborted) throw new Error("Module analysis was cancelled.");
      try {
        if ((await vscode.workspace.fs.stat(uri)).size > maxFileBytes) continue;
        const source = textDecoder.decode(await vscode.workspace.fs.readFile(uri));
        cachedText.set(pathOf(uri), source);
        for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](\.[^"']+)["']/g)) {
          const target = posix.normalize(posix.join(posix.dirname(pathOf(uri)), match[1]!));
          const stem = target.replace(/\.(?:mjs|cjs|js)$/, "");
          const resolved = [target, `${stem}.ts`, `${stem}.tsx`, `${target}.ts`, `${target}.js`, `${target}/index.ts`, `${target}/index.js`].find(path => available.has(path));
          if (resolved) related.add(resolved);
        }
      } catch { /* The normal bounded read below reports inaccessible entry files. */ }
    }
    const directories = [...preferred].map(path => path.slice(0, path.lastIndexOf("/") + 1));
    // Select the module's explicit files and nearby source, plus project-level context.
    for (let i = found.length - 1; i >= 0; i--) {
      const path = pathOf(found[i]!);
      if (!preferred.has(path) && !related.has(path) && (options.modulePaths || !directories.some(directory => path.startsWith(directory) && !path.slice(directory.length).includes("/")))
        && !(path.indexOf("/") < 0 && projectEvidenceFileKind(path) !== "source")) found.splice(i, 1);
    }
    coverage.push(options.modulePaths ? "Module analysis prioritizes its recorded member files and direct dependencies within a bounded scope. Unrelated directory neighbors are excluded."
      : "Module analysis reads its entry files, direct relative imports and nearby sources within a bounded scope. Cross-module behavior outside these excerpts remains unverified.");
  }
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
      const content = cachedText.get(path) ?? textDecoder.decode(await vscode.workspace.fs.readFile(uri));
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
    ...(options.preferredPaths ? { preferredPaths: options.preferredPaths } : {}),
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


export function buildKnowledgeReferences(knowledge: { objects?: readonly ProjectObject[]; intent?: ProjectIntent }): ProjectKnowledgeReference[] {
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
    add("step", intent.flows.flatMap((flow) => flow.steps.map((step) => ({ ...step, canonicalName: step.label }))));
    add("c4", (intent.c4?.elements ?? []).map((element) => ({ ...element, canonicalName: element.name })));
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