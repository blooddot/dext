/// <reference types="node" />
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { ask, terminal, type AskResult, type TerminalResult } from 'dext';

const CHANGELOG_PATH = 'CHANGELOG.md';
const PACKAGE_PATH = 'package.json';
const HEAD_COMMAND = 'git rev-parse HEAD';
const RULES = ['release-changelog.md'];
const GIT_TIMEOUT_MS = 60000;
const MAX_ENTRY_LENGTH = 150;
const MAX_ENTRIES = 60;
const MAX_REPORT_ENTRY = 200;
const MAX_DIFF_LENGTH = 120000;
const MAX_STAT_LENGTH = 20000;
const LEAD_MARKER = 'all notable changes';
const UNRELEASED_HEADING = '## Unreleased';
const VERSION_HEADING = /^## [0-9]+[.][0-9]+[.][0-9]+(?: |$)/u;
const VERSION_IN_HEADING = /^##\s+v?([0-9]+[.][0-9]+[.][0-9]+)/u;
const TAG_COMMAND = 'git tag --list';
const SAFE_SINCE = /^[A-Za-z0-9._/@{}~^+-]+$/u;

type SinceKind = 'tag' | 'branch' | 'remote' | 'commit';

interface ReportEntry {
  entry: string;
  reason: string;
}

interface HumanEntry {
  entry: string;
  question: string;
}

interface ChangelogReport {
  version: string;
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  written: boolean;
  path: string;
  insertedSection: string;
  replacedUnreleased: boolean;
  updatedExistingSection: boolean;
  unchanged: boolean;
  absorbedOrphanSections: string[];
  previousVersionHeading: string;
  dropped: ReportEntry[];
  archiveCandidates: ReportEntry[];
  needsHuman: HumanEntry[];
  problems: string[];
}

interface Range {
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  stat: string;
  diff: string;
}

interface Context {
  before: { text: string; hash: string };
  version: string;
  date: string;
  heading: string;
  layout: ChangelogLayout;
}

interface WritePlan {
  draft: Draft;
  heading: string;
  section: string;
  nextText: string;
  updated: boolean;
  unchanged: boolean;
  problems: string[];
}

/** 一次写入的结论：写入、已是最新、或带着问题未写入。 */
interface OutcomeReport {
  heading: string;
  section: string;
  written: boolean;
  unchanged: boolean;
  problems: string[];
  dryRun: boolean;
}

interface Draft {
  entries: string[];
  dropped: ReportEntry[];
  archiveCandidates: ReportEntry[];
  needsHuman: HumanEntry[];
  problems: string[];
}

interface ChangelogSection {
  heading: string;
  start: number;
  end: number;
  text: string;
}

/** 一个 `## ` 段落正文，外加它是否落在引导行上方（引导行上方的段落本身是畸形数据）。 */
interface RawSection extends ChangelogSection {
  aboveLead: boolean;
}

/** 带版本号的段落：`## 0.1.2 - 2026-11-03` 与 `## 0.1.2` 都算同一个版本的段落。 */
interface VersionSection extends ChangelogSection {
  version: string;
}

/** 本版段落的定位结果：`count` 大于 1 表示文件里有重复的本版段落。 */
interface VersionTarget {
  section: VersionSection | null;
  count: number;
}

interface ChangelogLayout {
  leadIndex: number;
  unreleased: ChangelogSection | null;
  orphans: ChangelogSection[];
  versions: VersionSection[];
  firstVersionHeading: string;
  headings: string[];
}

interface AskMaterial {
  version: string;
  date: string;
  since: string;
  sinceKind: SinceKind;
  sinceCommit: string;
  stat: string;
  diff: string;
  unreleased: string;
  orphans: string;
  currentSection: string;
}

function composeCommitCommand(since: string): string {
  return `git rev-parse --verify --quiet "${since}^{commit}"`;
}

function composeKindCommand(since: string): string {
  return `git rev-parse --symbolic-full-name "${since}"`;
}

function composeStatCommand(commit: string): string {
  return `git --no-pager diff --stat --no-color "${commit}...HEAD"`;
}

function composeDiffCommand(commit: string): string {
  return `git --no-pager diff --no-color --unified=3 "${commit}...HEAD"`;
}

async function runTerminal(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
}

async function listTags(): Promise<TerminalResult> {
  return terminal({ command: TAG_COMMAND, timeout_ms: GIT_TIMEOUT_MS });
}

