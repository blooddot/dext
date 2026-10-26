import type { SkillCommandSummary, SkillSummary } from "../../workflow/contracts/skill.js";
import { dedupeSkillIds, MAX_SELECTED_SKILLS } from "../domain/agentSelection.js";

export type PackCheckState = "checked" | "mixed" | "unchecked";

/** One pack (or the ungrouped skills) as the composer tree renders it. */
export interface SkillSelectionGroup {
  /** `undefined` for skills that no pack declared. */
  packId?: string;
  name: string;
  skills: SkillSummary[];
  commands: SkillCommandSummary[];
}

export function groupSkills(
  skills: readonly SkillSummary[],
  commands: readonly SkillCommandSummary[]
): SkillSelectionGroup[] {
  const groups = new Map<string, SkillSelectionGroup>();
  for (const skill of [...skills].sort((left, right) => left.id.localeCompare(right.id))) {
    const key = skill.packId ?? "";
    const group = groups.get(key) ?? {
      ...(skill.packId ? { packId: skill.packId } : {}),
      name: skill.packName ?? skill.packId ?? "Skills",
      skills: [],
      commands: []
    };
    group.skills.push(skill);
    groups.set(key, group);
  }
  for (const command of commands) {
    const group = groups.get(command.packId ?? "")
      ?? [...groups.values()].find((item) => item.skills.some((skill) => skill.id === command.skillId));
    if (group) group.commands.push(command);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.packId && !right.packId) return -1;
    if (!left.packId && right.packId) return 1;
    return left.name.localeCompare(right.name);
  });
}

export function packCheckState(packSkillIds: readonly string[], selected: readonly string[]): PackCheckState {
  if (!packSkillIds.length) return "unchecked";
  const chosen = new Set(selected);
  const count = packSkillIds.filter((id) => chosen.has(id)).length;
  return count === 0 ? "unchecked" : count === packSkillIds.length ? "checked" : "mixed";
}

/** Returns the new selection after a pack checkbox is toggled. Selecting a
 * pack selects every skill in it; clearing it clears only its own skills. */
export function togglePack(selected: readonly string[], packSkillIds: readonly string[], next: boolean): string[] {
  if (next) {
    return dedupeSkillIds([...selected, ...packSkillIds]).slice(0, MAX_SELECTED_SKILLS);
  }
  const remove = new Set(packSkillIds);
  return selected.filter((id) => !remove.has(id));
}

export function toggleSkill(selected: readonly string[], skillId: string): string[] {
  return selected.includes(skillId)
    ? selected.filter((id) => id !== skillId)
    : dedupeSkillIds([...selected, skillId]);
}

/** Commands the slash menu may offer for the current skill selection. */
export function commandsForSelection(
  commands: readonly SkillCommandSummary[],
  selected: readonly string[]
): SkillCommandSummary[] {
  const chosen = new Set(selected);
  return commands.filter((command) => chosen.has(command.skillId));
}

export function selectionLabel(selected: readonly string[]): string {
  return selected.length ? `${selected.length} skill${selected.length === 1 ? "" : "s"}` : "No skills";
}

/** The slash menu appears only while the first token on the line is the
 * command itself; a slash inside prose or arguments is ordinary text. */
export function isSlashCommandPrefix(text: string): boolean {
  return /^\/[A-Za-z0-9_.-]*$/.test(text);
}

export { dedupeSkillIds };
