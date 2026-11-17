import { skill, type SkillResult } from "dext";

/** The skill ids come from the pack in `.dext/skill-packs/openspec`; keeping them
 * here is what makes the menu and the completions carry them instead of your
 * memory. */
function run(id: string, input: string): Promise<SkillResult> {
  return skill({ skill: id, input });
}

/**
 * Plan a change: proposal, spec delta, design and tasks. Writes no code.
 * @param input What you want to build or fix.
 */
function propose(input = ""): Promise<SkillResult> {
  return run("openspec-propose", input);
}

/**
 * Implement an existing change by working through its tasks.
 * @param input The change to apply, plus any constraint for this run.
 */
function apply(input = ""): Promise<SkillResult> {
  return run("openspec-apply-change", input);
}

/**
 * Merge a finished change's delta into `openspec/specs` and archive it.
 * @param input The change to archive.
 */
function archive(input = ""): Promise<SkillResult> {
  return run("openspec-archive-change", input);
}

/**
 * Read the specs and the code and answer a question. Writes nothing.
 * @param input The question to explore.
 */
function explore(input = ""): Promise<SkillResult> {
  return run("openspec-explore", input);
}

/**
 * Revise a change that is still being planned.
 * @param input What to change about the plan.
 */
function update(input = ""): Promise<SkillResult> {
  return run("openspec-update-change", input);
}

/**
 * Realign `openspec/specs` with what the code now does.
 * @param input The scope to sync, or nothing for all of it.
 */
function sync(input = ""): Promise<SkillResult> {
  return run("openspec-sync-specs", input);
}

export const spec = { propose, apply, archive, explore, update, sync };
