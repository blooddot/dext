import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { open, readdir, readFile, realpath, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { insideRoot } from "../../../platform/node/insideRoot.js";
import { parseSkillMetadata } from "../domain/skillMetadata.js";
import { parseCommandSource, resolvedCommand, type ParsedSkillCommand } from "../domain/skillCommand.js";
import type { ConversationSkillEntry, SkillCommandResolution, SkillCommandSummary } from "../contracts/skill.js";
import {
  SKILL_PACKS_DIRECTORY,
  SKILL_PACK_MANIFEST_FILE,
  normalizeSkillPackManifest,
  type SkillPackManifest
} from "../../resources/domain/skillPack.js";

export interface SkillDescriptor {
  id: string;
  title: string;
  description: string;
  sourcePath: string;
  variant?: string;
  available?: boolean;
  /** Set when an installed pack manifest owns this skill. */
  packId?: string;
  packName?: string;
  /** Commands whose skill is this skill and which can run. */
  commandIds: string[];
}

interface CommandEntry {
  summary: SkillCommandSummary;
  parsed: ParsedSkillCommand;
  /** Lower numbers win: the local .dext root is 0, configured roots 1 and
   * global storage 2. */
  priority: number;
  agent: string;
}

interface InvalidCommand {
  id: string;
  reason: string;
  priority: number;
  agent: string;
}

interface SkillSource {
  sourcePath: string;
  root: string;
  scope: string;
  global: boolean;
  title: string;
  conversationTitle: string;
  description: string;
  declaredDescription: string | undefined;
  revision: string;
}

interface IndexedSkill extends Omit<SkillDescriptor, "sourcePath" | "title" | "description"> {
  source: SkillSource;
}

interface SkillVariant { agent: string; source: SkillSource; }

/** Vendored libraries keep their own layout, so this root is searched instead
 * of read one level deep: `.dext/third-party/<vendor>/<generator output>/`. */
const THIRD_PARTY_DIRECTORY = "third-party";
const SKIPPED_SKILL_DIRECTORIES = new Set([".git", "node_modules"]);
const MAX_SKILL_SCAN_DEPTH = 6;
// A named pipe substituted for SKILL.md must not block the open before stat.
const SKILL_READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

async function readSkillFile(handle: FileHandle): Promise<{ content: Buffer; revision: string }> {
  const file = await handle.stat();
  if (!file.isFile()) throw new Error("The registered path does not resolve to a SKILL.md file.");
  // Filesystems can report identical timestamps for consecutive same-size edits.
  const content = await handle.readFile();
  const revision = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return { content, revision };
}

function isSkillFile(path: string): boolean {
  const name = basename(path);
  return process.platform === "win32" ? name.toLowerCase() === "skill.md" : name === "SKILL.md";
}

async function readSkillSource(sourcePath: string, id: string) {
  const handle = await open(sourcePath, SKILL_READ_FLAGS);
  try {
    const { content, revision } = await readSkillFile(handle);
    const { title, conversationTitle, description, declaredDescription, diagnostics } = parseSkillMetadata(content.toString("utf8"), id);
    return { title, conversationTitle, description, declaredDescription, diagnostics, revision };
  } finally {
    await handle.close();
  }
}

function shortSkillLabel(text: string, limit: number): string {
  const characters = [...text.replace(/\s+/g, " ").trim()];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
}

/** Discovers Dext-owned SKILL.md packages. The local .dext directory wins
 * over explicitly configured shared roots, and a local pack manifest wins over
 * a global one. Commands are inert prompt templates read from installed pack
 * manifests or a skill's own `commands/` directory. */
export class SkillCatalog {
  private readonly entries = new Map<string, IndexedSkill>();
  private readonly commandEntries = new Map<string, CommandEntry[]>();
  private readonly invalidCommands = new Map<string, InvalidCommand[]>();
  private readonly skillVariants = new Map<string, SkillVariant[]>();
  private readonly notes: string[] = [];

  async reload(workspaceRoot: string, skillDirs: readonly string[] = [], globalRoot?: string): Promise<void> {
    this.entries.clear();
    this.commandEntries.clear();
    this.invalidCommands.clear();
    this.skillVariants.clear();
    this.notes.length = 0;
    const projectRoots = [join(workspaceRoot, ".dext", "skills"), join(workspaceRoot, ".dext", THIRD_PARTY_DIRECTORY)];
    const roots = unique([
      ...projectRoots,
      ...skillDirs.map((directory) => resolve(workspaceRoot, directory)),
      ...(globalRoot ? [resolve(globalRoot)] : [])
    ]);
    const globalSkills = globalRoot ? resolve(globalRoot) : undefined;
    const priorityOf = (root: string): number =>
      projectRoots.some((project) => resolve(project) === resolve(root)) ? 0 : root === globalSkills ? 2 : 1;
    // Commands live beside the Skill they belong to, which a vendored layout
    // puts below the root rather than directly in it.
    const skillDirectories = new Map<string, string[]>();
    for (const root of roots) {
      const global = root === globalSkills;
      const scope = global ? dirname(root) : insideRoot(workspaceRoot, root) ? workspaceRoot : root;
      skillDirectories.set(root, await this.addSkillsRoot(root, scope, global));
    }
    const packRoots = [
      { root: join(workspaceRoot, ".dext", SKILL_PACKS_DIRECTORY), base: join(workspaceRoot, ".dext"), priority: 0 },
      ...(globalRoot
        ? [{ root: join(dirname(resolve(globalRoot)), SKILL_PACKS_DIRECTORY), base: dirname(resolve(globalRoot)), priority: 2 }]
        : [])
    ];
    const seenPacks = new Set<string>();
    for (const pack of packRoots) {
      const global = pack.priority === 2;
      await this.addPackRoot(pack.root, pack.base, global ? pack.base : workspaceRoot, seenPacks, pack.priority, global);
    }
    // Loose commands come last so a pack's manifest (registered first at the
    // same priority) wins; the priority check still lets a local loose command
    // replace one from a global pack.
    for (const root of roots) await this.addLooseCommands(skillDirectories.get(root) ?? [], priorityOf(root));
  }

  list(agent = "shared"): SkillDescriptor[] {
    const commands = this.commands(agent);
    return [...this.entries.values()].map(({ source, ...entry }) => {
      const variant = this.variantFor(entry.id, agent);
      const { sourcePath, title, description } = variant?.source ?? source;
      return { ...entry, sourcePath, title, description,
        ...(this.skillVariants.has(entry.id) ? { available: Boolean(variant) } : {}),
        ...(variant ? { variant: variant.agent } : {}),
        commandIds: commands.filter((command) => command.skillId === entry.id).map((command) => command.id).sort() };
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Command descriptors safe for the composer; source paths stay on the host. */
  commands(agent = "shared"): SkillCommandSummary[] {
    return [...this.commandEntries.keys()]
      .flatMap((id) => {
        const entry = this.commandFor(id, agent);
        return entry && (!this.skillVariants.has(entry.summary.skillId) || this.variantFor(entry.summary.skillId, agent)) ? [entry.summary] : [];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  warnings(): string[] {
    return [...this.notes];
  }

  async load(id: string, workspaceRoot: string, workspacePath = ".", agent = "shared"): Promise<{ instructions: string; sourcePath: string }> {
    const base = resolve(workspaceRoot, workspacePath);
    if (!insideRoot(workspaceRoot, base)) throw new Error("skill workspace must stay inside the current project.");
    const { sourcePath } = this.sourceFor(id, agent);
    const source = await readFile(sourcePath, "utf8");
    return { instructions: source, sourcePath };
  }

  /** Ordinary turns resolve validated paths and only refresh metadata if a file changed. */
  async describeForConversation(id: string, workspaceRoot: string, agent: string): Promise<ConversationSkillEntry> {
    const source = this.sourceFor(id, agent);
    try {
      return await this.describeConversationSource(id, source, workspaceRoot);
    } catch (error) {
      const shared = this.skillVariants.get(id)?.find((variant) => variant.agent === "shared")?.source;
      if (!shared || shared === source) throw error;
      try {
        return await this.describeConversationSource(id, shared, workspaceRoot);
      } catch (fallbackError) {
        const primaryReason = error instanceof Error ? error.message : String(error);
        const sharedReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new AggregateError([error, fallbackError],
          `Skill '${id}' is unavailable. Its '${agent}' SKILL.md could not be used: ${primaryReason}. Its shared fallback could not be used: ${sharedReason}`);
      }
    }
  }

  private async describeConversationSource(id: string, source: SkillSource, workspaceRoot: string): Promise<ConversationSkillEntry> {
    const [file, root, scope, workspace] = await Promise.all([
      realpath(source.sourcePath), realpath(source.root), realpath(source.scope), realpath(workspaceRoot)
    ]);
    if (!insideRoot(root, file, { allowRoot: false }) || !insideRoot(scope, file, { allowRoot: false })) {
      throw new Error("SKILL.md resolves outside its registered root.");
    }
    if (!isSkillFile(source.sourcePath) || !isSkillFile(file)) {
      throw new Error("The registered path does not resolve to a SKILL.md file.");
    }
    const path = !source.global && insideRoot(workspace, file) ? relative(workspace, file).split(sep).join("/") : file;
    const handle = await open(file, SKILL_READ_FLAGS);
    try {
      const { content, revision } = await readSkillFile(handle);
      const changed = revision !== source.revision;
      if (changed) {
        const metadata = parseSkillMetadata(content.toString("utf8"), id);
        const { title, conversationTitle, description, declaredDescription } = metadata;
        Object.assign(source, { title, conversationTitle, description, declaredDescription, revision });
      }
      return {
        id, path, revision, changed,
        title: shortSkillLabel(source.conversationTitle, 120) || id,
        description: shortSkillLabel(source.declaredDescription ?? "", 300) || "No description provided."
      };
    } finally {
      await handle.close();
    }
  }

  private variantFor(id: string, agent: string): SkillVariant | undefined {
    const variants = this.skillVariants.get(id);
    return variants?.find((item) => item.agent === agent) ?? variants?.find((item) => item.agent === "shared");
  }

  private sourceFor(id: string, agent: string): SkillSource {
    const descriptor = this.entries.get(id);
    if (!descriptor) throw new Error(`Unknown skill '${id}'. Reload Dext after adding a SKILL.md package.`);
    const variant = this.variantFor(id, agent);
    if (this.skillVariants.has(id) && !variant) throw new Error(`Skill '${id}' has no '${agent}' version or shared fallback.`);
    return variant?.source ?? descriptor.source;
  }

  /** Resolves one `/command` for a turn. The skill must be selected for the
   * conversation; an unknown or unsupported command never falls through to a
   * model call with the raw slash text. */
  resolveCommand(id: string, selectedSkillIds: readonly string[], args = "", agent = "shared"): SkillCommandResolution {
    const entry = this.commandFor(id, agent);
    if (!entry) {
      const invalid = this.invalidCommands.get(id)?.find((item) => item.agent === agent || item.agent === "shared");
      return invalid
        ? { status: "invalid", id, reason: invalid.reason }
        : this.commandEntries.has(id) || this.invalidCommands.has(id)
          ? { status: "invalid", id, reason: `Command has no '${agent}' version or shared fallback.` }
        : { status: "unknown", id };
    }
    if (!selectedSkillIds.includes(entry.summary.skillId)) {
      return { status: "inactive", command: entry.summary };
    }
    return resolvedCommand(entry.summary, entry.parsed.template, args);
  }

  /** Every directory below the root that holds a SKILL.md, in the order the
   * Skills were claimed. A directory without its own SKILL.md is searched
   * rather than skipped, so a vendored generator output is found where it is. */
  private async addSkillsRoot(root: string, scope: string, global: boolean): Promise<string[]> {
    const found: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      let directories: Dirent<string>[];
      try {
        directories = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of directories) {
        if (!entry.isDirectory() || SKIPPED_SKILL_DIRECTORIES.has(entry.name)) continue;
        const skillDirectory = join(directory, entry.name);
        const sourcePath = join(skillDirectory, "SKILL.md");
        let metadata: Awaited<ReturnType<typeof readSkillSource>> | undefined;
        try {
          metadata = await readSkillSource(sourcePath, entry.name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (metadata === undefined) {
          // shortcut: six directory levels, raise it if a vendor nests deeper.
          if (depth < MAX_SKILL_SCAN_DEPTH) await visit(skillDirectory, depth + 1);
          continue;
        }
        found.push(skillDirectory);
        const existing = this.entries.get(entry.name);
        if (existing) {
          if (existing.source.sourcePath !== sourcePath) this.notes.push(`${entry.name}: also defined at ${sourcePath}; the earlier package wins.`);
          continue;
        }
        const { diagnostics, ...fields } = metadata;
        for (const diagnostic of diagnostics) this.notes.push(`${entry.name}: ${diagnostic}`);
        this.entries.set(entry.name, {
          id: entry.name,
          source: { sourcePath, root, scope, global, ...fields },
          commandIds: []
        });
      }
    };
    await visit(root, 0);
    return found;
  }

  private commandFor(id: string, agent: string): CommandEntry | undefined {
    const entries = this.commandEntries.get(id) ?? [];
    const invalid = this.invalidCommands.get(id) ?? [];
    const priority = Math.min(...entries.map((item) => item.priority), ...invalid.map((item) => item.priority));
    return entries.find((item) => item.priority === priority && item.agent === agent)
      ?? entries.find((item) => item.priority === priority && item.agent === "shared");
  }

  private registerInvalidCommand(id: string, reason: string, priority: number, agent = "shared"): void {
    const entries = this.invalidCommands.get(id) ?? [];
    if (!entries.some((entry) => entry.agent === agent && entry.priority === priority)) entries.push({ id, reason, priority, agent });
    this.invalidCommands.set(id, entries);
  }

  private registerCommand(id: string, summary: SkillCommandSummary, parsed: ParsedSkillCommand, priority: number, agent = "shared"): void {
    const entries = this.commandEntries.get(id) ?? [];
    if (!entries.some((entry) => entry.agent === agent && entry.priority === priority)) entries.push({ summary, parsed, priority, agent });
    this.commandEntries.set(id, entries);
  }

  private async addPackRoot(root: string, base: string, scope: string, seen: Set<string>, priority: number, global: boolean): Promise<void> {
    let directories: Dirent<string>[];
    try {
      directories = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const directory of directories) {
      if (!directory.isDirectory() || seen.has(directory.name)) continue;
      let manifest: SkillPackManifest | undefined;
      try {
        const source = await readFile(join(root, directory.name, SKILL_PACK_MANIFEST_FILE), "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(source);
        } catch (error) {
          this.notes.push(`${directory.name}: malformed pack manifest (${error instanceof Error ? error.message : String(error)}).`);
          continue;
        }
        manifest = normalizeSkillPackManifest(parsed, directory.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      if (!manifest) {
        this.notes.push(`${directory.name}: pack manifest has no usable skills.`);
        continue;
      }
      seen.add(directory.name);
      // A pack only owns skills installed in its own scope. Without this
      // check a global pack would tag a local skill that shadows its own copy.
      const scopedSkills = manifest.skills.filter((record) => {
        const skill = this.entries.get(record.id);
        return Boolean(skill && insideRoot(base, skill.source.sourcePath));
      });
      for (const record of scopedSkills) {
        const skill = this.entries.get(record.id)!;
        if (skill.packId && skill.packId !== directory.name) continue;
        skill.packId = directory.name;
        skill.packName = manifest.name;
        if (manifest.version === 2) {
          const variants = this.skillVariants.get(record.id) ?? [];
          this.skillVariants.set(record.id, variants);
          const path = record.file ? resolve(base, record.file) : undefined;
          if (!path || !insideRoot(base, path)) { this.notes.push(`${record.id}: variant path escapes the resource root or is missing.`); continue; }
          try {
            const { diagnostics: _diagnostics, ...metadata } = await readSkillSource(path, record.id);
            void _diagnostics;
            const agent = record.agent ?? "unknown";
            if (variants.some((variant) => variant.agent === agent)) {
              this.notes.push(`${record.id}: duplicate '${agent}' variant in pack manifest.`);
              continue;
            }
            variants.push({ agent, source: { sourcePath: path, root: base, scope, global, ...metadata } });
          } catch { this.notes.push(`${record.id}: variant file is missing.`); }
        }
      }
      const scopedIds = new Set(scopedSkills.map((record) => record.id));
      for (const record of manifest.commands) {
        const agent = manifest.version === 2 ? record.agent ?? "unknown" : "shared";
        if (!scopedIds.has(record.skillId)) continue;
        if (record.status !== "available" || !record.file) {
          this.registerInvalidCommand(record.id, record.reason ?? "Command is unavailable.", priority, agent);
          continue;
        }
        const path = resolve(base, record.file);
        if (!insideRoot(base, path)) {
          this.registerInvalidCommand(record.id, "Command path escapes the resource root.", priority, agent);
          continue;
        }
        let source: string;
        try {
          source = await readFile(path, "utf8");
        } catch {
          this.registerInvalidCommand(record.id, "Command file is missing.", priority, agent);
          continue;
        }
        const parsed = parseCommandSource(record.id, source);
        if (!parsed.supported) {
          this.registerInvalidCommand(record.id, parsed.diagnostics.join(" "), priority, agent);
          continue;
        }
        const packId = this.entries.get(record.skillId)?.packId;
        const packName = this.entries.get(record.skillId)?.packName;
        this.registerCommand(record.id, {
          id: record.id,
          title: record.title || parsed.title,
          description: record.description || parsed.description,
          skillId: record.skillId,
          ...(packId ? { packId } : {}),
          ...(packName ? { packName } : {}),
          ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
          syntax: `/${record.id}`
        }, parsed, priority, agent);
      }
    }
  }

  private async addLooseCommands(skillDirectories: readonly string[], priority: number): Promise<void> {
    for (const directory of skillDirectories) {
      const commandsRoot = join(directory, "commands");
      let files: Dirent<string>[];
      try {
        files = await readdir(commandsRoot, { withFileTypes: true, encoding: "utf8" });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".md")) continue;
        const id = file.name.slice(0, -3);
        let source: string;
        try {
          source = await readFile(join(commandsRoot, file.name), "utf8");
        } catch {
          continue;
        }
        const parsed = parseCommandSource(id, source);
        if (!parsed.supported) {
          this.registerInvalidCommand(id, parsed.diagnostics.join(" "), priority);
          continue;
        }
        const skillId = parsed.skillId ?? (this.entries.has(id) ? id : undefined);
        if (!skillId || !this.entries.has(skillId)) {
          this.registerInvalidCommand(id, `Command '${id}' does not map to an installed skill.`, priority);
          continue;
        }
        const skill = this.entries.get(skillId)!;
        this.registerCommand(id, {
          id,
          title: parsed.title,
          description: parsed.description,
          skillId,
          ...(skill.packId ? { packId: skill.packId } : {}),
          ...(skill.packName ? { packName: skill.packName } : {}),
          ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
          syntax: `/${id}`
        }, parsed, priority);
      }
    }
  }

}
