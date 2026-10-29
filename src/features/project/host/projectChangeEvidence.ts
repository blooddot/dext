import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { projectContentHash } from "./persistence/projectStore.js";
import { projectWorkspaceKey } from "./projectPlanService.js";

const execute = promisify(execFile);
const baselineSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), workspaceKey: z.string(), capturedAt: z.number(),
  complete: z.boolean(), diagnostics: z.array(z.string()), git: z.boolean(), initialStatus: z.string(),
  files: z.record(z.string(), z.object({ hash: z.string(), content: z.string().optional() }).strict())
}).strict();
export type ProjectChangeBaseline = z.infer<typeof baselineSchema>;
export interface ProjectChangeReport {
  evidenceId: string;
  complete: boolean;
  diagnostics: string[];
  changes: Array<{ path: string; kind: "added" | "modified" | "deleted"; beforeHash?: string; afterHash?: string; before?: string; after?: string }>;
  renameCandidates: Array<{ from: string; to: string }>;
}
export interface ProjectChangeLimits { maxFiles?: number; maxFileBytes?: number; maxBytes?: number; exclude?: (path: string) => boolean }
const excluded = /(^|\/)(?:\.git|node_modules|dist|build|\.env(?:\.[^/]*)?|\.ssh|\.aws)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;

/** Content evidence, not an assertion that every observed edit was authored by the Agent. */
export class ProjectChangeEvidence {
  private readonly root: string;
  private readonly directory: string;
  constructor(workspace: string, storage: string, private readonly limits: ProjectChangeLimits = {}) {
    this.root = resolve(workspace);
    this.directory = join(storage, "plan-project", projectContentHash(projectWorkspaceKey(workspace)));
  }

  private async discover(): Promise<{ paths: string[]; git: boolean; status: string; diagnostics: string[] }> {
    try {
      const result = await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: this.root, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const status = await execute("git", ["status", "--porcelain=v1", "-z"], { cwd: this.root, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      return { paths: [...new Set(result.stdout.split("\0").filter(Boolean))].sort(), git: true, status: status.stdout, diagnostics: [] };
    } catch {
      const paths: string[] = []; const diagnostics = ["Git inventory unavailable; bounded filesystem inventory was used."];
      const walk = async (directory: string): Promise<void> => {
        if (paths.length > (this.limits.maxFiles ?? 1000)) return;
        for (const entry of await readdir(join(this.root, directory), { withFileTypes: true })) {
          const path = [directory, entry.name].filter(Boolean).join("/");
          if (excluded.test(path) || this.limits.exclude?.(path)) continue;
          if (entry.isSymbolicLink()) { diagnostics.push(`Symlink excluded: ${path}`); continue; }
          if (entry.isDirectory()) await walk(path);
          else paths.push(path);
          if (paths.length > (this.limits.maxFiles ?? 1000)) return;
        }
      };
      try { await walk(""); } catch (error) { diagnostics.push(`Inventory incomplete: ${String(error)}`); }
      return { paths: paths.sort(), git: false, status: "", diagnostics };
    }
  }

  private async snapshot(id = randomUUID()): Promise<ProjectChangeBaseline> {
    const inventory = await this.discover();
    const diagnostics = [...inventory.diagnostics];
    const files: ProjectChangeBaseline["files"] = {};
    let bytes = 0; let count = 0;
    const root = await realpath(this.root);
    for (const path of inventory.paths) {
      if (excluded.test(path) || this.limits.exclude?.(path)) continue;
      if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) { diagnostics.push(`Unsafe path: ${path}`); continue; }
      if (++count > (this.limits.maxFiles ?? 1000)) { diagnostics.push("File count budget exceeded."); break; }
      try {
        const absolute = join(this.root, path);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isFile()) { diagnostics.push(`Not a regular file: ${path}`); continue; }
        const rel = relative(root, await realpath(absolute));
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) { diagnostics.push(`Path escapes workspace: ${path}`); continue; }
        if (stat.size > (this.limits.maxFileBytes ?? 256 * 1024) || bytes + stat.size > (this.limits.maxBytes ?? 32 * 1024 * 1024)) { diagnostics.push(`Content budget exceeded: ${path}`); continue; }
        const content = await readFile(absolute);
        const after = await lstat(absolute);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) { diagnostics.push(`Concurrent edit while reading: ${path}`); continue; }
        bytes += content.length;
        let text: string | undefined;
        if (!content.includes(0)) try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { /* Binary hashes still establish unchanged bytes. */ }
        files[path] = { hash: createHash("sha256").update(content).digest("hex"), ...(text !== undefined ? { content: text } : {}) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`Unreadable content: ${path}`);
      }
    }
    return { version: 1, id, workspaceKey: projectWorkspaceKey(this.root), capturedAt: Date.now(), files, git: inventory.git, initialStatus: inventory.status, diagnostics, complete: !diagnostics.length };
  }

  async capture(): Promise<ProjectChangeBaseline> {
    const baseline = await this.snapshot();
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, `${baseline.id}.json`), JSON.stringify(baseline), { flag: "wx" });
    return baseline;
  }

  async compare(evidenceId: string): Promise<ProjectChangeReport> {
    if (!z.string().uuid().safeParse(evidenceId).success) throw new Error("Invalid Project evidence identity.");
    const baseline = baselineSchema.parse(JSON.parse(await readFile(join(this.directory, `${evidenceId}.json`), "utf8")));
    if (baseline.workspaceKey !== projectWorkspaceKey(this.root)) throw new Error("Project evidence belongs to another workspace.");
    const current = await this.snapshot();
    const changes: ProjectChangeReport["changes"] = [];
    const diagnostics = [...baseline.diagnostics, ...current.diagnostics];
    for (const path of [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])].sort()) {
      const before = baseline.files[path], after = current.files[path];
      if (before?.hash === after?.hash) continue;
      if ((before && before.content === undefined) || (after && after.content === undefined)) diagnostics.push(`Changed binary or non-UTF8 content requires review: ${path}`);
      changes.push({ path, kind: !before ? "added" : !after ? "deleted" : "modified", ...(before ? { beforeHash: before.hash, ...(before.content !== undefined ? { before: before.content } : {}) } : {}), ...(after ? { afterHash: after.hash, ...(after.content !== undefined ? { after: after.content } : {}) } : {}) });
    }
    const renameCandidates = changes.filter(change => change.kind === "deleted").flatMap(from => changes.filter(to => to.kind === "added" && to.afterHash === from.beforeHash).map(to => ({ from: from.path, to: to.path })));
    return { evidenceId, complete: baseline.complete && current.complete && !diagnostics.length, diagnostics, changes, renameCandidates };
  }
}
