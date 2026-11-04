import { createHash } from "node:crypto";
import { parse } from "acorn";
import { posix } from "node:path";
import { z } from "zod";
import { projectContextSchema, type ProjectContext } from "../../contracts/projectIntent.js";
import type { StructureFile, StructureMember, StructureSummary } from "./projectStructure.js";
import { buildStructureGraphFromMembers, buildStructureGraphFromSummary, structureConsumers, structureDependencies, structureDependencyEdges, structureConsumerEdges } from "./projectStructureGraph.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_.-]+/)[0]!;

/** Read literal browser entry declarations without importing or executing a build script. */
export function browserBuildEntries(content: string): { paths: string[]; gaps: string[] } {
  const paths = new Set<string>(), gaps: string[] = [];
  let tree: unknown;
  try { tree = parse(content, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { return { paths: [], gaps: ["Build configuration could not be statically parsed; dynamic/TypeScript entries remain unverified."] }; }
  const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const key = (value: unknown): unknown => object(value)?.name ?? object(value)?.value;
  function entry(value: unknown): void {
    const node = object(value);
    if (!node) return;
    if (node.type === "Literal" && typeof node.value === "string") { paths.add(node.value); return; }
    if (node.type === "ArrayExpression" && Array.isArray(node.elements)) { node.elements.forEach(entry); return; }
    if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
      for (const property of node.properties) {
        const item = object(property);
        if (item?.type === "Property" && !item.computed) entry(item.value);
        else gaps.push("Computed browser entry was omitted.");
      }
      return;
    }
    gaps.push("Nonliteral browser entry was omitted.");
  }
  function walk(value: unknown): void {
    const node = object(value);
    if (!node) return;
    if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
      const properties = node.properties.map(object).filter((item): item is Record<string, unknown> => !!item);
      if (properties.some(item => key(item.key) === "platform" && object(item.value)?.value === "browser")) {
        for (const item of properties) if (key(item.key) === "entryPoints") entry(item.value);
      }
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === "object") walk(child);
  }
  walk(tree);
  return { paths: [...paths], gaps: [...new Set(gaps)] };
}
export interface StructureCandidate { id: string; files: Array<StructureMember & { consumers?: string[] }> }

/** Prioritize potential runtime boundaries for actual source reads, never infer C4 from these hints. */
export function runtimeEvidenceCandidates(files: readonly StructureFile[]): StructureFile[] {
  const categories = [
    /(?:child_process|worker_threads|subprocess|multiprocessing|std::process|std::thread)/i,
    /(?:vscode|electron|tauri|webview)/i,
    /(?:^node:https?$|express|fastify|flask|django|aiohttp|axum|actix)/i
  ];
  const ranked = files.map(file => ({ file,
    category: categories.findIndex(pattern => file.imports.some(item => !item.typeOnly && pattern.test(item.specifier))),
    entry: file.symbols.find(symbol => /^(?:main|activate|bootstrap|spawn\w*|create\w*(?:Server|Webview(?:Panel)?|Worker|Window))$/i.test(symbol.name))
  })).filter(item => item.category >= 0 || item.entry)
    .sort((a, b) => Number(!!b.entry) - Number(!!a.entry) || a.file.path.localeCompare(b.file.path));
  // Read at least the strongest candidate of each detected family before its other consumers.
  const first = [...new Set(ranked.map(item => item.category))].map(category => ranked.find(item => item.category === category)!);
  return [...first, ...ranked.filter(item => !first.includes(item))].map(item => item.file);
}

