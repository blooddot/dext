import { resourcePathSegments, type ResourceDocument } from "../contracts/resourceSession.js";
import { isSkillId } from "../../workflow/contracts/skill.js";
import {
  SKILL_PACK_MANIFEST_FILE,
  SKILL_PACK_SOURCE_FILE,
  SKILL_PACKS_DIRECTORY,
  type SkillPackManifest
} from "./skillPack.js";

/** An installed pack and its manifest, used to check ownership before a replacement. */
export interface InstalledSkillPack {
  id: string;
  manifest: SkillPackManifest;
}

export interface SkillPackUpgradePlan {
  /** Complete new pack tree, relative to the resource root. */
  files: Array<{ path: string; content: string }>;
  /** Canonical `skills/<id>` directories the old manifest owned. */
  removeSkills: string[];
  addedSkills: string[];
  removedSkills: string[];
  primarySkillId: string;
}

function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function canonicalSkillIds(files: ReadonlyArray<{ path: string }>): string[] {
  const ids = new Map<string, string>();
  for (const file of files) {
    const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
    if (!match) continue;
    const id = match[1]!;
    const folded = id.toLowerCase();
    const existing = ids.get(folded);
    if (existing !== undefined && existing !== id) throw new Error(`The pack declares both '${existing}' and '${id}'.`);
    ids.set(folded, id);
  }
  return [...ids.values()].sort();
}

/**
 * Builds the exact replacement for an installed pack. The caller confirms and
 * moves the old directories to Trash; this plan only proves that every new
 * canonical Skill is either owned by this pack already or free to install.
 */
export async function buildSkillPackUpgradePlan(input: {
  packId: string;
  existing: SkillPackManifest;
  draft: ResourceDocument;
  otherPacks: readonly InstalledSkillPack[];
  exists(this: void, relativePath: string): Promise<boolean>;
}): Promise<SkillPackUpgradePlan> {
  const { packId, existing, draft, otherPacks } = input;
  const primaryPath = `skills/${draft.name}/SKILL.md`;
  const sourceFiles = [...(draft.files ?? []), { path: primaryPath, content: draft.content }];
  const files = new Map<string, { path: string; content: string }>();
  for (const file of sourceFiles) {
    const parts = resourcePathSegments("file", file.path);
    if (!parts.length || (parts[0] !== "skills" && !(parts[0] === "skill-packs" && parts[1] === packId))) {
      throw new Error(`The updated pack would write outside its own directories: ${file.path}`);
    }
    const key = file.path.toLowerCase();
    if (files.has(key)) throw new Error(`The updated pack writes '${file.path}' twice.`);
    files.set(key, { path: file.path, content: withTrailingNewline(file.content) });
  }
  const nextFiles = [...files.values()];

  const oldIds = [...new Set(existing.skills.map((skill) => skill.id))].sort();
  const oldFolded = new Set(oldIds.map((id) => id.toLowerCase()));
  const nextIds = canonicalSkillIds(nextFiles);
  if (![...oldIds, ...nextIds].every(isSkillId)) throw new Error("The Skill pack contains an unsafe Skill id.");
  const otherIds = new Set(otherPacks.flatMap((pack) => pack.manifest.skills.map((skill) => skill.id.toLowerCase())));
  for (const id of nextIds) {
    if (otherIds.has(id.toLowerCase())) {
      throw new Error(`Skill '${id}' is also claimed by another installed pack. Resolve the conflicting manifests before updating.`);
    }
    if (oldFolded.has(id.toLowerCase())) continue;
    if (await input.exists(`skills/${id}`)) {
      throw new Error(`Skill '${id}' already exists outside this pack. Remove it before updating the pack.`);
    }
  }
  for (const id of oldIds) {
    if (otherIds.has(id.toLowerCase())) {
      throw new Error(`Skill '${id}' is also claimed by another installed pack. Resolve the conflicting manifests before updating.`);
    }
  }

  return {
    files: nextFiles,
    removeSkills: oldIds,
    addedSkills: nextIds.filter((id) => !oldFolded.has(id.toLowerCase())),
    removedSkills: oldIds.filter((id) => !nextIds.some((next) => next.toLowerCase() === id.toLowerCase())),
    primarySkillId: draft.name
  };
}

/** `pack.json` and `SOURCE.md` are generated provenance. They are rewritten on
 * the next import, so a difference there alone is not a pack update. */
function isSkillPackMetadataPath(packId: string, path: string): boolean {
  const prefix = `${SKILL_PACKS_DIRECTORY}/${packId}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return name === SKILL_PACK_MANIFEST_FILE || name === SKILL_PACK_SOURCE_FILE;
}

export interface SkillPackContentDiff {
  /** Every planned file matches the installed bytes and no pack file is left over. */
  identical: boolean;
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * Compares a replacement with the installed pack by file content. A newer commit
 * may leave every installed Skill byte-identical (README, hook, or test changes
 * do not affect a pack), and a moved release tag may change content without
 * changing the version. Only this diff can tell those cases apart.
 */
export function compareSkillPackContent(input: {
  packId: string;
  planFiles: ReadonlyArray<{ path: string; content: string }>;
  installed: ReadonlyMap<string, Uint8Array>;
}): SkillPackContentDiff {
  const decoder = new TextDecoder();
  const next = new Map<string, { path: string; content: string }>();
  for (const file of input.planFiles) {
    if (isSkillPackMetadataPath(input.packId, file.path)) continue;
    next.set(file.path.toLowerCase(), { path: file.path, content: normalizeContent(file.content) });
  }
  const previous = new Map<string, { path: string; content: string }>();
  for (const [path, bytes] of input.installed) {
    if (isSkillPackMetadataPath(input.packId, path)) continue;
    previous.set(path.toLowerCase(), { path, content: normalizeContent(decoder.decode(bytes)) });
  }
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [key, entry] of next) {
    const before = previous.get(key);
    if (!before) added.push(entry.path);
    else if (before.content !== entry.content) changed.push(entry.path);
  }
  for (const [key, entry] of previous) {
    if (!next.has(key)) removed.push(entry.path);
  }
  changed.sort();
  added.sort();
  removed.sort();
  return { identical: !changed.length && !added.length && !removed.length, changed, added, removed };
}

/** The importer appends a trailing newline and writes LF, but a pack installed
 * from a Git checkout can carry CRLF. Line endings are not content here. */
function normalizeContent(value: string): string {
  return value.replace(/\r\n/g, "\n");
}
