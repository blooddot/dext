import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ResourceEntry } from "../contracts/resourceDocuments.js";
import { RESOURCE_DIRECTORIES, resourcePathSegments } from "../contracts/resourceSession.js";
import { isSkillId } from "../../workflow/contracts/skill.js";
import { isSkillPackId, normalizeSkillPackManifest, type SkillPackManifest } from "../domain/skillPack.js";

export interface ResourceRemovalPlan {
  label: string;
  targets: string[];
  skills: string[];
  /** Detects changed pack ownership while the confirmation is open. */
  revision: string;
}

function within(root: string, path: string): boolean {
  const part = relative(resolve(root), resolve(path));
  return Boolean(part) && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

/** Resolve from trusted root + resource id; never trust a Webview's path. */
export function managedResourcePath(entry: ResourceEntry, root: string): string {
  if (entry.reference || entry.source.kind !== entry.scope || !entry.source.path || entry.kind === "file") {
    throw new Error("This is a read-only resource, not a managed source file.");
  }
  resourcePathSegments(entry.kind, entry.path);
  const kindRoot = resolve(root, RESOURCE_DIRECTORIES[entry.kind]);
  const path = resolve(kindRoot, entry.path);
  if (!within(kindRoot, path) || relative(path, resolve(entry.source.path)) !== "") {
    throw new Error("The resource path is outside its managed directory.");
  }
  return path;
}

/** Reject links in every component below the named resource root. This also
 * protects recursive directory removal from a symlink/junction in a parent. */
async function validateTarget(root: string, target: string): Promise<void> {
  if (!within(root, target)) throw new Error("Refusing to remove the resource root or a path outside it.");
  let current = resolve(root);
  for (const part of relative(current, target).split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Resource removal cannot follow a link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function packs(root: string): Promise<Array<{ id: string; manifest: SkillPackManifest; revision: string }>> {
  const directory = join(root, "skill-packs");
  await validateTarget(root, directory);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: Array<{ id: string; manifest: SkillPackManifest; revision: string }> = [];
  for (const entry of entries) {
    if (!isSkillPackId(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Resource removal cannot follow a link: ${join(directory, entry.name)}`);
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "pack.json");
    await validateTarget(root, path);
    let source: string;
    try { source = await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    let manifest: SkillPackManifest | undefined;
    try { manifest = normalizeSkillPackManifest(JSON.parse(source) as unknown, entry.name); } catch { /* Report below. */ }
    if (!manifest) throw new Error(`Skill pack '${entry.name}' has an invalid manifest. Repair it before removing Skills.`);
    result.push({ id: entry.name, manifest, revision: createHash("sha256").update(source).digest("hex") });
  }
  return result;
}

export async function resourceRemovalPlan(entry: ResourceEntry, root: string): Promise<ResourceRemovalPlan> {
  const source = managedResourcePath(entry, root);
  let targets = [entry.kind === "skill" ? dirname(source) : source];
  let label = `${entry.kind === "skill" ? "Skill" : entry.kind.toUpperCase()} '${entry.name}'`;
  let skills: string[] = [];
  let revision = "";
  if (entry.kind === "skill") {
    const installed = await packs(root);
    const canonicalFile = (id: string) => resolve(root, "skills", id, "SKILL.md");
    const owners = installed.filter((pack) => pack.manifest.skills.some((skill) => samePath(source, canonicalFile(skill.id))));
    if (owners.length > 1) throw new Error("This Skill is claimed by more than one pack. Resolve the conflicting manifests before removing it.");
    const owner = owners[0];
    if (owner) {
      skills = [...new Set(owner.manifest.skills.map((skill) => skill.id))];
      if (!skills.every(isSkillId)) throw new Error("The Skill pack contains an unsafe Skill id.");
      if (installed.some((pack) => pack !== owner && pack.manifest.skills.some((skill) => skills.some((id) => samePath(canonicalFile(id), canonicalFile(skill.id)))))) {
        throw new Error("Another pack also owns a Skill in this pack. Resolve its ownership before removing it.");
      }
      const packRoot = resolve(root, "skill-packs", owner.id);
      for (const skill of owner.manifest.skills) {
        if (!skill.file) continue; // Legacy packs use the canonical skills directory.
        const file = resolve(root, skill.file);
        if (relative(file, resolve(root, "skills", skill.id, "SKILL.md")) !== "" && !within(packRoot, file)) {
          throw new Error("The pack manifest points to a Skill outside its owned directories.");
        }
      }
      label = `Skill pack '${owner.manifest.name}'`;
      targets = [...skills.map((id) => resolve(root, "skills", id)), packRoot];
      revision = owner.revision;
    }
  }
  for (const target of targets) await validateTarget(root, target);
  return { label, targets, skills, revision };
}

/** Confirmation, dirty-document protection and Trash belong to the host.
 * The same plan is checked again immediately before touching any filesystem. */
export async function removeManagedResource(entry: ResourceEntry, root: string, host: {
  confirm(plan: ResourceRemovalPlan): Promise<boolean>;
  dirtyPaths(): readonly string[];
  trash(path: string): Promise<void>;
}): Promise<boolean> {
  const checkDirty = (plan: ResourceRemovalPlan): void => {
    if (host.dirtyPaths().some((path) => plan.targets.some((target) => relative(resolve(target), resolve(path)) === "" || within(target, path)))) {
      throw new Error("This resource has unsaved files. Save or discard those changes before deleting it.");
    }
  };
  const plan = await resourceRemovalPlan(entry, root);
  checkDirty(plan);
  if (!await host.confirm(plan)) return false;
  const current = await resourceRemovalPlan(entry, root);
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("The resource changed while confirming deletion. Refresh and try again.");
  checkDirty(current);
  const removed: string[] = [];
  for (const path of current.targets) {
    // Resolve/check each exact target again before a recursive removal.
    await validateTarget(root, path);
    try { await host.trash(path); removed.push(path); }
    catch (error) {
      throw new Error(`Could not remove ${current.label}: ${error instanceof Error ? error.message : String(error)}.${removed.length ? ` Already moved to Trash: ${removed.join(", ")}.` : ""}`);
    }
  }
  return true;
}
