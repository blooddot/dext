/** Skill pack manifests and the human-readable import report. A pack is a
 * plain directory under `.dext/skill-packs/<id>/`. Dext never executes a pack:
 * hook files are copied and recorded, never run. */

export const SKILL_PACKS_DIRECTORY = "skill-packs";
export const SKILLS_DIRECTORY = "skills";
export const SKILL_PACK_MANIFEST_FILE = "pack.json";
export const SKILL_PACK_COMMANDS_DIRECTORY = "commands";
export const SKILL_PACK_SOURCE_FILE = "SOURCE.md";
/** Upstream files a declared hook needs, mirrored at their repository paths so
 * `__dirname/..` and `CLAUDE_PLUGIN_ROOT` resolve as they do in the source. */
export const SKILL_PACK_UPSTREAM_DIRECTORY = "upstream";

export const SKILL_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const SKILL_PACK_ID_MAX_LENGTH = 64;

export type SkillPackAnalysisMode = "deterministic" | "ai";

/** One skill as recorded in the manifest. `directory` is the path in the
 * source repository, kept for provenance and never used for writes. */
export interface SkillPackSkillRecord {
  id: string;
  name: string;
  description: string;
  directory: string;
  agent?: string;
  /** Installed SKILL.md path relative to the Dext resource root (v2 packs). */
  file?: string;
  commands: string[];
  warnings: string[];
}

export interface SkillPackCommandRecord {
  id: string;
  title: string;
  description: string;
  skillId: string;
  /** Repository path of the command template. */
  source: string;
  agent?: string;
  sourceAgent?: string;
  warnings?: string[];
  /** Installed path relative to `.dext/`, when the command is available. */
  file?: string;
  status: "available" | "unavailable";
  reason?: string;
}

/** How the pack's skill set was chosen. The report is part of the contract so
 * a later reader can tell an AI decision from a deterministic one. */
export interface SkillPackAnalysis {
  mode: SkillPackAnalysisMode;
  summary?: string;
  confidence?: "high" | "medium";
  /** Directories the import installed. */
  selected: string[];
  /** Candidates that could not be used, with a specific reason. */
  excluded: Array<{ path: string; reason: string }>;
  /** Candidates the analysis rejected or that were out of scope. */
  skipped: Array<{ path: string; reason: string }>;
}

/** One hook command a pack's native plugin manifest declared. Events and
 * matchers are copied verbatim from the source host; Dext never rewrites them
 * into another host's vocabulary. */
export interface SkillPackHookRecord {
  /** Native host the declaration belongs to, e.g. `claude` or `codex`. */
  agent: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  /** Repository path of the hook configuration file. */
  source: string;
  /** Repository-relative plugin root, mirrored under `upstream/`. */
  root: string;
}

export interface SkillPackManifest {
  name: string;
  /** Manifest format, not the upstream package version. */
  version: 1 | 2;
  source: string;
  targetAgent?: string;
  notes?: string[];
  /** Version declared by the repository's package.json or plugin manifest. */
  upstreamVersion?: string;
  /** Published GitHub release tag the pack was downloaded from. */
  releaseTag?: string;
  commit?: string;
  license?: string;
  importedAt: string;
  skills: SkillPackSkillRecord[];
  commands: SkillPackCommandRecord[];
  hooks?: SkillPackHookRecord[];
  analysis: SkillPackAnalysis;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A pack id derived from a repository or package name. */
export function skillPackId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
  return (normalized || "skill-pack").slice(0, SKILL_PACK_ID_MAX_LENGTH);
}

export function isSkillPackId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= SKILL_PACK_ID_MAX_LENGTH
    && SKILL_PACK_ID_PATTERN.test(value);
}

/** Tolerant reader for `.dext/skill-packs/<id>/pack.json`. A malformed manifest
 * must not stop the catalog from loading the skills beside it. */
