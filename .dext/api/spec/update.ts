import type { SkillResult } from "dext";
import { describeChange, displayResult, nextStep, runWriting, specCall, unresolved, type SpecScope } from "./shared.ts";

/**
 * Revise a change that is still being planned.
 * @param change The change to revise.
 * @param input What to change about the plan.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function update(change: string, input = "", scope: SpecScope = {}): Promise<SkillResult> {
  const request = describeChange(change, [input,
    "在最终说明开头明确写出当前状态（待确认、已写入、无需修改或阻塞）。如仍需确认，列出拟修订内容。"
  ].filter(Boolean).join("\n\n"));
  const result = await runWriting("openspec-update-change", request, scope, "只有修订已写入时才报告 completed。无需修改时用 unchanged。");
  const outcome = result.outcome;
  const next = outcome?.change === change && outcome.scope && (outcome.status === "completed" || outcome.status === "unchanged")
    ? nextStep(`${specCall("apply", outcome.scope, change)} —— 方案确认后开始实施。`)
    : unresolved(outcome, "尚未确认规划修订结果，请查看 Agent 说明。");
  return displayResult(result, "OpenSpec 规划修订", next);
}
