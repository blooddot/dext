/** Skill pack manifests and the human-readable import report. A pack is a
 * plain directory under `.dext/skill-packs/<id>/`; it never executes code. */

export const SKILL_PACKS_DIRECTORY = "skill-packs";
export const SKILLS_DIRECTORY = "skills";
export const SKILL_PACK_MANIFEST_FILE = "pack.json";
export const SKILL_PACK_COMMANDS_DIRECTORY = "commands";
export const SKILL_PACK_SOURCE_FILE = "SOURCE.md";

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

export interface SkillPackManifest {
  name: string;
  version: 1;
  source: string;
  targetAgent?: string;
  notes?: string[];
  commit?: string;
  license?: string;
  importedAt: string;
  skills: SkillPackSkillRecord[];
  commands: SkillPackCommandRecord[];
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
      ...(Array.isArray(command.warnings) ? { warnings: strings(command.warnings) } : {}),
      ...(text(command.file) ? { file: text(command.file)! } : {}),
      status,
      ...(text(command.reason) ? { reason: text(command.reason)! } : {})
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
    version: 1,
    source: text(data.source) ?? "",
    ...(text(data.targetAgent) ? { targetAgent: text(data.targetAgent)! } : {}),
    ...(Array.isArray(data.notes) ? { notes: strings(data.notes) } : {}),
    ...(text(data.commit) ? { commit: text(data.commit)! } : {}),
    ...(text(data.license) ? { license: text(data.license)! } : {}),
    importedAt: text(data.importedAt) ?? "",
    skills,
    commands,
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
    ...(manifest.targetAgent ? [`- Import target: ${manifest.targetAgent} (files are selected at import time; switching Agent does not replace them)`] : []),
    ...(manifest.commit ? [`- Commit: ${manifest.commit}`] : []),
    `- Imported: ${manifest.importedAt}`,
    `- Discovery: ${manifest.analysis.mode === "ai" ? "AI-assisted selection" : "deterministic"}`,
    ...(manifest.analysis.summary ? [`- Summary: ${manifest.analysis.summary}`] : []),
    `- Skills: ${manifest.skills.map((skill) => skill.id).join(", ")}`,
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
