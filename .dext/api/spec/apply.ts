import type { SkillResult } from "dext";
import {
  describeChange, displayResult, hasScope, isExistingChangeName, nextStep, openSpecJson, openspecCommand, resolvedScope,
  runWriting, specCall, unresolved, unverifiedScope, type SpecRoot, type SpecScope, type WritingResult
} from "./shared.ts";

interface ApplyTask {
  id: string;
  description: string;
  done: boolean;
  sourcePath?: string;
}

interface ApplyInstructions {
  tasks: ApplyTask[];
  state: "ready" | "blocked" | "all_done";
  instruction?: string;
  root: SpecRoot;
  cwd: string;
}

/** Use the CLI's task list so custom schemas and human acceptance stay out of the count. */
async function applyInstructions(change: string, scope: SpecScope, verified = false): Promise<ApplyInstructions | undefined> {
  if (!isExistingChangeName(change)) return undefined;
  const result = await openSpecJson(`instructions apply --change "${change}" --json`, scope);
  if (verified && (result?.cwd !== scope.cwd || (result?.root.store_id ?? undefined) !== scope.store)) return undefined;
  const data = result?.data as (ApplyInstructions & { changeName?: unknown }) | undefined;
  if (result?.exitCode === 0 && data?.changeName === change &&
    (data.state === "ready" || data.state === "blocked" || data.state === "all_done") && Array.isArray(data.tasks) && data.tasks.every((task) =>
    typeof task?.id === "string" && typeof task.description === "string" && typeof task.done === "boolean" &&
    (task.sourcePath === undefined || typeof task.sourcePath === "string"))) {
    return { ...data, cwd: result.cwd, instruction: typeof data.instruction === "string" ? data.instruction : undefined };
  }
  return undefined;
}

function taskLabel(task: ApplyTask): string {
  return task.description.replace(/\s+verify:\s+.*$/is, "").replace(/\s+/g, " ").trim();
}

/** Use the CLI state to guide the next step and retain its completion instructions. */
function applyNext(change: string, scope: SpecScope, instructions: ApplyInstructions | undefined): string {
  const applyAgain = specCall("apply", scope, change);
  const status = `在 OpenSpec 根目录 \`${scope.root}\` 运行 \`${openspecCommand(`status --change "${change}" --json`, scope)}\``;
  if (!instructions) {
    return nextStep(`${status}，确认状态后再决定是否继续 ${applyAgain}。`);
  }
  if (instructions.state === "all_done") {
    return nextStep(...[
      instructions.instruction,
      `完成审查或验证及变更要求的人工验收后，运行 ${specCall("archive", scope, change)}。`
    ].filter((line): line is string => Boolean(line?.trim())));
  }
  if (instructions.state === "blocked") {
    return nextStep(
      `${status}，用 ${specCall("update", scope, change, "…")} 补齐缺失产物后重跑 ${applyAgain}。`);
  }
  const next = instructions.tasks.find((task) => !task.done);
  return nextStep(next
    ? `${applyAgain} —— 从「${taskLabel(next)}」继续；中断后重跑同一条命令即可，不用做别的决定。`
    : `${applyAgain} —— 再跑一次，OpenSpec 会重新报出第一项未完成的任务。`);
}

function applyProgress(before: ApplyTask[] | undefined, after: ApplyTask[] | undefined, reason = ""): string {
  const heading = "### OpenSpec 实施进度";
  if (!after) return [heading, reason, "未能从 OpenSpec 核实任务进度。"].filter(Boolean).join("\n\n");

  const total = after.length;
  const completed = after.filter((task) => task.done).length;
  const next = after.find((task) => !task.done);
  const start = before ? `开始时 ${before.filter((task) => task.done).length}/${before.length}，结束时 ` : "";
  const progress = `${completed}/${total} 项已勾选，剩余 ${total - completed} 项。`;
  const sections = [heading, `${start}${progress}`, reason];
  if (before) {
    const taskKey = (task: ApplyTask) => JSON.stringify([task.sourcePath, task.description]);
    const keys = before.map(taskKey);
    // OpenSpec IDs are positional. Only attribute changes in a stable, unambiguous list.
    if (keys.length === after.length && new Set(keys).size === keys.length &&
        after.every((task, index) => taskKey(task) === keys[index])) {
      const newlyCompleted = after.filter((task, index) => task.done && !before[index]!.done);
      sections.push(newlyCompleted.length
        ? `本轮新增勾选\n\n${newlyCompleted.map((task) => `- ${taskLabel(task)}`).join("\n")}`
        : "本轮没有新增勾选的任务。");
    } else {
      sections.push("任务清单发生变化或存在重复描述，本轮仅显示总进度。");
    }
  }
  sections.push(next ? `实施尚未完成。下一项是 ${taskLabel(next)}` : total ? "开发任务已全部勾选。" : "当前没有开发任务。");
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Implement an existing change by working through its tasks.
 * @param change The change to apply, e.g. "add-video-export".
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function apply(change: string, scope: SpecScope = {}): Promise<SkillResult> {
  const before = await applyInstructions(change, scope);
  const explicit = hasScope(scope);
  if (explicit && !before) {
    return displayResult(unverifiedScope(), "OpenSpec 实施受阻", nextStep("核对调用参数后重新运行。"));
  }
  const verified = explicit && before ? resolvedScope(before) : undefined;
  let result: WritingResult;
  try {
    result = await runWriting("openspec-apply-change", describeChange(change), scope,
      "请报告本轮实际实施的变更。因用户确认或阻塞而暂停时，保留对应状态。", verified);
  } catch (error) {
    const after = verified ? await applyInstructions(change, verified, true) : undefined;
    console.log(applyProgress(verified ? before?.tasks : undefined, after?.tasks, "实施执行出错，请查看本轮错误。"));
    throw error;
  }
  const outcome = result.outcome;
  const selected = verified ?? (outcome?.change === change ? outcome.scope : undefined);
  const after = selected ? await applyInstructions(change, selected, !!verified) : undefined;
  // The initial lookup can resolve the default root before the skill selects a store.
  const sameRoot = before && after && before.root.path === after.root.path && (before.root.store_id ?? null) === (after.root.store_id ?? null);
  const reason = after?.state === "blocked" ? ["OpenSpec 报告实施受阻。", after.instruction].filter(Boolean).join("\n\n") : "";
  const next = selected && outcome?.status !== "pending"
    ? outcome?.status === "blocked" && after?.state !== "blocked"
      ? nextStep("先处理 Agent 说明中的阻塞，再继续实施。")
      : applyNext(change, selected, after)
    : unresolved(outcome, "未能核实本轮实施范围，请查看 Agent 说明。");
  const text = [applyProgress(sameRoot ? before.tasks : undefined, after?.tasks, reason), `### Agent 执行说明\n\n${result.text}`, next].join("\n\n");
  console.log(text);
  return { kind: "skill", text };
}