/** 本版是否已经打过 tag：已发布的段落不再改写，返回 tag 名，未发布返回空串。 */
async function probeReleaseTag(version: string): Promise<string> {
  const result = await listTags();
  const unreadable = result.exit_code !== 0;
  if (unreadable) {
    const detail = result.stderr.trim();
    throw new Error(`无法读取 tag 列表：${TAG_COMMAND} → 退出码 ${result.exit_code}${detail === '' ? '' : `；${detail}`}`);
  }
  const names = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return names.find((name) => name === version || name === `v${version}`) ?? '';
}

async function composeSection(input: string): Promise<AskResult> {
  return ask({ input, rules: RULES });
}

async function resolveRange(since: string): Promise<Range> {
  const sinceResult = await runTerminal(composeCommitCommand(since));
  const sinceCommit = sinceResult.stdout.trim();
  const unresolved = sinceResult.exit_code !== 0 || sinceCommit === '';
  if (unresolved) {
    const detail = sinceResult.stderr.trim();
    throw new Error(`无法把对比起点 ${since} 解析成 commit：${sinceResult.command} → 退出码 ${sinceResult.exit_code}${detail === '' ? '' : `；${detail}`}`);
  }

  const headResult = await runTerminal(HEAD_COMMAND);
  const headCommit = headResult.stdout.trim();
  const headMissing = headResult.exit_code !== 0 || headCommit === '';
  if (headMissing) throw new Error(`无法读取 HEAD：${HEAD_COMMAND} → 退出码 ${headResult.exit_code}`);

  const atHead = sinceCommit === headCommit;
  if (atHead) {
    throw new Error(`对比起点 ${since} 与 HEAD 指向同一个 commit（${headCommit}），没有可整理的变化。`);
  }

  const kindResult = await runTerminal(composeKindCommand(since));
  const statResult = await runTerminal(composeStatCommand(sinceCommit));
  const diffResult = await runTerminal(composeDiffCommand(sinceCommit));
  return {
    since,
    sinceKind: kindFromSymbolic(kindResult.stdout),
    sinceCommit,
    stat: clip(statResult.stdout, MAX_STAT_LENGTH),
    diff: clip(diffResult.stdout, MAX_DIFF_LENGTH),
  };
}

async function loadContext(): Promise<Context> {
  const packageRaw = await readFile(PACKAGE_PATH, 'utf8');
  const packageJson = asRecord(JSON.parse(packageRaw));
  const versionValue = packageJson.version;
  const version = typeof versionValue === 'string' ? versionValue.trim() : '';
  const missing = version === '';
  if (missing) throw new Error('package.json 缺少 version 字段。');

  const text = await readFile(CHANGELOG_PATH, 'utf8');
  const date = localDate(new Date());
  const layout = parseLayout(text);
  return {
    before: { text, hash: sha256(text) },
    version,
    date,
    heading: `## ${version} - ${date}`,
    layout,
  };
}

async function prepareWrite(
  context: Context,
  composedText: string,
  target: VersionTarget,
  releasedTag: string,
): Promise<WritePlan> {
  const draft = parseDraft(composedText);
  const problems = [...draft.problems, ...checkEntries(draft.entries)];

  const unreleasedCount = context.layout.headings.filter((item) => item === UNRELEASED_HEADING).length;
  const duplicateUnreleased = unreleasedCount > 1;
  if (duplicateUnreleased) problems.push('CHANGELOG.md 含多个 ## Unreleased 段落，拒绝自动处理。');

  const leadMissing = context.layout.leadIndex < 0;
  if (leadMissing) problems.push('CHANGELOG.md 中找不到 “All notable changes” 引导行，无法确定插入位置。');

  const noEntries = draft.entries.length === 0;
  if (noEntries) problems.push('本次没有整理出可写入的条目，未生成段落。');

  const ambiguous = target.count > 1;
  if (ambiguous) problems.push(`CHANGELOG.md 含 ${target.count} 个 “${context.version}” 段落，拒绝自动处理，请先人工合并。`);

  const newer = newerVersionHeading(context.layout, target);
  if (newer !== '') {
    problems.push(`CHANGELOG.md 中 “${newer}” 位于本版段落之前，package.json 的 version（${context.version}）疑似没有提升，拒绝改写旧段落。`);
  }

  const released = target.section !== null && releasedTag !== '';
  if (released) {
    problems.push(`本版段落已随 tag “${releasedTag}” 发布，拒绝改写已发布段落；请先提升 package.json 的 version。`);
  }

  const blocked = duplicateUnreleased || leadMissing || noEntries || ambiguous || newer !== '' || released;
  const heading = target.section === null ? context.heading : target.section.heading;
  let section = '';
  let nextText = '';
  let updated = false;
  let unchanged = false;
  if (!blocked) {
    section = buildSection(heading, draft.entries);
    const replacedHeading = context.layout.unreleased === null ? '' : UNRELEASED_HEADING;
    if (target.section === null) {
      nextText = buildNextText(context.before.text, context.layout, section);
      problems.push(...checkHeadings(context.before.text, nextText, context.heading, replacedHeading));
    } else {
      unchanged = section.trimEnd() === target.section.text.trimEnd();
      updated = !unchanged;
      if (updated) {
        nextText = buildUpdatedText(context.before.text, context.layout, target.section, section);
        problems.push(...checkHeadings(context.before.text, nextText, '', replacedHeading));
      }
    }
  }

  const currentHash = sha256(await readFile(CHANGELOG_PATH, 'utf8'));
  const drifted = currentHash !== context.before.hash;
  if (drifted) problems.push('CHANGELOG.md 在生成期间被改动（sha256 不一致），拒绝写入。');

  return { draft, heading, section, nextText, updated, unchanged, problems };
}

