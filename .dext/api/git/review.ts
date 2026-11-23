/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { agent, skill, terminal, type SkillResult } from "dext";
import {
  readDecisions, readLegacyFindings, readNewFindings, readSavedFindings, REVIEW_DECISIONS,
  reviewFindingInstructions, type ReviewFinding
} from "./reviewFindings.ts";
import { cleanFile, hasRepairAnchor, readRepairDeltas, repairHunks, REPAIR_FILE_LIMIT, type RepairDelta } from "./reviewRepair.ts";

type ReviewKind = "workspace" | "commit" | "range";

// 工作区审查分三段：取快照 → 用快照和上一轮基线判定范围（全量 / 增量 / 直接复用）
// → 执行一次审查并把结论写成新基线。每个 Dext 内置调用有单独的具名函数。
//
// 工作区内容和 Git 状态都用于识别增量。HEAD 变化时，重新建立审查范围。
// 有已修或手工修改过的既有问题时，优先完成定点复核。

/** 工作区审查基线和逐条问题记录。 */
const STATE_PATH = ".dext/state/review/workspace.json";
const STATE_DIR = ".dext/state/review";
/** 基线自己不是要审的代码：它每轮都变，混进改动清单会把自己拖进复审范围。 */
const STATE_PREFIX = ".dext/state/";
const STATE_VERSION = 1;
/** 变动的文件占已审文件的比例超过这个值就退回全量：增量省下的头部开销抵不过逐文件复审。 */
const FULL_RATIO = 0.4;
/** 反向依赖超过这个数量时退回全量：跨文件核对面太宽，一次全量比逐个补更省。 */
const DEP_LIMIT = 8;
/** 一个文件最多取多少个导出符号去搜反向依赖。 */
const SYMBOL_LIMIT = 24;
const REPAIR_PROMPT_LIMIT = 48 * 1024;
const REPAIR_CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const SOURCE_PATTERNS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"];
/** 只看顶层导出声明；`export { a as b }` 这类再导出由调用方一侧的 grep 兜住。 */
const EXPORTED = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu;
const SKIPPED_HEADING = /^#{2,6}\s*本轮未审文件/u;
const HEADING = /^#{1,6}\s+/u;
const NOBODY = /^\s*(?:（无）|无|none\.?)\s*$/iu;

const READ_ONLY = [
  "只读审查，不修改文件，不提交代码。",
  "命令返回的 JSON 仅供内部处理，最终 SkillResult.text 必须是 Markdown 审查报告，不要原样返回 JSON。",
  "报告的每条问题描述与建议必须使用简体中文，不要翻译标题、文件路径、命令和代码。"
];

/** 一个路径可以同时有暂存删除和同路径的未跟踪内容。 */
interface ChangedFile {
  hash: string;
  status: string;
}

interface Snapshot {
  head: string;
  files: Record<string, ChangedFile>;
  contents?: Map<string, Buffer>;
}

export interface ReviewState {
  version: number;
  round: number;
  mode: "full" | "incremental";
  head: string;
  reviewedAt: string;
  /** 每个路径上一次覆盖到的快照。定点复核范围外的变更保留旧值。 */
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
  findings?: ReviewFinding[];
  repairs?: RepairDelta[];
  lastVerification?: { ids: string[]; paths: string[] };
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
  /** 定点复核时，独立文件变更始终保留待审。 */
  verification?: { ids: Set<string>; outside: string[]; callers: string[]; repairs: RepairDelta[] };
}

// ---------------------------------------------------------------- git 与快照

async function git(args: string, unbornHead = false): Promise<string> {
  const result = await terminal({ command: `git ${args}`, timeout_ms: GIT_TIMEOUT_MS });
  if (result.exit_code === 0) return result.stdout;
  if (unbornHead && result.exit_code === 1) return "";
  throw new Error(result.stderr.trim() || `git ${args} 执行失败`);
}