/** Discovery hints select real text windows; they never assert a transport or runtime edge. */
export function runtimeEvidenceWindows(content: string, file: StructureFile, maxChars: number): Array<{ startLine: number; endLine: number; primary: boolean; category: string }> {
  const lines = content.split("\n");
  const code = (line: string) => !/^\s*(?:\/\/|\*|#)/.test(line);
  const boundary = lines.findIndex(line => code(line)
    && /\b(?:spawn|fork|createWebviewPanel|createWebview|createServer|Worker|BrowserWindow|Popen|Process|listen)\s*\(|Command::new\s*\(/.test(line));
  const entry = file.symbols.find(symbol => /^(?:main|activate|bootstrap)$/i.test(symbol.name));
  const points = [{ point: boundary >= 0 ? boundary : entry ? entry.line - 1 : -1, category: "primary" }];
  // Outbound HTTP and transport dispatch often occur far below the first process launch.
  for (const [category, pattern] of [
    ["transport", /\b(?:fetch|urlopen)\s*\(|\b(?:requests|http|https)\.(?:request|get|post)\s*\(|(?:ClientSession|reqwest::Client)\b/],
    ["transport", /\b(?:transport|protocol)\s*===?\s*["'](?:http|https|stdio|sse|websocket|grpc)["']/i],
    ["client", /\bacquireVsCodeApi\s*\(|\b__dextApi\b/],
    ["send", /\.\s*postMessage(?:\?\.)?\s*\(/],
    ["dispatch", /^\s*(?:async\s+)?handleMessage\s*\(/],
    ["host-receive", /\bonDidReceiveMessage(?:\?\.)?\s*\(/],
    ["receive", /\baddEventListener\s*\(\s*["']message["']/],
    ["launcher", /\brun\w*Process\s*\(/],
    ["deployment", /\b(?:joinPath|join|resolve)\s*\([^\n]*(?:extensionUri|resourcesPath|__dirname)[^\n]*["'](?:vendor|bin|resources)["']/]
  ] as const) points.push({ category, point: lines.findIndex(line => code(line) && pattern.test(line)
    && !/\bfunction\s+(?:acquireVsCodeApi|run\w*Process)\b/.test(line)) });
  const windows: Array<{ startLine: number; endLine: number; primary: boolean; category: string }> = [];
  for (const { point, category } of points) {
    if (point < 0) continue;
    const existing = windows.find(window => point + 1 >= window.startLine && point + 1 <= window.endLine);
    if (existing) {
      if (category !== "primary" && category !== "transport") { existing.category = category; existing.primary = false; }
      continue;
    }
    const start = Math.max(0, point - 3);
    let end = start, chars = 0;
    while (end < lines.length && chars + lines[end]!.length + 1 <= maxChars) { chars += lines[end]!.length + 1; end++; }
    windows.push({ startLine: start + 1, endLine: Math.max(start + 1, end), primary: category === "primary", category });
  }
  return windows;
}

/** Small neighborhoods are scheduling hints, never the final knowledge boundaries. */
export function structureCandidates(summary: StructureSummary): StructureCandidate[] {
  const graph = buildStructureGraphFromSummary(summary);
  const result: StructureCandidate[] = [];
  for (const pkg of [...new Set(summary.modules.map(module => module.package))].sort()) {
    const files = summary.modules.filter(module => module.package === pkg).flatMap(module => module.members).sort((a, b) => a.path.localeCompare(b.path));
    const remaining = new Map(files.map(file => [file.path, file]));
    const families = new Map<string, Set<string>>();
    for (const file of files) { const family = families.get(stem(file.path)) ?? new Set<string>(); family.add(file.path); families.set(stem(file.path), family); }
    const claim = (file: StructureMember) => { remaining.delete(file.path); families.get(stem(file.path))!.delete(file.path); };
    const neighbors = new Map<string, Set<string>>();
    for (const file of files) {
      const adjacent = neighbors.get(file.path) ?? new Set<string>();
      for (const edge of structureDependencyEdges(graph, file.path)) adjacent.add(edge.to);
      for (const edge of structureConsumerEdges(graph, file.path)) adjacent.add(edge.from);
      neighbors.set(file.path, adjacent);
    }
    while (remaining.size) {
      const first = remaining.values().next().value!;
      const group = [first]; claim(first);
      while (group.length < 16 && remaining.size) {
        // Bound neighbor scoring, not coverage: remaining files always seed a later group.
        const pool = new Set(group.flatMap(member => [
          ...Array.from(families.get(stem(member.path))!).slice(0, 16),
          ...Array.from(neighbors.get(member.path) ?? []).filter(path => remaining.has(path)).slice(0, 64)
        ]));
        if (!pool.size) break;
        const score = (file: StructureMember) => group.reduce((best, member) => Math.max(best,
          (stem(file.path) === stem(member.path) ? 4 : 0) + (neighbors.get(member.path)?.has(file.path) ? 2 : 0)
          + (posix.dirname(file.path) === posix.dirname(member.path) ? 1 : 0)), 0);
        const next = [...pool].map(path => remaining.get(path)!).map(file => ({ file, score: score(file) })).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))[0]!;
        if (next.score < 2) break;
        group.push(next.file); claim(next.file);
      }
      result.push({ id: `candidate:${first.path}`, files: group });
    }
  }
  return result.map(candidate => ({ ...candidate, files: candidate.files.map(file => ({ ...file,
    consumers: structureConsumers(graph, file.path, { typeOnly: false })
  })) }));
}

/** A directory is the structural prior: its files are one candidate, and only whole candidates may be joined. */
export function directoryCandidates(summary: StructureSummary): StructureCandidate[] {
  const graph = buildStructureGraphFromSummary(summary);
  const byDirectory = new Map<string, StructureMember[]>();
  for (const file of summary.modules.flatMap(module => module.members).sort((a, b) => a.path.localeCompare(b.path))) {
    const directory = posix.dirname(file.path);
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
  }
  return [...byDirectory].map(([directory, files]) => ({ id: `candidate:${directory}`,
    files: files.map(file => ({ ...file, consumers: structureConsumers(graph, file.path, { typeOnly: false }) })) }));
}

const label = z.string().trim().min(1).max(120);
export const responsibilityDraftSchema = z.object({ contexts: z.array(z.object({
  canonicalName: label, purpose: z.string().trim().min(1).max(500),
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(5).default([]),
  sourceFiles: z.array(z.string().min(1)).min(1), entryPoints: z.array(z.string().min(1)).min(1).max(6)
}).strict()).min(1).max(60) }).strict();
export const responsibilityMergeSchema = z.object({ contexts: z.array(responsibilityDraftSchema.shape.contexts.element).min(1).max(120) }).strict();

/** Only retain actionable, source-anchored questions, not a disclaimer on every outline. */
function specificQuestions(questions: readonly string[], paths: readonly string[]): string[] {
  return [...new Set(questions.map(question => question.trim()))].filter(question =>
    /[?？]$/.test(question) && paths.some(path => question.includes(path))
    && !/(?:runtime verification|implementation verification|not established by|运行时验证|实现验证|无法从声明)/i.test(question));
}

/** Every indexed file has one primary owner. Dependencies provide cross-module references. */
export function validateOwnership(groups: readonly { name: string; members: readonly string[] }[], expected: ReadonlySet<string>): string[] {
  const errors: string[] = [], owners = new Set<string>();
  for (const group of groups) for (const member of group.members) {
    if (!expected.has(member)) errors.push(`${group.name}: Unknown source member '${member}'.`);
    if (owners.has(member)) errors.push(`${group.name}: Duplicate source ownership '${member}'.`);
    owners.add(member);
  }
  for (const member of expected) if (!owners.has(member)) errors.push(`Missing source ownership '${member}'.`);
  return errors;
}

/** An entry point outside its own module is a claim the index cannot support. */
export function validateEntryPoints(groups: readonly { name: string; members: readonly string[]; entryPoints?: readonly string[] }[]): string[] {
  return groups.flatMap(group => (group.entryPoints ?? []).filter(path => !group.members.includes(path))
    .map(path => `${group.name}: Entry point '${path}' is not owned by this module.`));
}

/**
 * A merge is a claim the static index can support: a non-type-only import between the groups or a
 * consumer both groups share. Similar names, one package and one directory are not evidence.
 */
export function evidenceComponents(summary: StructureSummary, groups: readonly (readonly string[])[]): number[][] {
  const graph = buildStructureGraphFromSummary(summary);
  const groupOf = new Map<string, number>();
  groups.forEach((members, index) => members.forEach(path => groupOf.set(path, index)));
  const consumers = new Map<string, Set<string>>();
  for (const path of groupOf.keys()) consumers.set(path, new Set(structureConsumers(graph, path, { typeOnly: false })));
  const parent = groups.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]!));
  const sharedConsumers = (left: number, right: number): boolean => {
    const rightConsumers = new Set(groups[right]!.flatMap(path => [...consumers.get(path) ?? []]));
    return groups[left]!.some(path => [...consumers.get(path) ?? []].some(consumer => rightConsumers.has(consumer)
      && groupOf.get(consumer) !== left && groupOf.get(consumer) !== right));
  };
  for (let left = 0; left < groups.length; left++) for (let right = left + 1; right < groups.length; right++) {
    const connected = sharedConsumers(left, right) || sharedConsumers(right, left)
      || groups[left]!.some(path => structureDependencies(graph, path, { typeOnly: false }).some(target => groupOf.get(target) === right))
      || groups[right]!.some(path => structureDependencies(graph, path, { typeOnly: false }).some(target => groupOf.get(target) === left));
    if (!connected) continue;
    const a = find(left), b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const components = new Map<number, number[]>();
  groups.forEach((_, index) => { const root = find(index); components.set(root, [...components.get(root) ?? [], index]); });
  return [...components.values()].map(component => component.sort((a, b) => a - b));
}

/** A proposed responsibility may only span groups the index connects. */
export function mergeEvidence(summary: StructureSummary, groups: readonly (readonly string[])[]): { allowed: boolean; components: number[][] } {
  const components = evidenceComponents(summary, groups);
  return { allowed: components.length <= 1, components };
}

export interface StructureHierarchyNode { id: string; title: string; parentId?: string; dir: string }
export interface StructureHierarchy { parents: StructureHierarchyNode[]; parentOf: Map<string, string> }

/** The deepest directory that contains every file of one responsibility. */
export function commonDirectory(paths: readonly string[]): string {
  const dirs = paths.map(path => posix.dirname(path)).filter(dir => dir !== ".");
  if (!dirs.length) return "";
  let common = dirs[0]!.split("/");
  for (const dir of dirs.slice(1)) {
    const parts = dir.split("/");
    let index = 0;
    while (index < common.length && index < parts.length && common[index] === parts[index]) index += 1;
    common = common.slice(0, index);
  }
  return common.join("/");
}

interface DirectoryNode { segment: string; dir: string; direct: number[]; children: Map<string, DirectoryNode>; id?: string }
interface DirectoryEntry { group?: number; id?: string }

/**
 * Directory depth is not hierarchy: a directory with one responsibility folds into it, two or more
 * entries make a parent node. No AI decides this, so the tree can be checked against file paths.
 */
export function deriveStructureHierarchy(groups: readonly { id: string; paths: readonly string[] }[]): StructureHierarchy {
  const root: DirectoryNode = { segment: "", dir: "", direct: [], children: new Map() };
  groups.forEach((group, index) => {
    const dir = commonDirectory(group.paths);
    let node = root;
    for (const segment of dir ? dir.split("/") : []) {
      const child = node.children.get(segment) ?? { segment, dir: node.dir ? `${node.dir}/${segment}` : segment, direct: [], children: new Map() };
      node.children.set(segment, child); node = child;
    }
    node.direct.push(index);
  });
  const used = new Set(groups.map(group => group.id));
  const parents: StructureHierarchyNode[] = [], parentOf = new Map<string, string>();
  const idOf = (node: DirectoryNode): string => {
    if (node.id) return node.id;
    const base = `module:${slug(node.dir)}`;
    let id = base, suffix = 1;
    while (used.has(id)) id = `${base}-${++suffix}`;
    used.add(id); node.id = id; return id;
  };
  const collect = (node: DirectoryNode): DirectoryEntry[] => {
    const entries: DirectoryEntry[] = node.direct.map(group => ({ group }));
    for (const child of node.children.values()) {
      const folded = collect(child);
      // A single entry is not a hierarchy level; it belongs to the nearest branching directory.
      if (folded.length > 1) entries.push({ id: idOf(child) });
      else entries.push(...folded);
    }
    // A single-entry directory is not a hierarchy level; two or more entries make it a parent, whether
    // they are its own modules or its children's.
    if (entries.length < 2 || !node.dir) return entries;
    const id = idOf(node);
    for (const entry of entries) {
      if (entry.group !== undefined) parentOf.set(groups[entry.group]!.id, id);
      else if (entry.id) { parents.find(parent => parent.id === entry.id)!.parentId = id; parentOf.set(entry.id, id); }
    }
    parents.push({ id, title: node.segment, dir: node.dir });
    return [{ id }];
  };
  collect(root);
  return { parents, parentOf };
}

/** Parent ids must exist once, form no cycle, and still enclose their children's files. */
export function validateStructureHierarchy(hierarchy: StructureHierarchy, groups: readonly { id: string; paths: readonly string[] }[]): string[] {
  const errors: string[] = [], known = new Set(groups.map(group => group.id));
  const dirs = new Map(groups.map(group => [group.id, commonDirectory(group.paths)]));
  for (const parent of hierarchy.parents) {
    if (known.has(parent.id)) errors.push(`Duplicate module id '${parent.id}'.`);
    known.add(parent.id); dirs.set(parent.id, parent.dir);
  }
  for (const parent of hierarchy.parents) {
    if (parent.parentId) {
      const owner = hierarchy.parents.find(item => item.id === parent.parentId);
      if (!owner) errors.push(`Parent '${parent.parentId}' of '${parent.id}' is missing.`);
      else if (owner.dir && !(parent.dir === owner.dir || parent.dir.startsWith(`${owner.dir}/`))) errors.push(`Parent '${owner.id}' does not enclose '${parent.id}'.`);
    }
  }
  for (const [child, parent] of hierarchy.parentOf) {
    if (!known.has(parent)) errors.push(`Parent '${parent}' of '${child}' is missing.`);
    const childDir = dirs.get(child), parentDir = dirs.get(parent);
    if (childDir !== undefined && parentDir !== undefined && parentDir && !(childDir === parentDir || childDir.startsWith(`${parentDir}/`))) errors.push(`Parent '${parent}' is not an ancestor of '${child}'.`);
  }
  for (const start of [...new Set([...hierarchy.parentOf.keys(), ...hierarchy.parents.map(parent => parent.id)])]) {
    const seen = new Set<string>(); let cursor: string | undefined = start;
    while (cursor && hierarchy.parentOf.has(cursor)) {
      if (seen.has(cursor)) { errors.push(`Containment cycle at '${cursor}'.`); break; }
      seen.add(cursor); cursor = hierarchy.parentOf.get(cursor);
    }
  }
  return [...new Set(errors)];
}

/** Every indexed file has one primary owner. Dependencies provide cross-module references. */
export function responsibilityContext(name: string, purpose: string, members: readonly StructureMember[], entryPoints: readonly string[], uncertainties: readonly string[] = []): ProjectContext {
  const sorted = [...members].sort((a, b) => a.path.localeCompare(b.path));
  const sourceFiles = sorted.map(file => file.path);
  const entries = [...new Set(entryPoints)];
  const questions = specificQuestions(uncertainties, sourceFiles);
  return projectContextSchema.parse({ id: `responsibility:${digest(sourceFiles).slice(0, 20)}`, canonicalName: name, purpose,
    detail: "outline", sourceFiles, entryPoints: entries,
    ...(questions.length ? { uncertainties: questions } : {}),
    structureHash: digest(sorted.map(file => [file.path, file.hash])),
    evidence: entries.map(path => ({ path, contentHash: sorted.find(file => file.path === path)!.hash })) });
}

export function connectResponsibilities(contexts: ProjectContext[], files: readonly StructureMember[]): ProjectContext[] {
  const owners = new Map(contexts.flatMap(context => (context.sourceFiles ?? []).map(path => [path, context.id] as const)));
  const graph = buildStructureGraphFromMembers(files);
  return contexts.map(context => ({ ...context, dependsOn: [...new Set((context.sourceFiles ?? []).flatMap(path =>
    structureDependencies(graph, path).flatMap(target => owners.get(target) && owners.get(target) !== context.id ? [owners.get(target)!] : [])))].sort() }));
}