async function persist(text: string, problems: string[]): Promise<boolean> {
  try {
    await writeChangelog(text);
    return true;
  } catch (error) {
    problems.push(`写入 CHANGELOG.md 失败：${describeError(error)}`);
    return false;
  }
}

function reportOutcome(outcome: OutcomeReport): void {
  const failed = outcome.problems.length > 0;
  if (outcome.written) console.log(`已写入 ${CHANGELOG_PATH}：${outcome.heading}`);
  const nothingToDo = outcome.unchanged && !failed;
  if (nothingToDo) console.log(`未写入 ${CHANGELOG_PATH}：${outcome.heading} 已是最新，本次没有需要合并的变化。`);
  const quietDryRun = outcome.dryRun && !failed && outcome.section !== '';
  if (quietDryRun) console.log(`dryRun：全部校验通过，未写入 ${CHANGELOG_PATH}。`);
  if (failed) {
    console.error(`未写入 ${CHANGELOG_PATH}，发现 ${outcome.problems.length} 个问题：`);
    for (const problem of outcome.problems) console.error(`- ${problem}`);
  }
}

function assertSafeSince(since: string): void {
  const empty = since.trim() === '';
  if (empty) throw new Error('对比起点不能为空。');
  const optionLike = since.startsWith('-');
  if (optionLike) throw new Error(`对比起点不能以 “-” 开头：${since}`);
  const unsafe = !SAFE_SINCE.test(since);
  if (unsafe) throw new Error(`对比起点含不能安全放进 git 命令的字符：${since}`);
}

function kindFromSymbolic(stdout: string): SinceKind {
  const first = stdout.split('\n').map((line) => line.trim()).find((line) => line !== '');
  const missing = first === undefined;
  if (missing) return 'commit';
  const tag = first.startsWith('refs/tags/');
  if (tag) return 'tag';
  const branch = first.startsWith('refs/heads/');
  if (branch) return 'branch';
  const remote = first.startsWith('refs/remotes/');
  if (remote) return 'remote';
  return 'commit';
}

function clip(value: string, limit: number): string {
  const clean = value.trim();
  const empty = clean === '';
  if (empty) return '（无输出）';
  const tooLong = clean.length > limit;
  if (!tooLong) return clean;
  return `${clean.slice(0, limit)}\n…（已截断，共 ${clean.length} 字符）`;
}

function clipEntry(entry: string): string {
  return entry.slice(0, MAX_REPORT_ENTRY);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  const usable = typeof value === 'object' && value !== null && !Array.isArray(value);
  return usable ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  return items.filter((item): item is string => typeof item === 'string');
}

function readReasons(value: unknown): ReportEntry[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const entries: ReportEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const entry = typeof record.entry === 'string' ? record.entry : '';
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    const missingEntry = entry.trim() === '';
    if (missingEntry) continue;
    entries.push({ entry: clipEntry(entry), reason: reason === '' ? '模型未给出理由' : reason });
  }
  return entries;
}

