import type { SkillResult } from "dext";
import { displayResult, nextStep, openChanges, runWriting, specCall, unresolved, type SpecScope } from "./shared.ts";

/**
 * Plan a change: proposal, spec delta, design and tasks. Writes only
 * `openspec/changes/<name>/`, never code.
 * @param input What you want to build or fix.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function propose(input = "", scope: SpecScope = {}): Promise<SkillResult> {
  const result = await runWriting("openspec-propose", input, scope,
    "规划产物齐备后，按所选 OpenSpec store 运行严格校验并报告结果。只有本轮 new change 成功创建了该变更且规划检查通过时，才报告 completed。");
  const outcome = result.outcome;
  const selected = outcome?.scope;
  let next = unresolved(outcome, "尚未确认本轮提案已创建并通过检查，请查看 Agent 说明。");
  if (outcome?.status === "completed" && selected && outcome.change) {
    const change = (await openChanges(selected))?.find((entry) => entry.name === outcome.change);
    if (change) next = (change.totalTasks ?? 0) > 0
      ? nextStep(`${specCall("apply", selected, change.name)} —— 审阅本轮规划产物并确认方案后运行。`)
      : nextStep(`${specCall("update", selected, change.name, "…")} —— 补齐任务清单后再实施。`);
  }
  return displayResult(result, "OpenSpec 提案结果", next);
}
