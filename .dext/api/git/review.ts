/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { skill, terminal, type SkillResult } from "dext";

type ReviewKind = "workspace" | "commit" | "range";

// 工作区审查分三段：取快照 → 用快照和上一轮基线判定范围（全量 / 增量 / 直接复用）
// → 跑一次 skill 并把这一轮写成新基线。每一段各占一个具名函数，terminal/skill
// 各占一个 wrapper，其余都是不出现在执行流里的纯解析 helper。
//
// 判定只看一件事：这份 diff 里哪些内容还没被审过。哈希是工作区文件内容的哈希，
// 与 HEAD、暂存区和 diff 生成方式都无关；HEAD 变了就退回全量，因为「相对 HEAD 的
// 改动」本身就是另一组内容了。

/** 基线落在工作区里：`git.review` 写，`git.fix` 补「改了哪些文件」，`git.commit` 用它确认提交前审过全量。 */
const STATE_PATH = ".dext/state/review/workspace.json";
/** 基线自己不是要审的代码：它每轮都变，混进改动清单会把自己拖进复审范围。 */
const STATE_PREFIX = ".dext/state/";
const STATE_VERSION = 1;
/** 变动的文件占已审文件的比例超过这个值就退回全量：增量省下的头部开销抵不过逐文件复审。 */
const FULL_RATIO = 0.4;
/** 反向依赖超过这个数量时退回全量：跨文件核对面太宽，一次全量比逐个补更省。 */
const DEP_LIMIT = 8;
/** 一个文件最多取多少个导出符号去搜反向依赖。 */
const SYMBOL_LIMIT = 24;
const REPORT_CHAR_LIMIT = 24_000;
const GIT_TIMEOUT_MS = 60_000;
const SOURCE_PATTERNS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"];
/** 只看顶层导出声明；`export { a as b }` 这类再导出由调用方一侧的 grep 兜住。 */
const EXPORTED = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
const SKIPPED_HEADING = /^#{2,6}\s*本轮未审文件/u;
const HEADING = /^#{1,6}\s+/u;
const NOBODY = /（无）|^\s*无\s*$|^\s*none\b/iu;

const READ_ONLY = [
  "只读审查，不修改文件，不提交代码。",
  "命令返回的 JSON 仅供内部处理，最终 SkillResult.text 必须是 Markdown 审查报告，不要原样返回 JSON。",
  "报告的每条问题描述与建议必须使用简体中文，不要翻译标题、文件路径、命令和代码。"
];

/** 工作区里一个改动文件：内容哈希是「审过没审过」的唯一依据，status 只用于展示。 */
interface ChangedFile {
  hash: string;
  status: string;
}

interface Snapshot {
  head: string;
  files: Record<string, ChangedFile>;
}

export interface ReviewState {
  version: number;
  round: number;
  mode: "full" | "incremental";
  head: string;
  reviewedAt: string;
  /** 该轮开始时的全部改动文件，值是内容哈希。 */
  files: Record<string, ChangedFile>;
  /** 该轮真正复审过的文件：增量时是复审清单加反向依赖。 */
  reviewed: string[];
  /** 该轮沿用上一轮结论、没有重审的文件。 */
  carried: string[];
  /** 上一轮报告里明确没审的文件，下一轮无条件复审。 */
  skipped: string[];
  /** 报告是否带了「本轮未审文件」小节：缺了就无法把「没审」和「审过」分开。 */
  coverageKnown: boolean;
  /** 上一轮 fix 改过的文件，与哈希比对互为印证。 */
  touched: string[];
  fixRuns: number;
  report: string;
}

interface WorkspacePlan {
  mode: "reuse" | "full" | "incremental";
  reason: string;
  /** 本轮真正要审的文件。 */
  review: string[];
  /** 反向依赖：本身没改，只核对调用点。 */
  deps: string[];
  /** 沿用上一轮结论的文件。 */
  carried: string[];
}

// ---------------------------------------------------------------- git 与快照

/** `git <args>`：退出码非 0 当作读不到，判定只用读得到的部分。 */
async function git(args: string): Promise<string> {
  const result = await terminal({ command: `git ${args}`, timeout_ms: GIT_TIMEOUT_MS });
  return result.exit_code === 0 ? result.stdout.replace(/\r/g, "") : "";
}

/** `XY <path>`, or `XY <old> -> <new>` where the path dirty now is the right one. */
function dirtied(porcelain: string): Array<{ code: string; path: string }> {
  return porcelain.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim().split(" -> ").pop() ?? "" }))
    .filter((entry) => entry.path !== "");
}

