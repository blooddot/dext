import { agent, type AgentResult } from "dext";

/** Default request when the caller only selects the API. */
const DEFAULT_TASK = "先审查当前工作区变更，只修复 Critical 与 High，其余条目只列出。";

/**
 * Fix the Critical and High findings, list the rest. Code only: it never edits
 * `openspec/` or `tasks.md`, and reports instead when a fix would change a spec
 * Requirement. Writes directly, so a `git.review` afterwards is the check.
 * @param input A `git.review` report, one finding, or a custom fix request.
 */
async function fixFinding(input: string): Promise<AgentResult> {
  return agent({
    input: input || DEFAULT_TASK,
    patch: false,
    rules: ["git/fix.md"],
    echo: true
  });
}

export async function fix(input = ""): Promise<AgentResult> {
  return await fixFinding(input);
}
