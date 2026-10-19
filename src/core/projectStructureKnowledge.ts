import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { StructureFile, StructureMember, StructureSummary } from "./projectStructure.js";
import { projectContextSchema, type ProjectContext } from "./projectIntent.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const stem = (path: string) => posix.basename(path).replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_.-]+/)[0]!;
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
    && /\b(?:spawn|fork|createWebviewPanel|createWebview|createServer|Worker|BrowserWindow|Popen|Process|postMessage|listen)\s*\(|Command::new\s*\(/.test(line));
  const entry = file.symbols.find(symbol => /^(?:main|activate|bootstrap)$/i.test(symbol.name));
  const points = [{ point: boundary >= 0 ? boundary : entry ? entry.line - 1 : -1, category: "primary" }];
  // Outbound HTTP and transport dispatch often occur far below the first process launch.
  for (const [category, pattern] of [
    ["transport", /\b(?:fetch|urlopen)\s*\(|\b(?:requests|http|https)\.(?:request|get|post)\s*\(|(?:ClientSession|reqwest::Client)\b/],
    ["transport", /\b(?:transport|protocol)\s*===?\s*["'](?:http|https|stdio|sse|websocket|grpc)["']/i],
    ["client", /\bacquireVsCodeApi\s*\(/],
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
  const result: StructureCandidate[] = [];
  for (const pkg of [...new Set(summary.modules.map(module => module.package))].sort()) {
    const files = summary.modules.filter(module => module.package === pkg).flatMap(module => module.members).sort((a, b) => a.path.localeCompare(b.path));
    const remaining = new Map(files.map(file => [file.path, file]));
    const families = new Map<string, Set<string>>();
    for (const file of files) { const family = families.get(stem(file.path)) ?? new Set<string>(); family.add(file.path); families.set(stem(file.path), family); }
    const claim = (file: StructureMember) => { remaining.delete(file.path); families.get(stem(file.path))!.delete(file.path); };
    const neighbors = new Map<string, Set<string>>();
    for (const file of files) for (const edge of file.dependencies) if (edge.to && remaining.has(edge.to)) {
      for (const [a, b] of [[file.path, edge.to], [edge.to, file.path]]) {
        const targets = neighbors.get(a!) ?? new Set<string>(); targets.add(b!); neighbors.set(a!, targets);
      }
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
  const consumers = new Map<string, Set<string>>();
  for (const file of summary.modules.flatMap(module => module.members)) for (const edge of file.dependencies) if (edge.to && !edge.typeOnly) {
    const paths = consumers.get(edge.to) ?? new Set<string>(); paths.add(file.path); consumers.set(edge.to, paths);
  }
  return result.map(candidate => ({ ...candidate, files: candidate.files.map(file => ({ ...file,
    consumers: [...(consumers.get(file.path) ?? [])].sort()
  })) }));
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
  const dependencies = new Map(files.map(file => [file.path, file.dependencies]));
  return contexts.map(context => ({ ...context, dependsOn: [...new Set((context.sourceFiles ?? []).flatMap(path =>
    (dependencies.get(path) ?? []).flatMap(edge => edge.to && owners.get(edge.to) && owners.get(edge.to) !== context.id ? [owners.get(edge.to)!] : [])))].sort() }));
}
