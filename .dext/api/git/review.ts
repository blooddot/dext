/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { agent, skill, terminal, type SkillResult } from "dext";
import {
  readDecisions, readDeferredFindings, readLegacyFindings, readNewFindings, readSavedFindings, REVIEW_DECISIONS,
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
const STATE_VERSION = 2;
/** 变动的文件占已审文件的比例超过这个值就退回全量：增量省下的头部开销抵不过逐文件复审。 */
const FULL_RATIO = 0.4;
/** 反向依赖超过这个数量时退回全量：跨文件核对面太宽，一次全量比逐个补更省。 */
const DEP_LIMIT = 8;
/** 限制每条 grep 命令的模式数，保留跨批次的所有导出。 */
const SYMBOL_BATCH_SIZE = 24;
const REPAIR_PROMPT_LIMIT = 48 * 1024;
const REPAIR_CAPTURE_LIMIT = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
const SOURCE_PATTERNS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.vue"];
/** 匹配顶层导出声明和导出列表。列表中的注释可以包含右花括号。 */
const EXPORTED = /^export\b(?:\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)|\s*(?:type\s*)?\{((?:[^/}]|\/(?![*/])|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)*)\})/gmu;
const EXPORT_SPECIFIER = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+(["']?)([A-Za-z_$][\w$]*)\2)?$/u;
const DEFAULT_EXPORT = /^\s*export\s+default\b/mu;
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
  index?: string;
  worktreeMode?: string;
  exports?: string[];
}

interface Snapshot {
  head: string;
  files: Record<string, ChangedFile>;
  root?: string;
  contents?: Map<string, Buffer>;
  headBlobs?: Map<string, string>;
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
  /** 本批报告的回归缺少修复差异锚点，仍需核对的文件。 */
  followUp: string[] | null;
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
    if (!path || path.startsWith(STATE_PREFIX)) continue;
    const prior = files.get(path);
    if (prior) prior.push(code);
    else files.set(path, [code]);
  }
  return files;
}

async function diffEntries(cached: boolean) {
  const raw = await git(`diff ${cached ? "--cached " : ""}--raw --no-abbrev --no-renames -z --`);
  const source = cached ? "暂存区" : "工作区";
  const records = raw.split("\0");
  if (records.pop() !== "" || records.length % 2 !== 0) throw new Error(`${source}输出不完整，无法确认审查范围。`);
  const entries = new Map<string, { raw: string; mode: string; oldBlob: string }>();
  for (let index = 0; index < records.length; index += 2) {
    const [entry, path] = [records[index]!, records[index + 1]!];
    const fields = /^:\d{6} (\d{6}) ([0-9a-f]+) [0-9a-f]+ [A-Z]$/u.exec(entry);
    if (!fields || !path) {
      throw new Error(`${source}输出无效，无法确认审查范围。`);
    }
    entries.set(path, { raw: entry, mode: fields[1]!, oldBlob: fields[2]! });
  }
  return entries;
}

/** HEAD 与全部改动文件的内容哈希。改动清单来自 `git status`，与审查范围同一来源。 */
async function snapshot(capture = false): Promise<Snapshot> {
  const toplevel = (await git("rev-parse --show-toplevel")).trim();
  if (toplevel === "") throw new Error("git.review 需要一个 git 工作区：当前目录不是 git 仓库，或 git 不可用。");
  const porcelain = await git("status --porcelain=v1 --no-renames -z -uall");
  if (porcelain && !porcelain.endsWith("\0")) throw new Error("git status 输出不完整，无法确认审查范围。");
  const [staged, unstaged] = await Promise.all([
    /(?:^|\0)[A-Z][ A-Z] (?!\.dext\/state\/)/u.test(porcelain) ? diffEntries(true) : undefined,
    /(?:^|\0)[ A-Z][A-Z] (?!\.dext\/state\/)/u.test(porcelain) ? diffEntries(false) : undefined
  ]);
  const files: Record<string, ChangedFile> = Object.create(null);
  const headBlobs = new Map<string, string>();
  const contents = capture ? new Map<string, Buffer>() : undefined;
  let captureBytes = 0;
  for (const [path, codes] of dirtied(porcelain)) {
    const absolute = resolve(toplevel, path);
    const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const link = stat?.isSymbolicLink();
    let content: Buffer | null = null;
    if (link) content = await readlink(absolute, { encoding: "buffer" });
    else if (stat?.isFile()) content = await readFile(absolute);
    const digest = content ? createHash("sha256").update(content).digest("hex").slice(0, 16) : "unreadable";
    const hash = link ? `link:${digest}` : digest;
    const stagedEntry = staged?.get(path);
    const worktreeEntry = unstaged?.get(path);
    const original = stagedEntry?.oldBlob ?? worktreeEntry?.oldBlob;
    if (original) headBlobs.set(path, original);
    const names = !link && content ? exportedNames(content.toString("utf8")) : [];
    files[path] = {
      hash, status: codes.sort().join(" + "),
      ...(stagedEntry && { index: stagedEntry.raw }),
      ...(worktreeEntry && { worktreeMode: worktreeEntry.mode }),
      ...(names.length && { exports: names })
    };
    if (contents && content && content.length <= REPAIR_FILE_LIMIT && captureBytes + content.length <= REPAIR_CAPTURE_LIMIT) {
      contents.set(path, content);
      captureBytes += content.length;
    }
  }
  return { head: (await git("rev-parse --verify -q HEAD", true)).trim(), files, root: toplevel, contents, headBlobs };
}

