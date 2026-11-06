/// <reference types="node" />
import { ask, terminal, type AskResult, type TerminalResult } from "dext";
import { readFile } from "node:fs/promises";

// 流程只有五段：定位起点 → 解析引用 → 取改动 → 跑一次判断 → 组装结论。
// 每个 terminal/ask 各占一个具名 wrapper；其余都是不出现在执行流里的纯解析 helper。
const GIT_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 600_000;
const CHECK_COMMAND = "npm run check";
const DEFAULT_BASELINE_PATH = ".dext/release-audit-baseline.md";
const AUDIT_RULES = ["release/audit.md"];
const FILE_LIMIT = 50;
const LINE_LIMIT = 5_000;
const DIFF_CHAR_LIMIT = 120_000;
const SECTION_CHAR_LIMIT = 24_000;
const FILE_LIST_CHAR_LIMIT = 12_000;
const BASELINE_CHAR_LIMIT = 12_000;
const EVIDENCE_CHAR_LIMIT = 1_600;
const SAFE_SINCE = /^[A-Za-z0-9._/@{}~^+-]+$/u;
const ANSI = /\u001b\[[0-9;]*[a-z]/giu;
const STAT_ROW = /^(.+?)\s+\|\s+(?:(\d+)|Bin)\b/u;
const STAT_SUMMARY = /^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/u;
const VERSION_HEADING = /^##\s+(.+?)\s*$/u;
const VERSION_IN_HEADING = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)(?=$|[\s(])/u;
const NON_SOURCE_DIRECTORIES = ["test", "tests", "docs", ".dext", "release", "dist", "media", "node_modules", "vendor", ".vscode-test"];
const NON_SOURCE_FILES = ["package-lock.json", "npm-shrinkwrap.json", "CHANGELOG.md", "README.md", "README.zh-CN.md"];
const NON_SOURCE_EXTENSIONS = ["md", "lock", "snap"];

type Verdict = "pass" | "fail" | "skip";
type SinceKind = "tag" | "branch" | "remote" | "commit";

interface CheckedEntry {
  criterion: string;
  result: Verdict;
  how: string;
}

interface Blocker {
  id: string;
  title: string;
  file: string;
  line: number;
  evidence: string;
  repro: string;
  consequence: string;
  fix: string;
}

interface Advisory {
  id: string;
  title: string;
  file: string;
  line: number;
  note: string;
}

interface ChangelogGap {
  missing: Array<{ change: string; file: string; line: number; evidence: string }>;
  inaccurate: Array<{ claim: string; actual: string; file: string; line: number }>;
  migrationMissing: Array<{ change: string; needs: string }>;
}

interface AuditReport {
  ready: boolean;
  version: string;
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  checked: CheckedEntry[];
  blockers: Blocker[];
  advisories: Advisory[];
  changelogGap: ChangelogGap;
}

/** 审查起点：since 解析出的 commit + HEAD。两者来自同一条 git 命令。 */
interface SourceFacts {
  commit: string;
  head: string;
  usable: boolean;
  onHead: boolean;
  failure: string;
}

interface RefMatches {
  tagCommit: string;
  branchCommit: string;
}

/** 引用形态：kind 只用于回显，refs 只用于同名 tag/branch 提示。 */
interface RefInfo {
  sinceKind: SinceKind;
  refs: RefMatches;
}

interface DiffScope {
  files: string[];
  fileCount: number;
  changedLines: number;
  summary: string;
}

/** 一次 git diff 的两种产物：范围统计与补丁正文。 */
interface DiffDocument {
  scope: DiffScope;
  patch: string;
}

interface VersionHeading {
  version: string;
  line: number;
  endLine: number;
  text: string;
}

interface Versions {
  version: string;
  packageText: string;
  lockPresent: boolean;
  lockBroken: boolean;
  lockTop: string;
  lockTopLine: number;
  lockRoot: string;
  lockRootLine: number;
}

interface ChangelogFacts {
  present: boolean;
  firstVersion: VersionHeading | null;
  packageSection: VersionHeading | null;
  sectionText: string;
  introLine: number;
}

/** 版本、CHANGELOG、baseline 一起读，入口只出现一个本地事实节点。 */
interface LocalFacts {
  versions: Versions;
  changelog: ChangelogFacts;
  baseline: string;
}

interface VersionFact {
  place: string;
  value: string;
  file: string;
  line: number;
}

interface VersionCheck {
  ok: boolean;
  how: string;
  facts: VersionFact[];
  blockers: Blocker[];
}

interface CheckOutcome {
  result: Verdict;
  how: string;
  blocker: Blocker | null;
}

interface SectionCheck {
  ok: boolean;
  how: string;
  blocker: Blocker | null;
}

interface Judgement {
  alignment: { result: Verdict; how: string };
  upgrade: { result: Verdict; how: string };
  netChange: { result: Verdict; how: string };
  blockers: Blocker[];
  advisories: Advisory[];
  changelogGap: ChangelogGap;
}

interface AcceptedEntries {
  positions: Set<string>;
}

interface JudgePackage {
  since: string;
  sinceKind: SinceKind;
  source: SourceFacts;
  scope: DiffScope;
  wide: boolean;
  patch: string;
  local: LocalFacts;
  check: TerminalResult;
  baselinePath: string;
}

interface ReportParts {
  since: string;
  sinceKind: SinceKind;
  source: SourceFacts;
  refInfo: RefInfo;
  scope: DiffScope;
  wide: boolean;
  detail: TerminalResult;
  check: TerminalResult;
  local: LocalFacts;
  judgement: Judgement;
}

// ---------------------------------------------------------------- 命令与 wrapper

function assertSafeSince(since: string): void {
  const safe = SAFE_SINCE.test(since);
  if (safe === false) {
    throw new Error(`since "${since}" 含有不能安全放进 git 命令的字符：只接受 tag、分支、remote 或 commit 里常见的字符（字母、数字与 . _ / @ { } ~ ^ + -）。`);
  }
}

/** 一条命令拿两个 commit：第一个参数无法解析时 && 短路，stdout 为空。 */
function composeResolveCommand(since: string): string {
  assertSafeSince(since);
  return `git rev-parse --verify --quiet "${since}^{commit}" && git rev-parse HEAD`;
}

function composeKindCommand(since: string): string {
  return `git rev-parse --symbolic-full-name "${since}"`;
}

function composeRefCommand(since: string): string {
  return `git show-ref "${since}"`;
}

/** --stat 与 --patch 一起输出：第一次调用就同时给出范围与正文。 */
function composeDiffCommand(commit: string): string {
  return `git --no-pager diff --stat --patch --no-color --unified=3 "${commit}...HEAD"`;
}

/** 范围过大时只把源码文件的补丁交给判断步骤。排除式 pathspec：包含式要枚举上百条路径，超过 Windows 8191 字符的命令行上限，而且 --stat 里的长路径是缩写的（`.../x`），枚举出来根本匹配不到。 */
function composeSourceDiffCommand(commit: string): string {
  const excluded = [
    ...NON_SOURCE_DIRECTORIES.map((directory) => `:(exclude)${directory}/**`),
    ...NON_SOURCE_FILES.map((file) => `:(exclude)${file}`),
    ...NON_SOURCE_EXTENSIONS.map((extension) => `:(exclude)**/*.${extension}`)
  ];
  return `git --no-pager diff --no-color --unified=2 "${commit}...HEAD" -- ${excluded.map((spec) => `"${spec}"`).join(" ")}`;
}

async function resolveSince(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readSinceKind(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readRefMatches(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readDiff(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readSourceDiff(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function runCheckCommand(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: CHECK_TIMEOUT_MS });
}

async function judgeChanges(input: string): Promise<AskResult> {
  return ask({ input, rules: AUDIT_RULES });
}

// ---------------------------------------------------------------- 通用解析

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return 0;
}

function asObject(value: unknown): Record<string, unknown> {
  const object = typeof value === "object" && value !== null && Array.isArray(value) === false;
  return object ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function limitText(value: string, limit: number): string {
  const trimmed = value.trim();
  const short = trimmed.length <= limit;
  return short ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断，原文 ${trimmed.length} 字符）`;
}

function tail(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}

function lineOf(text: string, pattern: RegExp): number {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index + 1;
  }
  return 1;
}

// ---------------------------------------------------------------- 起点与引用

function readSource(result: TerminalResult): SourceFacts {
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  const commit = lines[0] ?? "";
  const head = lines[1] ?? "";
  const usable = commit !== "" && head !== "";
  const onHead = usable && commit === head;
  const detail = result.stderr.trim();
  const suffix = detail === "" ? "" : `；${detail}`;
  const failure = commit === ""
    ? `${result.command} 退出码 ${result.exit_code}，没有解析出 commit${suffix}`
    : `解析出 commit ${commit}，但读不到 HEAD（${result.command} 退出码 ${result.exit_code}）${suffix}`;
  return { commit, head, usable, onHead, failure };
}

function readSinceKindValue(stdout: string): SinceKind {
  const first = stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "");
  if (first === undefined) return "commit";
  if (first.startsWith("refs/tags/")) return "tag";
  if (first.startsWith("refs/heads/")) return "branch";
  if (first.startsWith("refs/remotes/")) return "remote";
  return "commit";
}

function readRefState(stdout: string, since: string): RefMatches {
  const tagRef = `refs/tags/${since}`;
  const branchRef = `refs/heads/${since}`;
  let tagCommit = "";
  let branchCommit = "";
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [commit = "", ref = ""] = trimmed.split(/\s+/u);
    if (ref === tagRef) tagCommit = commit;
    if (ref === branchRef) branchCommit = commit;
  }
  return { tagCommit, branchCommit };
}

function readRefInfo(kindStdout: string, refStdout: string, since: string): RefInfo {
  return { sinceKind: readSinceKindValue(kindStdout), refs: readRefState(refStdout, since) };
}

// ---------------------------------------------------------------- 改动范围

function normalizeStatPath(value: string): string {
  const braced = /\{(.+?)\s+=>\s+(.+?)\}/u.exec(value);
  if (braced !== null) return value.replace(braced[0], braced[2] ?? "");
  const arrow = /^(.*?)\s+=>\s+(.*)$/u.exec(value);
  if (arrow !== null) return (arrow[2] ?? "").trim();
  return value;
}

function readDiffScope(stat: string): DiffScope {
  const lines = stat.split(/\r?\n/u);
  const files: string[] = [];
  let summaryFiles = 0;
  let summaryLines = 0;
  let rowLines = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const summary = STAT_SUMMARY.exec(trimmed);
    if (summary !== null) {
      summaryFiles = Number(summary[1] ?? 0);
      summaryLines = Number(summary[2] ?? 0) + Number(summary[3] ?? 0);
      continue;
    }
    const row = STAT_ROW.exec(line);
    if (row === null) continue;
    const file = normalizeStatPath((row[1] ?? "").trim());
    if (file !== "") files.push(file);
    rowLines += Number(row[2] ?? 0);
  }
  return {
    files,
    fileCount: files.length > 0 ? files.length : summaryFiles,
    changedLines: summaryLines > 0 ? summaryLines : rowLines,
    summary: stat.trim()
  };
}

/** 一次输出拆成范围统计与补丁正文；统计块以空行加 diff --git 结束。 */
function readDiffDocument(stdout: string): DiffDocument {
  const text = stripAnsi(stdout);
  const marker = text.indexOf("\ndiff --git ");
  const hasPatch = marker >= 0;
  const stat = hasPatch ? text.slice(0, marker) : text;
  const patch = hasPatch ? text.slice(marker + 1) : "";
  return { scope: readDiffScope(stat), patch };
}

// ---------------------------------------------------------------- 本地事实

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

async function readOptional(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch {
    return "";
  }
}

async function readVersions(): Promise<Versions> {
  const packageText = await readFile("package.json", "utf8");
  const pkg = safeParse(packageText);
  if (pkg === null) throw new Error("工作区根目录的 package.json 不是合法 JSON，无法读取本次发布版本。");
  const version = asString(pkg.version);
  const missing = version === "";
  if (missing) throw new Error("工作区根目录的 package.json 没有 version 字段，无法确定本次发布版本。");
  const lockText = await readOptional("package-lock.json");
  const lock = lockText === "" ? null : safeParse(lockText);
  const root = lock === null ? {} : asObject(asObject(lock.packages)[""]);
  return {
    version,
    packageText,
    lockPresent: lockText !== "",
    lockBroken: lockText !== "" && lock === null,
    lockTop: lock === null ? "" : asString(lock.version),
    lockTopLine: lockText === "" ? 1 : lineOf(lockText, /"version"\s*:/u),
    lockRoot: asString(root.version),
    lockRootLine: lockText === "" ? 1 : lineOfRootLockVersion(lockText)
  };
}

async function readChangelog(version: string): Promise<ChangelogFacts> {
  const text = await readOptional("CHANGELOG.md");
  const headings = versionHeadings(text);
  const firstVersion = headings.length > 0 ? (headings[0] ?? null) : null;
  const packageSection = headings.find((heading) => heading.version === version) ?? null;
  const introIndex = text.split(/\r?\n/u).findIndex((line) => /all notable changes/iu.test(line));
  return {
    present: text !== "",
    firstVersion,
    packageSection,
    sectionText: packageSection === null ? "" : packageSection.text,
    introLine: introIndex + 1
  };
}

/** 版本、CHANGELOG、baseline 只读这一次，判断与组装共用。 */
async function readLocalFacts(baselineTarget: string): Promise<LocalFacts> {
  const versions = await readVersions();
  const changelog = await readChangelog(versions.version);
  const baseline = await readOptional(baselineTarget);
  return { versions, changelog, baseline };
}

function versionHeadings(text: string): VersionHeading[] {
  const lines = text.split(/\r?\n/u);
  const headings: VersionHeading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = VERSION_HEADING.exec(lines[index] ?? "");
    if (heading === null) continue;
    const version = versionFromHeading(heading[1] ?? "");
    if (version === "") continue;
    const end = sectionEnd(lines, index);
    headings.push({ version, line: index + 1, endLine: end, text: lines.slice(index, end).join("\n") });
  }
  return headings;
}

function versionFromHeading(heading: string): string {
  const match = VERSION_IN_HEADING.exec(heading.trim());
  return match === null ? "" : (match[1] ?? "");
}

function sectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,2}\s+/u.test(line)) return index;
  }
  return lines.length;
}

function lineOfRootLockVersion(text: string): number {
  const start = text.search(/"":\s*\{/u);
  if (start < 0) return 1;
  const match = /"version"\s*:/u.exec(text.slice(start));
  if (match === null) return 1;
  return text.slice(0, start + match.index).split(/\r?\n/u).length;
}

// ---------------------------------------------------------------- 确定性核对

function readVersionFacts(versions: Versions, changelog: ChangelogFacts): VersionFact[] {
  const first = changelog.firstVersion;
  return [
    { place: "package.json 的 version", value: versions.version, file: "package.json", line: lineOf(versions.packageText, /"version"\s*:/u) },
    { place: "package-lock.json 顶层 version", value: versions.lockTop, file: "package-lock.json", line: versions.lockTopLine },
    { place: "package-lock.json 的 packages[\"\"].version", value: versions.lockRoot, file: "package-lock.json", line: versions.lockRootLine },
    { place: "CHANGELOG 第一个版本段落标题的版本号", value: first === null ? "" : first.version, file: "CHANGELOG.md", line: first === null ? 1 : first.line }
  ];
}

function lockVersionBlocker(id: string, fact: VersionFact, version: string, packageLine: number): Blocker {
  const valueText = fact.value === "" ? "（不存在或为空）" : `"${fact.value}"`;
  return {
    id,
    title: `${fact.place} 是 ${valueText}，与 package.json 的 "${version}" 不一致`,
    file: fact.file,
    line: fact.line,
    evidence: `package-lock.json:${fact.line} → ${fact.place} = ${valueText}；package.json:${packageLine} → "version": "${version}"（输入：工作区根目录的 package.json 与 package-lock.json）`,
    repro: "node -p \"require('./package.json').version\"; node -p \"require('./package-lock.json').version\"; node -p \"require('./package-lock.json').packages[''].version\"",
    consequence: `安装与打包用的清单里记录的版本与 package.json 不同，装 ${version} 的用户在包页面、升级提示和 lock 文件里看到的是另一个版本号。`,
    fix: `把该处改成 ${version}，再运行 npm install --package-lock-only 并重新提交 package-lock.json。`
  };
}

function compareVersions(versions: Versions, changelog: ChangelogFacts): VersionCheck {
  const version = versions.version;
  const packageLine = lineOf(versions.packageText, /"version"\s*:/u);
  const facts = readVersionFacts(versions, changelog);
  const blockers: Blocker[] = [];
  if (versions.lockBroken) {
    blockers.push({
      id: "version-lock-unparsable",
      title: "package-lock.json 无法解析，版本一致性无法核对",
      file: "package-lock.json",
      line: 1,
      evidence: `package-lock.json:1 → 文件存在但 JSON 解析失败（输入：工作区根目录的 package-lock.json）`,
      repro: "node -p \"require('./package-lock.json').version\"",
      consequence: `npm 无法按现有 lock 复现安装，装 ${version} 的用户与 CI 拿到的依赖树和发布时不一致。`,
      fix: "修好 package-lock.json 的语法，或删除后运行 npm install --package-lock-only 重新生成。"
    });
  }
  const topWrong = versions.lockBroken === false && versions.lockTop !== version;
  if (topWrong) blockers.push(lockVersionBlocker("version-lock-top", facts[1], version, packageLine));
  const rootWrong = versions.lockBroken === false && versions.lockRoot !== version;
  if (rootWrong) blockers.push(lockVersionBlocker("version-lock-root", facts[2], version, packageLine));
  const lockOk = versions.lockPresent && versions.lockBroken === false && versions.lockTop === version && versions.lockRoot === version;
  const first = changelog.firstVersion;
  const changelogOk = first !== null && first.version === version;
  const how = facts.map((fact) => `${fact.place}=${fact.value === "" ? "（不存在或为空）" : fact.value}`).join("；");
  return { ok: lockOk && changelogOk, how, facts, blockers };
}

function inspectChangelogSection(changelog: ChangelogFacts, version: string): SectionCheck {
  const first = changelog.firstVersion;
  const section = changelog.packageSection;

  if (changelog.present === false) {
    return {
      ok: false,
      how: "工作区根目录没有 CHANGELOG.md",
      blocker: {
        id: "changelog-missing",
        title: "工作区根目录没有 CHANGELOG.md",
        file: "CHANGELOG.md",
        line: 1,
        evidence: "`CHANGELOG.md:1` 读取失败（ENOENT，输入：工作区根目录的 CHANGELOG.md）",
        repro: "ls CHANGELOG.md",
        consequence: `发布 ${version} 时升级者看不到本版改了什么，破坏性改动没有提前告知，也无法判断是否需要迁移。`,
        fix: `新增 CHANGELOG.md，把 \`## ${version}\` 写成本文件的第一个版本段落。`
      }
    };
  }

  if (section === null) {
    const firstText = first === null
      ? "文件中没有任何 `## <version>` 段落"
      : `文件中第一个版本段落是 ${first.version}（CHANGELOG.md:${first.line}）`;
    const line = first === null ? 1 : first.line;
    return {
      ok: false,
      how: `缺少 ## ${version} 段落；${firstText}`,
      blocker: {
        id: "changelog-section-missing",
        title: `CHANGELOG 缺少 ## ${version} 段落`,
        file: "CHANGELOG.md",
        line,
        evidence: `CHANGELOG.md:${line} → ${firstText}；package.json 的 version 是 ${version}（输入：工作区根目录的 CHANGELOG.md 与 package.json）`,
        repro: "grep -n '^## ' CHANGELOG.md | head -n 5",
        consequence: `发布 ${version} 时包页面没有任何本版说明，升级者只能翻 git log，本版的删除与默认值改动不会被提前发现。`,
        fix: `在 Unreleased 与 "All notable changes" 引导行之后新增 \`## ${version}\` 段落，逐条列出本版用户可见变化与破坏性改动。`
      }
    };
  }

  const firstIsSection = first !== null && first.line === section.line;
  if (firstIsSection === false) {
    const firstVersion = first === null ? "（无）" : first.version;
    const firstLine = first === null ? 1 : first.line;
    return {
      ok: false,
      how: `${version} 段落在 CHANGELOG.md:${section.line}，但第一个版本段落是 ${firstVersion}（CHANGELOG.md:${firstLine}）`,
      blocker: {
        id: "changelog-section-order",
        title: `${version} 不是 CHANGELOG 的第一个版本段落`,
        file: "CHANGELOG.md",
        line: section.line,
        evidence: `CHANGELOG.md:${section.line} 是 \`## ${version}\`，而 CHANGELOG.md:${firstLine} 的 ${firstVersion} 排在它前面（输入：CHANGELOG.md 的 ## 标题顺序）`,
        repro: "grep -n '^## ' CHANGELOG.md",
        consequence: `读者与自动化脚本都会把第一个版本段落当成最新版，于是 ${version} 的说明被读成 ${firstVersion}，发布说明指向旧改动。`,
        fix: `把 \`## ${version}\` 段落移到 Unreleased 之后、${firstVersion} 段落之前。`
      }
    };
  }

  const aboveIntro = changelog.introLine > 0 && section.line < changelog.introLine;
  if (aboveIntro) {
    return {
      ok: false,
      how: `${version} 段落位于 "All notable changes" 引导行（CHANGELOG.md:${changelog.introLine}）之上`,
      blocker: {
        id: "changelog-section-position",
        title: `${version} 段落排在 "All notable changes" 引导行之上`,
        file: "CHANGELOG.md",
        line: section.line,
        evidence: `CHANGELOG.md:${section.line} 的 \`## ${version}\` 在 CHANGELOG.md:${changelog.introLine} 的引导行之前（输入：工作区根目录的 CHANGELOG.md）`,
        repro: "grep -n 'All notable changes' CHANGELOG.md",
        consequence: `文件还没说明自己在记录什么就先出现版本明细，段落切分会把引导行并进 ${version} 段落，读者与工具都拿不到稳定的版本边界。`,
        fix: `把 "All notable changes" 引导行移到文件最前面，让 \`## ${version}\` 段落排在它下面。`
      }
    };
  }

  const introNote = changelog.introLine === 0
    ? "文件里没有 \"All notable changes\" 引导行"
    : `位于引导行 CHANGELOG.md:${changelog.introLine} 之后`;
  return {
    ok: true,
    how: `CHANGELOG.md:${section.line} 起是第一个版本段落 ## ${version}，${introNote}`,
    blocker: null
  };
}

function readCheckOutcome(result: TerminalResult, packageText: string): CheckOutcome {
  const seconds = Math.round(result.duration_ms / 1000);
  const how = `${result.command} → 退出码 ${result.exit_code}（${result.status}，${seconds}s）`;
  const passed = result.exit_code === 0;
  if (passed) return { result: "pass", how, blocker: null };
  const output = tail([result.stdout, result.stderr].filter((value) => value.trim() !== "").join("\n"), EVIDENCE_CHAR_LIMIT);
  return {
    result: "fail",
    how,
    blocker: {
      id: "check-command",
      title: `npm run check 失败（退出码 ${result.exit_code}）`,
      file: "package.json",
      line: lineOf(packageText, /"check"\s*:/u),
      evidence: `${result.command} → 退出码 ${result.exit_code}；输出末尾：${output === "" ? "（无输出）" : output}`,
      repro: CHECK_COMMAND,
      consequence: "提交前跑 npm run check 的任何人都看到同一处失败；lint、类型、测试或构建任一未通过时，release/ 里的包会带着该问题，vscode:prepublish 也会在这里中断。",
      fix: "按输出里的第一处报错修到 npm run check 退出码为 0，再重新审查。"
    }
  };
}

// ---------------------------------------------------------------- 判断输入与结果

function composeJudgeInput(parts: JudgePackage): string {
  const changelog = parts.local.changelog;
  const version = parts.local.versions.version;
  const section = changelog.packageSection;
  const first = changelog.firstVersion;
  const sectionBody = section === null
    ? `（CHANGELOG.md 中没有 ## ${version} 段落；第一个版本段落是 ${first === null ? "（无）" : `${first.version}（第 ${first.line} 行）`}）`
    : limitText(section.text, SECTION_CHAR_LIMIT);
  const sectionWhere = section === null ? "缺少本版段落" : `CHANGELOG.md:${section.line}-${section.endLine}`;
  const factLines = readVersionFacts(parts.local.versions, changelog).map((fact) => `- ${fact.place}：${fact.value === "" ? "（不存在或为空）" : fact.value}（${fact.file}:${fact.line}）`);
  const fileLines = parts.scope.files.length === 0
    ? "（git diff --stat 没有给出文件行）"
    : limitText(parts.scope.files.map((file) => `- ${file}`).join("\n"), FILE_LIST_CHAR_LIMIT);
  const baselineBody = parts.local.baseline.trim() === ""
    ? `（${parts.baselinePath} 不存在或为空，本次没有已接受条目）`
    : limitText(parts.local.baseline, BASELINE_CHAR_LIMIT);
  const narrowed = parts.wide
    ? `改动规模超过 ${FILE_LIMIT} 个文件或 ${LINE_LIMIT} 行的阈值，这里只有源码文件的 diff；测试、文档与 lock 文件的改动见上面的 stat 与文件清单。`
    : "三点 diff 全文。";
  const statBody = parts.scope.summary === "" ? "（空）" : limitText(parts.scope.summary, 8_000);
  const checkHow = `${parts.check.command} → 退出码 ${parts.check.exit_code}（${parts.check.status}）`;
  return [
    `你是 Dext 发布前的只读审查员：判断当前 HEAD 是否可以发布为 package.json 里的版本 ${version}。只报告真正阻塞发布的问题。`,
    "严格按 .dext/rules/release/audit.md 的判据与输出契约返回一个 JSON 对象：不要 markdown 围栏，不要散文，不要额外的顶层键。",
    [
      "## 已确定的事实",
      `- since（原样）：${parts.since}`,
      `- 解析结果：kind=${parts.sinceKind}，commit=${parts.source.commit}`,
      `- HEAD：${parts.source.head}`,
      `- 版本（package.json，原样回显）：${version}`,
      `- 改动规模：${parts.scope.fileCount} 个文件，${parts.scope.changedLines} 行（insertions + deletions）`,
      `- 判断拿到的 diff：${narrowed}`,
      `- npm run check：${checkHow}`,
      `- CHANGELOG 本版段落位置：${sectionWhere}`
    ].join("\n"),
    [
      "## 宿主已核对，不要重复报告",
      ...factLines,
      `- git diff 一律三点：git diff ${parts.source.commit}...HEAD`,
      "- version-consistency、check-command、changelog-section 由宿主判定；你只补 changelog-alignment、upgrade-path、net-change，以及代码层面的 blocker 与 advisory。"
    ].join("\n"),
    ["## git diff --stat <since>...HEAD", "```text", statBody, "```"].join("\n"),
    ["## 改动文件（完整清单，含测试、文档与 lock 文件）", fileLines].join("\n"),
    ["## git diff <since>...HEAD", "```diff", limitText(parts.patch, DIFF_CHAR_LIMIT), "```"].join("\n"),
    ["## CHANGELOG 本版段落", "```md", sectionBody, "```"].join("\n"),
    ["## baseline（已接受条目，按位置跳过）", baselineBody].join("\n"),
    [
      "## 输出要求",
      "- 顶层键固定为 alignment、upgrade、netChange、blockers、advisories、changelogGap，缺内容用空数组，不要省略键。",
      "- alignment、upgrade、netChange 都要给出 result（pass/fail/skip）与 how（写明核对了什么）。",
      "- blockers 只放同时写得出 evidence（可复现命令加输出，或 文件:行 加具体输入）、consequence（谁在什么情况下看到什么坏结果）、repro 与 fix 的项；写不出来的降级进 advisories。",
      "- 过程条目进 advisories，并在 note 里注明「应从本版段落删除」。",
      "- 所有 file 都是相对工作区根目录的路径，line 从 1 开始。"
    ].join("\n")
  ].join("\n\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const found = start >= 0 && end > start;
  if (found === false) {
    throw new Error(`判断步骤没有返回 JSON 对象，返回内容开头：${text.slice(0, 400)}`);
  }
  const body = text.slice(start, end + 1);
  try {
    return asObject(JSON.parse(body));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`判断步骤返回的 JSON 无法解析：${reason}；原文开头：${body.slice(0, 400)}`);
  }
}

function readVerdict(raw: Record<string, unknown>, key: string): { result: Verdict; how: string } {
  const entry = asObject(raw[key]);
  const result = entry.result;
  const how = asString(entry.how);
  const valid = result === "pass" || result === "fail" || result === "skip";
  if (valid === false) {
    throw new Error(`判断步骤返回的 JSON 缺少有效的 ${key}.result（pass/fail/skip），审查未完成。`);
  }
  return { result: result as Verdict, how: how === "" ? `${key} 未给出说明` : how };
}

function toBlocker(value: unknown, index: number): Blocker | null {
  const raw = asObject(value);
  const title = asString(raw.title);
  const file = asString(raw.file);
  const line = asNumber(raw.line);
  const evidence = asString(raw.evidence);
  const repro = asString(raw.repro);
  const consequence = asString(raw.consequence);
  const fix = asString(raw.fix);
  const complete = title !== "" && file !== "" && line > 0 && evidence !== "" && repro !== "" && consequence !== "" && fix !== "";
  if (complete === false) return null;
  const id = asString(raw.id);
  return { id: id === "" ? `blocker-${index + 1}` : id, title, file, line, evidence, repro, consequence, fix };
}

function demoteBlocker(value: unknown, index: number): Advisory {
  const raw = asObject(value);
  const title = asString(raw.title);
  const file = asString(raw.file);
  const line = asNumber(raw.line);
  const evidence = asString(raw.evidence);
  const consequence = asString(raw.consequence);
  const missing: string[] = [];
  if (file === "") missing.push("file");
  if (line <= 0) missing.push("line");
  if (evidence === "") missing.push("evidence");
  if (consequence === "") missing.push("consequence");
  if (asString(raw.repro) === "") missing.push("repro");
  if (asString(raw.fix) === "") missing.push("fix");
  const note = [
    `阻断理由不完整（缺少 ${missing.length === 0 ? "可报告的完整字段" : missing.join("/")}），已从 blockers 降级，不计入发布阻塞。`,
    evidence === "" ? "" : `原证据：${evidence}`,
    consequence === "" ? "" : `原后果：${consequence}`
  ].filter((part) => part !== "").join(" ");
  const id = asString(raw.id);
  return {
    id: id === "" ? `demoted-${index + 1}` : `demoted-${id}`,
    title: title === "" ? "判断步骤给出了一条证据不足的阻塞项" : title,
    file,
    line,
    note
  };
}

function toAdvisory(value: unknown, index: number): Advisory | null {
  const raw = asObject(value);
  const title = asString(raw.title);
  const note = asString(raw.note);
  const resolvedTitle = title === "" ? note : title;
  if (resolvedTitle === "") return null;
  const id = asString(raw.id);
  return { id: id === "" ? `advisory-${index + 1}` : id, title: resolvedTitle, file: asString(raw.file), line: asNumber(raw.line), note };
}

function toChangelogGap(raw: Record<string, unknown>): ChangelogGap {
  const missing: ChangelogGap["missing"] = [];
  for (const item of asArray(raw.missing)) {
    const entry = asObject(item);
    const change = asString(entry.change);
    const file = asString(entry.file);
    if (change === "" || file === "") continue;
    missing.push({ change, file, line: Math.max(asNumber(entry.line), 1), evidence: asString(entry.evidence) });
  }
  const inaccurate: ChangelogGap["inaccurate"] = [];
  for (const item of asArray(raw.inaccurate)) {
    const entry = asObject(item);
    const claim = asString(entry.claim);
    const actual = asString(entry.actual);
    if (claim === "" || actual === "") continue;
    inaccurate.push({ claim, actual, file: asString(entry.file), line: asNumber(entry.line) });
  }
  const migrationMissing: ChangelogGap["migrationMissing"] = [];
  for (const item of asArray(raw.migrationMissing)) {
    const entry = asObject(item);
    const change = asString(entry.change);
    const needs = asString(entry.needs);
    if (change === "" || needs === "") continue;
    migrationMissing.push({ change, needs });
  }
  return { missing, inaccurate, migrationMissing };
}

function normalizeJudgement(text: string): Judgement {
  const raw = parseJsonObject(text);
  const blockers: Blocker[] = [];
  const advisories: Advisory[] = [];
  for (const [index, value] of asArray(raw.blockers).entries()) {
    const blocker = toBlocker(value, index);
    if (blocker === null) {
      advisories.push(demoteBlocker(value, index));
    } else {
      blockers.push(blocker);
    }
  }
  for (const [index, value] of asArray(raw.advisories).entries()) {
    const advisory = toAdvisory(value, index);
    if (advisory !== null) advisories.push(advisory);
  }
  return {
    alignment: readVerdict(raw, "alignment"),
    upgrade: readVerdict(raw, "upgrade"),
    netChange: readVerdict(raw, "netChange"),
    blockers,
    advisories,
    changelogGap: toChangelogGap(asObject(raw.changelogGap))
  };
}

// ---------------------------------------------------------------- baseline 与附加提示

function readAccepted(text: string): AcceptedEntries {
  const positions = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const bullet = trimmed.startsWith("-") || trimmed.startsWith("*");
    if (bullet === false) continue;
    const match = /([\w@./-]+):(\d+)/u.exec(trimmed);
    if (match === null) continue;
    positions.add(`${match[1]}:${Number(match[2])}`);
  }
  return { positions };
}