/** 工作区里这份文件的当前内容。读不到（删除、子模块、权限）用一个固定标记。 */
async function contentHash(path: string): Promise<string> {
  const content = await readFile(path).catch(() => null);
  if (content === null) return "unreadable";
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** HEAD 与全部改动文件的内容哈希。改动清单来自 `git status`，与审查范围同一来源。 */
async function snapshot(): Promise<Snapshot> {
  const toplevel = (await git("rev-parse --show-toplevel")).trim();
  if (toplevel === "") throw new Error("git.review 需要一个 git 工作区：当前目录不是 git 仓库，或 git 不可用。");
  const porcelain = await git("-c core.quotePath=false status --porcelain=v1 -uall");
  const files: Record<string, ChangedFile> = {};
  for (const entry of dirtied(porcelain)) {
    if (entry.path.startsWith(STATE_PREFIX)) continue;
    files[entry.path] = { hash: await contentHash(entry.path), status: entry.code };
  }
  return { head: (await git("rev-parse HEAD")).trim(), files };
}

function changedBetween(before: Snapshot | null, after: Snapshot): string[] {
  if (before === null) return [];
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter((path) => before.files[path]?.hash !== after.files[path]?.hash);
}

function short(commit: string): string {
  return commit === "" ? "（还没有提交）" : commit.slice(0, 7);
}

// ---------------------------------------------------------------- 基线状态

function asObject(value: unknown): Record<string, unknown> {
  const object = typeof value === "object" && value !== null && Array.isArray(value) === false;
  return object ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 只接受能完整解释的基线；任何一处对不上都当作没有基线，退化成全量。 */
function readFiles(value: unknown): Record<string, ChangedFile> | null {
  const raw = asObject(value);
  const files: Record<string, ChangedFile> = {};
  for (const [path, entry] of Object.entries(raw)) {
    const file = asObject(entry);
    const hash = asText(file.hash);
    if (hash === "") return null;
    files[path] = { hash, status: asText(file.status) };
  }
  return files;
}

function readStateValue(text: string): ReviewState | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const raw = asObject(parsed);
  const files = readFiles(raw.files);
  const mode = raw.mode;
  const round = raw.round;
  const valid = files !== null
    && raw.version === STATE_VERSION
    && typeof round === "number"
    && (mode === "full" || mode === "incremental")
    && typeof raw.report === "string";
  if (valid === false) return null;
  return {
    version: STATE_VERSION,
    round: round as number,
    mode: mode as ReviewState["mode"],
    head: asText(raw.head),
    reviewedAt: asText(raw.reviewedAt),
    files: files as Record<string, ChangedFile>,
    reviewed: asList(raw.reviewed),
    carried: asList(raw.carried),
    skipped: asList(raw.skipped),
    coverageKnown: raw.coverageKnown !== false,
    touched: asList(raw.touched),
    fixRuns: typeof raw.fixRuns === "number" ? raw.fixRuns : 0,
    report: asText(raw.report)
  };
}

async function readState(): Promise<ReviewState | null> {
  const text = await readFile(STATE_PATH, "utf8").catch(() => "");
  return text.trim() === "" ? null : readStateValue(text);
}

async function writeState(state: ReviewState): Promise<void> {
  await mkdir(".dext/state/review", { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 报告末尾的「本轮未审文件」小节：下一轮据此把没审过的文件拉回复审。 */
function readSkipped(report: string): { known: boolean; paths: string[] } {
  const lines = report.split(/\r?\n/u);
  const start = lines.findIndex((line) => SKIPPED_HEADING.test(line));
  if (start < 0) return { known: false, paths: [] };
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet === null) continue;
    const body = bullet[1] ?? "";
    if (NOBODY.test(body)) continue;
    const fenced = /`([^`]+)`/u.exec(body);
    const bare = /^<?([\w@./-]+\.[A-Za-z0-9]+)>?/u.exec(body);
    const path = (fenced?.[1] ?? bare?.[1] ?? "").replace(/^\.\//u, "").trim();
    if (path !== "") paths.push(path);
  }
  return { known: true, paths: [...new Set(paths)] };
}

// ---------------------------------------------------------------- 判定

/** 被改文件导出的符号在别处的引用：改了签名而调用点没改，是增量之外唯一会漏审的形态。 */
async function exportedNames(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  const names: string[] = [];
  for (const match of content.matchAll(EXPORTED)) {
    const name = match[1] ?? "";
    if (name.length >= 3) names.push(name);
  }
  return [...new Set(names)].slice(0, SYMBOL_LIMIT);
}

async function reverseDeps(targets: string[], changed: Set<string>): Promise<string[]> {
  const names = [...new Set((await Promise.all(targets.map(exportedNames))).flat())];
  if (names.length === 0) return [];
  const patterns = names.map((name) => `-e "${name}"`).join(" ");
  const pathspecs = SOURCE_PATTERNS.map((pattern) => `"${pattern}"`).join(" ");
  const result = await terminal({ command: `git grep -l -w ${patterns} -- ${pathspecs}`, timeout_ms: GIT_TIMEOUT_MS });
  if (result.exit_code !== 0) return [];
  return result.stdout.split("\n")
    .map((line) => line.trim())
    .filter((path) => path !== "" && changed.has(path) === false)
    .sort();
}

/** 全量还是增量不是用户的选项，而是「有没有没审过的内容」的结论。 */
async function planWorkspace(current: Snapshot, previous: ReviewState | null, full: boolean): Promise<WorkspacePlan> {
  const paths = Object.keys(current.files).sort();
  const whole = (reason: string): WorkspacePlan => ({ mode: "full", reason, review: paths, deps: [], carried: [] });

  if (paths.length === 0) return { mode: "reuse", reason: "工作区相对 HEAD 没有改动", review: [], deps: [], carried: [] };
  if (full) return whole("调用方传入 full = true");
  if (previous === null) return whole("没有可用的上一轮基线（首轮）");
  if (previous.head !== current.head) {
    return whole(`HEAD 已从 ${short(previous.head)} 变为 ${short(current.head)}，上一轮的逐文件哈希不再可比`);
  }
  if (previous.coverageKnown === false) {
    return whole("上一轮报告缺少「本轮未审文件」小节，无法区分「没审」和「审过」");
  }

  const forced = [...previous.skipped, ...previous.touched].filter((path) => current.files[path] !== undefined);
  const pending = paths.filter((path) => previous.files[path]?.hash !== current.files[path]?.hash);
  const targets = [...new Set([...pending, ...forced])].sort();
  if (targets.length === 0) {
    return { mode: "reuse", reason: `相对第 ${previous.round} 轮没有文件内容变化`, review: [], deps: [], carried: paths };
  }

  const known = Math.max(paths.length, Object.keys(previous.files).length);
  if (targets.length / known > FULL_RATIO) {
    return whole(`${targets.length}/${known} 个文件自上一轮起有变化，超过 ${Math.round(FULL_RATIO * 100)}% 阈值`);
  }
  const deps = await reverseDeps(targets, new Set(paths));
  if (deps.length > DEP_LIMIT) return whole(`反向依赖 ${deps.length} 个文件，超过 ${DEP_LIMIT} 个阈值`);
  return {
    mode: "incremental",
    reason: `${targets.length}/${known} 个文件自上一轮起有变化`,
    review: targets,
    deps,
    carried: paths.filter((path) => targets.includes(path) === false)
  };
}

function describePlan(plan: WorkspacePlan, round: number, current: Snapshot): string {
  const total = Object.keys(current.files).length;
  if (plan.mode === "full") return `全量审查（第 ${round} 轮）— ${plan.reason}；共 ${total} 个改动文件。`;
  const deps = plan.deps.length === 0 ? "" : ` + 反向依赖 ${plan.deps.length} 个`;
  return `增量审查（第 ${round} 轮）— ${plan.reason}；复审 ${plan.review.length} 个${deps}，复用 ${plan.carried.length} 个。`;
}

// ---------------------------------------------------------------- 输入

function limitText(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断，原文 ${trimmed.length} 字符）`;
}

function bullets(paths: string[], current: Snapshot): string {
  if (paths.length === 0) return "（无）";
  return paths.map((path) => {
    const status = current.files[path]?.status ?? "";
    return status === "" ? `- ${path}（未改动）` : `- ${path}（${status}）`;
  }).join("\n");
}

/** 覆盖率小节是下一轮能否走增量的唯一依据，所以全量和增量都固定要求这一节。 */
const COVERAGE_ASK = [
  "报告末尾固定写「### 本轮未审文件」小节：全部审完写 `（无）`；有跳过就逐行写 `- <path> — 原因`（路径用反引号包住）。",
  "这一小节缺了，下一轮只能再全量一遍。"
].join("\n");

function composeFullInput(current: Snapshot, round: number): string {
  const paths = Object.keys(current.files).sort();
  return [
    "审查当前 Git 工作区变更。",
    "覆盖所有 reviewable_files，按 severity 和 category 输出结果，并报告审查覆盖率。",
    ...READ_ONLY,
    [`本轮是第 ${round} 轮全量审查（HEAD ${short(current.head)}），共 ${paths.length} 个改动文件：`, bullets(paths, current)].join("\n"),
    COVERAGE_ASK
  ].join("\n");
}

function composeIncrementalInput(current: Snapshot, previous: ReviewState, plan: WorkspacePlan, round: number): string {
  const deps = plan.deps.length === 0
    ? "## 反向依赖（0）\n（无）"
    : [
      `## 反向依赖（${plan.deps.length}，只核对调用点）`,
      "这些文件本身没改，只核对它们的调用点是否适配上面的改动；不要重述它们未改动的内容。",
      bullets(plan.deps, current)
    ].join("\n");
  return [
    "审查当前 Git 工作区变更的增量部分：只复审下面清单里的文件。",
    ...READ_ONLY,
    [
      "## 本轮判定（主机读 git 得出，不要重新判断范围）",
      `- ${describePlan(plan, round, current)}`,
      "- 复审清单是唯一审查范围：`ocr delegate preview` 只用于取规则，它列出的其它文件属于「沿用上一轮」，不要重审。",
      "- 覆盖率按「复审清单 + 反向依赖」统计，不要用 preview 的全量文件数。"
    ].join("\n"),
    [`## 复审清单（${plan.review.length}）`, bullets(plan.review, current)].join("\n"),
    deps,
    [
      `## 沿用上一轮结论（${plan.carried.length}，不要重审）`,
      bullets(plan.carried, current)
    ].join("\n"),
    [
      `## 上一轮报告（第 ${previous.round} 轮，供沿用与对照）`,
      "```md",
      limitText(previous.report, REPORT_CHAR_LIMIT),
      "```"
    ].join("\n"),
    [
      "## 本轮输出要求",
      "1. 严重性分组里只放本轮复审发现的问题。",
      "2. 新增「### 沿用上一轮结论」小节：把上一轮报告里涉及复用文件的条目原样搬过来（保留 path:line），已经在本轮确认修好的标「已修复」。",
      `3. ${COVERAGE_ASK}`
    ].join("\n")
  ].join("\n");
}

// ---------------------------------------------------------------- wrapper 与落盘

async function runSkill(input: string): Promise<SkillResult> {
  return await skill({ skill: "open-code-review-delegate", apply: true, input, echo: true });
}

/** 报告落盘失败不该让一次已经跑完的审查变成异常：说清楚，下一轮退回全量即可。 */
async function saveRound(current: Snapshot, plan: WorkspacePlan, round: number, report: string): Promise<void> {
  const skipped = readSkipped(report);
  try {
    await writeState({
      version: STATE_VERSION,
      round,
      mode: plan.mode === "incremental" ? "incremental" : "full",
      head: current.head,
      reviewedAt: new Date().toISOString(),
      files: current.files,
      reviewed: plan.mode === "incremental" ? [...plan.review, ...plan.deps] : Object.keys(current.files).sort(),
      carried: plan.carried,
      skipped: skipped.paths,
      coverageKnown: skipped.known,
      touched: [],
      fixRuns: 0,
      report
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`git.review：基线没有写进 ${STATE_PATH}（${reason}），下一轮会退回全量审查。`);
    return;
  }
  const coverage = skipped.known ? "" : "；报告缺少「本轮未审文件」小节，下一轮退回全量";
  console.log([
    `git.review：基线已写入 ${STATE_PATH}（第 ${round} 轮，复审 ${plan.mode === "incremental" ? plan.review.length + plan.deps.length : Object.keys(current.files).length} 个，复用 ${plan.carried.length} 个${coverage}）。`,
    "改动之后用 fix(\"\") 复用这份报告；要强制全量：review(\"workspace\", true)。"
  ].join("\n"));
}

async function reviewWorkspace(full: boolean): Promise<SkillResult> {
  const current = await snapshot();
  const previous = await readState();
  const plan = await planWorkspace(current, previous, full);
  const round = (previous?.round ?? 0) + 1;

  if (plan.mode === "reuse") {
    const report = previous?.report.trim() ?? "";
    const gone = Object.keys(previous?.files ?? {}).filter((path) => current.files[path] === undefined);
    const stale = gone.length === 0
      ? ""
      : `注意：${gone.length} 个文件已不再改动（${gone.slice(0, 3).join("、")}${gone.length > 3 ? " 等" : ""}），上一轮关于它们的条目可能已失效。`;
    const text = report === ""
      ? `${plan.reason}，本轮跳过审查。`
      : [
        report,
        "",
        "---",
        `本轮（第 ${round} 轮）没有需要重审的内容：${plan.reason}。结论沿用第 ${previous?.round ?? 0} 轮。`,
        stale,
        "如需强制全量：review(\"workspace\", true)。"
      ].filter((line) => line !== "").join("\n");
    console.log(`git.review：跳过模型调用 — ${plan.reason}。`);
    return { kind: "skill", text };
  }

  console.log(`git.review：${describePlan(plan, round, current)}`);
  const input = plan.mode === "full" || previous === null
    ? composeFullInput(current, round)
    : composeIncrementalInput(current, previous, plan, round);
  const result = await runSkill(input);
  await saveRound(current, plan, round, result.text);
  return result;
}

// ---------------------------------------------------------------- fix 与 commit 共用

/**
 * 基线与工作区快照。`git.fix` 用 `snapshot` 加 `markFixed` 把「这一轮改了哪些文件」
 * 补进基线，`git.commit` 用 `read` 确认提交前审过全量。
 */
export const reviewState = {
  read: readState,
  snapshot,
  /** 记录一次 fix 的落点：下一轮 review 会复审这些文件，而不只是看哈希。 */
  async markFixed(previous: ReviewState | null, before: Snapshot | null): Promise<void> {
    if (previous === null) return;
    const after = await snapshot();
    const fresh = changedBetween(before, after);
    const touched = [...new Set([...previous.touched, ...fresh])].sort();
    await writeState({ ...previous, touched, fixRuns: previous.fixRuns + 1 });
    console.log(fresh.length === 0
      ? "git.fix：本轮没有改动文件；下一轮 review 若也没有新改动，会直接复用上一轮结论。"
      : `git.fix：本轮改动 ${fresh.length} 个文件（${fresh.slice(0, 5).join("、")}${fresh.length > 5 ? " 等" : ""}），下一轮 review 会复审它们。`);
  }
};

// ---------------------------------------------------------------- commit / range

function reviewScope(kind: ReviewKind, first?: string, second?: string): string {
  if (kind === "workspace") throw new Error("workspace review 走基线判定，不接受 ref 参数。");

  const ref = first?.trim();
  if (!ref) throw new Error(`${kind} review requires a ref.`);

  if (kind === "commit") {
    if (second !== undefined) throw new Error("commit review accepts exactly one commit ref.");
    return `审查 commit ${ref}。`;
  }

  return `审查 ${ref} 到 ${second?.trim() || "HEAD"} 的分支差异。`;
}

async function runReview(scope: string): Promise<SkillResult> {
  return await runSkill([
    scope,
    "覆盖所有 reviewable_files，按 severity 和 category 输出结果，并报告审查覆盖率。",
    ...READ_ONLY
  ].join("\n"));
}

// ---------------------------------------------------------------- 入口

/**
 * 审查当前工作区的改动，全量还是增量由主机按上一轮基线自动判定：内容没变的文件沿用上一轮的结论，
 * 变化的文件加它们的反向依赖才重新复审。
 * @param full 强制全量重审。基线缺失、HEAD 变化、变化比例过大时也会自动走全量。
 */
export function review(kind: "workspace", full?: boolean): Promise<SkillResult>;
export function review(kind: "commit", commit: string): Promise<SkillResult>;
export function review(kind: "range", from: string, to?: string): Promise<SkillResult>;
export async function review(kind: ReviewKind, first?: string | boolean, second?: string): Promise<SkillResult> {
  if (kind === "workspace") {
    if (typeof first === "string" || second !== undefined) {
      throw new Error('workspace review 只接受一个可选布尔：review("workspace", true) 强制全量。');
    }
    return await reviewWorkspace(first === true);
  }
  if (first !== undefined && typeof first !== "string") {
    throw new Error(`${kind} review 的第二个参数是 ref：review("range", from, to?)。`);
  }
  if (second !== undefined && typeof second !== "string") {
    throw new Error(`${kind} review 的第三个参数是 to ref：review("range", from, to?)。`);
  }
  return await runReview(reviewScope(kind, first, second));
}
