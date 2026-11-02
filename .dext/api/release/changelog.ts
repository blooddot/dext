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
const MAX_ENTRY_LENGTH = 200;
const MAX_DIFF_LENGTH = 120000;
const MAX_STAT_LENGTH = 20000;
const LEAD_MARKER = 'all notable changes';
const UNRELEASED_HEADING = '## Unreleased';
const VERSION_HEADING = /^## [0-9]+[.][0-9]+[.][0-9]+(?: |$)/u;
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
  section: string;
  nextText: string;
  problems: string[];
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

interface ChangelogLayout {
  leadIndex: number;
  unreleased: ChangelogSection | null;
  orphans: ChangelogSection[];
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
}

function composeCommitCommand(since: string): string {
  return `git rev-parse --verify --quiet '${since}^{commit}'`;
}

function composeKindCommand(since: string): string {
  return `git rev-parse --symbolic-full-name '${since}'`;
}

function composeStatCommand(commit: string): string {
  return `git --no-pager diff --stat --no-color '${commit}...HEAD'`;
}

function composeDiffCommand(commit: string): string {
  return `git --no-pager diff --no-color --unified=3 '${commit}...HEAD'`;
}

async function runTerminal(command: string): Promise<TerminalResult> {
  return terminal({ command, timeout_ms: GIT_TIMEOUT_MS });
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

async function prepareWrite(context: Context, composedText: string): Promise<WritePlan> {
  const draft = parseDraft(composedText);
  const problems = [...draft.problems, ...checkEntries(draft.entries)];

  const unreleasedCount = context.layout.headings.filter((item) => item === UNRELEASED_HEADING).length;
  const duplicateUnreleased = unreleasedCount > 1;
  if (duplicateUnreleased) problems.push('CHANGELOG.md 含多个 ## Unreleased 段落，拒绝自动处理。');

  const leadMissing = context.layout.leadIndex < 0;
  if (leadMissing) problems.push('CHANGELOG.md 中找不到 “All notable changes” 引导行，无法确定插入位置。');

  const noEntries = draft.entries.length === 0;
  if (noEntries) problems.push('本次没有整理出可写入的条目，未生成段落。');

  let section = '';
  let nextText = '';
  const ready = !leadMissing && !noEntries && !duplicateUnreleased;
  if (ready) {
    section = buildSection(context.heading, draft.entries);
    const headingExists = context.layout.headings.includes(context.heading);
    if (headingExists) {
      problems.push(`CHANGELOG.md 已存在本版标题 “${context.heading}”，拒绝重复写入。`);
    } else {
      nextText = buildNextText(context.before.text, context.layout, section);
      const replacedHeading = context.layout.unreleased === null ? '' : UNRELEASED_HEADING;
      problems.push(...checkHeadings(context.before.text, nextText, context.heading, replacedHeading));
    }
  }

  const currentHash = sha256(await readFile(CHANGELOG_PATH, 'utf8'));
  const drifted = currentHash !== context.before.hash;
  if (drifted) problems.push('CHANGELOG.md 在生成期间被改动（sha256 不一致），拒绝写入。');

  return { draft, section, nextText, problems };
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

function reportOutcome(heading: string, section: string, written: boolean, problems: string[], dryRun: boolean): void {
  const failed = problems.length > 0;
  if (written) console.log(`已写入 ${CHANGELOG_PATH}：${heading}`);
  const quietDryRun = dryRun && !failed && section !== '';
  if (quietDryRun) console.log(`dryRun：全部校验通过，未写入 ${CHANGELOG_PATH}。`);
  if (failed) {
    console.error(`未写入 ${CHANGELOG_PATH}，发现 ${problems.length} 个问题：`);
    for (const problem of problems) console.error(`- ${problem}`);
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
  return entry.slice(0, MAX_ENTRY_LENGTH);
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
  let unreleased: ChangelogSection | null = null;
  const orphans: ChangelogSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const isSection = lines[index].startsWith('## ');
    if (!isSection) continue;
    const heading = lines[index].trim();
    const aboveLead = leadIndex >= 0 && index < leadIndex;
    const naturalEnd = findSectionEnd(lines, index);
    const end = aboveLead ? Math.min(naturalEnd, leadIndex) : naturalEnd;
    const section: ChangelogSection = {
      heading,
      start: index,
      end,
      text: lines.slice(index, end).join('\n').trimEnd(),
    };
    const isUnreleased = heading === UNRELEASED_HEADING;
    if (isUnreleased && unreleased === null) unreleased = section;
    const versioned = VERSION_HEADING.test(heading);
    if (aboveLead && !isUnreleased && !versioned) orphans.push(section);
  }
  const anchor = unreleased === null ? leadIndex : unreleased.start;
  const firstVersionHeading = anchor < 0 ? '' : firstVersionAfter(lines, anchor);
  return { leadIndex, unreleased, orphans, firstVersionHeading, headings: headings(text) };
}

function buildSection(heading: string, entries: string[]): string {
  return [heading, '', ...entries].join('\n');
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
  return [
    `整理 ${material.version}（${material.date}）的 CHANGELOG 段落。`,
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
    '只出现在 diff 中、上面两个来源都没有提到的变化，请从 diff 自行识别。',
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
    seen.add(entry);
  }
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
  });
  const composed = await composeSection(material);

  const plan = await prepareWrite(context, composed.text);
  const clean = plan.problems.length === 0;
  const ready = clean && plan.section !== '';
  const shouldWrite = ready && !dryRun;
  let written = false;
  if (shouldWrite) written = await persist(plan.nextText, plan.problems);

  reportOutcome(context.heading, plan.section, written, plan.problems, dryRun);

  return {
    version: context.version,
    since: range.since,
    sinceKind: range.sinceKind,
    sinceCommit: range.sinceCommit,
    written,
    path: CHANGELOG_PATH,
    insertedSection: plan.section,
    replacedUnreleased: context.layout.unreleased !== null,
    absorbedOrphanSections: context.layout.orphans.map((section) => section.heading),
    previousVersionHeading: context.layout.firstVersionHeading,
    dropped: plan.draft.dropped,
    archiveCandidates: plan.draft.archiveCandidates,
    needsHuman: plan.draft.needsHuman,
    problems: plan.problems,
  };
}
