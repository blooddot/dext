import { skill, type SkillResult } from "dext";

type ReviewKind = "workspace" | "commit" | "range";
type ReviewSeverity = "critical" | "high" | "medium" | "low";

interface ReviewFinding {
  path: string;
  content: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  severity?: ReviewSeverity;
  suggestion?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function coverageValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}%`;
  const text = stringValue(value);
  return text === undefined || text.endsWith("%") ? text ?? "unknown" : `${text}%`;
}

function finding(value: unknown): ReviewFinding | undefined {
  const item = record(value);
  const path = stringValue(item?.path);
  const content = stringValue(item?.content);
  if (!path || !content) return undefined;
  const startLine = numberValue(item?.start_line);
  const endLine = numberValue(item?.end_line);
  const category = stringValue(item?.category);
  const severity = stringValue(item?.severity);
  const suggestion = stringValue(item?.suggestion_code);
  return {
    path,
    content,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(category ? { category } : {}),
    ...(severity === "critical" || severity === "high" || severity === "medium" || severity === "low" ? { severity } : {}),
    ...(suggestion ? { suggestion } : {})
  };
}

function reviewMarkdown(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const payload = record(parsed);
  if (!payload) return undefined;
  const summary = record(payload.summary);
  const findings = Array.isArray(payload.findings)
    ? payload.findings.map(finding).filter((item): item is ReviewFinding => item !== undefined)
    : undefined;
  if (stringValue(payload.mode) !== "delegation" || !summary || findings === undefined) return undefined;

  const totalFiles = numberValue(summary.total_files) ?? 0;
  const reviewedFiles = numberValue(summary.reviewed_files) ?? 0;
  const skippedFiles = numberValue(summary.skipped_files) ?? 0;
  const coverage = coverageValue(summary.coverage_rate);
  const lines = [
    "## Code Review Results",
    "",
    "审查模式为 delegation。",
    "",
    `- 总文件数：${totalFiles}`,
    `- 已审查：${reviewedFiles}`,
    `- 跳过：${skippedFiles}`,
    `- 覆盖率：${coverage}`,
    ""
  ];

  for (const severity of ["critical", "high", "medium", "low", "other"] as const) {
    const matches = findings.filter((item) => severity === "other" ? item.severity === undefined : item.severity === severity);
    if (severity === "other" && !matches.length) continue;
    lines.push(`### ${severity[0]!.toUpperCase()}${severity.slice(1)}`, "");
    if (!matches.length) {
      lines.push("无。", "");
      continue;
    }
    for (const item of matches) {
      const location = item.startLine === undefined
        ? ""
        : item.endLine !== undefined && item.endLine !== item.startLine
          ? `:${item.startLine}-${item.endLine}`
          : `:${item.startLine}`;
      const category = item.category ? ` [${item.category}]` : "";
      lines.push(`- **\`${item.path}${location}\`**${category} — ${item.content}`);
      if (item.suggestion) lines.push(`  > 建议：${item.suggestion}`);
    }
    lines.push("");
  }

  const excluded = Array.isArray(payload.excluded)
    ? payload.excluded.map((value) => record(value)).flatMap((item) => {
      const path = stringValue(item?.path);
      const reason = stringValue(item?.reason);
      return path && reason ? [`- \`${path}\` — ${reason}`] : [];
    })
    : [];
  if (excluded.length) lines.push("### Skipped / Excluded", "", ...excluded, "");

  const checks = Array.isArray(payload.checks)
    ? payload.checks.map((value) => record(value)).flatMap((item) => {
      const command = stringValue(item?.command);
      const status = stringValue(item?.status);
      return command && status ? [`- \`${command}\` — ${status}`] : [];
    })
    : [];
  if (checks.length) lines.push("### Checks", "", ...checks, "");

  const notes = Array.isArray(payload.notes)
    ? payload.notes.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => `- ${value}`)
    : [];
  if (notes.length) lines.push("### Notes", "", ...notes, "");
  return lines.join("\n").trim();
}

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
  const result = await skill({
    skill: "open-code-review-delegate",
    input: [
      scope,
      "只读审查，不修改文件，不提交代码。",
      "覆盖所有 reviewable_files，按 severity 和 category 输出结果，并报告审查覆盖率。",
      "命令返回的 JSON 仅供内部处理，最终 SkillResult.text 必须是 Markdown 审查报告，不要原样返回 JSON。"
    ].join("\n"),
    echo: true
  });
  const formatted = reviewMarkdown(result.text);
  return formatted === undefined ? result : { ...result, text: formatted };
}

export function review(kind: "workspace"): Promise<SkillResult>;
export function review(kind: "commit", commit: string): Promise<SkillResult>;
export function review(kind: "range", from: string, to?: string): Promise<SkillResult>;
export async function review(kind: ReviewKind, first?: string, second?: string): Promise<SkillResult> {
  return await runReview(reviewScope(kind, first, second));
}
