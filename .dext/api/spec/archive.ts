import { ui, type SkillResult } from "dext";
import {
  describeChange, displayResult, nextStep, openChanges, openSpecJson, resolvedScope, runWriting, specCall,
  unresolved, type SpecChange, type SpecScope, type WritingResult
} from "./shared.ts";

const archiveActions = {
  artifacts: [{ id: "continue", label: "继续归档检查" }],
  tasks: [{ id: "continue", label: "继续归档检查" }],
  sync_needed: [{ id: "sync", label: "同步后归档（推荐）" }, { id: "skip", label: "跳过同步，直接归档" }],
  already_synced: [{ id: "archive", label: "直接归档" }, { id: "sync", label: "重新同步后归档" }],
  sync_blocked: [{ id: "skip", label: "跳过同步，直接归档" }]
} as const;

type ArchivePrompt = { kind: keyof typeof archiveActions; summary: string };

function parseArchivePrompt(value: unknown): ArchivePrompt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, summary } = value as Record<string, unknown>;
  if (typeof kind === "string" && Object.hasOwn(archiveActions, kind) && typeof summary === "string" && summary.trim()) {
    return { kind: kind as ArchivePrompt["kind"], summary: summary.trim().slice(0, 20000) };
  }
  return undefined;
}

function newest(changes: SpecChange[] | undefined): SpecChange | undefined {
  return changes?.slice().sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))[0];
}

function changeProgress(change: SpecChange): string {
  const total = change.totalTasks ?? 0;
  return total > 0 ? `${change.completedTasks ?? 0}/${total} 项已勾选` : "还没有任务清单";
}

/**
 * Merge a finished change's delta into `openspec/specs` and archive it.
 * @param change The change to archive.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
export async function archive(change: string, scope: SpecScope = {}): Promise<SkillResult> {
  const confirmations: { kind: ArchivePrompt["kind"]; action: string; summary: string }[] = [];
  let selectedScope = scope;
  let result: WritingResult;
  for (;;) {
    result = await runWriting("openspec-archive-change", describeChange(change), selectedScope, [
      "只有本轮成功移动变更目录才报告 completed，同时追加 archiveName（实际归档目录名，不含路径）。",
      "归档确认由 Dext API 弹窗收集。遇到未经确认的步骤时，先说明发现，再报告 pending，追加 archivePrompt 对象（kind 和简体中文纯文本 summary）。等待确认期间不要同步或移动目录。",
      "kind 为 artifacts（产物未齐）、tasks（任务未完成）、sync_needed（需要同步）、already_synced（已同步）或 sync_blocked（同步受阻）。summary 列出该步的警告或各规格的同步评估。",
      `本次 API 调用中用户已提交的确认 ${JSON.stringify(confirmations)}。重新检查选定变更和范围，仅在确认项及其条件仍相符时使用该选择。continue 表示通过该步的警告并继续检查，sync 表示执行并验证同步后归档，skip 表示跳过同步后归档，archive 表示已同步时直接归档。`
    ].join("\n"));
    const outcome = result.outcome;
    if (outcome?.status !== "pending" || outcome.change !== change || !outcome.scope) break;
    const prompt = parseArchivePrompt(outcome.archivePrompt);
    if (!prompt) break;
    const { kind, summary } = prompt;
    if (confirmations.some((confirmation) => confirmation.kind === kind)) break;

    const checked = await openSpecJson("list --json", outcome.scope);
    if (checked?.exitCode !== 0 || !Array.isArray(checked.data.changes) ||
        !checked.data.changes.some((entry: SpecChange | null) => entry?.name === change)) break;

    const actions = archiveActions[kind];
    const reply = await ui.form({
      title: `归档 ${change}`,
      description: summary,
      fields: [],
      actions: [...actions],
      cancel_label: "取消",
      on_cancel: "return",
      presentation: "dialog"
    });
    if (reply.status !== "submitted" || !actions.some(({ id }) => id === reply.action)) {
      return displayResult({ kind: "skill", text: "已取消归档。" }, "OpenSpec 归档结果", nextStep("需要归档时可重新运行原调用。"));
    }
    confirmations.push({ kind, action: reply.action, summary });
    selectedScope = resolvedScope(checked);
  }
  const outcome = result.outcome;
  const selected = outcome?.change === change ? outcome.scope : undefined;
  const changes = selected ? await openChanges(selected, true) : undefined;
  const active = changes?.filter((entry) => !entry.archived);
  const archiveName = outcome?.archiveName;
  const datePrefix = /^\d{4}-\d{2}-\d{2}-/;
  const matchesTarget = archiveName && datePrefix.test(archiveName) &&
    (datePrefix.test(change) ? archiveName === change : archiveName.slice(11) === change);
  let next: string;
  if (outcome?.status === "pending") {
    next = nextStep("归档确认未能完成，请查看 Agent 说明后重新运行原调用。");
  } else if (active?.some((entry) => entry.name === change)) {
    next = nextStep(`${change} 仍在活跃变更中。请处理 Agent 说明中的确认事项或阻塞。`);
  } else if (selected && outcome?.status === "completed" && matchesTarget &&
      changes?.some((entry) => entry.archived && entry.name === archiveName)) {
    const remaining = newest(active);
    next = remaining
      ? nextStep(`${specCall("apply", selected, remaining.name)} —— 还有活跃变更 ${remaining.name}（${changeProgress(remaining)}）。`)
      : nextStep(`活跃变更已清空。要开新变更时用 ${specCall("propose", selected, "…")}。`);
  } else {
    next = unresolved(outcome, "归档状态未知，请核对 Agent 说明和所选 OpenSpec 根目录中的归档记录。");
  }
  return displayResult(result, "OpenSpec 归档结果", next);
}
