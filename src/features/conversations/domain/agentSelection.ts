import type { AgentSelection } from "../../agents/contracts/agent.js";
import { isSkillId } from "../../workflow/contracts/skill.js";

/** A conversation may select at most this many skills. The cap bounds the
 * prompt prefix and the composer menu at the same time. */
export const MAX_SELECTED_SKILLS = 64;

/** Trims, validates, dedupes and caps a selection list. Unknown ids are not
 * rejected here: the host cross-checks them against the installed catalog. */
export function dedupeSkillIds(values: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const id = value.trim();
    if (!isSkillId(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length >= MAX_SELECTED_SKILLS) break;
  }
  return next;
}

/** Normalizes a persisted or incoming selection so a legacy tab without
 * `skills` keeps reading exactly as before. */
export function normalizeAgentSelection(selection: AgentSelection): AgentSelection {
  const skills = dedupeSkillIds(selection.skills);
  const { skills: _ignored, ...rest } = selection;
  void _ignored;
  return skills.length ? { ...rest, skills } : rest;
}

/** A new tab starts with no skills: the user opts in for every conversation. */
export function withoutSkills(selection: AgentSelection): AgentSelection {
  const { skills: _ignored, ...rest } = selection;
  void _ignored;
  return rest;
}
