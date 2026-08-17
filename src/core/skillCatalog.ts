import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export interface SkillDescriptor {
  id: string;
  title: string;
  description: string;
  sourcePath: string;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function metadata(source: string, fallback: string): Pick<SkillDescriptor, "title" | "description"> {
  const name = /^\s*name\s*:\s*["']?([^\r\n"']+)/mi.exec(source)?.[1]?.trim()
    ?? /^#\s+(.+)$/m.exec(source)?.[1]?.trim()
    ?? fallback;
  const description = /^\s*description\s*:\s*["']?([^\r\n"']+)/mi.exec(source)?.[1]?.trim()
    ?? source.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.startsWith("---"))
    ?? "Standard project skill.";
  return { title: name, description };
}

/** Discovers standard SKILL.md packages. The first configured root wins so
 * project-local skills predictably override later shared directories. */
export class SkillCatalog {
  private readonly entries = new Map<string, SkillDescriptor>();

  async reload(workspaceRoot: string, skillDirs: readonly string[] = []): Promise<void> {
    this.entries.clear();
    const roots = [
      join(workspaceRoot, ".agents", "skills"),
      join(workspaceRoot, "dext", "skills"),
      ...skillDirs.map((directory) => resolve(workspaceRoot, directory))
    ];
    for (const root of roots) await this.addRoot(root);
  }

  list(): SkillDescriptor[] {
    return [...this.entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async load(id: string, workspaceRoot: string, workspacePath = "."): Promise<{ instructions: string; sourcePath: string }> {
    const base = resolve(workspaceRoot, workspacePath);
    if (!inside(workspaceRoot, base)) throw new Error("skill workspace must stay inside the current project.");
    const descriptor = this.entries.get(id);
    if (!descriptor) throw new Error(`Unknown skill '${id}'. Reload Dext after adding a SKILL.md package.`);
    const source = await readFile(descriptor.sourcePath, "utf8");
    return { instructions: source, sourcePath: descriptor.sourcePath };
  }

  private async addRoot(root: string): Promise<void> {
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
        this.entries.set(entry.name, { id: entry.name, sourcePath, ...metadata(source, entry.name) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}
