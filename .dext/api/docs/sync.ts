/// <reference types="node" />
import path from "node:path";
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
const AUDIT_RULES = ["docs-audit.md", "docs-style.md"];
const UPDATE_RULES = ["docs-update.md", "docs-style.md"];
const LINK_PATTERN = /\]\(([^)\s]+)\)/gu;
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu;

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

async function confirmDraft(message: string): Promise<UiConfirmResult> {
  return ui.confirm({ message, confirm_label: "应用文档改动", cancel_label: "取消" });
}

async function commitDraft(draft: AgentResult): Promise<ApplyResult> {
  return apply({ result: draft });
}

function changedFiles(draft: AgentResult): PatchChange[] {
  return draft.patch?.changes ?? [];
}

function describeDraft(draft: AgentResult, changes: PatchChange[]): string {
  const title = draft.patch?.title ?? draft.summary ?? "文档更新";
  const lines = changes.map((change) => `- ${change.uri.replace(/^file:\/\//iu, "")}`);
  return [`${title}（${changes.length} 个文件）`, ...lines].join("\n");
}

/** 写入草稿并汇报；返回值就是入口要判的「是否冲突」。 */
function reportApply(applied: ApplyResult): boolean {
  const conflicted = applied.status === "conflict";
  if (conflicted) {
    console.error(`文档改动写入冲突，未修改任何文件：${applied.summary}`);
  } else {
    console.log(`文档改动已写入（${applied.status}）：${applied.summary}`);
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

export async function sync(directory: string): Promise<AgentResult> {
  const present = await exists(directory);
  if (present === false) {
    throw new Error(`目录不存在：${directory}。传入要同步的目录路径，例如 "src/mcp" 或 "docs/guide"。`);
  }
  const audit = await auditDocs(composeAuditInput(directory));
  const draft = await draftDocs(composeDraftInput(directory, audit.text));
  const changes = changedFiles(draft);
  const unchanged = changes.length === 0;
  if (unchanged) {
    console.log("文档已与代码一致，本次未生成改动。");
    return draft;
  }
  const approval = await confirmDraft(`确认写入以下文档改动？\n\n${describeDraft(draft, changes)}`);
  const approved = approval.confirmed;
  if (approved) {
    const applied = await commitDraft(draft);
    const conflicted = reportApply(applied);
    if (conflicted) {
      return draft;
    }
    const problems = await verifyDocLinks();
    reportProblems(problems);
    return draft;
  }
  console.log("已取消，未写入任何文档改动。");
  return draft;
}