function dropAccepted<T extends { file: string; line: number }>(items: T[], accepted: AcceptedEntries): T[] {
  return items.filter((item) => accepted.positions.has(`${item.file}:${item.line}`) === false);
}

function collectBlockers(...items: Array<Blocker | null>): Blocker[] {
  return items.filter((item): item is Blocker => item !== null);
}

function refAdvisories(since: string, refs: RefMatches): Advisory[] {
  const ambiguous = refs.tagCommit !== "" && refs.branchCommit !== "";
  if (ambiguous === false) return [];
  return [
    {
      id: "ambiguous-short-ref",
      title: `"${since}" 同时是 tag 与分支名，git 按 tag 解析`,
      file: "",
      line: 0,
      note: `refs/tags/${since}（${refs.tagCommit}）与 refs/heads/${since}（${refs.branchCommit}）都存在；git rev-parse "${since}^{commit}" 按 tag 解析到 ${refs.tagCommit}。建议改传完整 ref，例如 refs/tags/${since}。该提示不影响任何判据。`
    }
  ];
}

function scopeAdvisories(scope: DiffScope, wide: boolean, detail: TerminalResult): Advisory[] {
  const advisories: Advisory[] = [];
  if (wide) {
    advisories.push({
      id: "large-diff",
      title: `改动 ${scope.fileCount} 个文件 / ${scope.changedLines} 行，判断只收到源码 diff`,
      file: "",
      line: 0,
      note: `本次改动超过 ${FILE_LIMIT} 个文件或 ${LINE_LIMIT} 行的阈值：判断步骤只看源码文件（排除测试、文档、lock 与产物）的 diff，测试、文档、lock 文件的改动仍记录在 stat 与文件清单里供 changelog-alignment 使用；范围外的细节需要本地跑 git diff <since>...HEAD 复核。`
    });
  }
  const truncated = detail.stdout.includes("[output truncated]");
  if (truncated) {
    advisories.push({
      id: "diff-truncated",
      title: "diff 输出被 terminal 截断",
      file: "",
      line: 0,
      note: "terminal() 最多保留 256 KiB 输出，本次 diff 在中间被截断；被截断的部分没有进入判断，需要本地跑 git diff <since>...HEAD 复核。"
    });
  }
  return advisories;
}

