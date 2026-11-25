import type { SkillResult } from "dext";
import { describeChange, displayResult, nextStep, openSpecJson, runWriting, specCall, unresolved, type SpecScope } from "./shared.ts";

/**
 * Realign `openspec/specs` with what the code now does.
 * @param change The change whose delta to sync, or omit to let the skill select it.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function sync(change = "", scope: SpecScope = {}): Promise<SkillResult> {
  const result = await runWriting("openspec-sync-specs", describeChange(change), scope,
    "只有所选变更的增量规格已同步且主规格校验通过时才报告 completed。");
  const outcome = result.outcome;
  const selected = outcome?.scope;
  const synced = outcome?.change;
  let next = unresolved(outcome, "同步结果尚未确认，请查看 Agent 说明。");
  if (outcome?.status === "completed" && selected && synced && (!change || change === synced)) {
    const validation = await openSpecJson("validate --specs --json", selected);
    const items = validation?.data.items as Array<{ valid?: boolean }> | undefined;
    if (validation && Array.isArray(items) && items.every((item) => typeof item?.valid === "boolean")) {
      next = validation.exitCode === 0 && items.every((item) => item.valid)
        ? nextStep(`${specCall("archive", selected, synced)} —— 规格已同步且主规格校验通过，可以归档。`)
        : nextStep("主规格校验未通过。先处理校验问题，再重新同步。");
    } else {
      next = nextStep("主规格校验结果未知，请在所选 OpenSpec 根目录核对。");
    }
  }
  return displayResult(result, "OpenSpec 规格同步", next);
}
