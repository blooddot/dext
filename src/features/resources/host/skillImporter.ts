import { basename, dirname } from "node:path";
import { isSkillCommandId, isSkillId } from "../../workflow/contracts/skill.js";
import { parseSkillMetadata, type SkillMetadata } from "../../workflow/domain/skillMetadata.js";
import { parseCommandSource } from "../../workflow/domain/skillCommand.js";
import type { ResourceDocument, ResourceFile } from "../contracts/resourceSession.js";
import { parseGithubUrl, githubTreeUrl, type GithubSource } from "../domain/skillSource.js";
import {
  SKILL_PACK_COMMANDS_DIRECTORY,
  SKILL_PACK_MANIFEST_FILE,
  SKILL_PACK_SOURCE_FILE,
  SKILLS_DIRECTORY,
  SKILL_PACKS_DIRECTORY,
  formatSkillPackReport,
  skillPackId,
  type SkillPackAnalysis,
  type SkillPackCommandRecord,
  type SkillPackManifest,
  type SkillPackSkillRecord
} from "../domain/skillPack.js";
import {
  validateSkillImportSelection,
  type SkillCandidateSummary,
  type SkillImportAnalyzer
} from "../domain/skillImportAnalysis.js";
import type { FetchedArchive } from "./githubArchive.js";
import { fetchGithubSkillSnapshot } from "./githubSkillSnapshot.js";

export const SKILL_PACK_MAX_FILES = 128;
export const SKILL_PACK_MAX_BYTES = 1_000_000;
export const SKILL_FILE_MAX_BYTES = 200_000;
const MAX_COMMAND_BYTES = 200_000;
const DENYLISTED_SEGMENTS = new Set([
  ".git", "node_modules", "test", "tests", "fixtures", "examples", "docs", "vendor", ".github",
  ".idea", ".vscode", "dist", "build", "coverage"
]);
const COMMAND_ROOTS = [
  ".claude/commands",
  ".opencode/command",
  ".opencode/commands",
  ".codex/commands",
  "commands",
  ".github/commands"
];
const LICENSE_NAME = /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i;

export interface SkillCandidate {
  /** Repository-relative directory; empty for a root SKILL.md. */
  directory: string;
  id: string;
  skillPath: string;
  metadata: SkillMetadata;
  /** Every repository-relative file owned by this skill. */
  files: string[];
  shallow: { ok: boolean; reason?: string };
}

export interface SkillDiscovery {
  candidates: SkillCandidate[];
  valid: SkillCandidate[];
  deterministic: boolean;
  /** Why the set is ambiguous, for the report and the failure message. */
  ambiguity?: string;
  /** Adapter copies with the same id as a canonical skill. */
  ignoredDuplicates: Array<{ path: string; reason: string }>;
  commandFiles: string[];
}

export interface SkillPackDraft {
  draft: ResourceDocument;
  report: string;
  manifest: SkillPackManifest;
  primarySkillId: string;
}

export interface ImportSkillPackOptions {
  analyzer?: SkillImportAnalyzer;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** Pre-fetched archive, used by tests and by a retry that already downloaded it. */
  archive?: FetchedArchive;
  limits?: { maxCompressedBytes?: number; maxExpandedBytes?: number; timeoutMs?: number };
}

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function isBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function hasDenylistedSegment(path: string): boolean {
  return path.split("/").some((segment) => DENYLISTED_SEGMENTS.has(segment));
}

function repositoryName(source: GithubSource): string {
  const generic = new Set(["skills", ".claude", ".opencode", ".codex", "commands", "plugins"]);
  return source.path && !generic.has(basename(source.path)) ? basename(source.path) : source.repo;
}

/** Finds every SKILL.md in the archive and classifies the candidate set. The
 * directory layout is irrelevant: a nested SKILL.md is a supporting file of the
 * outer skill, and a root SKILL.md owns the whole repository. */
