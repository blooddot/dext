import { createHash } from "node:crypto";
import { posix } from "node:path";

const AGENT_DIRECTORIES: Record<string, string> = {
  ".codex": "codex", ".codex-plugin": "codex",
  ".claude": "claude", ".claude-plugin": "claude",
  ".opencode": "opencode", ".openclaw": "openclaw",
  ".github": "copilot", ".cursor": "cursor", ".gemini": "gemini", ".pi": "pi"
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
  if (/^(?:skills\/|\.agents\/skills\/|commands\/)/.test(path)) return "shared";
  const matches = declarations?.roots.filter((root) => path === root.path || path.startsWith(`${root.path}/`)) ?? [];
  const agents = new Set(matches.map((root) => root.agent));
  if (agents.size === 1) return [...agents][0]!;
  if (agents.size > 1 || !path || path.split("/").includes("skills")) return "shared";
  return "unknown";
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

/** Import all Agent versions. Only equivalent copies of the same Agent version
 * are collapsed; conflicting same-Agent sources require a narrower source URL. */
export function collectSkillVariants<T extends SkillVariantCandidate>(
  candidates: T[], hash: (path: string) => string | undefined, declarations: SkillSourceDeclarations
): { candidates: T[]; skipped: Array<{ path: string; reason: string }> } {
  const spellings = new Map<string, string>();
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const folded = candidate.id.toLowerCase();
    if (spellings.has(folded) && spellings.get(folded) !== candidate.id) {
      throw new Error(`Two skill directories resolve to the same id with different casing: ${candidate.id}`);
    }
    spellings.set(folded, candidate.id);
    const key = `${folded}:${sourceAgent(candidate.directory, declarations)}`;
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  const selected: T[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const identity = treeIdentity(first, hash);
    if (group.length > 1 && (!identity || group.some((item) => treeIdentity(item, hash) !== identity))) {
      throw new Error(`Different ${sourceAgent(first.directory, declarations)} variants of skill '${first.id}' have the same id. Import a specific directory instead: ${group.map((item) => item.directory).join(", ")}`);
    }
    selected.push(first);
    for (const duplicate of group.slice(1)) skipped.push({ path: duplicate.directory,
      reason: `Identical skill tree for the same Agent; using '${first.directory}'.` });
  }
  return { candidates: selected, skipped };
}
