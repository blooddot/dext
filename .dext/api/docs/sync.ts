/// <reference types="node" />
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import {
  agent,
  apply,
  ask,
  ui,
  type AgentResult,
  type ApplyResult,
  type AskResult,
  type PatchChange,
  type UiConfirmResult,
} from "dext";

const DOCS_DIRECTORY = "docs";
const AUDIT_RULES = ["docs/audit.md", "docs/style.md"];
const UPDATE_RULES = ["docs/update.md", "docs/style.md"];
const LINK_PATTERN = /\]\(([^)\s]+)\)/gu;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu;
/** 与 .gitignore 对齐：只有构建产物的目录与文件不参与工作区比较。 */
const ARTIFACT_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "release",
  "coverage",
  ".vscode-test",
  ".npm-cache",
]);
const ARTIFACT_DIRECTORY_PREFIX = ".tmp-";
const ARTIFACT_SUFFIX = ".vsix";
const ARTIFACT_FILES = new Set([".taste-skill"]);
const MAX_REPORTED_FILES = 40;

/** 工作区里一份文件的状态：只留哈希，够判断新增、改写与删除。 */
interface WorkspaceEntry {
  hash: string;
}

type WorkspaceState = Map<string, WorkspaceEntry>;

interface WorkspaceDiff {
  added: string[];
  modified: string[];
  removed: string[];
  total: number;
}

/** patch 落地结果：只有草稿自己没改盘时才需要它。 */
interface PatchOutcome {
  status: ApplyResult["status"];
  summary: string;
}

export interface SyncReport {
  directory: string;
  approved: boolean;
  unchanged: boolean;
  files: string[];
  patch: PatchOutcome | null;
  problems: string[];
}

/** 目录既是唯一参数也是范围，两段 prompt 共用这一句。 */
function describeRequest(directory: string): string {
  return `用户请求：只同步与 ${directory} 相关的文档。`;
}

function composeAuditInput(directory: string): string {
  return ["审计项目代码与 docs/ 文档之间的漂移，只读，不修改任何文件。", describeRequest(directory)].join("\n\n");
}

function composeDraftInput(directory: string, audit: string): string {
  return ["根据用户请求与下列审计结论更新 docs/ 下的项目文档。", describeRequest(directory), "审计结论：", audit].join("\n\n");
}

async function auditDocs(input: string): Promise<AskResult> {
  return ask({ input, rules: AUDIT_RULES });
}

async function draftDocs(input: string): Promise<AgentResult> {
  return agent({ input, patch: true, rules: UPDATE_RULES });
}

/** 草稿会直接写盘，所以确认必须发生在写之前：取消时工作区还是干净的。 */
function confirmWrite(directory: string): Promise<UiConfirmResult> {
  return ui.confirm({
    message: [
      describeRequest(directory),
      "按上面的审计结论更新 docs/ 与 README 指南表格？草稿会直接写入工作区内的文件，可能新增、改写或删除页面。",
      "取消则不会写入任何文件。",
    ].join("\n\n"),
    confirm_label: "开始更新文档",
    cancel_label: "取消",
  });
}

async function commitDraft(draft: AgentResult): Promise<ApplyResult> {
  return apply({ result: draft });
}

function patchChanges(draft: AgentResult): PatchChange[] {
  return draft.patch?.changes ?? [];
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function relativeToWorkspace(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join("/");
}

function artifact(name: string, directory: boolean): boolean {
  const artifactDirectory = directory && (ARTIFACT_DIRECTORIES.has(name) || name.startsWith(ARTIFACT_DIRECTORY_PREFIX));
  const artifactFile = !directory && (name.endsWith(ARTIFACT_SUFFIX) || ARTIFACT_FILES.has(name));
  return artifactDirectory || artifactFile;
}

/** 草稿写盘前后各拍一张快照：真正的改动以磁盘为准，不以 patch.changes 为准。 */
async function snapshotWorkspace(): Promise<WorkspaceState> {
  const state: WorkspaceState = new Map();
  await collectWorkspace(".", state);
  return state;
}

async function collectWorkspace(directory: string, state: WorkspaceState): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  const missing = entries === null;
  if (missing) return;
  for (const entry of entries) {
    const nested = entry.isDirectory();
    const skipped = artifact(entry.name, nested);
    if (skipped) continue;
    const target = path.join(directory, entry.name);
    if (nested) {
      await collectWorkspace(target, state);
      continue;
    }
    const regular = entry.isFile();
    if (!regular) continue;
    const content = await readFile(target).catch(() => null);
    const unreadable = content === null;
    if (unreadable) continue;
    state.set(relativeToWorkspace(target), { hash: sha256(content) });
  }
}