function dirtied(porcelain: string): Map<string, string[]> {
  const records = porcelain.split("\0");
  const files = new Map<string, string[]>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const code = record.slice(0, 2).trim();
    const path = record.slice(3);
    if (/[RC]/u.test(code)) index += 1; // -z lists the old rename/copy path after the destination.
    if (!path || path.startsWith(STATE_PREFIX)) continue;
    const prior = files.get(path);
    if (prior) prior.push(code);
    else files.set(path, [code]);
  }
  return files;
}

/** HEAD 与全部改动文件的内容哈希。改动清单来自 `git status`，与审查范围同一来源。 */
async function snapshot(capture = false): Promise<Snapshot> {
  const toplevel = (await git("rev-parse --show-toplevel")).trim();
  if (toplevel === "") throw new Error("git.review 需要一个 git 工作区：当前目录不是 git 仓库，或 git 不可用。");
  const porcelain = await git("status --porcelain=v1 -z -uall");
  if (porcelain && !porcelain.endsWith("\0")) throw new Error("git status 输出不完整，无法确认审查范围。");
  const files: Record<string, ChangedFile> = Object.create(null);
  const contents = capture ? new Map<string, Buffer>() : undefined;
  let captureBytes = 0;
  for (const [path, codes] of dirtied(porcelain)) {
    const content = await readFile(path).catch(() => null);
    const hash = content ? createHash("sha256").update(content).digest("hex").slice(0, 16) : "unreadable";
    files[path] = { hash, status: codes.sort().join(" + ") };
    if (contents && content && content.length <= REPAIR_FILE_LIMIT && captureBytes + content.length <= REPAIR_CAPTURE_LIMIT) {
      contents.set(path, content);
      captureBytes += content.length;
    }
  }
  return { head: (await git("rev-parse --verify -q HEAD", true)).trim(), files, contents };
}

function fileStamp(snapshot: Snapshot, path: string): string {
  const entry = snapshot.files[path];
  return entry ? `${entry.status}:${entry.hash}` : "clean";
}

function attemptKey(snapshot: Snapshot, paths: readonly string[], evidence: string): string {
  return createHash("sha256").update(JSON.stringify([snapshot.head, evidence, paths.map((path) => [path, fileStamp(snapshot, path)])])).digest("hex");
}

async function capturedFile(snapshot: Snapshot, path: string): Promise<Buffer | undefined> {
  const entry = snapshot.files[path];
  if (!entry) return cleanFile(snapshot.head, path);
  if (entry.hash === "unreadable" && entry.status === "D") return Buffer.alloc(0);
  return snapshot.contents?.get(path);
}

function changedBetween(before: Snapshot | null, after: Snapshot): string[] {
  if (before === null) return [];
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  return [...paths].filter((path) => before.files[path]?.hash !== after.files[path]?.hash
    || before.files[path]?.status !== after.files[path]?.status);
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
  const files: Record<string, ChangedFile> = Object.create(null);
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
  const verification = asObject(raw.lastVerification);
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
    report: asText(raw.report),
    findings: raw.findings === undefined ? readLegacyFindings(raw.report as string) : readSavedFindings(raw.findings),
    repairs: readRepairDeltas(raw.repairs),
    lastVerification: Array.isArray(verification.ids) && Array.isArray(verification.paths)
      ? { ids: asList(verification.ids), paths: asList(verification.paths) } : undefined
  };
}