function alignmentHow(judgement: Judgement): string {
  const gap = judgement.changelogGap;
  const counts = `changelogGap：missing ${gap.missing.length} 条，inaccurate ${gap.inaccurate.length} 条，migrationMissing ${gap.migrationMissing.length} 条`;
  return `${judgement.alignment.how}；${counts}`;
}

/** 返回值在对话里只是一段 JSON，所以报告同时写到 stdout，人才能直接读。 */
function reportOutcome(report: Omit<AuditReport, "ready">, ready: boolean): void {
  const headline = ready
    ? `release/audit：${report.version} 没有阻塞发布的问题。`
    : `release/audit：${report.version} 有 ${report.blockers.length} 个阻塞发布的问题。`;
  const blockers = report.blockers.flatMap((blocker) => [
    `- [${blocker.id}] ${blocker.title}（${blocker.file}:${blocker.line}）`,
    `  后果：${blocker.consequence}`,
    `  修复：${blocker.fix}`
  ]);
  const advisories = report.advisories.map((advisory) => {
    const where = advisory.line > 0 ? `（${advisory.file}:${advisory.line}）` : "";
    return `- 建议 [${advisory.id}] ${advisory.title}${where}`;
  });
  const verdicts = report.checked.map((item) => `${item.criterion}=${item.result}`).join("、");
  console.log([headline, ...blockers, ...advisories, `检查项：${verdicts}`].join("\n"));
}