function readQuestions(value: unknown): HumanEntry[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  const entries: HumanEntry[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const entry = typeof record.entry === 'string' ? record.entry : '';
    const question = typeof record.question === 'string' ? record.question.trim() : '';
    const missingEntry = entry.trim() === '';
    if (missingEntry) continue;
    entries.push({
      entry: clipEntry(entry),
      question: question === '' ? '请确认这条变化是否对用户可感知。' : question,
    });
  }
  return entries;
}

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.trim());
}

function findSectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const isSection = lines[index].startsWith('## ');
    if (isSection) return index;
  }
  return lines.length;
}

function firstVersionAfter(lines: string[], anchor: number): string {
  for (let index = anchor + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const isSection = line.startsWith('## ');
    const versioned = VERSION_HEADING.test(line.trim());
    if (isSection && versioned) return line.trim();
  }
  return '';
}

function parseLayout(text: string): ChangelogLayout {
  const lines = text.split('\n');
  const leadIndex = lines.findIndex((line) => line.toLowerCase().includes(LEAD_MARKER));
  const sections = listSections(lines, leadIndex);
  const unreleasedSection = sections.find((section) => section.heading === UNRELEASED_HEADING);
  const unreleased = unreleasedSection === undefined ? null : asSection(unreleasedSection);
  const orphans = sections
    .filter((section) => section.aboveLead && section.heading !== UNRELEASED_HEADING)
    .filter((section) => !VERSION_HEADING.test(section.heading))
    .map(asSection);
  const versions = sections
    .filter((section) => VERSION_HEADING.test(section.heading))
    .map((section) => ({ ...asSection(section), version: versionOf(section.heading) }));
  const anchor = unreleased === null ? leadIndex : unreleased.start;
  const firstVersionHeading = anchor < 0 ? '' : firstVersionAfter(lines, anchor);
  return { leadIndex, unreleased, orphans, versions, firstVersionHeading, headings: headings(text) };
}

function listSections(lines: string[], leadIndex: number): RawSection[] {
  const sections: RawSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const isSection = line.startsWith('## ');
    if (!isSection) continue;
    const heading = line.trim();
    const aboveLead = leadIndex >= 0 && index < leadIndex;
    const naturalEnd = findSectionEnd(lines, index);
    const end = aboveLead ? Math.min(naturalEnd, leadIndex) : naturalEnd;
    sections.push({ heading, start: index, end, text: lines.slice(index, end).join('\n').trimEnd(), aboveLead });
  }
  return sections;
}

function asSection(section: RawSection): ChangelogSection {
  return { heading: section.heading, start: section.start, end: section.end, text: section.text };
}

function versionOf(heading: string): string {
  const match = VERSION_IN_HEADING.exec(heading.trim());
  return match === null ? '' : (match[1] ?? '');
}

/** 本版段落：0 个就新建，1 个就地更新，多于 1 个拒绝自动处理。 */
function locateVersion(layout: ChangelogLayout, version: string): VersionTarget {
  const matches = layout.versions.filter((section) => section.version === version);
  const single = matches.length === 1 ? matches[0] : undefined;
  return { section: single ?? null, count: matches.length };
}

/** 比本版更新的版本段落若就在上面，说明 package.json 的 version 没提升。 */
function newerVersionHeading(layout: ChangelogLayout, target: VersionTarget): string {
  const section = target.section;
  const absent = section === null;
  if (absent) return '';
  const newest = layout.versions[0];
  const unknown = newest === undefined;
  if (unknown) return '';
  const isTarget = newest.start === section.start;
  return isTarget ? '' : newest.heading;
}

function buildSection(heading: string, entries: string[]): string {
  return [heading, '', ...entries].join('\n');
}

/** 段目前后各留一个空行：插入与就地更新共用同一种接缝。 */
function appendSection(sequence: string[], sectionLines: string[]): void {
  while (sequence.length > 0 && (sequence[sequence.length - 1] ?? '').trim() === '') sequence.pop();
  const empty = sequence.length === 0;
  if (!empty) sequence.push('');
  sequence.push(...sectionLines, '');
}

function joinLines(sequence: string[], trailingNewline: boolean): string {
  const trimmed = [...sequence];
  while (trimmed.length > 0 && (trimmed[trimmed.length - 1] ?? '').trim() === '') trimmed.pop();
  const body = trimmed.join('\n');
  return trailingNewline ? `${body}\n` : body;
}

