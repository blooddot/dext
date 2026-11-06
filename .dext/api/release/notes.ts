/// <reference types="node" />
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { template, terminal, type TemplateResult, type TerminalResult } from 'dext';

// 流程只有五段：定位起点 → 读取引用类型 → 取改动 → 渲染模板 → 写文件并汇报。
// 结构由 .dext/templates/release/notes.md 决定，模型只填字段，代码不拼 markdown。
const PACKAGE_PATH = 'package.json';
const CHANGELOG_PATH = 'CHANGELOG.md';
const NOTES_DIR = 'docs/releases';
const NOTES_TEMPLATE = '.dext/templates/release/notes.md';
const RULES = ['release/notes.md'];
const GIT_TIMEOUT_MS = 60_000;
const STAT_CHAR_LIMIT = 20_000;
const PATCH_CHAR_LIMIT = 120_000;
/** terminal 只给 256 KiB，超预算的 patch 会被从中间截断；此时改用同样体积很小的 commit 列表。 */
const LARGE_CHANGE_LINES = 2_000;
const SECTION_CHAR_LIMIT = 24_000;
const CHURN = /(\d+) (?:insertion|deletion)s?\([+-]\)/gu;
const PLACEHOLDER_LEFT = /\{\{[^}]+\}\}/u;
const SAFE_SINCE = /^[A-Za-z0-9._/@{}~^+-]+$/u;
const ANSI = /\u001b\[[0-9;]*[a-z]/giu;
const VERSION_HEADING = /^##\s+(.+?)\s*$/u;
const VERSION_IN_HEADING = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)(?=$|[\s(])/u;

type SinceKind = 'tag' | 'branch' | 'remote' | 'commit';

interface SourceFacts {
  commit: string;
  head: string;
  usable: boolean;
  onHead: boolean;
  failure: string;
}

interface Versions {
  name: string;
  version: string;
}

interface ChangelogSection {
  present: boolean;
  firstVersion: string;
  firstLine: number;
  sectionLine: number;
  sectionEnd: number;
  text: string;
}

interface LocalFacts {
  versions: Versions;
  changelog: ChangelogSection;
  date: string;
}

interface NotesPackage {
  since: string;
  sinceKind: SinceKind;
  source: SourceFacts;
  stat: string;
  changes: ChangeEvidence;
  local: LocalFacts;
}

interface ChangeEvidence {
  heading: string;
  body: string;
}

interface ReleaseNotesReport {
  ready: boolean;
  version: string;
  date: string;
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  notes: string;
  path: string;
  warnings: string[];
}

interface VersionHeading {
  version: string;
  line: number;
  endLine: number;
  text: string;
}

// ---------------------------------------------------------------- 命令与 wrapper

function assertSafeSince(since: string): void {
  const empty = since.trim() === '';
  if (empty) throw new Error('对比起点不能为空。');
  const optionLike = since.startsWith('-');
  if (optionLike) throw new Error(`对比起点不能以 “-” 开头：${since}`);
  const unsafe = SAFE_SINCE.test(since) === false;
  if (unsafe) throw new Error(`对比起点含不能安全放进 git 命令的字符：${since}`);
}

/** 一条命令拿两个 commit：第一个参数无法解析时 && 短路，stdout 为空。 */
function composeResolveCommand(since: string): string {
  assertSafeSince(since);
  return `git rev-parse --verify --quiet "${since}^{commit}" && git rev-parse HEAD`;
}

function composeKindCommand(since: string): string {
  return `git rev-parse --symbolic-full-name "${since}"`;
}

function composeStatCommand(commit: string): string {
  return `git --no-pager diff --stat --no-color "${commit}...HEAD"`;
}

function composePatchCommand(commit: string): string {
  return `git --no-pager diff --no-color --unified=3 "${commit}...HEAD"`;
}

function composeLogCommand(commit: string): string {
  return `git --no-pager log --oneline --no-merges "${commit}..HEAD"`;
}

/** 统计行里的增删行数之和，用来决定送 diff 还是送 commit 列表。 */
function changeLines(stat: string): number {
  let total = 0;
  for (const match of stat.matchAll(CHURN)) total += Number(match[1]);
  return total;
}

async function resolveSource(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readKind(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readStat(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function readChanges(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function renderNotes(title: string, input: string): Promise<TemplateResult> {
  return template({ source: NOTES_TEMPLATE, values: { title }, input, rules: RULES });
}

// ---------------------------------------------------------------- 通用解析

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value: unknown): Record<string, unknown> {
  const object = typeof value === 'object' && value !== null && Array.isArray(value) === false;
  return object ? (value as Record<string, unknown>) : {};
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

function limitText(value: string, limit: number): string {
  const trimmed = value.trim();
  const short = trimmed.length <= limit;
  return short ? trimmed : `${trimmed.slice(0, limit)}\n…（已截断，共 ${trimmed.length} 字符）`;
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------- 起点与引用

function readSource(result: TerminalResult): SourceFacts {
  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
  const commit = lines[0] ?? '';
  const head = lines[1] ?? '';
  const usable = commit !== '' && head !== '';
  const onHead = usable && commit === head;
  const detail = result.stderr.trim();
  const suffix = detail === '' ? '' : `；${detail}`;
  const failure = commit === ''
    ? `${result.command} 退出码 ${result.exit_code}，没有解析出 commit${suffix}`
    : `解析出 commit ${commit}，但读不到 HEAD（${result.command} 退出码 ${result.exit_code}）${suffix}`;
  return { commit, head, usable, onHead, failure };
}

function kindFromSymbolic(stdout: string): SinceKind {
  const first = stdout.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '');
  if (first === undefined) return 'commit';
  if (first.startsWith('refs/tags/')) return 'tag';
  if (first.startsWith('refs/heads/')) return 'branch';
  if (first.startsWith('refs/remotes/')) return 'remote';
  return 'commit';
}

// ---------------------------------------------------------------- 本地事实

async function readOptional(target: string): Promise<string> {
  try {
    return await readFile(target, 'utf8');
  } catch {
    return '';
  }
}

async function readVersions(): Promise<Versions> {
  const text = await readFile(PACKAGE_PATH, 'utf8');
  const pkg = safeParse(text);
  if (pkg === null) throw new Error(`${PACKAGE_PATH} 不是合法 JSON，无法确定本次发布的版本。`);
  const version = asString(pkg.version);
  if (version === '') throw new Error(`${PACKAGE_PATH} 缺少 version 字段，无法确定本次发布的版本。`);
  const displayName = asString(pkg.displayName);
  const name = displayName === '' ? asString(pkg.name) : displayName;
  return { name: name === '' ? 'Release' : name, version };
}

async function readChangelog(version: string): Promise<ChangelogSection> {
  const text = await readOptional(CHANGELOG_PATH);
  const headings = versionHeadings(text);
  const first = headings[0] ?? null;
  const section: VersionHeading | null = headings.find((heading) => heading.version === version) ?? null;
  return {
    present: text !== '',
    firstVersion: first === null ? '' : first.version,
    firstLine: first === null ? 1 : first.line,
    sectionLine: section === null ? 1 : section.line,
    sectionEnd: section === null ? 1 : section.endLine,
    text: section === null ? '' : section.text
  };
}

/** 版本、CHANGELOG 与日期只读这一次，整理与组装共用。 */
async function readLocalFacts(): Promise<LocalFacts> {
  const versions = await readVersions();
  const changelog = await readChangelog(versions.version);
  return { versions, changelog, date: localDate(new Date()) };
}

function versionHeadings(text: string): VersionHeading[] {
  const lines = text.split(/\r?\n/u);
  const headings: VersionHeading[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = VERSION_HEADING.exec(lines[index] ?? '');
    if (heading === null) continue;
    const version = versionFromHeading(heading[1] ?? '');
    if (version === '') continue;
    const end = sectionEnd(lines, index);
    headings.push({ version, line: index + 1, endLine: end, text: lines.slice(index, end).join('\n') });
  }
  return headings;
}

function versionFromHeading(heading: string): string {
  const match = VERSION_IN_HEADING.exec(heading.trim());
  return match === null ? '' : (match[1] ?? '');
}

function sectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^#{1,2}\s+/u.test(line)) return index;
  }
  return lines.length;
}

// ---------------------------------------------------------------- 整理输入

function composeNotesInput(parts: NotesPackage): string {
  const version = parts.local.versions.version;
  const changelog = parts.local.changelog;
  const first = changelog.firstVersion === '' ? '（无）' : `${changelog.firstVersion}（CHANGELOG.md:${changelog.firstLine}）`;
  const sectionNote = changelog.text === ''
    ? `CHANGELOG.md 中没有 ## ${version} 段落；第一个版本段落是 ${first}。`
    : `CHANGELOG.md:${changelog.sectionLine}-${changelog.sectionEnd}`;
  const statBody = parts.stat.trim() === '' ? '（空）' : limitText(parts.stat, STAT_CHAR_LIMIT);
  const changesBody = parts.changes.body.trim() === '' ? '（空）' : limitText(parts.changes.body, PATCH_CHAR_LIMIT);
  const changelogBody = changelog.text === '' ? '（不存在）' : limitText(changelog.text, SECTION_CHAR_LIMIT);
  return [
    `写 ${parts.local.date} 的中英双语发布说明：表格字段值按 .dext/templates/release/notes.md 的字段说明填写，结构由模板渲染，你不要自己写标题、节名或列表符号。`,
    '分类与写法按 .dext/rules/release/notes.md：CHANGELOG 本版段落是主要来源，diff 用于核对。',
    [
      '## 已确定的事实',
      `- 版本：${version}`,
      `- 日期：${parts.local.date}`,
      `- since（原样）：${parts.since}`,
      `- 解析结果：kind=${parts.sinceKind}，commit=${parts.source.commit}`,
      `- HEAD：${parts.source.head}`,
      `- CHANGELOG 本版段落位置：${sectionNote}`
    ].join('\n'),
    ['## git diff --stat <since>...HEAD', '```text', statBody, '```'].join('\n'),
    ['## ' + parts.changes.heading, '```text', changesBody, '```'].join('\n'),
    ['## CHANGELOG 本版段落原文', '```md', changelogBody, '```'].join('\n')
  ].join('\n\n');
}

// ---------------------------------------------------------------- 告警

function sectionWarnings(changelog: ChangelogSection, version: string): string[] {
  if (changelog.present === false) {
    return [`工作区根目录没有 ${CHANGELOG_PATH}，发布说明只能依据 diff 整理。`];
  }
  if (changelog.text === '') {
    const first = changelog.firstVersion === ''
      ? '文件中没有任何版本段落'
      : `第一个版本段落是 ${changelog.firstVersion}（${CHANGELOG_PATH}:${changelog.firstLine}）`;
    return [`${CHANGELOG_PATH} 缺少 ## ${version} 段落，${first}；发布说明只能依据 diff 整理。`];
  }
  if (changelog.firstVersion !== version) {
    return [`${version} 不是 ${CHANGELOG_PATH} 的第一个版本段落（第一个是 ${changelog.firstVersion}，第 ${changelog.firstLine} 行），发布说明可能写的是旧版内容。`];
  }
  return [];
}

function collectWarnings(changelog: ChangelogSection, version: string, changes: string): string[] {
  const truncated = changes.includes('[output truncated]');
  const truncationWarning = truncated ? ['diff 输出被 terminal 截断，被截断的部分没有进入整理，发布说明可能漏掉变化。'] : [];
  return [...sectionWarnings(changelog, version), ...truncationWarning];
}

// ---------------------------------------------------------------- 入口

export async function notes(since: string): Promise<ReleaseNotesReport> {
  const sourceResult = await resolveSource(composeResolveCommand(since));
  const source = readSource(sourceResult);
  if (source.usable === false) {
    throw new Error(`无法确定发布说明的对比起点：${source.failure}`);
  }
  if (source.onHead) {
    throw new Error(`对比起点 ${since} 解析到的就是 HEAD（${source.commit}），三点 diff 为空，发布说明会没有内容。请传更早的 tag、分支或 commit。`);
  }

  const kindResult = await readKind(composeKindCommand(since));
  const sinceKind = kindFromSymbolic(kindResult.stdout);
  const statResult = await readStat(composeStatCommand(source.commit));
  const stat = stripAnsi(statResult.stdout);
  const large = changeLines(stat) > LARGE_CHANGE_LINES;
  const changeResult = await readChanges(large ? composeLogCommand(source.commit) : composePatchCommand(source.commit));
  const local = await readLocalFacts();
  const changes = {
    heading: large ? `git log --oneline --no-merges ${since}..HEAD（${since}...HEAD 改动超出 diff 预算，未附 diff）` : `git diff ${since}...HEAD`,
    body: stripAnsi(changeResult.stdout)
  };

  const title = `${local.versions.name} ${local.versions.version}`;
  const rendered = await renderNotes(title, composeNotesInput({ since, sinceKind, source, stat, changes, local }));
  const notesText = rendered.text.trim();
  // 模板的自检：占位符没填完说明模型漏了字段，宁可不写文件也不写出半成品。
  if (notesText === '' || PLACEHOLDER_LEFT.test(notesText)) {
    throw new Error(`模板 ${NOTES_TEMPLATE} 渲染结果为空或仍有未填字段：${notesText.slice(0, 400)}`);
  }

  const warnings = collectWarnings(local.changelog, local.versions.version, changes.body);
  const ready = warnings.length === 0;
  const path = `${NOTES_DIR}/${local.versions.version}.md`;
  await mkdir(NOTES_DIR, { recursive: true });
  await writeFile(path, `${notesText}\n`, 'utf8');
  const report: ReleaseNotesReport = {
    ready,
    version: local.versions.version,
    date: local.date,
    since,
    sinceKind,
    sinceCommit: source.commit,
    notes: notesText,
    path,
    warnings
  };
  reportOutcome(report, ready);
  return report;
}

function reportOutcome(report: ReleaseNotesReport, ready: boolean): void {
  console.log(report.notes);
  if (ready) {
    console.log(`\nrelease/notes：${report.version}（${report.date}）的中英双语发布说明已写入 ${report.path}。`);
    return;
  }
  console.error(`\nrelease/notes：${report.version} 的发布说明有 ${report.warnings.length} 处需要人工补正：`);
  for (const warning of report.warnings) console.error(`- ${warning}`);
}