// ---------------------------------------------------------------- 组装

/** 把采集到的事实与一次判断合成返回值；ready 由入口按 blockers 计算。 */
function assembleReport(parts: ReportParts): Omit<AuditReport, "ready"> {
  const versionCheck = compareVersions(parts.local.versions, parts.local.changelog);
  const sectionCheck = inspectChangelogSection(parts.local.changelog, parts.local.versions.version);
  const check = readCheckOutcome(parts.check, parts.local.versions.packageText);
  const accepted = readAccepted(parts.local.baseline);
  const deterministic = collectBlockers(check.blocker, sectionCheck.blocker, ...versionCheck.blockers);
  const blockers = dropAccepted([...deterministic, ...parts.judgement.blockers], accepted);
  const advisories = dropAccepted([
    ...parts.judgement.advisories,
    ...refAdvisories(parts.since, parts.refInfo.refs),
    ...scopeAdvisories(parts.scope, parts.wide, parts.detail)
  ], accepted);
  const checked: CheckedEntry[] = [
    { criterion: "check-command", result: check.result, how: check.how },
    { criterion: "version-consistency", result: versionCheck.ok ? "pass" : "fail", how: versionCheck.how },
    { criterion: "changelog-section", result: sectionCheck.ok ? "pass" : "fail", how: sectionCheck.how },
    { criterion: "changelog-alignment", result: parts.judgement.alignment.result, how: alignmentHow(parts.judgement) },
    { criterion: "upgrade-path", result: parts.judgement.upgrade.result, how: parts.judgement.upgrade.how },
    { criterion: "net-change", result: parts.judgement.netChange.result, how: parts.judgement.netChange.how }
  ];
  return {
    version: parts.local.versions.version,
    since: parts.since,
    sinceKind: parts.sinceKind,
    sinceCommit: parts.source.commit,
    checked,
    blockers,
    advisories,
    changelogGap: parts.judgement.changelogGap
  };
}