/** 就地更新：保留原标题与位置，同时把 `## Unreleased` 折进本版段落。 */
function buildUpdatedText(text: string, layout: ChangelogLayout, target: ChangelogSection, section: string): string {
  const lines = text.split('\n');
  const sectionLines = section.split('\n');
  const dropped = layout.unreleased;
  const merged: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const unreleasedLine = dropped !== null && index >= dropped.start && index < dropped.end;
    if (unreleasedLine) continue;
    const replacedLine = index >= target.start && index < target.end;
    if (!replacedLine) {
      merged.push(lines[index] ?? '');
      continue;
    }
    const firstReplacedLine = index === target.start;
    if (firstReplacedLine) appendSection(merged, sectionLines);
  }
  return joinLines(merged, text.endsWith('\n'));
}

function buildNextText(text: string, layout: ChangelogLayout, section: string): string {
  const lines = text.split('\n');
  const sectionLines = section.split('\n');
  if (layout.unreleased !== null) {
    const before = lines.slice(0, layout.unreleased.start);
    const after = lines.slice(layout.unreleased.end);
    return [...before, ...sectionLines, '', ...after].join('\n');
  }
  const rest = lines.slice(layout.leadIndex + 1);
  while (rest.length > 0 && rest[0].trim() === '') rest.shift();
  const merged = [...lines.slice(0, layout.leadIndex + 1), '', ...sectionLines, '', ...rest];
  const joined = merged.join('\n');
  const trailingNewline = text.endsWith('\n');
  const missingNewline = !joined.endsWith('\n');
  return trailingNewline && missingNewline ? `${joined}\n` : joined;
}

function composeAskInput(material: AskMaterial): string {
  const unreleased = material.unreleased === '' ? '（不存在）' : material.unreleased;
  const orphans = material.orphans === '' ? '（不存在）' : material.orphans;
  const updating = material.currentSection !== '';
  const current = updating ? material.currentSection : '（不存在，本次新建段落）';
  const goal = updating
    ? `就地更新 ${material.version} 的 CHANGELOG 段落：段落已存在，标题与日期由调用方保留。`
    : `整理 ${material.version}（${material.date}）的 CHANGELOG 新段落。`;
  return [
    goal,
    `对比范围：${material.since}...HEAD，类型 ${material.sinceKind}，起点 commit ${material.sinceCommit}。`,
    '## git diff --stat',
    material.stat,
    '## git diff',
    material.diff,
    '## 来源一：现有 ## Unreleased 段落原文',
    unreleased,
    '## 来源二：All notable changes 引导行上方的无版本 ## 段落原文',
    orphans,
    '## 来源三',
    '只出现在 diff 中、上面来源都没有提到的变化，请从 diff 自行识别。',
    '## 来源四：现有本版段落原文',
    current,
    '来源四非空时是就地更新：仍成立的旧条目保留它的事实，但措辞可以按预算压缩。',
    `预算：entries 最多 ${MAX_ENTRIES} 条，每条正文不超过 ${MAX_ENTRY_LENGTH} 字符；超出会被拒绝。`,
    '按 rules/release-changelog.md 的分类与写法返回 JSON 对象，不要输出 JSON 以外的文字。',
  ].join('\n\n');
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const closed = start >= 0 && end > start;
  return closed ? trimmed.slice(start, end + 1) : '';
}

function emptyDraft(problems: string[]): Draft {
  return { entries: [], dropped: [], archiveCandidates: [], needsHuman: [], problems };
}

function parseDraft(text: string): Draft {
  const payload = extractJson(text);
  const missing = payload === '';
  if (missing) return emptyDraft(['模型输出中没有 JSON 对象，未得到分类结果。']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    return emptyDraft([`模型输出不是合法 JSON：${describeError(error)}`]);
  }
  const record = asRecord(parsed);
  const rawEntries = record.entries;
  const entries = stringList(rawEntries);
  const problems = stringList(record.problems);
  const malformed = Array.isArray(rawEntries) && rawEntries.length !== entries.length;
  if (malformed) problems.push('模型输出的 entries 含非字符串项，已忽略。');
  return {
    entries,
    dropped: readReasons(record.dropped),
    archiveCandidates: readReasons(record.archiveCandidates),
    needsHuman: readQuestions(record.needsHuman),
    problems,
  };
}