async function readState(): Promise<ReviewState | null> {
  try {
    return readStateValue(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readLockedState(): ReviewState | null {
  try {
    return readStateValue(readFileSync(STATE_PATH, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(state: ReviewState, previous: ReviewState | null): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  // SQLite supplies an OS-backed interprocess lock. The JSON stays the source
  // of truth and is replaced atomically while the lock is held.
  const { DatabaseSync } = await import("node:sqlite");
  const lock = new DatabaseSync(`${STATE_DIR}/writer.sqlite`);
  try {
    lock.exec("PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE");
    const latest = readLockedState();
    if (latest?.round !== previous?.round || latest?.reviewedAt !== previous?.reviewedAt || latest?.fixRuns !== previous?.fixRuns) {
      throw new Error("审查基线在本轮运行期间已更新");
    }
    const temporary = `${STATE_DIR}/next.json`;
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(temporary, STATE_PATH);
    } finally {
      rmSync(temporary, { force: true });
    }
  } finally {
    lock.close();
  }
}

/** 报告末尾的「本轮未审文件」小节：下一轮据此把没审过的文件拉回复审。 */
function readSkipped(report: string): { known: boolean; paths: string[] } {
  const lines = report.split(/\r?\n/u);
  const start = lines.findIndex((line) => SKIPPED_HEADING.test(line));
  if (start < 0) return { known: false, paths: [] };
  const paths: string[] = [];
  let known = false;
  for (const line of lines.slice(start + 1)) {
    if (HEADING.test(line)) break;
    if (!line.trim()) continue;
    if (NOBODY.test(line)) { known = true; continue; }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (bullet === null) return { known: false, paths: [] };
    const body = bullet[1] ?? "";
    if (NOBODY.test(body)) continue;
    const fenced = /`([^`]+)`/u.exec(body);
    const bare = /^<?([\w@./-]+\.[A-Za-z0-9]+)>?/u.exec(body);
    const path = (fenced?.[1] ?? bare?.[1] ?? "").replace(/^\.\//u, "").trim();
    if (path === "") return { known: false, paths: [] };
    paths.push(path);
  }
  return { known: known || paths.length > 0, paths: [...new Set(paths)] };
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
  const result = await terminal({ command: `git grep --no-color -l -z -w ${patterns} -- ${pathspecs}`, timeout_ms: GIT_TIMEOUT_MS });
  if (result.exit_code !== 0) return [];
  return [...new Set(result.stdout.split("\0"))]
    .filter((path) => path !== "" && !path.startsWith(STATE_PREFIX) && !changed.has(path))
    .sort();
}

/** 全量还是增量不是用户的选项，而是「有没有没审过的内容」的结论。 */
async function planWorkspace(current: Snapshot, previous: ReviewState | null, full: boolean): Promise<WorkspacePlan> {
  const paths = Object.keys(current.files).sort();
  const whole = (reason: string): WorkspacePlan => ({ mode: "full", reason, review: paths, deps: [], carried: [] });
  const baseline = previous?.head === current.head ? previous : null;
  const changed = new Set(changedBetween(baseline, current));
  const verification = baseline?.findings?.filter(({ path, status }) => status === "pending" || (status === "open" && changed.has(path))) ?? [];

  if (!full && baseline?.lastVerification && !verification.length) {
    return { mode: "reuse", reason: "上一批修复复核已结束", review: [], deps: [], carried: paths };
  }
  if (paths.length === 0 && verification.length === 0) {
    return { mode: "reuse", reason: "工作区相对 HEAD 没有改动", review: [], deps: [], carried: [] };
  }
  if (full) return whole("调用方传入 full = true");
  if (previous === null) return whole("没有可用的上一轮基线（首轮）");
  if (!baseline) {
    return whole(`HEAD 已从 ${short(previous.head)} 变为 ${short(current.head)}，上一轮的逐文件哈希不再可比`);
  }
  if (verification.length) {
    const related = new Set([...verification.map(({ path }) => path), ...previous.touched]);
    const review = paths.filter((path) => related.has(path));
    const deps = [...related].filter((path) => !current.files[path]);
    const callers = (await reverseDeps([...related], related)).slice(0, DEP_LIMIT);
    const repairs = previous.repairs?.filter((repair) => related.has(repair.path) && fileStamp(current, repair.path) === repair.after) ?? [];
    const outside = paths.filter((path) => changed.has(path) && !related.has(path));
    return {
      mode: "incremental", reason: `逐条复核 ${verification.length} 个既有问题`, review, deps,
      carried: paths.filter((path) => !related.has(path) && !deps.includes(path) && !changed.has(path)),
      verification: { ids: new Set(verification.map(({ id }) => id)), outside, callers, repairs }
    };
  }
  if (previous.coverageKnown === false) {
    return whole("上一轮报告缺少「本轮未审文件」小节，无法区分「没审」和「审过」");
  }
  if (previous.findings === undefined) return whole("上一轮报告没有可逐条复核的问题记录");

  const forced = [...previous.skipped, ...previous.touched].filter((path) => current.files[path] !== undefined);
  const pending = paths.filter((path) => changed.has(path));
  const targets = [...new Set([...pending, ...forced])].sort();
  const extra = previous.skipped.filter((path) => current.files[path] === undefined);
  if (targets.length === 0 && extra.length === 0) {
    return { mode: "reuse", reason: `相对第 ${previous.round} 轮没有文件内容变化`, review: [], deps: [], carried: paths };
  }

  const known = Math.max(paths.length, Object.keys(previous.files).length);
  if (targets.length / known > FULL_RATIO) {
    return whole(`${targets.length}/${known} 个文件自上一轮起有变化，超过 ${Math.round(FULL_RATIO * 100)}% 阈值`);
  }
  const deps = [...new Set([...extra, ...await reverseDeps(targets, new Set(targets))])];
  if (deps.length > DEP_LIMIT) return whole(`反向依赖 ${deps.length} 个文件，超过 ${DEP_LIMIT} 个阈值`);
  return {
    mode: "incremental",
    reason: `${targets.length}/${known} 个文件自上一轮起有变化`,
    review: targets,
    deps,
    carried: paths.filter((path) => !targets.includes(path) && !deps.includes(path))
  };
}

function describePlan(plan: WorkspacePlan, round: number, current: Snapshot): string {
  const total = Object.keys(current.files).length;
  if (plan.mode === "full") return `全量审查（第 ${round} 轮）— ${plan.reason}；共 ${total} 个改动文件。`;
  const deps = plan.deps.length === 0 ? "" : ` + 反向依赖 ${plan.deps.length} 个`;
  if (plan.verification) return `修复复核（第 ${round} 轮）— ${plan.reason}；核对 ${plan.review.length + plan.deps.length} 个文件。`;
  return `增量审查（第 ${round} 轮）— ${plan.reason}；复审 ${plan.review.length} 个${deps}，复用 ${plan.carried.length} 个。`;
}

// ---------------------------------------------------------------- 输入

function bullets(paths: string[], current: Snapshot): string {
  if (paths.length === 0) return "（无）";
  return paths.map((path) => {
    const status = current.files[path]?.status ?? "";
    return status === "" ? `- ${path}（不在当前改动中，按现状核对）` : `- ${path}（${status}）`;
  }).join("\n");
}

/** 覆盖率小节是下一轮能否走增量的唯一依据，所以全量和增量都固定要求这一节。 */
const COVERAGE_ASK = [
  "报告末尾固定写「### 本轮未审文件」小节：全部审完写 `（无）`；有跳过就逐行写 `- <path> — 原因`（路径用反引号包住）。"
].join("\n");

function composeWorkspaceInput(current: Snapshot, plan: WorkspacePlan, round: number, targets: readonly ReviewFinding[]): string {
  const verification = plan.verification;
  const repairDiff = verification?.repairs.map(({ path, hunks }) => `文件 ${path}\n${hunks}`).join("\n\n");
  return [
    "审查当前 Git 工作区变更。以下是 Dext 宿主指定的审查范围和报告格式。",
    ...READ_ONLY,
    describePlan(plan, round, current),
    "审查范围以宿主的文件清单为准。候选调用点不计入覆盖，排除 `.dext/state/`。",
    `## 审查文件（${plan.review.length}）\n${bullets(plan.review, current)}`,
    `## ${verification ? "工作区没有改动的复核文件" : "调用点及定点复核文件"}（${plan.deps.length}）\n${bullets(plan.deps, current)}`,
    verification ? "本轮目标是验收列出的 ID。哪怕当前没有 Git diff，也按文件现状复核。候选调用点供按需查证，无需逐一阅读，也不计入覆盖。" : "",
    verification?.callers.length ? `## 候选调用点（按需）\n${verification.callers.map((path) => `- ${path}`).join("\n")}` : "",
    verification ? `## 实际修复差异\n${repairDiff || "本轮缺少可对照的前后差异，仅复核既有问题。"}` : "",
    reviewFindingInstructions(targets, Boolean(verification)),
    COVERAGE_ASK
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------- wrapper 与落盘

async function runSkill(input: string): Promise<SkillResult> {
  return await skill({ skill: "open-code-review-delegate", apply: true, input, echo: true });
}

async function runWorkspaceReview(input: string): Promise<SkillResult> {
  const result = await agent({ input, rules: ["git/review.md"], apply: true, patch: false, echo: true });
  return { kind: "skill", text: result.text };
}

function reviewStatus(state: ReviewState, verification = false): string {
  const findings = state.findings ?? [];
  const open = findings.filter(({ status }) => status === "open" || status === "pending");
  const deferred = findings.filter(({ status }) => status === "deferred");
  const resolved = findings.filter(({ status }) => status === "resolved");
  const pending = open.filter(({ status }) => status === "pending").length;
  const manual = open.filter(({ status, attempt, explicitFix }) => status === "open" && (attempt || explicitFix)).length;
  const verdict = state.findings === undefined || !state.coverageKnown || state.skipped.length
    ? "覆盖尚未确认" : open.length ? "还有待处理问题"
      : verification ? "修复复核通过，当前范围内没有待处理问题" : "通过，当前范围内没有待处理问题";
  return [
    `### 审查状态（第 ${state.round} 轮）`,
    `${verdict}。待修 ${open.length - pending}，待复核 ${pending}，已关闭 ${resolved.length}，延期建议 ${deferred.length}，未审文件 ${state.skipped.length}。`,
    manual ? `${manual} 条需要明确选择后再修。` : "",
    ...[...open, ...deferred, ...resolved].map((item) => `- \`${item.id}\` [${item.status}] \`${item.location}\` ${item.title}${item.status === "open" && item.evidence ? ` — ${item.evidence}` : ""}`)
  ].filter(Boolean).join("\n");
}

async function saveRound(
  current: Snapshot, previous: ReviewState | null, plan: WorkspacePlan, round: number, report: string,
  prior: readonly ReviewFinding[], targets: readonly ReviewFinding[]
): Promise<string> {
  const coverage = readSkipped(report);
  const scope = new Set([...plan.review, ...plan.deps]);
  const skipped = plan.verification ? coverage.paths.filter((path) => scope.has(path)) : coverage.paths;
  const newFindings = readNewFindings(report, scope);
  const added = plan.verification ? (newFindings ?? []).filter((item) => {
    const line = Number(/:(\d+)/u.exec(item.location.slice(item.path.length))?.[1]);
    return plan.verification?.repairs.some((repair) => repair.path === item.path && hasRepairAnchor(repair, line))
      && targets.some(({ id }) => item.detail.includes(id));
  }).map((item): ReviewFinding => ({ ...item, explicitFix: true })) : newFindings;
  const decisions = readDecisions(report, REVIEW_DECISIONS, targets, "resolved");
  if (!coverage.known || skipped.some((path) => !scope.has(path)) || !added || !decisions
    || added.some(({ id, path }) => decisions.has(id) || skipped.includes(path))) {
    return "git.review：报告缺少有效的覆盖或逐条复核记录。本轮未更新审查基线，不能判定通过。";
  }
  const after = await snapshot().catch(() => null);
  if (!after || after.head !== current.head) return "git.review：审查期间 HEAD 或工作区快照无法确认，本轮未更新基线。";
  const drift = changedBetween(current, after);
  const invalidated = plan.verification ? drift.filter((path) => scope.has(path)) : drift;
  if (invalidated.length) return `git.review：审查期间有 ${invalidated.length} 个范围内文件变化，本轮未更新基线。请复核这批现状。`;
  const findings = new Map(prior.map((item) => [item.id, item]));
  for (const item of targets) {
    const decision = decisions.get(item.id)!;
    if (!skipped.includes(item.path)) {
      const paths = item.attempt?.paths ?? [item.path];
      findings.set(item.id, { ...item, status: decision.done ? "resolved" : "open", evidence: decision.evidence,
        attempt: !decision.done && (item.attempt || plan.verification) ? { paths, key: attemptKey(after, paths, decision.evidence) } : undefined });
    }
  }
  for (const item of added) findings.set(item.id, item);
  const outside = new Set(plan.verification?.outside);
  if (plan.verification) for (const path of drift) outside.add(path);
  // Keep the earlier baseline for unrelated edits, including mid-review edits.
  const files = { ...current.files };
  for (const path of outside) {
    const lastReviewed = previous?.files[path];
    if (lastReviewed) files[path] = lastReviewed;
    else delete files[path];
  }
  const notRechecked = plan.verification ? previous?.skipped.filter((path) => !scope.has(path)) ?? [] : [];
  const state: ReviewState = {
    version: STATE_VERSION,
    round,
    mode: plan.mode === "incremental" ? "incremental" : "full",
    head: current.head,
    reviewedAt: new Date().toISOString(),
    files,
    reviewed: [...scope].filter((path) => !skipped.includes(path)),
    carried: plan.carried.filter((path) => !outside.has(path)),
    skipped: [...notRechecked, ...skipped],
    coverageKnown: plan.verification ? previous?.coverageKnown ?? false : true,
    touched: [],
    fixRuns: 0,
    report,
    findings: [...findings.values()],
    repairs: plan.verification && skipped.length ? previous?.repairs : undefined,
    lastVerification: plan.verification ? { ids: [...plan.verification.ids, ...added.map(({ id }) => id)], paths: [...scope] } : undefined
  };
  try {
    await writeState(state, previous);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `git.review：基线没有写进 ${STATE_PATH}（${reason}），本轮未确认审查状态。`;
  }
  if (!plan.verification) return reviewStatus(state);
  const summary = savedVerificationStatus(state);
  return [summary,
    outside.size ? `另有 ${outside.size} 个独立文件变更留待单独审查。` : "",
    !newFindings || newFindings.length !== added.length ? "报告中缺少修复差异锚点的新观察留待单独审查。" : ""
  ].filter(Boolean).join("\n\n");
}

function savedVerificationStatus(state: ReviewState): string {
  const verification = state.lastVerification!;
  const scope = new Set(verification.paths);
  const ids = new Set(verification.ids);
  return reviewStatus({ ...state, coverageKnown: true, skipped: state.skipped.filter((path) => scope.has(path)),
    findings: state.findings?.filter(({ id }) => ids.has(id)) }, true);
}

async function reviewWorkspace(full: boolean): Promise<SkillResult> {
  const current = await snapshot();
  const previous = await readState();
  const plan = await planWorkspace(current, previous, full);
  const round = (previous?.round ?? 0) + 1;

  if (plan.mode === "reuse") {
    const last = previous?.head === current.head ? previous.lastVerification : undefined;
    const changed = last ? changedBetween(previous, current) : [];
    const summary = last && previous
      ? changed.some((path) => last.paths.includes(path)) ? "上次复核范围内有后续改动。" : savedVerificationStatus(previous)
      : plan.carried.length && previous ? reviewStatus(previous) : "";
    const text = [`git.review：${plan.reason}，本轮跳过模型调用。`, summary,
      changed.length ? `有 ${changed.length} 个文件仍待另行审查。要重新审查，运行 review("workspace", true)。` : ""
    ].filter(Boolean).join("\n\n");
    console.log(text);
    return { kind: "skill", text };
  }

  const prior = previous?.head === current.head ? previous.findings ?? [] : [];
  if (plan.mode === "full") {
    const followUp = prior.filter(({ status }) => status === "open" || status === "pending").map(({ path }) => path);
    const skipped = previous?.head === current.head ? previous.skipped : [];
    plan.deps.push(...[...new Set([...skipped, ...followUp])].filter((path) => !current.files[path]));
  }
  const scope = new Set([...plan.review, ...plan.deps]);
  const targets = prior.filter(({ id, path, status }) => plan.verification
    ? plan.verification.ids.has(id) : scope.has(path) && (status === "open" || status === "pending"));
  console.log(`git.review：${describePlan(plan, round, current)}`);
  const input = composeWorkspaceInput(current, plan, round, targets);
  const result = await runWorkspaceReview(input);
  const status = await saveRound(current, previous, plan, round, result.text, prior, targets);
  console.log(status);
  return { ...result, text: `${result.text}\n\n${status}` };
}

// ---------------------------------------------------------------- fix 与 commit 共用

/** `git.fix` 用快照登记修复落点，逐条结论交给下一轮只读复核。 */
export const reviewState = {
  read: readState,
  snapshot,
  wasTried(item: ReviewFinding, current: Snapshot): boolean {
    return item.attempt?.key === attemptKey(current, item.attempt?.paths ?? [], item.evidence);
  },
  async markFixed(previous: ReviewState | null, before: Snapshot | null, targets: readonly ReviewFinding[],
    report: { decisions?: ReadonlyMap<string, { done: boolean; evidence: string }>; claimedPaths: readonly string[] }): Promise<void> {
    if (previous === null) return;
    const after = await snapshot(Boolean(targets.length));
    if (!before || before.head !== previous.head || after.head !== previous.head) throw new Error("修复期间的 HEAD 无法确认");
    const claimed = new Set([...targets.map(({ path }) => path), ...report.claimedPaths]);
    const fresh = changedBetween(before, after).filter((path) => !targets.length || claimed.has(path));
    const touched = [...new Set([...previous.touched, ...fresh])].sort();
    const attempted = new Set(targets.map(({ id }) => id));
    const repairs = (previous.repairs ?? []).filter(({ path }) => !fresh.includes(path));
    let remaining = REPAIR_PROMPT_LIMIT - repairs.reduce((bytes, { hunks }) => bytes + Buffer.byteLength(hunks), 0);
    if (targets.length) for (const path of fresh) {
      if (remaining <= 0) break;
      const hunks = await repairHunks(await capturedFile(before, path), await capturedFile(after, path)).catch(() => "");
      const size = Buffer.byteLength(hunks);
      if (size > 0 && size <= remaining) {
        repairs.push({ path, after: fileStamp(after, path), hunks });
        remaining -= size;
      }
    }
    const findings = previous.findings?.map((item): ReviewFinding => {
      if (!attempted.has(item.id)) return item;
      const decision = report.decisions?.get(item.id);
      const evidence = decision?.evidence ?? "修复执行未返回有效的逐条验证记录。";
      const paths = [...new Set([item.path, ...(item.attempt?.paths ?? []), ...fresh])].sort();
      return { ...item, status: decision?.done ? "pending" : item.status, evidence,
        attempt: { paths, key: attemptKey(after, paths, evidence) } };
    });
    await writeState({ ...previous, touched, fixRuns: previous.fixRuns + 1, findings, repairs }, previous);
    const pending = findings?.filter(({ status }) => status === "pending").length ?? 0;
    console.log(`git.fix：本轮改动 ${fresh.length} 个文件，${pending} 条待复核。${pending ? '下一步运行 review("workspace")。' : "本次修复已结束，请查看各条证据。"}`);
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
 * 审查当前工作区的改动。有修复待验收时优先复核这批问题，完成后复用该批结论。
 * @param full 从当前工作区重新开始全量审查。
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
