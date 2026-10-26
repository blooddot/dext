import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ImportVariantOptions, ImportVariantSource } from "../domain/skillImportVariants.js";

const AGENT_DIRECTORIES: Record<string, string> = {
  ".codex": "codex", ".codex-plugin": "codex",
  ".claude": "claude", ".claude-plugin": "claude",
  ".opencode": "opencode", ".openclaw": "openclaw",
  ".github": "copilot", ".cursor": "cursor", ".gemini": "gemini"
};

export const PLUGIN_MANIFEST = /(?:^|\/)\.(?:codex|claude)-plugin\/plugin\.json$/;

export interface SkillSourceDeclarations {
  roots: Array<{ path: string; agent: string; packRoot: string }>;
  notes: string[];
}

/** Read only known manifest fields. Paths are relative to the plugin root;
 * declarations never create candidates or execute hooks. */
export function skillSourceDeclarations(files: ReadonlyMap<string, Uint8Array>): SkillSourceDeclarations {
  const roots: SkillSourceDeclarations["roots"] = [];
  const notes: string[] = [];
  for (const [path, bytes] of files) {
    if (!PLUGIN_MANIFEST.test(path)) continue;
    notes.push(`${path}: native plugin configuration and hooks are not installed.`);
    if (bytes.byteLength > 200_000) { notes.push(`${path}: manifest is too large to inspect.`); continue; }
    try {
      const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { skills?: unknown };
      const values = data.skills === undefined ? ["./skills"] : Array.isArray(data.skills) ? data.skills : [data.skills];
      const pluginRoot = posix.dirname(posix.dirname(path));
      const agent = path.includes(".codex-plugin/") ? "codex" : "claude";
      for (const value of values) {
        if (typeof value !== "string") continue;
        const relative = value.replace(/^\.\//, "").replace(/\/$/, "");
        if (!relative || /[\\:]/.test(relative) || relative.split("/").some((part) => !part || part === "." || part === "..")) {
          notes.push(`${path}: ignored unsafe skill path '${value}'.`);
          continue;
        }
        roots.push({ path: pluginRoot === "." ? relative : `${pluginRoot}/${relative}`, agent, packRoot: pluginRoot });
      }
    } catch {
      notes.push(`${path}: manifest is not valid JSON; only directory conventions were used.`);
    }
  }
  return { roots, notes };
}

/** Mirror directories of one pack share a logical parent. Package prefixes
 * stay intact so unrelated monorepo packs still require analysis. */
export function logicalSkillDirectory(path: string, declarations: SkillSourceDeclarations): string {
  const parts = path.split("/");
  const providerIndex = parts.findIndex((part, index) => (Object.hasOwn(AGENT_DIRECTORIES, part) || part === ".agents") && parts[index + 1] === "skills");
  if (providerIndex >= 0) { parts.splice(providerIndex, 1); return parts.join("/"); }
  const declaration = declarations.roots.find((root) => path.startsWith(`${root.path}/`));
  if (declaration) return `${declaration.packRoot === "." ? "" : `${declaration.packRoot}/`}skills/${path.slice(declaration.path.length + 1)}`;
  return path;
}

export function sourceAgent(path: string, declarations?: SkillSourceDeclarations): string {
  for (const part of path.split("/")) if (Object.hasOwn(AGENT_DIRECTORIES, part)) return AGENT_DIRECTORIES[part]!;
  // These are portable skill locations, even when a plugin references them.
  if (/^(?:skills\/|\.agents\/skills\/)/.test(path)) return "shared";
  const matches = declarations?.roots.filter((root) => path === root.path || path.startsWith(`${root.path}/`)) ?? [];
  const agents = new Set(matches.map((root) => root.agent));
  return agents.size === 1 ? [...agents][0]! : "shared";
}

export interface SkillVariantCandidate {
  id: string;
  directory: string;
  files: string[];
}

export function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Compare the entire owned tree, not just SKILL.md. Missing hashes mean the
 * variants have not been proved identical, so they still need a choice. */
function treeIdentity(candidate: SkillVariantCandidate, hash: (path: string) => string | undefined): string | undefined {
  const parts: string[] = [];
  for (const path of candidate.files) {
    const value = hash(path);
    if (!value) return undefined;
    parts.push(`${candidate.directory ? path.slice(candidate.directory.length + 1) : path}:${value}`);
  }
  return parts.sort().join("\n");
}

export async function chooseImportVariant<T extends ImportVariantSource>(
  kind: "skill" | "command", id: string, sources: T[], targetAgent: string, options: ImportVariantOptions
): Promise<T> {
  if (sources.length === 1) return sources[0]!;
  const selected = await options.chooseVariant?.({ kind, id, targetAgent, sources });
  if (!selected) {
    if (options.chooseVariant) throw new Error("Skill import stopped: no variant was selected.");
    throw new Error(`Choose a ${kind} variant for '${id}' instead of merging different contents:\n${sources.map((source) => `- ${source.agent}: ${source.path}`).join("\n")}`);
  }
  const result = sources.find((source) => source.path === selected);
  if (!result) throw new Error(`The chosen ${kind} variant is not an offered source: ${selected}`);
  return result;
}

export async function selectSkillVariants<T extends SkillVariantCandidate>(
  candidates: T[], hash: (path: string) => string | undefined, declarations: SkillSourceDeclarations,
  options: ImportVariantOptions, explicitSourceAgent?: string
): Promise<{ candidates: T[]; targetAgent: string; skipped: Array<{ path: string; reason: string }> }> {
  const groups = new Map<string, Array<{ candidate: T; path: string; agent: string; identity: string | undefined }>>();
  for (const candidate of candidates) {
    const key = candidate.id.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), {
      candidate, path: candidate.directory, agent: sourceAgent(candidate.directory, declarations), identity: treeIdentity(candidate, hash)
    }]);
  }
  for (const group of groups.values()) {
    if (new Set(group.map((entry) => entry.candidate.id)).size > 1) {
      throw new Error(`Two skill directories resolve to the same id with different casing: ${group.map((entry) => entry.path).join(", ")}`);
    }
  }
  const equivalent = (group: Array<{ identity: string | undefined }>): boolean => group.length > 1 && Boolean(group[0]?.identity)
    && group.every((entry) => entry.identity === group[0]!.identity);
  const agents = [...new Set(candidates.map((candidate) => sourceAgent(candidate.directory, declarations)))];
  const competingAgents = [...groups.values()].some((group) => group.length > 1 && !equivalent(group)
    && new Set(group.map((entry) => entry.agent)).size > 1);
  const uniqueAgents = [...groups.values()].filter((group) => !equivalent(group) || group.length === 1)
    .flatMap((group) => group.map((entry) => entry.agent));
  const needsTarget = competingAgents || new Set(uniqueAgents).size > 1
    || (agents.length === 1 && agents[0] !== "shared" && agents[0] !== options.preferredAgent);
  let targetAgent = options.targetAgent ?? explicitSourceAgent;
  if (!targetAgent && needsTarget) {
    const declaredAgents = declarations.roots.filter((root) => candidates.some((candidate) => candidate.directory === root.path || candidate.directory.startsWith(`${root.path}/`))).map((root) => root.agent);
    const targets = [...new Set([...agents, ...declaredAgents])];
    if (agents.includes("shared") && options.preferredAgent && !targets.includes(options.preferredAgent)) targets.push(options.preferredAgent);
    const recommended = options.preferredAgent && targets.includes(options.preferredAgent) ? options.preferredAgent
      : targets.includes("shared") ? "shared" : targets[0]!;
    targetAgent = await options.chooseTarget?.({ recommended, targets, sources: candidates.map((candidate) => ({ path: candidate.directory, agent: sourceAgent(candidate.directory, declarations) })) });
    if (!targetAgent) {
      if (options.chooseTarget) throw new Error("Skill import stopped: no target version was selected.");
      throw new Error(`Choose an import target (${targets.join(", ")}) for this multi-agent repository.`);
    }
    if (!targets.includes(targetAgent)) throw new Error(`The chosen import target is not available: ${targetAgent}`);
  }
  targetAgent ??= options.preferredAgent ?? "shared";
  const selected: T[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const group of groups.values()) {
    const isEquivalent = equivalent(group);
    const rank = (entry: { agent: string }): number => entry.agent === targetAgent ? 0 : entry.agent === "shared" ? 1 : 2;
    const eligible = group.filter((entry) => isEquivalent || entry.agent === targetAgent || entry.agent === "shared");
    if (!eligible.length) {
      skipped.push(...group.map((entry) => ({ path: entry.path, reason: `${entry.agent} variant excluded for import target '${targetAgent}'.` })));
      continue;
    }
    const bestRank = Math.min(...eligible.map(rank));
    const preferred = eligible.filter((entry) => rank(entry) === bestRank);
    const chosen = isEquivalent ? preferred.sort((a, b) => a.path.localeCompare(b.path))[0]!
      : await chooseImportVariant("skill", group[0]!.candidate.id, preferred, targetAgent, options);
    selected.push(chosen.candidate);
    for (const entry of group) {
      if (entry === chosen) continue;
      skipped.push({ path: entry.path, reason: isEquivalent
        ? `Identical skill tree; using '${chosen.path}' (${chosen.agent}).`
        : `Different ${entry.agent} variant; import target '${targetAgent}' uses '${chosen.path}' (${chosen.agent}).` });
    }
  }
  if (!selected.length) throw new Error(`No skills are available for import target '${targetAgent}'.`);
  return { candidates: selected, targetAgent, skipped };
}