export function discoverSkillCandidates(
  files: ReadonlyMap<string, Uint8Array>,
  repository: string,
  indexedPaths: readonly string[] = [...files.keys()]
): SkillDiscovery {
  const commandFiles = indexedPaths.filter((path) => /\.md$/i.test(path) && COMMAND_ROOTS.some((root) => path.startsWith(`${root}/`)));
  // Only repository metadata is skipped outright. Test, example and documentation
  // copies stay candidates so the ambiguity check can send them to the analyzer
  // instead of importing or silently dropping one.
  const paths = indexedPaths.filter((path) => /(?:^|\/)SKILL\.md$/i.test(path)
    && !path.split("/").some((segment) => segment === ".git" || segment === "node_modules"));
  if (!paths.length) return { candidates: [], valid: [], deterministic: false, ignoredDuplicates: [], commandFiles };
  let skillPaths: string[];
  const rootSkill = paths.find((path) => path.toLowerCase() === "skill.md");
  if (rootSkill) skillPaths = [rootSkill];
  else {
    skillPaths = [];
    for (const path of paths.sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right))) {
      const directory = dirname(path) === "." ? "" : dirname(path);
      if (skillPaths.some((existing) => {
        const existingDirectory = dirname(existing) === "." ? "" : dirname(existing);
        return existingDirectory !== "" && (directory === existingDirectory || directory.startsWith(`${existingDirectory}/`));
      })) continue;
      skillPaths.push(path);
    }
  }

  const grouped = new Map<string, SkillCandidate[]>();
  for (const skillPath of skillPaths) {
    const directory = dirname(skillPath) === "." ? "" : dirname(skillPath);
    const id = directory ? basename(directory) : repository;
    const source = files.get(skillPath)!;
    const text = decodeText(source);
    const metadata = text === undefined ? undefined : parseSkillMetadata(text, id);
    const owned = indexedPaths.filter((path) => directory === "" ? true : path === skillPath || path.startsWith(`${directory}/`)).sort();
    let reason: string | undefined;
    if (!isSkillId(id)) reason = `Invalid skill id '${String(id)}'.`;
    else if (source.byteLength > SKILL_FILE_MAX_BYTES) reason = `SKILL.md is larger than ${SKILL_FILE_MAX_BYTES} bytes.`;
    else if (!text || !metadata) reason = "SKILL.md is not valid UTF-8.";
    else if (metadata.diagnostics.some((diagnostic) => /Invalid YAML|must be a/.test(diagnostic))) {
      reason = metadata.diagnostics.join(" ");
    } else if (!metadata.body) reason = "SKILL.md has no body.";
    const candidate: SkillCandidate = {
      directory, id, skillPath,
      metadata: metadata ?? parseSkillMetadata("", id),
      files: owned,
      shallow: reason ? { ok: false, reason } : { ok: true }
    };
    const folded = id.toLowerCase();
    grouped.set(folded, [...(grouped.get(folded) ?? []), candidate]);
  }

  // A repository that ships adapter copies (for example `.openclaw/skills/`)
  // beside its canonical `skills/` must not fail: prefer the visible copy and
  // report the hidden one. Two visible directories with the same id are a real
  // conflict and still fail.
  const candidates: SkillCandidate[] = [];
  const ignoredDuplicates: Array<{ path: string; reason: string }> = [];
  for (const group of grouped.values()) {
    if (group.length === 1) {
      candidates.push(group[0]!);
      continue;
    }
    const canonical = group.filter((candidate) => !candidate.directory.split("/").some((segment) => segment.startsWith(".")));
    if (canonical.length !== 1) {
      const directories = group.map((candidate) => `'${candidate.directory || "."}'`).join(" and ");
      throw new Error(`Two skill directories resolve to the same id '${group[0]!.id}': ${directories}. Rename one before importing.`);
    }
    candidates.push(canonical[0]!);
    for (const duplicate of group) {
      if (duplicate === canonical[0]) continue;
      ignoredDuplicates.push({
        path: duplicate.directory || ".",
        reason: `Duplicate adapter copy of '${canonical[0]!.id}'; the canonical directory is '${canonical[0]!.directory || "."}'.`
      });
    }
  }
  candidates.sort((left, right) => left.directory.localeCompare(right.directory));

  const valid = candidates.filter((candidate) => candidate.shallow.ok);
  let deterministic = false;
  let ambiguity: string | undefined;
  if (valid.length === 1) {
    // A lone copy under docs/, examples/ or test/ is still a copy: ask the
    // analyzer rather than installing whatever documentation the repository
    // happens to ship.
    deterministic = !hasDenylistedSegment(valid[0]!.directory);
    if (!deterministic) {
      ambiguity = `The only candidate is inside a documentation, test, or example directory: '${valid[0]!.directory}'.`;
    }
  } else if (valid.length > 1) {
    const parents = new Set(valid.map((candidate) => dirname(candidate.directory)));
    const parent = parents.size === 1 ? [...parents][0]! : undefined;
    const allDirectChildren = parent !== undefined
      && parent !== "."
      && parent !== ""
      && valid.every((candidate) => candidate.directory !== "" && dirname(candidate.directory) === parent);
    if (allDirectChildren && !hasDenylistedSegment(parent) && !valid.some((candidate) => hasDenylistedSegment(candidate.directory))) {
      deterministic = true;
    } else {
      ambiguity = valid.length === 1
        ? undefined
        : "The candidates are spread across unrelated directories.";
    }
  }
  return { candidates, valid, deterministic, ...(ambiguity ? { ambiguity } : {}), ignoredDuplicates, commandFiles };
}

