/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { ask, terminal, type AskResult, type TerminalResult } from 'dext';

// 流程只有五段：定位起点 → 读取引用类型 → 取改动 → 整理一次 → 组装发布说明。
// 每个 terminal/ask 各占一个具名 wrapper；解析、渲染与告警都在普通 helper 里。
const PACKAGE_PATH = 'package.json';
const CHANGELOG_PATH = 'CHANGELOG.md';
const RULES = ['release/notes.md'];
const GIT_TIMEOUT_MS = 60_000;
const STAT_CHAR_LIMIT = 20_000;
const PATCH_CHAR_LIMIT = 120_000;
const SECTION_CHAR_LIMIT = 24_000;
const MAX_ITEMS = 12;
const MAX_ITEM_CHAR = 300;
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

interface BreakingChange {
  change: string;
  migration: string;
}

interface Draft {
  summary: string;
  highlights: string[];
  breaking: BreakingChange[];
  features: string[];
  fixes: string[];
  notes: string[];
  problems: string[];
}

interface NotesSection {
  heading: string;
  items: string[];
}

interface NotesPackage {
  since: string;
  sinceKind: SinceKind;
  source: SourceFacts;
  stat: string;
  patch: string;
  local: LocalFacts;
}

interface ReportParts {
  since: string;
  sinceKind: SinceKind;
  source: SourceFacts;
  local: LocalFacts;
  draft: Draft;
}

interface ReleaseNotesReport {
  ready: boolean;
  version: string;
  date: string;
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  notes: string;
  sections: NotesSection[];
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
  return `git rev-parse --verify --quiet '${since}^{commit}' && git rev-parse HEAD`;
}

function composeKindCommand(since: string): string {
  return `git rev-parse --symbolic-full-name '${since}'`;
}

function composeStatCommand(commit: string): string {
  return `git --no-pager diff --stat --no-color '${commit}...HEAD'`;
}

