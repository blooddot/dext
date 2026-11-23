import { agent, type AgentResult } from "dext";
import { reviewState, type ReviewState } from "./review.ts";

/** 没有历史报告时的退路：这时 fix 只能自己先审一遍，代价是一次完整的审查。 */
const DEFAULT_TASK =
  "先审查当前工作区变更，再按规则修复审查发现的问题。";

/** 报告再长也只取这一段：fix 需要的是条目，不是被截断到全空的任务描述。 */
const REPORT_CHAR_LIMIT = 24_000;

function limitReport(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REPORT_CHAR_LIMIT
    ? trimmed
    : `${trimmed.slice(0, REPORT_CHAR_LIMIT)}\n…（已截断，原文 ${trimmed.length} 字符；需要全部条目时用 review("workspace", true) 重新生成报告）`;
}

/** 把上一轮报告变成一次「只修这些」的任务，而不是让它从零再审一遍整份 diff。 */
function composeReportTask(state: ReviewState): string {
  const repeat = state.fixRuns === 0
    ? ""
    : `这份报告已经跑过 ${state.fixRuns} 次 fix：先看工作区里前几次留下的改动，已修好的不要重复改。`;
  return [
    `按规则处理下面这份 git.review 报告（第 ${state.round} 轮）里的问题。`,
    "范围以报告为准：报告没点到的文件不要动，不要重新审查整个工作区。",
    repeat,
    `## 第 ${state.round} 轮审查报告（${state.mode === "full" ? "全量" : "增量"}，复审 ${state.reviewed.length} 个文件）`,
    limitReport(state.report)
  ].filter((part) => part !== "").join("\n\n");
}

/**
 * Fix review findings within the scope set by `git/fix.md` or the caller's
 * explicit request. Code only: it never edits `openspec/` or `tasks.md`,
 * and reports instead when a fix would change a spec Requirement. Writes
 * directly, so a `git.review` afterwards is the check. With no input it consumes
 * the last `git.review` report instead of re-reviewing the whole workspace.
 * @param input A finding, a custom fix request, or `""` to use the last review report.
 */
async function fixFinding(input: string): Promise<AgentResult> {
  const explicit = input.trim() !== "";
  const previous = await reviewState.read();
  const report = explicit === false && previous !== null && previous.report.trim() !== "" ? previous : null;
  const before = await reviewState.snapshot().catch(() => null);

  if (explicit === false) {
    console.log(report === null
      ? "git.fix：没有历史审查报告，本轮按「先审查再修复」执行；这次改动会被下一轮 review 记为基线。"
      : `git.fix：读取第 ${report.round} 轮报告（复审 ${report.reviewed.length} 个文件，沿用 ${report.carried.length} 个），只修报告点到的问题。`);
  }

  const task = explicit ? input : report === null ? DEFAULT_TASK : composeReportTask(report);
  const result = await agent({ input: task, patch: false, rules: ["git/fix.md"], echo: true });

  await reviewState.markFixed(previous, before).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`git.fix：没能把本轮改动记进基线（${reason}）；下一轮 review 会按内容哈希重新判定。`);
  });
  return result;
}

export async function fix(input = ""): Promise<AgentResult> {
  return await fixFinding(input);
}
