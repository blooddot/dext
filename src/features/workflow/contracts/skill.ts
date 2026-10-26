/** Browser-safe skill and command contracts. Nothing here may import Node,
 * VS Code or any host module: the composer bundle renders these shapes. */

/** A skill directory name. It is also the id the composer selects and the
 * `/command` namespace prefix. */
export const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const SKILL_ID_MAX_LENGTH = 64;

/** A command name without the leading slash and without the pack namespace. */
export const SKILL_COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const SKILL_COMMAND_ID_MAX_LENGTH = 64;

export function isSkillId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= SKILL_ID_MAX_LENGTH
    && SKILL_ID_PATTERN.test(value);
}

export function isSkillCommandId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= SKILL_COMMAND_ID_MAX_LENGTH
    && SKILL_COMMAND_ID_PATTERN.test(value);
}

/** The canonical spelling of a command in the composer. Accepts `id`, `/id`,
 * `  /id` and returns `/id`; any other shape is rejected. A command is only
 * recognised at the start of the input, because a slash inside prose is not an
 * invocation. */
export function canonicalCommandToken(value: string): string | undefined {
  const match = /^\s*\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s|$)/.exec(value);
  return match && isSkillCommandId(match[1]) ? `/${match[1]}` : undefined;
}

export function skillCommandSyntax(id: string): string {
  return isSkillCommandId(id) ? `/${id}` : "";
}

/** Discovery output for one installed skill. Source paths deliberately stay on
 * the host: the composer only needs ids, labels and pack membership. */
export interface SkillSummary {
  id: string;
  title: string;
  description: string;
  /** Automatically resolved for the current Input Agent. */
  variant?: string;
  available?: boolean;
  /** Present when `.dext/skill-packs/<pack>/pack.json` declared this skill. */
  packId?: string;
  packName?: string;
  /** Ids of commands whose skill is this skill and which the host can run. */
  commandIds: string[];
}

/** A command the composer may offer once its skill is selected. */
export interface SkillCommandSummary {
  id: string;
  title: string;
  description: string;
  /** The skill that makes this command runnable. */
  skillId: string;
  packId?: string;
  packName?: string;
  argumentHint?: string;
  syntax: string;
}

/** A command resolved for execution. The body is a prompt template, never
 * shell: unsupported syntax keeps the command out of the catalog. */
export interface ResolvedSkillCommand {
  id: string;
  title: string;
  description: string;
  skillId: string;
  packId?: string;
  packName?: string;
  /** The raw command template with `$ARGUMENTS` still in place. */
  template: string;
  /** The template after `$ARGUMENTS` expansion, ready for the turn. */
  instruction: string;
  /** The arguments after the command token, trimmed. */
  arguments: string;
}

export type SkillCommandResolution =
  | { status: "ok"; command: ResolvedSkillCommand }
  | { status: "inactive"; command: SkillCommandSummary }
  | { status: "invalid"; id: string; reason: string }
  | { status: "unknown"; id: string };

/** Splits the first `/command` token from the rest of the composer input. */
export function splitCommandInput(input: string): { token: string; commandId: string; arguments: string } | undefined {
  const match = /^\s*\/([A-Za-z0-9][A-Za-z0-9_.-]*)(?=\s|$)/.exec(input);
  if (!match || !isSkillCommandId(match[1])) return undefined;
  return {
    token: `/${match[1]}`,
    commandId: match[1],
    arguments: input.slice(match[0].length).trim()
  };
}
