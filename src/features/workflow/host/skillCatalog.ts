import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseSkillMetadata } from "../domain/skillMetadata.js";
import { parseCommandSource, resolvedCommand, type ParsedSkillCommand } from "../domain/skillCommand.js";
import type { SkillCommandResolution, SkillCommandSummary } from "../contracts/skill.js";
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
}

interface InvalidCommand {
  id: string;
  reason: string;
  priority: number;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Discovers Dext-owned SKILL.md packages. The local .dext directory wins
 * over explicitly configured shared roots, and a local pack manifest wins over
 * a global one. Commands are inert prompt templates read from installed pack
 * manifests or a skill's own `commands/` directory. */
export class SkillCatalog {
  private readonly entries = new Map<string, SkillDescriptor>();
  private readonly commandEntries = new Map<string, CommandEntry>();
  private readonly invalidCommands = new Map<string, InvalidCommand>();
  private readonly notes: string[] = [];

  async reload(workspaceRoot: string, skillDirs: readonly string[] = [], globalRoot?: string): Promise<void> {
    this.entries.clear();
    this.commandEntries.clear();
    this.invalidCommands.clear();
    this.notes.length = 0;
    const roots = unique([
      join(workspaceRoot, ".dext", "skills"),
      ...skillDirs.map((directory) => resolve(workspaceRoot, directory)),
      ...(globalRoot ? [resolve(globalRoot)] : [])
    ]);
    const globalSkills = globalRoot ? resolve(globalRoot) : undefined;
    const priorityOf = (root: string): number =>
      resolve(root) === resolve(workspaceRoot, ".dext", "skills") ? 0 : root === globalSkills ? 2 : 1;
    for (const root of roots) await this.addSkillsRoot(root);
    const packRoots = [
      { root: join(workspaceRoot, ".dext", SKILL_PACKS_DIRECTORY), base: join(workspaceRoot, ".dext"), priority: 0 },
      ...(globalRoot
        ? [{ root: join(dirname(resolve(globalRoot)), SKILL_PACKS_DIRECTORY), base: dirname(resolve(globalRoot)), priority: 2 }]
        : [])
    ];
    const seenPacks = new Set<string>();
    for (const pack of packRoots) await this.addPackRoot(pack.root, pack.base, seenPacks, pack.priority);
    // Loose commands come last so a pack's manifest (registered first at the
    // same priority) wins; the priority check still lets a local loose command
    // replace one from a global pack.
    for (const root of roots) await this.addLooseCommands(root, priorityOf(root));
    this.attachCommandIds();
  }

  list(): SkillDescriptor[] {
    return [...this.entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Command descriptors safe for the composer; source paths stay on the host. */
  commands(): SkillCommandSummary[] {
    return [...this.commandEntries.values()]
      .map((entry) => entry.summary)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  warnings(): string[] {
    return [...this.notes];
  }

  async load(id: string, workspaceRoot: string, workspacePath = "."): Promise<{ instructions: string; sourcePath: string }> {
    const base = resolve(workspaceRoot, workspacePath);
    if (!inside(workspaceRoot, base)) throw new Error("skill workspace must stay inside the current project.");
    const descriptor = this.entries.get(id);
    if (!descriptor) throw new Error(`Unknown skill '${id}'. Reload Dext after adding a SKILL.md package.`);
    const source = await readFile(descriptor.sourcePath, "utf8");
    return { instructions: source, sourcePath: descriptor.sourcePath };
  }

  /** Resolves one `/command` for a turn. The skill must be selected for the
   * conversation; an unknown or unsupported command never falls through to a
   * model call with the raw slash text. */
  resolveCommand(id: string, selectedSkillIds: readonly string[], args = ""): SkillCommandResolution {
    const entry = this.commandEntries.get(id);
    if (!entry) {
      const invalid = this.invalidCommands.get(id);
      return invalid
        ? { status: "invalid", id, reason: invalid.reason }
        : { status: "unknown", id };
    }
    if (!selectedSkillIds.includes(entry.summary.skillId)) {
      return { status: "inactive", command: entry.summary };
    }
    return resolvedCommand(entry.summary, entry.parsed.template, args);
  }

  private async addSkillsRoot(root: string): Promise<void> {
    let directories: Dirent<string>[];
    try {
      directories = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of directories) {
      if (!entry.isDirectory() || this.entries.has(entry.name)) continue;
      const sourcePath = join(root, entry.name, "SKILL.md");
      try {
        const source = await readFile(sourcePath, "utf8");
        const metadata = parseSkillMetadata(source, entry.name);
        for (const diagnostic of metadata.diagnostics) this.notes.push(`${entry.name}: ${diagnostic}`);
        this.entries.set(entry.name, {
          id: entry.name,
          sourcePath,
          title: metadata.title,
          description: metadata.description,
          commandIds: []
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private commandWins(existing: { priority: number } | undefined, priority: number): boolean {
    return !existing || existing.priority > priority;
  }

  private registerInvalidCommand(id: string, reason: string, priority: number): void {
    if (!this.commandWins(this.commandEntries.get(id), priority)) return;
    if (!this.commandWins(this.invalidCommands.get(id), priority)) return;
    this.commandEntries.delete(id);
    this.invalidCommands.set(id, { id, reason, priority });
  }

  private registerCommand(id: string, summary: SkillCommandSummary, parsed: ParsedSkillCommand, priority: number): void {
    if (!this.commandWins(this.commandEntries.get(id), priority)) return;
    if (!this.commandWins(this.invalidCommands.get(id), priority)) return;
    this.invalidCommands.delete(id);
    this.commandEntries.set(id, { summary, parsed, priority });
  }

  private async addPackRoot(root: string, base: string, seen: Set<string>, priority: number): Promise<void> {
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
        return Boolean(skill && inside(base, skill.sourcePath));
      });
      for (const record of scopedSkills) {
        const skill = this.entries.get(record.id)!;
        if (skill.packId) continue;
        skill.packId = directory.name;
        skill.packName = manifest.name;
      }
      const scopedIds = new Set(scopedSkills.map((record) => record.id));
      for (const record of manifest.commands) {
        if (!scopedIds.has(record.skillId)) continue;
        if (record.status !== "available" || !record.file) {
          this.registerInvalidCommand(record.id, record.reason ?? "Command is unavailable.", priority);
          continue;
        }
        const path = resolve(base, record.file);
        if (!inside(base, path)) {
          this.registerInvalidCommand(record.id, "Command path escapes the resource root.", priority);
          continue;
        }
        let source: string;
        try {
          source = await readFile(path, "utf8");
        } catch {
          this.registerInvalidCommand(record.id, "Command file is missing.", priority);
          continue;
        }
        const parsed = parseCommandSource(record.id, source);
        if (!parsed.supported) {
          this.registerInvalidCommand(record.id, parsed.diagnostics.join(" "), priority);
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
        }, parsed, priority);
      }
    }
  }

  private async addLooseCommands(root: string, priority: number): Promise<void> {
    let directories: Dirent<string>[];
    try {
      directories = await readdir(root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const commandsRoot = join(root, directory.name, "commands");
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

  private attachCommandIds(): void {
    for (const skill of this.entries.values()) skill.commandIds = [];
    for (const entry of this.commandEntries.values()) {
      const skill = this.entries.get(entry.summary.skillId);
      if (skill) skill.commandIds.push(entry.summary.id);
    }
    for (const skill of this.entries.values()) skill.commandIds.sort();
  }
}
