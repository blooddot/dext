import { agent, skill, terminal, type SkillResult } from "dext";

/** The skill ids come from the pack in `.dext/skill-packs/openspec`; keeping them
 * here is what makes the menu and the completions carry them instead of your
 * memory. */

/** Dirty-or-untracked paths in the workspace, as git sees them.
 * `AgentResult.files` is model-authored: `patch: false` means the host never sees
 * what the CLI wrote, so a run that produced nothing can still list paths and a
 * run that produced everything can list none. `git status --porcelain -uall` is
 * the host reading the disk instead of trusting the report. `undefined` means the
 * workspace is not a git work tree, or git is missing, and the extra section is
 * skipped rather than failing the call. */
async function dirtyPaths(): Promise<Set<string> | undefined> {
  const status = await terminal({ command: "git status --porcelain -uall" });
  if (status.exit_code !== 0) return undefined;
  const paths = new Set<string>();
  for (const line of status.stdout.split("\n")) {
    // `XY <path>`, or `XY <old> -> <new>` for a rename: the name that is dirty now
    // is the one on the right.
    const entry = line.slice(3).trim();
    if (entry) paths.add(entry.split(" -> ").pop()!);
  }
  return paths;
}

/**
 * A skill that must create or edit files. `skill()` runs every call with
 * `allowWorkspaceWrite: false` (only the `agent` API enables writes), so a skill
 * that has to run `openspec new change` or write artifacts comes back as prose
 * and nothing reaches the disk. `agent()` loads the very same SKILL.md through
 * its `skills` argument and runs with the selected write scope, so the skill
 * executes instead of describing what it would do. The result keeps the
 * `{ kind: "skill", text }` shape callers already handle, and appends the paths
 * that git only now considers dirty — the answer to "did anything reach the
 * disk?". Paths that were already dirty before the run are reported separately:
 * git cannot attribute their changes to this run, so listing them as new would be
 * a lie and hiding them would look like nothing happened.
 */
async function runWriting(id: string, input: string): Promise<SkillResult> {
  const before = await dirtyPaths();
  const result = await agent({ input, skills: [id], apply: true, patch: false });
  const after = await dirtyPaths();
  if (!before || !after) return { kind: "skill", text: result.text };
  const added = [...after].filter((path) => !before.has(path)).sort();
  const preexisting = [...before].filter((path) => after.has(path)).length;
  const sections = [result.text];
  sections.push(added.length
    ? `Files changed:\n${added.map((path) => `- ${path}`).join("\n")}`
    : "Files changed: none — no file entered or left git's dirty set during this run.");
  if (preexisting) {
    sections.push(`(${preexisting} other path(s) were already dirty before the run, so their changes cannot be attributed to it.)`);
  }
  return { kind: "skill", text: sections.join("\n\n") };
}

/** A skill whose contract is to write nothing: the read-only path is the right
 * one, and it is also the cheapest — no write scope, no patch. */
function runReading(id: string, input: string): Promise<SkillResult> {
  return skill({ skill: id, input });
}

/** `change` is the name the skill's commands take as `--change "<name>"`. It
 * travels as its own line so the model never has to pick a name out of prose. */
function describeChange(change: string, input = ""): string {
  return [change === "" ? "" : `Change: ${change}`, input]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Plan a change: proposal, spec delta, design and tasks. Writes only
 * `openspec/changes/<name>/`, never code.
 * @param input What you want to build or fix.
 */
function propose(input = ""): Promise<SkillResult> {
  return runWriting("openspec-propose", input);
}

/**
 * Implement an existing change by working through its tasks.
 * @param change The change to apply, e.g. "add-video-export".
 */
function apply(change: string): Promise<SkillResult> {
  return runWriting("openspec-apply-change", describeChange(change));
}

/**
 * Merge a finished change's delta into `openspec/specs` and archive it.
 * @param change The change to archive.
 */
function archive(change: string): Promise<SkillResult> {
  return runWriting("openspec-archive-change", describeChange(change));
}

/**
 * Read the specs and the code and answer a question. Writes nothing.
 * @param input The question to explore.
 */
function explore(input = ""): Promise<SkillResult> {
  return runReading("openspec-explore", input);
}

/**
 * Revise a change that is still being planned.
 * @param change The change to revise.
 * @param input What to change about the plan.
 */
function update(change: string, input = ""): Promise<SkillResult> {
  return runWriting("openspec-update-change", describeChange(change, input));
}

/**
 * Realign `openspec/specs` with what the code now does.
 * @param change The change whose delta to sync, or nothing for every active change.
 */
function sync(change = ""): Promise<SkillResult> {
  return runWriting("openspec-sync-specs", describeChange(change));
}

export const spec = { propose, apply, archive, explore, update, sync };