function checkEntries(entries: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const duplicate = seen.has(entry);
    const singleLine = !entry.includes('\n');
    const bullet = entry.startsWith('- ');
    const content = entry.slice(2).trim();
    const empty = content === '';
    if (!singleLine) problems.push(`条目不是单行：${clipEntry(entry)}`);
    if (!bullet) problems.push(`条目缺少 “- ” 列表标记：${clipEntry(entry)}`);
    if (empty) problems.push(`条目内容为空：${clipEntry(entry)}`);
    if (duplicate) problems.push(`条目重复出现：${clipEntry(entry)}`);
    const tooLong = content.length > MAX_ENTRY_LENGTH;
    if (tooLong) problems.push(`条目 ${content.length} 字符，超过 ${MAX_ENTRY_LENGTH} 字符预算，请删掉后两三个事实只留结论：${clipEntry(content)}`);
    seen.add(entry);
  }
  const tooMany = entries.length > MAX_ENTRIES;
  if (tooMany) problems.push(`本版整理了 ${entries.length} 条，超过 ${MAX_ENTRIES} 条预算；请把同一页面、同一标识符的变化合并成一条后重写。`);
  return problems;
}

function removeHeadingOnce(sequence: string[], heading: string): string[] {
  const absent = heading === '';
  if (absent) return sequence;
  const index = sequence.indexOf(heading);
  const found = index >= 0;
  if (!found) return sequence;
  return [...sequence.slice(0, index), ...sequence.slice(index + 1)];
}

function describeMismatch(expected: string[], actual: string[]): string {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const left = expected[index] ?? '（缺失）';
    const right = actual[index] ?? '（缺失）';
    const differs = left !== right;
    if (differs) return `第 ${index + 1} 个标题期望 “${left}”，实际 “${right}”`;
  }
  return '标题数量或顺序不同';
}

function checkHeadings(
  beforeText: string,
  afterText: string,
  newHeading: string,
  replacedHeading: string,
): string[] {
  const expected = removeHeadingOnce(headings(beforeText), replacedHeading);
  const actual = removeHeadingOnce(headings(afterText), newHeading);
  const sameLength = expected.length === actual.length;
  const sameItems = sameLength && expected.every((line, index) => line === actual[index]);
  if (sameItems) return [];
  return [`写入会改变原有标题序列，已拒绝：${describeMismatch(expected, actual)}`];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeChangelog(text: string): Promise<void> {
  const directory = path.dirname(CHANGELOG_PATH);
  const temporary = path.join(directory, `.${path.basename(CHANGELOG_PATH)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, CHANGELOG_PATH);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function changelog(since: string, dryRun = false): Promise<ChangelogReport> {
  assertSafeSince(since);

  const range = await resolveRange(since);
  const context = await loadContext();
  const target = locateVersion(context.layout, context.version);
  const releasedTag = target.section === null ? '' : await probeReleaseTag(context.version);
  const material = composeAskInput({
    version: context.version,
    date: context.date,
    since: range.since,
    sinceKind: range.sinceKind,
    sinceCommit: range.sinceCommit,
    stat: range.stat,
    diff: range.diff,
    unreleased: context.layout.unreleased === null ? '' : context.layout.unreleased.text,
    orphans: context.layout.orphans.map((section) => section.text).join('\n\n'),
    currentSection: target.section === null ? '' : target.section.text,
  });
  const composed = await composeSection(material);

  const plan = await prepareWrite(context, composed.text, target, releasedTag);
  const ready = plan.problems.length === 0 && plan.nextText !== '';
  const shouldWrite = ready && !dryRun;
  let written = false;
  if (shouldWrite) written = await persist(plan.nextText, plan.problems);

  reportOutcome({
    heading: plan.heading,
    section: plan.section,
    written,
    unchanged: plan.unchanged,
    problems: plan.problems,
    dryRun,
  });

  return {
    version: context.version,
    since: range.since,
    sinceKind: range.sinceKind,
    sinceCommit: range.sinceCommit,
    written,
    path: CHANGELOG_PATH,
    insertedSection: plan.section,
    replacedUnreleased: context.layout.unreleased !== null,
    updatedExistingSection: plan.updated && plan.problems.length === 0,
    unchanged: plan.unchanged,
    absorbedOrphanSections: context.layout.orphans.map((section) => section.heading),
    previousVersionHeading: context.layout.firstVersionHeading,
    dropped: plan.draft.dropped,
    archiveCandidates: plan.draft.archiveCandidates,
    needsHuman: plan.draft.needsHuman,
    problems: plan.problems,
  };
}
