import { describe, expect, it } from "vitest";
import {
  commandsForSelection,
  dedupeSkillIds,
  groupSkills,
  isSlashCommandPrefix,
  packCheckState,
  selectionLabel,
  togglePack,
  toggleSkill
} from "../src/features/conversations/browser/skillSelection.js";
import type { SkillCommandSummary, SkillSummary } from "../src/features/workflow/contracts/skill.js";

const skill = (id: string, packId?: string): SkillSummary => ({
  id, title: id, description: `${id} description`, commandIds: [],
  ...(packId ? { packId, packName: packId } : {})
});
const command = (id: string, skillId: string, packId?: string): SkillCommandSummary => ({
  id, title: id, description: "", skillId, syntax: `/${id}`,
  ...(packId ? { packId, packName: packId } : {})
});

describe("skill selection tree", () => {
  it("groups packs before ungrouped skills and attaches their commands", () => {
    const groups = groupSkills(
      [skill("loose"), skill("review", "ponytail"), skill("audit", "ponytail")],
      [command("review", "review", "ponytail"), command("loose-command", "loose")]
    );
    expect(groups.map((group) => [group.packId, group.name, group.skills.map((item) => item.id)])).toEqual([
      ["ponytail", "ponytail", ["audit", "review"]],
      [undefined, "Skills", ["loose"]]
    ]);
    expect(groups[0]?.commands.map((item) => item.id)).toEqual(["review"]);
    expect(groups[1]?.commands.map((item) => item.id)).toEqual(["loose-command"]);
  });

  it("computes tri-state packs and toggles every member", () => {
    expect(packCheckState(["a", "b"], [])).toBe("unchecked");
    expect(packCheckState(["a", "b"], ["a"])).toBe("mixed");
    expect(packCheckState(["a", "b"], ["a", "b"])).toBe("checked");
    expect(togglePack(["x"], ["a", "b"], true)).toEqual(["x", "a", "b"]);
    expect(togglePack(["x", "a", "b"], ["a", "b"], false)).toEqual(["x"]);
    expect(toggleSkill(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleSkill(["a", "b"], "a")).toEqual(["b"]);
  });

  it("dedupes, caps and labels the selection", () => {
    expect(dedupeSkillIds(["a", "a", " bad/id ", "b"])).toEqual(["a", "b"]);
    expect(dedupeSkillIds(Array.from({ length: 70 }, (_, index) => `skill-${index}`))).toHaveLength(64);
    expect(selectionLabel([])).toBe("No skills");
    expect(selectionLabel(["a"])).toBe("1 skill");
    expect(selectionLabel(["a", "b"])).toBe("2 skills");
    const skills = [skill("review", "ponytail"), skill("audit", "ponytail"), skill("loose")];
    expect(selectionLabel(["review"], skills)).toBe("review");
    expect(selectionLabel(["review", "audit"], skills)).toBe("2 ponytail");
    expect(selectionLabel(["review", "loose"], skills)).toBe("2 skills");
    expect(selectionLabel(["loose", "gone"], skills)).toBe("2 skills");
    expect(selectionLabel(["gone"], skills)).toBe("1 skill");
  });

  it("offers commands only for selected skills", () => {
    const commands = [command("review", "review"), command("deploy", "deploy")];
    expect(commandsForSelection(commands, ["review"]).map((item) => item.id)).toEqual(["review"]);
    expect(commandsForSelection(commands, [])).toEqual([]);
  });

  it("recognizes only a first-token slash prefix", () => {
    expect(isSlashCommandPrefix("/")).toBe(true);
    expect(isSlashCommandPrefix("/ponytail-review")).toBe(true);
    expect(isSlashCommandPrefix("/review src/a.ts")).toBe(false);
    expect(isSlashCommandPrefix("please /review")).toBe(false);
    expect(isSlashCommandPrefix("/review/deeper")).toBe(false);
  });
});