// ---------------------------------------------------------------- 入口

export async function audit(since: string, baselinePath?: string): Promise<AuditReport> {
  const baselineTarget = baselinePath ?? DEFAULT_BASELINE_PATH;

  const sourceResult = await resolveSince(composeResolveCommand(since));
  const source = readSource(sourceResult);
  if (source.usable === false) {
    throw new Error(`无法确定审查起点：${source.failure}`);
  }
  if (source.onHead) {
    throw new Error(`since "${since}" 解析到的就是 HEAD（${source.commit}），三点 diff 为空，审查会得到空的通过结论。请传更早的 tag、分支或 commit。`);
  }

  const kindResult = await readSinceKind(composeKindCommand(since));
  const refResult = await readRefMatches(composeRefCommand(since));
  const refInfo = readRefInfo(kindResult.stdout, refResult.stdout, since);

  const diffResult = await readDiff(composeDiffCommand(source.commit));
  const document = readDiffDocument(diffResult.stdout);
  const scope = document.scope;
  const wide = scope.fileCount > FILE_LIMIT || scope.changedLines > LINE_LIMIT;
  let detail = diffResult;
  if (wide) {
    detail = await readSourceDiff(composeSourceDiffCommand(source.commit));
  }
  const patch = wide ? detail.stdout : document.patch;

  const local = await readLocalFacts(baselineTarget);
  const check = await runCheckCommand(CHECK_COMMAND);

  const raw = await judgeChanges(composeJudgeInput({
    since,
    sinceKind: refInfo.sinceKind,
    source,
    scope,
    wide,
    patch,
    local,
    check,
    baselinePath: baselineTarget
  }));
  const judgement = normalizeJudgement(raw.text);

  const report = assembleReport({
    since,
    sinceKind: refInfo.sinceKind,
    source,
    refInfo,
    scope,
    wide,
    detail,
    check,
    local,
    judgement
  });
  const ready = report.blockers.length === 0;
  reportOutcome(report, ready);
  return { ready, ...report };
}
