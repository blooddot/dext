import { createHash } from "node:crypto";

type Severity = "critical" | "high" | "medium" | "low";
type Status = "open" | "pending" | "resolved" | "deferred";

export interface ReviewFinding {
  id: string;
  path: string;
  location: string;
  severity: Severity;
  category: string;
  title: string;
  detail: string;
  status: Status;
  evidence: string;
  attempt?: { paths: string[]; key: string };
  explicitFix?: true;
}

const TITLE = "### 新发现";
const FOLLOW_UP = "### 另行审查";
export const REVIEW_DECISIONS = "### 既有问题复核";
export const FIX_DECISIONS = "### 修复结果";
export const FIX_PATHS = "### 本次修复文件";
const NONE = "（无）";
const FINDING_ROW = /^- `([^`]+)` \| `(critical|high|medium|low)` \| `([a-z_]+)` \| ([^|]+) \| (.+)$/u;

function section(report: string, title: string): string[] | undefined {
  const lines = report.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === title);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^#{1,6}\s/u.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).map((line) => line.trim()).filter(Boolean);
}

export function readDeferredFindings(report: string): ReviewFinding[] {
  const findings = new Map<string, ReviewFinding>();
  for (const line of section(report, FOLLOW_UP) ?? []) {
    const item = parseFindingRow(line);
    if (item && !findings.has(item.id)) findings.set(item.id, { ...item, status: "deferred" });
  }
  return [...findings.values()];
}

export function readFixPaths(report: string): string[] {
  return (section(report, FIX_PATHS) ?? []).flatMap((line) => {
    const path = /^- `([^`]+)`$/u.exec(line)?.[1];
    return path ? [path.replace(/^\.\//u, "")] : [];
  });
}

function finding(location: string, severity: string, category: string, title: string, detail: string): ReviewFinding | null {
  const path = location.replace(/:\d+(?:[–-]\d+)?$/u, "").replace(/^\.\//u, "");
  if (path === location || !path || !title.trim() || !detail.trim()) return null;
  if (/^[A-Za-z]:|\\/u.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  if (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low") return null;
  const id = `R-${createHash("sha256").update(JSON.stringify([path, title.trim().toLowerCase()])).digest("hex").slice(0, 12)}`;
  const status = severity === "critical" || severity === "high" || category === "bug" ? "open" : "deferred";
  return { id, path, location, severity, category, title: title.trim(), detail: detail.trim(), status, evidence: "" };
}

function parseFindingRow(line: string): ReviewFinding | null {
  const match = FINDING_ROW.exec(line);
  return match && finding(match[1]!, match[2]!, match[3]!, match[4]!, match[5]!);
}

export function readLegacyFindings(report: string): ReviewFinding[] | undefined {
  // Version 1 stored Markdown only. Migrate reports with explicit categories and
  // locations, retaining the original report when its shape is ambiguous.
  const findings: ReviewFinding[] = [];
  let hasSeverity = false;
  for (const severity of ["Critical", "High", "Medium", "Low"]) {
    const lines = section(report, `### ${severity}`);
    if (!lines) continue;
    hasSeverity = true;
    if (lines.length === 1 && /^(?:（无）|无|none\.?)$/iu.test(lines[0] ?? "")) continue;
    const items = lines.join("\n").split(/\n(?=(?:\d+\.|-)\s+\*\*)/u);
    for (const item of items) {
      const match = /^(?:\d+\.|-)\s+\*\*(.+?)\*\*\s*[（(]`?(\w+)`?\s*\/\s*`?(\w+)`?[）)]\s*[—-]\s*`([^`]+)`[^\n]*\n([\s\S]+)$/u.exec(item);
      if (!match || match[2]?.toLowerCase() !== severity.toLowerCase()) return undefined;
      const entry = finding(match[4]!, severity.toLowerCase(), match[3]!.toLowerCase(), match[1]!, match[5]!);
      if (!entry || findings.some(({ id }) => id === entry.id)) return undefined;
      findings.push(entry);
    }
  }
  return hasSeverity && !section(report, "### 沿用上一轮结论") ? findings : undefined;
}

export function readNewFindings(report: string, scope: ReadonlySet<string>): ReviewFinding[] | undefined {
  const lines = section(report, TITLE);
  if (!lines?.length) return undefined;
  if (lines.length === 1 && lines[0] === NONE) return [];
  const findings: ReviewFinding[] = [];
  for (const line of lines) {
    const entry = parseFindingRow(line);
    if (!entry || !scope.has(entry.path) || findings.some(({ id }) => id === entry.id)) return undefined;
    findings.push(entry);
  }
  return findings;
}

function isFixSummary(lines: readonly string[]): boolean {
  // The fix rule asks for a human-readable table and explanation after the
  // decisions. Ignore that appendix without accepting extra decision rows.
  const [header, delimiter, firstRow, ...rest] = lines;
  return /^\|.*\|$/u.test(header ?? "") && /^\|(?:\s*:?-+:?\s*\|)+$/u.test(delimiter ?? "")
    && /^\|.*\|$/u.test(firstRow ?? "") && !rest.some((line) => /^(?:[-*+]|\d+[.)])\s/u.test(line));
}

export function readDecisions(report: string, title: string, targets: readonly ReviewFinding[], done: "fixed" | "resolved") {
  const lines = section(report, title);
  if (!targets.length) return new Map<string, { done: boolean; evidence: string }>();
  if (!lines || lines.length < targets.length) return undefined;
  const summary = lines.slice(targets.length);
  if (summary.length && (done !== "fixed" || !isFixSummary(summary))) return undefined;
  const decisions = new Map<string, { done: boolean; evidence: string }>();
  for (const line of lines.slice(0, targets.length)) {
    const match = /^- `(R-[0-9a-f]{12})` \| `(fixed|resolved|open)` \| (.+)$/u.exec(line);
    if (!match) return undefined;
    const [, id, status, evidence] = match;
    if (!id || !evidence?.trim() || (status !== done && status !== "open")
      || decisions.has(id) || !targets.some((target) => target.id === id)) return undefined;
    decisions.set(id, { done: status === done, evidence: evidence.trim() });
  }
  return decisions;
}

export function findingList(findings: readonly ReviewFinding[]): string {
  return findings.map((item) => `- \`${item.id}\` \`${item.location}\` [${item.status}, ${item.severity}/${item.category}] ${item.title}\n  ${item.detail}${item.evidence ? `\n  上次验证：${item.evidence}` : ""}`).join("\n");
}

export function reviewFindingInstructions(targets: readonly ReviewFinding[], verification = false): string {
  const newFindings = verification
    ? "只列修复差异直接引入的可复现回归。path:line 必须落在已记录的修复差异中，证据要说明关联的问题 ID、变更和触发条件。缺乏对应差异时写（无），其他观察放在「另行审查」中。"
    : "只列本轮范围内有具体证据的新问题。真实的功能、崩溃和逻辑缺陷用 bug 类别。";
  return [
    `${TITLE}\n${newFindings} 每条独占一行，格式为 - \`path:123\` | \`medium\` | \`bug\` | 标题 | 影响、触发条件与证据。没有新问题时只写 ${NONE}。`,
    `${FOLLOW_UP}\n与本批改动及修复无关的缺陷可以延期，使用「新发现」的同一逐行格式，保留触发条件和实际影响。已排定的问题以及本批直接引入的回归在相应小节报告。`,
    targets.length ? [
      `## 本轮待复核问题\n${findingList(targets)}`,
      `${REVIEW_DECISIONS}\n逐条检查上面的问题及对应验证。每个 ID 恰好一行，格式为 - \`ID\` | \`resolved\` | 验证证据，或 - \`ID\` | \`open\` | 尚未解决的证据。证据不足保留 open。仍存在的既有问题使用原 ID，不写入「新发现」。`
    ].join("\n\n") : ""
  ].filter(Boolean).join("\n\n");
}

export function readSavedFindings(value: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ReviewFinding[] = [];
  for (const entry of value) {
    if (!entry || ["id", "path", "location", "severity", "category", "title", "detail", "status", "evidence"]
      .some((key) => typeof entry[key] !== "string")) return undefined;
    const expected = finding(entry.location, entry.severity, entry.category, entry.title, entry.detail);
    if (!expected || entry.id !== expected.id || entry.path !== expected.path
      || !["open", "pending", "resolved", "deferred"].includes(entry.status)
      || entries.some(({ id }) => id === entry.id)) return undefined;
    const attempt = entry.attempt;
    entries.push({ ...expected, status: entry.status, evidence: entry.evidence,
      ...(typeof attempt?.key === "string" && Array.isArray(attempt.paths) && attempt.paths.every((path: unknown) => typeof path === "string")
        ? { attempt: { key: attempt.key, paths: attempt.paths } } : {}),
      ...(entry.explicitFix === true ? { explicitFix: true } : {}) });
  }
  return entries;
}
