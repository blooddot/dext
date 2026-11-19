import { skill, type SkillResult } from "dext";

type ReviewKind = "workspace" | "commit" | "range";

function reviewScope(kind: ReviewKind, first?: string, second?: string): string {
  if (kind !== "workspace" && kind !== "commit" && kind !== "range") {
    throw new Error(`Unsupported review kind '${String(kind)}'.`);
  }

  if (kind === "workspace") {
    if (first !== undefined || second !== undefined) throw new Error("workspace review does not accept ref arguments.");
    return "审查当前 Git 工作区变更。";
  }

  const ref = first?.trim();
  if (!ref) throw new Error(`${kind} review requires a ref.`);

  if (kind === "commit") {
    if (second !== undefined) throw new Error("commit review accepts exactly one commit ref.");
    return `审查 commit ${ref}。`;
  }

  return `审查 ${ref} 到 ${second?.trim() || "HEAD"} 的分支差异。`;
}

async function runReview(scope: string): Promise<SkillResult> {
  return await skill({
    skill: "open-code-review-delegate",
    apply: true,
    input: [
      scope,
      "只读审查，不修改文件，不提交代码。",
      "覆盖所有 reviewable_files，按 severity 和 category 输出结果，并报告审查覆盖率。",
      "命令返回的 JSON 仅供内部处理，最终 SkillResult.text 必须是 Markdown 审查报告，不要原样返回 JSON。",
      "报告的每条问题描述与建议必须使用简体中文，不要翻译标题、文件路径、命令和代码。"
    ].join("\n"),
    echo: true
  });
}

export function review(kind: "workspace"): Promise<SkillResult>;
export function review(kind: "commit", commit: string): Promise<SkillResult>;
export function review(kind: "range", from: string, to?: string): Promise<SkillResult>;
export async function review(kind: ReviewKind, first?: string, second?: string): Promise<SkillResult> {
  return await runReview(reviewScope(kind, first, second));
}