function diffWorkspace(before: WorkspaceState, after: WorkspaceState): WorkspaceDiff {
  const added: string[] = [];
  const modified: string[] = [];
  for (const [file, entry] of after) {
    const previous = before.get(file);
    const created = previous === undefined;
    if (created) {
      added.push(file);
      continue;
    }
    const changed = previous.hash !== entry.hash;
    if (changed) modified.push(file);
  }
  const removed = [...before.keys()].filter((file) => !after.has(file));
  return {
    added: added.sort(),
    modified: modified.sort(),
    removed: removed.sort(),
    total: added.length + modified.length + removed.length,
  };
}

function describeDiffLines(diff: WorkspaceDiff): string[] {
  const entries = [
    ...diff.added.map((file) => `+ ${file}`),
    ...diff.modified.map((file) => `~ ${file}`),
    ...diff.removed.map((file) => `- ${file}`),
  ];
  const reported = entries.slice(0, MAX_REPORTED_FILES);
  const hidden = entries.length - reported.length;
  return hidden > 0 ? [...reported, `…另有 ${hidden} 个文件未列出`] : reported;
}

function describeChangeSet(draft: AgentResult, diff: WorkspaceDiff): string {
  const title = draft.patch?.title ?? draft.summary ?? "文档更新";
  return [`${title}（${diff.total} 个文件）`, ...describeDiffLines(diff)].join("\n");
}

/** 写入 patch 并汇报；返回值就是入口要判的「是否冲突」。 */
function reportApply(applied: ApplyResult): boolean {
  const conflicted = applied.status === "conflict";
  if (conflicted) {
    console.error(`patch 写入冲突，未修改任何文件：${applied.summary}`);
  } else {
    console.log(`patch 已写入（${applied.status}）：${applied.summary}`);
  }
  return conflicted;
}

function reportProblems(problems: string[]): void {
  const clean = problems.length === 0;
  if (clean) {
    console.log("文档链接检查通过。");
    return;
  }
  console.error(`发现 ${problems.length} 个文档链接问题：`);
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
}

/** 改动来自磁盘还是 patch，报出来的必须是同一个结论。 */
function reportDiff(draft: AgentResult, diff: WorkspaceDiff, applied: ApplyResult | null): void {
  if (diff.total === 0) {
    console.log("草稿没有改盘，改动来自它返回的 patch。");
  } else {
    console.log(describeChangeSet(draft, diff));
    const alsoPatched = patchChanges(draft).length > 0;
    if (alsoPatched) console.log("草稿已把改动写入工作区，跳过 apply：磁盘上的改动就是结果。");
  }
  if (applied !== null) reportApply(applied);
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const nested = entry.isDirectory();
    if (nested) {
      files.push(...(await markdownFiles(target)));
    } else {
      const markdown = entry.name.endsWith(".md");
      if (markdown) files.push(target);
    }
  }
  return files;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 返回失效的站内相对链接；外链、锚点、模板占位都跳过。 */
async function verifyDocLinks(): Promise<string[]> {
  const problems: string[] = [];
  for (const file of await markdownFiles(DOCS_DIRECTORY)) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = match[1];
      const external = EXTERNAL_TARGET.test(target) || target.includes("{") || target.includes("<");
      if (external) continue;
      const [relative] = target.split("#", 1);
      if (!relative) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(relative));
      const found = await exists(resolved);
      if (!found) {
        problems.push(`${file}: 链接目标不存在 → ${target}`);
      }
    }
  }
  return problems;
}

export async function sync(directory: string): Promise<SyncReport> {
  const present = await exists(directory);
  if (present === false) {
    throw new Error(`目录不存在：${directory}。传入要同步的目录路径，例如 "src/mcp" 或 "docs/guide"。`);
  }
  const audit = await auditDocs(composeAuditInput(directory));
  console.log(audit.text);
  const approval = await confirmWrite(directory);
  const approved = approval.confirmed;
  if (!approved) {
    console.log("已取消，未写入任何文档改动。");
    return { directory, approved: false, unchanged: false, files: [], patch: null, problems: [] };
  }
  const before = await snapshotWorkspace();
  const draft = await draftDocs(composeDraftInput(directory, audit.text));
  const after = await snapshotWorkspace();
  const diff = diffWorkspace(before, after);
  const changes = patchChanges(draft);
  const written = diff.total > 0;
  const patchPresent = changes.length > 0;
  const unchanged = !written && !patchPresent;
  if (unchanged) {
    console.log("文档已与代码一致，本次未生成改动。");
    const problems = await verifyDocLinks();
    reportProblems(problems);
    return { directory, approved: true, unchanged: true, files: [], patch: null, problems };
  }
  // 草稿要么自己改了盘，要么只回了一个 patch；两种都按实际结果汇报，
  // 已经落在磁盘上的改动不再走 apply，否则必然被判成冲突。
  const applied = written ? null : await commitDraft(draft);
  reportDiff(draft, diff, applied);
  const problems = await verifyDocLinks();
  reportProblems(problems);
  return {
    directory,
    approved: true,
    unchanged: false,
    files: [...diff.added, ...diff.modified, ...diff.removed],
    patch: applied === null ? null : { status: applied.status, summary: applied.summary },
    problems,
  };
}