export function normalizeSkillPackManifest(value: unknown, fallbackId: string): SkillPackManifest | undefined {
  const data = record(value);
  if (!data) return undefined;
  const skills = Array.isArray(data.skills) ? data.skills.flatMap((item) => {
    const skill = record(item);
    const id = text(skill?.id);
    if (!skill || !id) return [];
    return [{
      id,
      name: text(skill.name) ?? id,
      description: text(skill.description) ?? "",
      directory: text(skill.directory) ?? "",
      ...(text(skill.agent) ? { agent: text(skill.agent)! } : {}),
      ...(text(skill.file) ? { file: text(skill.file)! } : {}),
      commands: strings(skill.commands),
      warnings: strings(skill.warnings)
    }];
  }) : [];
  if (!skills.length) return undefined;
  const commands = Array.isArray(data.commands) ? data.commands.flatMap((item) => {
    const command = record(item);
    const id = text(command?.id);
    const skillId = text(command?.skillId);
    if (!command || !id || !skillId) return [];
    const status = command.status === "available" ? "available" as const : "unavailable" as const;
    return [{
      id,
      title: text(command.title) ?? id,
      description: text(command.description) ?? "",
      skillId,
      source: text(command.source) ?? "",
      ...(text(command.agent) ? { agent: text(command.agent)! } : {}),
      ...(text(command.sourceAgent) ? { sourceAgent: text(command.sourceAgent)! } : {}),
      ...(Array.isArray(command.warnings) ? { warnings: strings(command.warnings) } : {}),
      ...(text(command.file) ? { file: text(command.file)! } : {}),
      status,
      ...(text(command.reason) ? { reason: text(command.reason)! } : {})
    }];
  }) : [];
  // Hook records are optional provenance: an older manifest has none, and a
  // malformed entry must not invalidate the Skills beside it.
  const hooks = Array.isArray(data.hooks) ? data.hooks.flatMap((item) => {
    const hook = record(item);
    const agent = text(hook?.agent);
    const event = text(hook?.event);
    const command = text(hook?.command);
    if (!agent || !event || !command) return [];
    const timeout = typeof hook?.timeout === "number" && Number.isFinite(hook.timeout) && hook.timeout > 0
      ? hook.timeout
      : undefined;
    const matcher = text(hook?.matcher);
    return [{
      agent,
      event,
      command,
      ...(matcher ? { matcher } : {}),
      ...(timeout ? { timeout } : {}),
      source: text(hook?.source) ?? "",
      root: text(hook?.root) ?? ""
    }];
  }) : [];
  const analysisData = record(data.analysis);
  const mode: SkillPackAnalysisMode = analysisData?.mode === "ai" ? "ai" : "deterministic";
  const selected = strings(analysisData?.selected);
  const excluded = Array.isArray(analysisData?.excluded) ? analysisData.excluded.flatMap((item) => {
    const entry = record(item);
    const path = text(entry?.path);
    return path ? [{ path, reason: text(entry?.reason) ?? "" }] : [];
  }) : [];
  const skipped = Array.isArray(analysisData?.skipped) ? analysisData.skipped.flatMap((item) => {
    const entry = record(item);
    const path = text(entry?.path);
    return path ? [{ path, reason: text(entry?.reason) ?? "" }] : [];
  }) : [];
  const confidence = analysisData?.confidence === "high" || analysisData?.confidence === "medium"
    ? analysisData.confidence
    : undefined;
  const summary = text(analysisData?.summary);
  return {
    name: text(data.name) ?? fallbackId,
    version: data.version === 2 ? 2 : 1,
    source: text(data.source) ?? "",
    ...(text(data.upstreamVersion) ? { upstreamVersion: text(data.upstreamVersion)! } : {}),
    ...(text(data.releaseTag) ? { releaseTag: text(data.releaseTag)! } : {}),
    ...(text(data.targetAgent) ? { targetAgent: text(data.targetAgent)! } : {}),
    ...(Array.isArray(data.notes) ? { notes: strings(data.notes) } : {}),
    ...(text(data.commit) ? { commit: text(data.commit)! } : {}),
    ...(text(data.license) ? { license: text(data.license)! } : {}),
    importedAt: text(data.importedAt) ?? "",
    skills,
    commands,
    ...(hooks.length ? { hooks } : {}),
    analysis: {
      mode,
      ...(summary ? { summary } : {}),
      ...(confidence ? { confidence } : {}),
      selected: selected.length ? selected : skills.map((skill) => skill.directory).filter(Boolean),
      excluded,
      skipped
    }
  };
}

/** The report shown above the draft and stored as SOURCE.md. */
export function formatSkillPackReport(manifest: SkillPackManifest): string {
  const lines = [
    `# ${manifest.name} skill pack`,
    "",
    `- Source: ${manifest.source || "unknown"}`,
    ...(manifest.releaseTag ? [`- Release: ${manifest.releaseTag}`] : []),
    ...(manifest.upstreamVersion ? [`- Upstream version: ${manifest.upstreamVersion}`] : []),
    ...(manifest.version === 2 ? ["- Versions: all imported; each turn uses its Agent's version, then shared"]
      : manifest.targetAgent ? [`- Import target: ${manifest.targetAgent} (fixed legacy import)`] : []),
    ...(manifest.commit ? [`- Commit: ${manifest.commit}`] : []),
    `- Imported: ${manifest.importedAt}`,
    `- Discovery: ${manifest.analysis.mode === "ai" ? "AI-assisted selection" : "deterministic"}`,
    ...(manifest.analysis.summary ? [`- Summary: ${manifest.analysis.summary}`] : []),
    `- Skills: ${[...new Set(manifest.skills.map((skill) => skill.id))].join(", ")}`,
    `- Commands: ${manifest.commands.length
      ? manifest.commands.map((command) => `${command.id} (${command.status})`).join(", ")
      : "none"}`
  ];
  lines.push("", "## Selected sources", "");
  for (const skill of manifest.skills) lines.push(`- Skill ${skill.id}: ${skill.directory || "."} (${skill.agent ?? "shared"})`);
  for (const command of manifest.commands.filter((item) => item.status === "available")) {
    lines.push(`- Command /${command.id}: ${command.source} (${command.agent ?? "shared"})`);
    for (const warning of command.warnings ?? []) lines.push(`  - ${warning}`);
  }
  if (manifest.hooks?.length) {
    lines.push("", "## Hooks", "",
      "Copied under `upstream/` and recorded verbatim; Dext never executes them.", "");
    for (const hook of manifest.hooks) {
      const options = [hook.matcher ? `matcher: ${hook.matcher}` : undefined, hook.timeout ? `${hook.timeout}s` : undefined]
        .filter(Boolean).join(", ");
      lines.push(`- ${hook.agent} ${hook.event}${options ? ` (${options})` : ""}: ${hook.command}`);
    }
  }
  if (manifest.notes?.length) lines.push("", "## Import notes", "", ...manifest.notes.map((note) => `- ${note}`));
  if (manifest.analysis.skipped.length) {
    lines.push("", "## Skipped candidates", "");
    for (const entry of manifest.analysis.skipped) lines.push(`- ${entry.path}: ${entry.reason}`);
  }
  if (manifest.commands.some((command) => command.status === "unavailable")) {
    lines.push("", "## Unavailable commands", "");
    for (const command of manifest.commands.filter((item) => item.status === "unavailable")) {
      lines.push(`- ${command.id} (${command.source}): ${command.reason ?? "unsupported"}`);
    }
  }
  return lines.join("\n");
}