export async function selectCommandVariants<T extends ImportVariantSource & { id: string; identity: string }>(
  sources: T[], targetAgent: string, options: ImportVariantOptions
): Promise<{ selected: T[]; skipped: Array<{ source: T; reason: string }> }> {
  const groups = new Map<string, T[]>();
  for (const source of sources) {
    const key = source.id.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  const selected: T[] = [];
  const skipped: Array<{ source: T; reason: string }> = [];
  for (const group of groups.values()) {
    const rank = (source: T): number => source.agent === targetAgent ? 0 : source.agent === "shared" ? 1 : 2;
    const bestRank = Math.min(...group.map(rank));
    const preferred = group.filter((source) => rank(source) === bestRank);
    const identical = preferred.every((source) => source.identity === preferred[0]!.identity);
    const chosen = identical ? preferred.sort((a, b) => a.path.localeCompare(b.path))[0]!
      : await chooseImportVariant("command", group[0]!.id, preferred, targetAgent, options);
    selected.push(chosen);
    for (const source of group) {
      if (source === chosen) continue;
      skipped.push({ source, reason: `Using '${chosen.path}' (${chosen.agent}) for import target '${targetAgent}'${source.identity === chosen.identity ? "; identical template" : "; different variant"}.` });
    }
  }
  return { selected, skipped };
}
