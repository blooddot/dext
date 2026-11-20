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

async function commitSpec(change: string): Promise<AgentResult> {
  return agent({
    input: `将 OpenSpec change \`${change}\` 对应的工作区改动提交为一个 Conventional Commit。`,
    patch: false,
    rules: ["git/commit-spec.md"],
    echo: true
  });
}

/** 按功能拆分当前工作区的改动。`input` 可提供额外要求。 */
export function commit(input?: string): Promise<AgentResult>;
/**
 * 将指定 OpenSpec change 对应的工作区改动提交为一个 commit。
 * @param change 原 change 名称或完整归档目录名，例如 `2026-11-20-unify-ui-primitives`。
 */
export function commit(mode: "spec", change: string): Promise<AgentResult>;
export async function commit(input = "", change?: string): Promise<AgentResult> {
  if (arguments.length < 2) return await commitChanges(input);

  if (arguments.length !== 2 || input !== "spec") {
    throw new Error('按 OpenSpec change 提交时，请使用 commit("spec", change)。');
  }
  if (typeof change !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change)) {
    throw new Error("请提供有效的 OpenSpec change 名称，例如 add-video-export。");
  }

  return await commitSpec(change);
}