function composePatchCommand(commit: string): string {
  return `git --no-pager diff --no-color --unified=3 '${commit}...HEAD'`;
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

async function readPatch(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function draftReleaseNotes(input: string): Promise<AskResult> {
  return ask({ input, rules: RULES });
}

// ---------------------------------------------------------------- 通用解析

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asObject(value: unknown): Record<string, unknown> {
  const object = typeof value === 'object' && value !== null && Array.isArray(value) === false;
  return object ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function composeDraftInput(parts: NotesPackage): string {
  const version = parts.local.versions.version;
  const changelog = parts.local.changelog;
  const first = changelog.firstVersion === '' ? '（无）' : `${changelog.firstVersion}（CHANGELOG.md:${changelog.firstLine}）`;
  const sectionNote = changelog.text === ''
    ? `CHANGELOG.md 中没有 ## ${version} 段落；第一个版本段落是 ${first}。`
    : `CHANGELOG.md:${changelog.sectionLine}-${changelog.sectionEnd}`;
  const statBody = parts.stat.trim() === '' ? '（空）' : limitText(parts.stat, STAT_CHAR_LIMIT);
  const patchBody = parts.patch.trim() === '' ? '（空）' : limitText(parts.patch, PATCH_CHAR_LIMIT);
  const changelogBody = changelog.text === '' ? '（不存在）' : limitText(changelog.text, SECTION_CHAR_LIMIT);
  return [
    `为 ${parts.local.versions.name} ${version} 写 ${parts.local.date} 的发布说明。`,
    '严格按 .dext/rules/release/notes.md 的分类、写法与输出契约返回一个 JSON 对象：不要 markdown 围栏，不要散文，不要额外的顶层键。',
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
    ['## git diff <since>...HEAD', '```diff', patchBody, '```'].join('\n'),
    ['## CHANGELOG 本版段落原文', '```md', changelogBody, '```'].join('\n'),
    [
      '## 输出要求',
      '- 顶层键固定为 summary、highlights、breaking、features、fixes、notes、problems，缺内容用空数组，不要省略键。',
      '- summary 用 2-4 句说明本版最重要的事；highlights 最多 3 条，写升级者最该知道的结论。',
      '- breaking 每项含 change 与 migration；migration 必须是可执行的替换动作，写不出就不要放进 breaking。',
      '- 条目不要带 “- ” 前缀，调用方负责渲染列表；不写版本号、日期与标题。',
      '- problems 只在无法完成整理时填写，非空会让调用方标记这份发布说明需要人工补正。'
    ].join('\n')
  ].join('\n\n');
}

// ---------------------------------------------------------------- 解析整理结果

function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const found = start >= 0 && end > start;
  if (found === false) {
    throw new Error(`整理步骤没有返回 JSON 对象，返回内容开头：${text.slice(0, 400)}`);
  }
  const body = text.slice(start, end + 1);
  try {
    return asObject(JSON.parse(body));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`整理步骤返回的 JSON 无法解析：${reason}；原文开头：${body.slice(0, 400)}`);
  }
}

function normalizeItem(value: string): string {
  const stripped = value.replace(/^[-*]\s+/u, '').trim();
  const short = stripped.length <= MAX_ITEM_CHAR;
  return short ? stripped : `${stripped.slice(0, MAX_ITEM_CHAR)}…`;
}

function readItems(value: unknown): string[] {
  const items: string[] = [];
  for (const entry of asArray(value)) {
    const item = normalizeItem(asString(entry));
    const empty = item === '';
    if (empty) continue;
    const duplicate = items.includes(item);
    if (duplicate) continue;
    if (items.length >= MAX_ITEMS) break;
    items.push(item);
  }
  return items;
}

function readBreaking(value: unknown): BreakingChange[] {
  const items: BreakingChange[] = [];
  for (const entry of asArray(value)) {
    const raw = asObject(entry);
    const change = normalizeItem(asString(raw.change));
    if (change === '') continue;
    if (items.length >= MAX_ITEMS) break;
    items.push({ change, migration: asString(raw.migration) });
  }
  return items;
}

function normalizeDraft(text: string): Draft {
  const raw = parseJsonObject(text);
  return {
    summary: asString(raw.summary),
    highlights: readItems(raw.highlights),
    breaking: readBreaking(raw.breaking),
    features: readItems(raw.features),
    fixes: readItems(raw.fixes),
    notes: readItems(raw.notes),
    problems: asArray(raw.problems).map(asString).filter((item) => item !== '')
  };
}

// ---------------------------------------------------------------- 渲染与告警

function renderBreaking(item: BreakingChange): string {
  const missing = item.migration === '';
  return missing ? `**${item.change}**` : `**${item.change}** — ${item.migration}`;
}

function buildSections(draft: Draft): NotesSection[] {
  const sections: NotesSection[] = [
    { heading: 'Highlights', items: draft.highlights },
    { heading: 'Breaking changes', items: draft.breaking.map(renderBreaking) },
    { heading: 'New features', items: draft.features },
    { heading: 'Fixes', items: draft.fixes },
    { heading: 'Notes', items: draft.notes }
  ];
  return sections.filter((section) => section.items.length > 0);
}

function renderNotes(title: string, summary: string, sections: NotesSection[]): string {
  const lines: string[] = [`# ${title}`, ''];
  if (summary !== '') lines.push(summary, '');
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    for (const item of section.items) lines.push(`- ${item}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

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

function draftWarnings(draft: Draft): string[] {
  const warnings: string[] = [...draft.problems];
  const summaryMissing = draft.summary === '';
  if (summaryMissing) warnings.push('发布说明缺少 summary。');
  const total = draft.highlights.length + draft.breaking.length + draft.features.length + draft.fixes.length + draft.notes.length;
  if (total === 0) warnings.push('本次没有整理出任何用户可见变化，发布说明只有标题。');
  for (const item of draft.breaking) {
    const migrationMissing = item.migration === '';
    if (migrationMissing) warnings.push(`破坏性变更缺少迁移动作：${item.change}`);
  }
  return warnings;
}

function collectWarnings(changelog: ChangelogSection, version: string, draft: Draft, patch: string): string[] {
  const truncated = patch.includes('[output truncated]');
  const truncationWarning = truncated ? ['diff 输出被 terminal 截断，被截断的部分没有进入整理，发布说明可能漏掉变化。'] : [];
  return [...sectionWarnings(changelog, version), ...draftWarnings(draft), ...truncationWarning];
}

// ---------------------------------------------------------------- 组装与汇报

function assembleReport(parts: ReportParts): Omit<ReleaseNotesReport, 'ready' | 'warnings'> {
  const sections = buildSections(parts.draft);
  const title = `${parts.local.versions.name} ${parts.local.versions.version}`;
  return {
    version: parts.local.versions.version,
    date: parts.local.date,
    since: parts.since,
    sinceKind: parts.sinceKind,
    sinceCommit: parts.source.commit,
    notes: renderNotes(title, parts.draft.summary, sections),
    sections
  };
}

/** 返回值在对话里只是一个对象，所以发布说明同时写到 stdout，人才能直接读。 */
function reportOutcome(report: ReleaseNotesReport, ready: boolean): void {
  console.log(report.notes.trimEnd());
  if (ready) {
    console.log(`\nrelease/notes：${report.version}（${report.date}）的发布说明已生成，共 ${report.sections.length} 节。`);
    return;
  }
  console.error(`\nrelease/notes：${report.version} 的发布说明有 ${report.warnings.length} 处需要人工补正：`);
  for (const warning of report.warnings) console.error(`- ${warning}`);
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
  const patchResult = await readPatch(composePatchCommand(source.commit));
  const local = await readLocalFacts();

  const drafted = await draftReleaseNotes(composeDraftInput({
    since,
    sinceKind,
    source,
    stat: stripAnsi(statResult.stdout),
    patch: stripAnsi(patchResult.stdout),
    local
  }));
  const draft = normalizeDraft(drafted.text);
  const report = assembleReport({ since, sinceKind, source, local, draft });
  const warnings = collectWarnings(local.changelog, local.versions.version, draft, patchResult.stdout);
  const ready = warnings.length === 0;
  const finished: ReleaseNotesReport = { ready, ...report, warnings };
  reportOutcome(finished, ready);
  return finished;
}
