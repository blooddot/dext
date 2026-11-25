import { agent, type AgentResult } from "dext";
import { reviewState } from "./review.ts";
import { findingList, FIX_DECISIONS, FIX_PATHS, readDecisions, readFixPaths, type ReviewFinding } from "./reviewFindings.ts";

function composeFindingsTask(findings: readonly ReviewFinding[]): string {
  return [
    "只修复下面列出的问题。先确认根因，按需修改相关代码和测试。不得扩大成一次新的工作区审查。",
    findingList(findings),
    `${FIX_PATHS}\n逐行列出你实际编辑的文件，格式为 - \`path\`，包括回归测试。没有改动时写（无）。`,
    `${FIX_DECISIONS}\n每个 ID 恰好一行，格式为 - \`ID\` | \`fixed\` | 验证命令与通过结果，或 - \`ID\` | \`open\` | 未修复的原因。确认问题已不存在且验证通过也可报 fixed。未通过验证、无法验证或需要修改 spec 时保留 open。`
  ].join("\n\n");
}

function stopFix(text: string): AgentResult {
  console.log(text);
  return { kind: "agent", text };
}

async function runFix(input: string): Promise<AgentResult> {
  return await agent({ input, patch: false, rules: ["git/fix.md"], echo: true });
}

/**
 * Fix review findings within the scope set by `git/fix.md` or the caller's
 * explicit request. Code only: it never edits `openspec/` or `tasks.md`,
 * and reports instead when a fix would change a spec Requirement. Writes
 * directly, so `git.review` verifies the results. With no input it uses the
 * outstanding blocking findings from the last workspace review.
 * @param input A finding ID, custom fix request, or `""` to use outstanding findings.
 */
async function fixFinding(input: string): Promise<AgentResult> {
  const request = input.trim();
  const id = /^R-[0-9a-f]{12}$/u.test(request) ? request : undefined;
  const managed = !request || Boolean(id);
  const previous = await reviewState.read();
  const before = await reviewState.snapshot(managed).catch(() => null);
  const current = previous && before && (before.head === previous.head || id) ? previous : null;
  let targets: ReviewFinding[] = [];
  if (managed) {
    if (!current?.findings || !before) {
      return stopFix('git.fix：当前没有可用的逐条审查结果。先运行 review("workspace")。');
    }
    const findings = current.head === before.head ? current.findings : current.findings.filter(({ status }) => status === "deferred");
    if (findings.some(({ status }) => status === "pending")) {
      return stopFix('git.fix：已有一批问题待复核，运行 review("workspace") 后再决定是否继续修。');
    }
    const open = findings.filter(({ status }) => status === "open" || (id && status === "deferred"));
    targets = open.filter((item) => id ? item.id === id : !item.explicitFix && !reviewState.wasTried(item, before));
    if (!targets.length) {
      if (id) return stopFix(`git.fix：当前没有可修复的 ${id}。`);
      if (!open.length) return stopFix("git.fix：当前没有待修复的问题。");
      const details = open.map((item) => `- ${item.id} ${item.title}${item.evidence ? ` — ${item.evidence}` : ""}`).join("\n");
      return stopFix(`git.fix：默认修复已结束。以下问题需要明确选择后再修，可用 git.fix("问题 ID")。\n${details}`);
    }
  }

  const task = managed ? composeFindingsTask(targets) : input;
  let report = "";
  try {
    const result = await runFix(task);
    report = result.text;
    return result;
  } finally {
    const decisions = managed ? readDecisions(report, FIX_DECISIONS, targets, "fixed") : undefined;
    if (managed && !decisions) console.log("git.fix：缺少有效的逐条修复结果，记录本次尝试并保留原状态。");
    await reviewState.markFixed(current, before, targets, { decisions, claimedPaths: managed ? readFixPaths(report) : [] }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`git.fix：没能保存本次修复记录（${reason}）。请先核实当前审查状态。`);
    });
  }
}

export async function fix(input = ""): Promise<AgentResult> {
  return await fixFinding(input);
}
