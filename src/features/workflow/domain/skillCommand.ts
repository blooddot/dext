import { splitFrontMatter } from "./skillMetadata.js";
import {
  isSkillCommandId,
  type SkillCommandResolution
} from "../contracts/skill.js";

/** Keys Dext understands in a command's front matter. Everything else makes
 * the command unavailable rather than silently changing its meaning. */
const SUPPORTED_KEYS = new Set(["description", "skill", "argument-hint"]);
/** Provider-routing keys are inert here: Dext always runs the turn with the
 * conversation's own Agent, so a command's preferred model is not applied. */
const IGNORED_KEYS = new Set(["agent", "model", "subtask"]);

export interface CommandMetadata {
  description?: string;
  skillId?: string;
  argumentHint?: string;
  body: string;
  diagnostics: string[];
  ignoredKeys: string[];
  unsupportedKeys: string[];
}

function stringField(data: Record<string, unknown>, key: string, diagnostics: string[]): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    diagnostics.push(`Front matter '${key}' must be a string.`);
    return undefined;
  }
  return value.trim() || undefined;
}

export function parseCommandMetadata(source: string): CommandMetadata {
  const frontMatter = splitFrontMatter(source);
  const diagnostics = [...frontMatter.diagnostics];
  const description = stringField(frontMatter.data, "description", diagnostics);
  const argumentHint = stringField(frontMatter.data, "argument-hint", diagnostics);
  const skillId = stringField(frontMatter.data, "skill", diagnostics);
  const ignoredKeys: string[] = [];
  const unsupportedKeys: string[] = [];
  for (const key of Object.keys(frontMatter.data)) {
    if (SUPPORTED_KEYS.has(key)) continue;
    if (IGNORED_KEYS.has(key)) ignoredKeys.push(key);
    else unsupportedKeys.push(key);
  }
  if (unsupportedKeys.length) {
    diagnostics.push(`Unsupported command front matter: ${unsupportedKeys.join(", ")}.`);
  }
  return {
    ...(description ? { description } : {}),
    ...(skillId ? { skillId } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    body: frontMatter.body.trim(),
    diagnostics,
    ignoredKeys,
    unsupportedKeys
  };
}

export interface ParsedSkillCommand {
  id: string;
  title: string;
  description: string;
  skillId?: string;
  argumentHint?: string;
  /** The raw prompt template, with `$ARGUMENTS` unexpanded. */
  template: string;
  supported: boolean;
  diagnostics: string[];
  /** Human-readable reasons the command cannot run, in addition to diagnostics. */
  unsupported: string[];
  ignoredKeys: string[];
}

/** Finds prompt features Dext cannot reproduce. Commands stay inert prompt
 * templates: positional arguments, shell interpolation and variable expansion
 * would imply a runtime Dext does not have. */
export function unsupportedCommandFeatures(template: string): string[] {
  const reasons: string[] = [];
  if (/\$[1-9]/.test(template)) reasons.push("positional arguments ($1-$9) are not supported");
  if (/\$\(|\$\{/.test(template)) reasons.push("shell or variable expansion is not supported");
  if (/^\s*!\s+\S/m.test(template)) reasons.push("shell execution (!) is not supported");
  return reasons;
}

export function parseCommandSource(id: string, source: string): ParsedSkillCommand {
  const metadata = parseCommandMetadata(source);
  const diagnostics = [...metadata.diagnostics];
  if (!isSkillCommandId(id)) diagnostics.push(`Invalid command id '${String(id)}'.`);
  if (!metadata.body) diagnostics.push("Command has no prompt body.");
  if (metadata.skillId && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(metadata.skillId)) {
    diagnostics.push(`Invalid skill reference '${metadata.skillId}'.`);
  }
  const unsupported = unsupportedCommandFeatures(metadata.body);
  const title = /^#\s+(.+)$/m.exec(metadata.body)?.[1]?.trim() ?? metadata.description ?? id;
  const description = metadata.description
    ?? metadata.body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"))
    ?? "";
  return {
    id,
    title,
    description,
    ...(metadata.skillId ? { skillId: metadata.skillId } : {}),
    ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
    template: metadata.body,
    supported: diagnostics.length === 0 && unsupported.length === 0,
    diagnostics: [...diagnostics, ...unsupported.map((reason) => `Unsupported command syntax: ${reason}.`)],
    unsupported,
    ignoredKeys: metadata.ignoredKeys
  };
}

/** Expands the single supported placeholder. A template without `$ARGUMENTS`
 * receives the user's text appended, which matches how slash commands behave
 * elsewhere and keeps command authors from needing a placeholder. */
export function expandCommandArguments(template: string, args: string): string {
  const value = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", value).trim();
  return value ? `${template.trim()}\n\n${value}` : template.trim();
}

export function resolvedCommand(
  command: {
    id: string;
    title: string;
    description: string;
    skillId: string;
    packId?: string;
    packName?: string;
  },
  template: string,
  args: string
): Extract<SkillCommandResolution, { status: "ok" }> {
  return {
    status: "ok",
    command: {
      id: command.id,
      title: command.title,
      description: command.description,
      skillId: command.skillId,
      ...(command.packId ? { packId: command.packId } : {}),
      ...(command.packName ? { packName: command.packName } : {}),
      template,
      instruction: expandCommandArguments(template, args),
      arguments: args.trim()
    }
  };
}