function candidateSummary(candidate: SkillCandidate): SkillCandidateSummary {
  return {
    directory: candidate.directory,
    id: candidate.id,
    ...(candidate.metadata.name ? { name: candidate.metadata.name } : {}),
    description: candidate.metadata.description,
    fileCount: candidate.files.length,
    shallow: candidate.shallow.ok ? "ok" : "invalid",
    ...(candidate.shallow.reason ? { shallowReason: candidate.shallow.reason } : {})
  };
}

function candidateChoices(source: GithubSource, candidates: readonly SkillCandidate[]): string {
  return candidates.map((candidate) => `- ${candidate.directory || "."}: ${githubTreeUrl(source, candidate.directory)}`).join("\n");
}

function ambiguityFailure(source: GithubSource, candidates: readonly SkillCandidate[], detail?: string): Error {
  return new Error([
    detail ?? "This repository contains several unrelated skills, so Dext will not guess which pack to install.",
    "Import one of these directories instead:",
    candidateChoices(source, candidates)
  ].join("\n"));
}

/** Indexes the repository, chooses a pack, fetches and validates selected files and
 * returns a reviewable draft. No file is written here. */
export async function importSkillPack(input: string, options: ImportSkillPackOptions = {}): Promise<SkillPackDraft> {
  const parsed = parseGithubUrl(input);
  if ("error" in parsed) throw new Error(parsed.error);
  const source = parsed.source;
  const snapshot = options.archive ? undefined : await fetchGithubSkillSnapshot(source, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.limits ? { limits: options.limits } : {})
  });
  const archive = options.archive ?? snapshot!;
  if (options.signal?.aborted) throw new Error("Skill import stopped by user.");
  const allFiles = archive.files;
  // Report links carry the ref actually used (HEAD for repository roots).
  const reportSource: GithubSource = { ...source, ref: source.ref ?? archive.ref };
  // A tree link imports only the subtree it points at; a blob or raw link only
  // its own skill directory. Root LICENSE files stay visible for provenance.
  const prefix = source.kind === "blob" || source.kind === "tree" || source.kind === "raw" ? source.path : "";
  const paths = (snapshot?.paths ?? [...allFiles.keys()]).filter((path) => {
    const rootLicense = !path.includes("/") && LICENSE_NAME.test(path);
    return !prefix || path === prefix || path.startsWith(`${prefix}/`) || rootLicense;
  });
  const files = new Map<string, Uint8Array>();
  const loadFiles = async (requested: readonly string[]): Promise<void> => {
    if (options.signal?.aborted) throw new Error("Skill import stopped by user.");
    await snapshot?.loadFiles(requested);
    for (const path of requested) {
      const bytes = allFiles.get(path);
      if (bytes) files.set(path, bytes);
    }
  };
  // Discovery reads only SKILL.md contents; supporting names come from the index.
  await loadFiles(paths.filter((path) => /(?:^|\/)SKILL\.md$/i.test(path)
    && !path.split("/").some((segment) => segment === ".git" || segment === "node_modules")));
  if ((source.kind === "blob" || source.kind === "raw")
    && !files.has(`${source.path ? `${source.path}/` : ""}SKILL.md`)) {
    throw new Error(`The linked SKILL.md was not found in the downloaded archive: ${source.skillFile ?? source.path}.`);
  }
  const discovery = discoverSkillCandidates(files, repositoryName(source), paths);
  if (!discovery.candidates.length) {
    if (discovery.commandFiles.length) {
      throw new Error("This repository contains commands but no SKILL.md. Dext imports skill packs, not command-only repositories.");
    }
    throw new Error("No SKILL.md was found in the linked repository directory. Dext will not generate a skill from a README.");
  }
  const shallowInvalid = discovery.candidates.filter((candidate) => !candidate.shallow.ok);
  if (!discovery.valid.length) {
    throw new Error([
      "No candidate skill passed validation:",
      ...shallowInvalid.map((candidate) => `- ${candidate.directory || "."}: ${candidate.shallow.reason}`)
    ].join("\n"));
  }

  let selected: SkillCandidate[];
  let packName: string;
  let analysisMode: "deterministic" | "ai" = "deterministic";
  let summary: string | undefined;
  let confidence: "high" | "medium" | undefined;
  let selectedFromAnalysis: Set<string> | undefined;
  const skipped: SkillPackAnalysis["skipped"] = [
    ...discovery.ignoredDuplicates,
    ...shallowInvalid.map((candidate) => ({
      path: candidate.directory || ".",
      reason: candidate.shallow.reason ?? "invalid skill"
    }))
  ];
  if (discovery.deterministic) {
    selected = discovery.valid;
    packName = repositoryName(source);
  } else {
    if (!options.analyzer) throw ambiguityFailure(reportSource, discovery.valid, discovery.ambiguity);
    if (options.signal?.aborted) throw new Error("Skill import stopped by user.");
    let response: unknown;
    try {
      response = await options.analyzer({
        repository: source.repositoryUrl,
        sourceUrl: input.trim(),
        candidates: discovery.valid.map(candidateSummary),
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch (error) {
      if (options.signal?.aborted) throw new Error("Skill import stopped by user.");
      throw ambiguityFailure(reportSource, discovery.valid, `Dext could not analyze this repository: ${error instanceof Error ? error.message : String(error)}`);
    }
    let selection;
    try {
      selection = validateSkillImportSelection(response, discovery.valid.map(candidateSummary));
    } catch (error) {
      throw ambiguityFailure(reportSource, discovery.valid, error instanceof Error ? error.message : String(error));
    }
    const byDirectory = new Map(discovery.valid.map((candidate) => [candidate.directory, candidate]));
    selected = selection.skillDirectories.map((directory) => byDirectory.get(directory)!);
    selectedFromAnalysis = new Set(selection.skillDirectories);
    packName = selection.packName;
    analysisMode = "ai";
    summary = selection.summary || undefined;
    confidence = selection.confidence === "low" ? undefined : selection.confidence;
    for (const candidate of discovery.valid) {
      if (selectedFromAnalysis.has(candidate.directory)) continue;
      const excluded = selection.excluded.find((entry) => entry.path === candidate.directory);
      skipped.push({ path: candidate.directory || ".", reason: excluded?.reason ?? "not selected by the analysis" });
    }
  }

  await loadFiles([
    ...selected.flatMap((candidate) => candidate.files),
    ...discovery.commandFiles,
    ...paths.filter((path) => !path.includes("/") && LICENSE_NAME.test(path))
  ]);

  // Full validation of the selected set: any failure aborts the whole pack.
  const records: SkillPackSkillRecord[] = [];
  const packFiles: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const candidate of [...selected].sort((left, right) => left.directory.localeCompare(right.directory))) {
    const warnings: string[] = [];
    const metadata = candidate.metadata;
    const diagnostics = metadata.diagnostics.filter((diagnostic) => /Invalid YAML|must be a/.test(diagnostic));
    if (diagnostics.length) throw new Error(`Skill '${candidate.id}' is invalid: ${diagnostics.join(" ")}`);
    if (!metadata.description.trim()) throw new Error(`Skill '${candidate.id}' has no description.`);
    if (!metadata.body) throw new Error(`Skill '${candidate.id}' has no body.`);
    if (!metadata.hasFrontMatter) warnings.push("SKILL.md has no YAML front matter.");
    if (metadata.name && metadata.name !== candidate.id) warnings.push(`Front matter name '${metadata.name}' differs from the directory id '${candidate.id}'.`);
    if (!candidate.files.some((path) => LICENSE_NAME.test(basename(path)))) warnings.push("No LICENSE file was found beside SKILL.md.");
    for (const file of candidate.files) {
      const bytes = files.get(file)!;
      const relative = candidate.directory === ""
        ? file
        : file === candidate.skillPath ? "SKILL.md" : file.slice(candidate.directory.length + 1);
      if (isBinary(bytes)) {
        if (relative === "SKILL.md") throw new Error(`Skill '${candidate.id}' has a binary SKILL.md.`);
        warnings.push(`Skipped binary supporting file '${relative}'.`);
        continue;
      }
      if (bytes.byteLength > SKILL_FILE_MAX_BYTES) throw new Error(`'${relative}' in skill '${candidate.id}' is larger than ${SKILL_FILE_MAX_BYTES} bytes.`);
      if (decodeText(bytes) === undefined) {
        if (relative === "SKILL.md") throw new Error(`Skill '${candidate.id}' has a SKILL.md that is not valid UTF-8.`);
        warnings.push(`Skipped non-UTF-8 supporting file '${relative}'.`);
        continue;
      }
      if (bytes[0] === 0x23 && bytes[1] === 0x21) warnings.push(`Supporting file '${relative}' is executable text; it is copied but never run.`);
      packFiles.push({ path: `${SKILLS_DIRECTORY}/${candidate.id}/${relative}`, bytes });
    }
    records.push({
      id: candidate.id,
      name: metadata.name ?? candidate.id,
      description: metadata.description,
      directory: candidate.directory,
      commands: [],
      warnings
    });
  }

  // Commands are copied only when their syntax is a plain prompt template and
  // they map to a selected skill. Everything else is reported, never written.
  const packId = skillPackId(packName);
  const commands: SkillPackCommandRecord[] = [];
  const commandFiles = new Map<string, Uint8Array>();
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  for (const path of [...discovery.commandFiles].sort()) {
    if (!/\.md$/i.test(path) || !files.has(path)) continue;
    const bytes = files.get(path)!;
    const id = basename(path).replace(/\.md$/i, "");
    if (bytes.byteLength > MAX_COMMAND_BYTES) {
      commands.push({ id, title: id, description: "", skillId: "unmapped", source: path, status: "unavailable", reason: "Command file is too large." });
      continue;
    }
    const text = decodeText(bytes);
    if (text === undefined) {
      commands.push({ id, title: id, description: "", skillId: "unmapped", source: path, status: "unavailable", reason: "Command file is not valid UTF-8." });
      continue;
    }
    const parsedCommand = parseCommandSource(id, text);
    const mapping = parsedCommand.skillId ?? (selectedIds.has(id) ? id : undefined);
    if (!mapping || !selectedIds.has(mapping)) {
      commands.push({
        id, title: parsedCommand.title, description: parsedCommand.description, skillId: mapping ?? "",
        source: path, status: "unavailable", reason: "Command does not map to a selected skill."
      });
      continue;
    }
    if (!parsedCommand.supported) {
      commands.push({
        id, title: parsedCommand.title, description: parsedCommand.description, skillId: mapping,
        source: path, status: "unavailable", reason: parsedCommand.diagnostics.join(" ")
      });
      continue;
    }
    if (commands.some((command) => command.id === id)) {
      commands.push({
        id, title: parsedCommand.title, description: parsedCommand.description, skillId: mapping,
        source: path, status: "unavailable", reason: `Duplicate command id '${id}'.`
      });
      continue;
    }
    if (!isSkillCommandId(id)) {
      commands.push({
        id, title: parsedCommand.title, description: parsedCommand.description, skillId: mapping,
        source: path, status: "unavailable", reason: `Invalid command id '${String(id)}'.`
      });
      continue;
    }
    const installed = `${SKILL_PACKS_DIRECTORY}/${packId}/${SKILL_PACK_COMMANDS_DIRECTORY}/${id}.md`;
    commandFiles.set(installed, bytes);
    const record: SkillPackCommandRecord = {
      id, title: parsedCommand.title, description: parsedCommand.description, skillId: mapping,
      source: path, file: installed, status: "available"
    };
    commands.push(record);
    const skill = records.find((item) => item.id === mapping);
    if (skill) skill.commands.push(id);
  }

  const licenses = [...allFiles.keys()].filter((path) => !path.includes("/") && LICENSE_NAME.test(path)).sort();
  const licenseBytes = licenses[0] ? allFiles.get(licenses[0]) : undefined;
  const manifest: SkillPackManifest = {
    name: packName,
    version: 1,
    source: input.trim(),
    ...(archive.commit ? { commit: archive.commit } : {}),
    ...(licenses[0] ? { license: licenses[0] } : {}),
    importedAt: new Date().toISOString(),
    skills: records,
    commands,
    analysis: {
      mode: analysisMode,
      ...(summary ? { summary } : {}),
      ...(confidence ? { confidence } : {}),
      selected: records.map((record) => record.directory),
      excluded: shallowInvalid.map((candidate) => ({ path: candidate.directory || ".", reason: candidate.shallow.reason ?? "invalid skill" })),
      skipped
    }
  };
  const report = formatSkillPackReport(manifest);
  const primary = records.find((record) => record.id === packId) ?? records[0]!;
  const primaryCandidate = selected.find((candidate) => candidate.id === primary.id)!;
  const primarySource = files.get(primaryCandidate.skillPath);
  const primaryContent = primarySource ? decodeText(primarySource) : undefined;
  if (!primaryContent) throw new Error(`Skill '${primary.id}' has no readable SKILL.md.`);

  const manifestPath = `${SKILL_PACKS_DIRECTORY}/${packId}/${SKILL_PACK_MANIFEST_FILE}`;
  const sourcePath = `${SKILL_PACKS_DIRECTORY}/${packId}/${SKILL_PACK_SOURCE_FILE}`;
  const generated: ResourceFile[] = [
    ...packFiles.filter((file) => file.path !== `${SKILLS_DIRECTORY}/${primary.id}/SKILL.md`).map((file) => ({
      path: file.path,
      content: decodeText(file.bytes)!
    })),
    ...(licenseBytes ? [{ path: `${SKILL_PACKS_DIRECTORY}/${packId}/LICENSE`, content: decodeText(licenseBytes) ?? "" }] : []),
    ...[...commandFiles].map(([path, bytes]) => ({ path, content: decodeText(bytes)! })),
    { path: manifestPath, content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: sourcePath, content: `${report}\n` }
  ];
  const deduped = new Map<string, ResourceFile>();
  for (const file of generated) {
    const key = file.path.toLowerCase();
    if (deduped.has(key)) throw new Error(`The imported pack writes '${file.path}' twice.`);
    if (!file.content) throw new Error(`The imported pack would write an empty file: ${file.path}`);
    deduped.set(key, file);
  }
  const filesList = [...deduped.values()];
  const totalFiles = filesList.length + 1;
  const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
  const totalBytes = filesList.reduce((sum, file) => sum + byteLength(file.content), 0) + byteLength(primaryContent);
  if (totalFiles > SKILL_PACK_MAX_FILES) throw new Error(`The pack has ${totalFiles} files; the limit is ${SKILL_PACK_MAX_FILES}.`);
  if (totalBytes > SKILL_PACK_MAX_BYTES) throw new Error(`The pack is ${totalBytes} bytes; the limit is ${SKILL_PACK_MAX_BYTES}.`);

  return {
    draft: { name: primary.id, content: primaryContent, files: filesList },
    report,
    manifest,
    primarySkillId: primary.id
  };
}

export interface SkillPackPreflight {
  /** Resolves a path relative to `.dext/` (or the global root) in the target scope. */
  exists: (relative: string) => Promise<boolean>;
  /** Same lookup in the other scope, used only for a shadowing warning. */
  otherScopeExists?: (relative: string) => Promise<boolean>;
}

/** Re-checks every target before Create. Nothing is staged on failure. */
export async function preflightSkillPack(
  draft: ResourceDocument,
  options: SkillPackPreflight
): Promise<{ warnings: string[] }> {
  const paths = draft.files ?? [];
  const pack = paths.map((file) => /^skill-packs\/([^/]+)\//.exec(file.path)?.[1]).find(Boolean);
  if (!pack) throw new Error("An imported Skill pack is missing its pack manifest path.");
  if (await options.exists(`${SKILL_PACKS_DIRECTORY}/${pack}`)) {
    throw new Error(`Skill pack '${pack}' is already installed. Remove it before importing again.`);
  }
  const ids = new Map<string, string>();
  for (const id of [draft.name, ...paths.flatMap((file) => {
    const match = /^skills\/([^/]+)\//.exec(file.path);
    return match ? [match[1]!] : [];
  })]) {
    const folded = id.toLowerCase();
    const existing = ids.get(folded);
    if (existing !== undefined && existing !== id) throw new Error(`The pack declares both '${existing}' and '${id}'.`);
    ids.set(folded, id);
  }
  const warnings: string[] = [];
  for (const id of [...ids.values()].sort()) {
    if (!isSkillId(id)) throw new Error(`Invalid skill id '${String(id)}'.`);
    if (await options.exists(`${SKILLS_DIRECTORY}/${id}`)) {
      throw new Error(`Skill '${id}' already exists. Remove it before importing this pack.`);
    }
    if (options.otherScopeExists && await options.otherScopeExists(`${SKILLS_DIRECTORY}/${id}`)) {
      warnings.push(`Skill '${id}' also exists in the other scope; the local copy will take precedence.`);
    }
  }
  return { warnings };
}