function fileStamp(snapshot: Snapshot, path: string): string {
  const entry = snapshot.files[path];
  if (!entry) return "clean";
  return `${entry.status}:${entry.hash}${entry.index === undefined ? "" : `:${entry.index}`}`
    + (entry.worktreeMode === undefined ? "" : `:${entry.worktreeMode}`);
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
  return [...paths].filter((path) => fileStamp(before, path) !== fileStamp(after, path));
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = asObject(value);
  const files: Record<string, ChangedFile> = Object.create(null);
  for (const [path, entry] of Object.entries(raw)) {
    const file = asObject(entry);
    const hash = asText(file.hash);
    if (hash === "") return null;
    files[path] = {
      hash, status: asText(file.status),
      ...(typeof file.index === "string" && { index: file.index }),
      ...(typeof file.worktreeMode === "string" && { worktreeMode: file.worktreeMode }),
      ...(Array.isArray(file.exports) && { exports: asList(file.exports) })
    };
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
    && (raw.version === 1 || raw.version === STATE_VERSION)
    && typeof round === "number"
    && (mode === "full" || mode === "incremental")
    && typeof raw.report === "string";
  if (valid === false) return null;
  const verification = asObject(raw.lastVerification);
  const lastVerification = Array.isArray(verification.ids) && Array.isArray(verification.paths)
    ? { ids: asList(verification.ids), paths: asList(verification.paths) } : undefined;
  const report = raw.report as string;
  const findings = raw.findings === undefined ? readLegacyFindings(report) : readSavedFindings(raw.findings);
  let followUp = Array.isArray(raw.followUp) ? asList(raw.followUp) : null;
  if (raw.version === 1) {
    // Version 1 mixed independent observations and possible regressions in the same path list.
    // Rebuild the latter from the original verification report and preserve structured observations by ID.
    for (const item of readDeferredFindings(report)) {
      if (findings && !findings.some(({ id }) => id === item.id)) findings.push(item);
    }
    followUp = [];
    if (lastVerification) {
      const reported = readNewFindings(report, new Set(lastVerification.paths));
      followUp = reported ? unconfirmedRegressionPaths(reported, new Set(lastVerification.ids)) : null;
    }
  }
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
    followUp,
    coverageKnown: typeof raw.coverageKnown === "boolean" ? raw.coverageKnown : readSkipped(raw.report as string).known,
    touched: asList(raw.touched),
    fixRuns: typeof raw.fixRuns === "number" ? raw.fixRuns : 0,
    report,
    findings,
    repairs: readRepairDeltas(raw.repairs),
    lastVerification
  };
}

function unconfirmedRegressionPaths(findings: readonly ReviewFinding[], confirmed: ReadonlySet<string>): string[] {
  return findings.filter(({ id, status }) => status === "open" && !confirmed.has(id)).map(({ path }) => path);
}

