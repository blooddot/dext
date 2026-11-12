import { agent, type AgentResult } from "dext";

/** Default request when the caller only selects the API. */
const DEFAULT_TASK = "请整理当前工作区的改动，按功能创建独立的 Conventional Commit。";

/**
 * Split current changes into one Conventional Commit per feature.
 * @param input Additional requirements for this run.
 */
async function commitChanges(input: string): Promise<AgentResult> {
  return agent({
    input: input || DEFAULT_TASK,
    patch: false,
    rules: ["git/commit.md"],
    echo: true
  });
}

export async function commit(input = ""): Promise<AgentResult> {
  return await commitChanges(input);;
}