async function readState(requireValid = false): Promise<ReviewState | null> {
  try {
    const state = readStateValue(await readFile(STATE_PATH, "utf8"));
    if (requireValid && !state) throw new Error('审查记录无法读取。请运行 git.review("workspace", true) 重建基线。');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function commitCoverage(state: ReviewState, current: Snapshot) {
  if (state.head !== current.head || !state.coverageKnown || state.findings === undefined || state.followUp === null) {
    return null;
  }
  const changed = Object.keys(current.files).length ? changedBetween(state, current) : [];
  const unreviewed = [...new Set([...changed, ...state.skipped, ...state.followUp, ...state.touched])].sort();
  const pending = state.findings.filter(({ status }) => status === "pending").map(({ id }) => id);
  const open = state.findings.filter(({ status }) => status === "open").map(({ id }) => id);
  return { unreviewed, pending, open, ready: !unreviewed.length && !pending.length && !open.length };
}

async function requireCommitCoverage(): Promise<void> {
  const state = await readState(true);
  if (!state) return;
  const current = await snapshot();
  if (state.head !== current.head && !Object.keys(current.files).length) return;
  const coverage = commitCoverage(state, current);
  if (!coverage) throw new Error('当前审查基线无法确认。请运行 git.review("workspace", true) 后再提交。');
  const { unreviewed, pending, open, ready } = coverage;
  if (ready) return;
  throw new Error([
    "当前工作区还有审查事项待完成。",
    unreviewed.length ? `待审文件：${unreviewed.join("、")}。` : "",
    pending.length ? `待复核问题：${pending.join("、")}。` : "",
    open.length ? `待处理问题：${open.join("、")}。` : "",
    open.length && !unreviewed.length && !pending.length
      ? "请先处理上述问题，再运行 git.review(\"workspace\")。"
      : '请运行 git.review("workspace") 补审或复核当前改动。'
  ].filter(Boolean).join("\n"));
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

function exportedNames(content: string): string[] {
  const declarations = new Set<string>();
  const aliases = new Set<string>();
  if (DEFAULT_EXPORT.test(content)) declarations.add("default");
  for (const match of content.matchAll(EXPORTED)) {
    const declaration = match[1];
    if (declaration !== undefined) {
      declarations.add(declaration);
      continue;
    }
    const specifiers = match[2]?.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, " ") ?? "";
    for (const specifier of specifiers.split(",")) {
      const exported = EXPORT_SPECIFIER.exec(specifier.trim());
      const name = exported?.[3] ?? exported?.[1];
      if (name) aliases.add(name);
    }
  }
  return [...new Set([...declarations, ...aliases])];
}

/** 删除或重命名导出后，仍要核对使用旧名字的调用方。 */
async function reverseDeps(targets: string[], changed: Set<string>, current: Snapshot, previous: ReviewState): Promise<string[]> {
  const currentPaths = new Set(Object.keys(current.files));
  const moduleTargets = new Set(currentPaths.size ? targets.filter((path) => !currentPaths.has(path) && previous.files[path]
    && SOURCE_PATTERNS.some((pattern) => path.endsWith(pattern.slice(1)))) : []);
  const blobs = new Map<string, Set<string>>();
  const names = new Set<string>();
  const addNames = (path: string, exports: readonly string[]) => {
    for (const name of exports) {
      if (name.length >= 3 && name !== "default") names.add(name);
      else if (currentPaths.size) moduleTargets.add(path);
    }
  };
  for (const path of targets) {
    if (moduleTargets.has(path)) continue;
    const file = current.files[path];
    const prior = previous.files[path];
    const worktree = file ? file.exports ?? [] : exportedNames(await readFile(resolve(current.root ?? ".", path), "utf8").catch(() => ""));
    addNames(path, [...worktree, ...(prior?.exports ?? [])]);
    for (const oid of [current.headBlobs?.get(path), file?.index?.split(" ")[3], prior?.index?.split(" ")[3]]) {
      if (!oid || !/^(?!0+$)(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) continue;
      const paths = blobs.get(oid) ?? new Set<string>();
      paths.add(path);
      blobs.set(oid, paths);
    }
  }
  await Promise.all([...blobs].map(async ([oid, paths]) => {
    const result = await terminal({ command: `git cat-file blob ${oid}`, timeout_ms: GIT_TIMEOUT_MS });
    if (result.exit_code !== 0) return;
    const exports = exportedNames(result.stdout);
    for (const path of paths) addNames(path, exports);
  }));
  const patterns = [...names].filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name))
    .map((name) => `-e "${name.replaceAll("$", "[$]")}"`);
  const pathspecs = SOURCE_PATTERNS.map((pattern) => `"${pattern}"`).join(" ");
  // `--untracked` 与子模块递归互斥，单独搜索未跟踪文件才能保留普通搜索的递归行为。
  const scopes = ["", "--no-recurse-submodules --untracked ", "--cached "];
  const matches = new Set<string>();
  for (let offset = 0; offset < patterns.length; offset += SYMBOL_BATCH_SIZE) {
    const batch = patterns.slice(offset, offset + SYMBOL_BATCH_SIZE).join(" ");
    const results = await Promise.all(scopes.map((scope) => terminal({
      command: `git grep ${scope}--no-color -l -z -w ${batch} -- ${pathspecs}`, timeout_ms: GIT_TIMEOUT_MS
    })));
    for (const result of results) {
      if (result.exit_code === 0) for (const path of result.stdout.split("\0")) matches.add(path);
    }
  }
  if (moduleTargets.size) {
    const { reverseModuleDeps } = await import("./reviewDependencies.ts");
    const callers = await reverseModuleDeps(current.root ?? process.cwd(), moduleTargets, currentPaths, SOURCE_PATTERNS);
    for (const path of callers) matches.add(path);
  }
  return [...matches]
    .filter((path) => path !== "" && !path.startsWith(STATE_PREFIX) && !changed.has(path))
    .sort();
}

/** 全量还是增量不是用户的选项，而是「有没有没审过的内容」的结论。 */
async function planWorkspace(current: Snapshot, previous: ReviewState | null, full: boolean): Promise<WorkspacePlan> {
  const paths = Object.keys(current.files).sort();
  const baseline = previous?.head === current.head ? previous : null;
  const changed = new Set(changedBetween(baseline, current));
  // A clean path can still invalidate coverage for edits that remain in the worktree or index.
  const restored = paths.length ? [...changed].filter((path) => !current.files[path]) : [];
  const whole = async (reason: string, deps?: string[]): Promise<WorkspacePlan> => {
    const callers = deps ?? (baseline && restored.length ? await reverseDeps(restored, new Set(restored), current, baseline) : []);
    return { mode: "full", reason, review: paths, deps: [...new Set([...restored, ...callers])].filter((path) => !current.files[path]), carried: [] };
  };
  const verification = baseline?.findings?.filter(({ path, status }) => status === "pending" || (status === "open" && changed.has(path))) ?? [];
  const followUp = baseline?.followUp ?? [];
  const pendingPaths = [...new Set([...(baseline?.skipped ?? []), ...followUp, ...(baseline?.touched ?? [])])];

  if (paths.length === 0 && verification.length === 0 && pendingPaths.length === 0 && baseline?.followUp !== null) {
    return { mode: "reuse", reason: "工作区相对 HEAD 没有改动", review: [], deps: [], carried: [] };
  }
  if (full) return whole("调用方传入 full = true");
  if (previous === null) return whole("没有可用的上一轮基线（首轮）");
  if (!baseline) {
    return whole(`HEAD 已从 ${short(previous.head)} 变为 ${short(current.head)}，上一轮的逐文件哈希不再可比`);
  }
  if (baseline.followUp === null) return whole("上一轮复核的回归记录无法确认");
  if (verification.length) {
    const related = new Set([...verification.map(({ path }) => path), ...previous.touched]);
    const relatedRestored = restored.filter((path) => related.has(path));
    const otherRelated = [...related].filter((path) => !relatedRestored.includes(path));
    for (const caller of await reverseDeps(relatedRestored, related, current, baseline)) related.add(caller);
    const review = paths.filter((path) => related.has(path));
    const deps = [...related].filter((path) => !current.files[path]);
    const callers = await reverseDeps(otherRelated, related, current, baseline);
    const repairs = previous.repairs?.filter((repair) => related.has(repair.path) && fileStamp(current, repair.path) === repair.after) ?? [];
    const outside = [...paths, ...restored].filter((path) => changed.has(path) && !related.has(path));
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

  const forced = pendingPaths.filter((path) => current.files[path] !== undefined);
  const pending = [...paths.filter((path) => changed.has(path)), ...restored];
  const targets = [...new Set([...pending, ...forced])].sort();
  const extra = pendingPaths.filter((path) => current.files[path] === undefined);
  if (targets.length === 0 && extra.length === 0) {
    const reason = previous.lastVerification ? "上一批修复复核已结束" : `相对第 ${previous.round} 轮没有文件内容变化`;
    return { mode: "reuse", reason, review: [], deps: [], carried: paths };
  }

  const known = Math.max(paths.length, Object.keys(previous.files).length);
  if (targets.length / known > FULL_RATIO) {
    return whole(`${targets.length}/${known} 个文件自上一轮起有变化，超过 ${Math.round(FULL_RATIO * 100)}% 阈值`);
  }
  const deps = [...new Set([...restored, ...extra, ...await reverseDeps(targets, new Set(targets), current, baseline)])];
  if (deps.length > DEP_LIMIT) {
    return whole(`反向依赖 ${deps.length} 个文件，超过 ${DEP_LIMIT} 个阈值`, deps.filter((path) => !current.files[path]));
  }
  return {
    mode: "incremental",
    reason: `${targets.length}/${known} 个文件自上一轮起有变化`,
    review: targets.filter((path) => current.files[path] !== undefined),
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
    verification ? "逐条验收列出的 ID，并核对复核清单中各文件的当前差异。范围内未核对的文件列入「本轮未审文件」。与本批改动及修复无关的具体缺陷写入「另行审查」。哪怕当前没有 Git diff，也按现状复核。候选调用点供按需查证，无需逐一阅读，也不计入覆盖。" : "",
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
      : state.followUp === null || state.followUp.length ? "还有文件待补审"
      : verification ? "修复复核通过，当前范围内没有待处理问题" : "通过，当前范围内没有待处理问题";
  return [
    `### 审查状态（第 ${state.round} 轮）`,
    `${verdict}。待修 ${open.length - pending}，待复核 ${pending}，已关闭 ${resolved.length}，延期建议 ${deferred.length}，未审文件 ${state.skipped.length}。`,
    manual ? `${manual} 条需要明确选择后再修。` : "",
    state.followUp === null ? "上轮复核的回归记录无法确认，请重新全量审查。"
      : state.followUp.length ? `待补审文件：${state.followUp.join("、")}。` : "",
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
  if (!newFindings) return "git.review：报告缺少有效的新发现记录。本轮未更新审查基线。";
  const added = plan.verification ? newFindings.filter((item) => {
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
  for (const item of added) {
    if (plan.verification || findings.get(item.id)?.status !== "deferred") findings.set(item.id, item);
  }
  const deferred = readDeferredFindings(report).filter(({ id }) => !findings.has(id));
  for (const item of deferred) findings.set(item.id, item);
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
  const priorFollowUp = previous?.head === current.head ? previous.followUp ?? [] : [];
  const followUp = [...new Set([
    ...priorFollowUp.filter((path) => plan.verification || !scope.has(path) || skipped.includes(path)),
    ...unconfirmedRegressionPaths(newFindings, new Set(added.map(({ id }) => id)))
  ])].sort();
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
    followUp,
    coverageKnown: plan.verification ? previous?.coverageKnown ?? false : true,
    touched: [],
    fixRuns: 0,
    report,
    findings: [...findings.values()],
    repairs: plan.verification && skipped.length ? previous?.repairs : undefined,
    lastVerification: plan.verification ? { ids: [...plan.verification.ids, ...[...added, ...deferred].map(({ id }) => id)], paths: [...scope] } : undefined
  };
  try {
    await writeState(state, previous);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `git.review：基线没有写进 ${STATE_PATH}（${reason}），本轮未确认审查状态。`;
  }
  const summary = plan.verification ? savedVerificationStatus(state) : reviewStatus(state);
  return [summary,
    outside.size ? `另有 ${outside.size} 个独立文件变更留待单独审查。` : "",
    plan.verification && followUp.length ? `待补审文件：${followUp.join("、")}。` : "",
    commitCoverage(state, after)?.ready ? "本批审查已完成，可以运行 git.commit()。" : ""
  ].filter(Boolean).join("\n\n");
}

function savedVerificationStatus(state: ReviewState): string {
  const verification = state.lastVerification!;
  const scope = new Set(verification.paths);
  const ids = new Set(verification.ids);
  return reviewStatus({ ...state, coverageKnown: true, skipped: state.skipped.filter((path) => scope.has(path)), followUp: [],
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
      changed.length ? `有 ${changed.length} 个文件仍待另行审查。要重新审查，运行 review("workspace", true)。` : "",
      previous && plan.carried.length && commitCoverage(previous, current)?.ready ? "本批审查已完成，可以运行 git.commit()。" : ""
    ].filter(Boolean).join("\n\n");
    console.log(text);
    return { kind: "skill", text };
  }

  const prior = previous?.head === current.head ? previous.findings ?? [] : previous?.findings?.filter(({ status }) => status === "deferred") ?? [];
  if (plan.mode === "full") {
    const followUp = prior.filter(({ status }) => status === "open" || status === "pending").map(({ path }) => path);
    const skipped = previous?.head === current.head ? previous.skipped : [];
    const observations = previous?.head === current.head ? previous.followUp ?? [] : [];
    plan.deps = [...new Set([...plan.deps, ...skipped, ...followUp, ...observations])].filter((path) => !current.files[path]);
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
  requireCommitCoverage,
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
