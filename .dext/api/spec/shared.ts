/// <reference types="node" />
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { agent, terminal, type SkillResult } from "dext";

/** Dirty-or-untracked paths in the workspace, as git sees them.
 * `AgentResult.files` is model-authored: `patch: false` means the host never sees
 * what the CLI wrote, so a run that produced nothing can still list paths and a
 * run that produced everything can list none. `git status --porcelain -uall` is
 * the host reading the disk instead of trusting the report. `undefined` means the
 * workspace is not a git work tree, or git is missing, and the extra section is
 * skipped rather than failing the call. */
async function dirtyPaths(cwd?: string): Promise<Set<string> | undefined> {
  const status = await terminal({ command: "git status --porcelain -uall", ...(cwd ? { cwd } : {}) });
  if (status.exit_code !== 0) return undefined;
  const paths = new Set<string>();
  for (const line of status.stdout.split("\n")) {
    // `XY <path>`, or `XY <old> -> <new>` for a rename: the name that is dirty now
    // is the one on the right.
    const entry = line.slice(3).trim();
    if (entry) paths.add(entry.split(" -> ").pop()!);
  }
  return paths;
}

/** Run the skill with write access and report which paths became dirty.
 * Count preexisting dirty paths separately because Git cannot attribute their
 * changes to this call. */
export async function runWriting(id: string, input: string, scope: SpecScope, completion: string, verified?: ResolvedScope): Promise<WritingResult> {
  if (!verified && hasScope(scope)) {
    const result = await openSpecJson("list --json", scope);
    if (result?.exitCode !== 0) return unverifiedScope();
    verified = resolvedScope(result);
  }
  const selected = verified ?? scope;
  const cwd = verified?.cwd;
  const before = await dirtyPaths(cwd);
  const result = await runWorkflowAgent(id, input, selected, completion, true);
  const { text } = result;
  const after = await dirtyPaths(cwd);
  if (!before || !after) return result;
  const added = [...after].filter((path) => !before.has(path)).sort();
  const preexisting = [...before].filter((path) => after.has(path)).length;
  const sections = [text];
  sections.push(added.length
    ? `Newly dirty paths:\n${added.map((path) => `- ${path}`).join("\n")}`
    : "Newly dirty paths: none.");
  if (preexisting) {
    sections.push(`(${preexisting} other path(s) were already dirty before the run, so their changes cannot be attributed to it.)`);
  }
  return { ...result, text: sections.join("\n\n") };
}

export async function runWorkflowAgent(id: string, input: string, scope: SpecScope, completion: string, apply: boolean): Promise<WritingResult> {
  const { cwd } = scope;
  const result = await agent({
    input: [input, workflowReport(scope, completion)].filter(Boolean).join("\n\n"),
    skills: [id], apply, patch: false,
    ...(cwd ? { workspace: { kind: "dirRef", uri: pathToFileURL(cwd).href, path: relative(process.cwd(), cwd) || "." } } : {})
  });
  const report = /(?:^|\r?\n)DEXT_OPENSPEC_RESULT ([^\r\n]+)\s*$/.exec(result.text);
  const text = report ? result.text.slice(0, report.index).trimEnd() : result.text;
  return { kind: "skill", text, outcome: parseOutcome(report?.[1], scope) };
}

/** `change` is the name the skill's commands take as `--change "<name>"`. It
 * travels as its own line so the model never has to pick a name out of prose. */
export function describeChange(change: string, input = ""): string {
  return [change === "" ? "" : `Change: ${change}`, input]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** `next` is the one command that moves the work forward. It is rendered last and
also travels in the returned text, so a script and a human read the same answer to
"what do I run now?". */
export function displayResult(result: SkillResult, heading: string, next = ""): SkillResult {
  const text = next ? `${result.text}\n\n${next}` : result.text;
  console.log(`### ${heading}\n\n${text}`);
  return { kind: "skill", text };
}

/** Every call ends with this section; the heading is what makes it findable at the
 * bottom of a long skill reply. */
export function nextStep(...lines: string[]): string {
  return ["### 下一步", ...lines].join("\n\n");
}

export interface SpecScope {
  store?: string;
  cwd?: string;
  root?: string;
}

export interface SpecRoot {
  path: string;
  store_id?: string | null;
}

export type ResolvedScope = SpecScope & { cwd: string; root: string };

interface WorkflowOutcome {
  status: "completed" | "pending" | "blocked" | "unchanged";
  scope?: SpecScope;
  change?: string;
  archiveName?: string;
  archivePrompt?: unknown;
}

export interface WritingResult extends SkillResult {
  outcome?: WorkflowOutcome;
}

export const isId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

export function hasScope(scope: SpecScope): boolean {
  return scope.cwd !== undefined || scope.root !== undefined || scope.store !== undefined;
}

export function resolvedScope({ cwd, root }: { cwd: string; root: SpecRoot }): ResolvedScope {
  return { cwd, root: root.path, ...(root.store_id ? { store: root.store_id } : {}) };
}

export function unverifiedScope(): WritingResult {
  return { kind: "skill", text: "未能核实指定的 OpenSpec 范围或目标。请检查 cwd、root、store 和变更 ID。", outcome: { status: "blocked" } };
}

function workflowReport(scope: SpecScope, completion: string): string {
  return [
    `OpenSpec 调用范围 ${JSON.stringify(scope)}。有 cwd 时从该工作区目录运行命令，有 store 时始终携带 --store，有 root 时先确认 CLI 解析出的根目录与其一致。范围不匹配时停止并报告原因。`,
    '先按技能要求正常说明结果。最后追加一行 DEXT_OPENSPEC_RESULT <JSON>，不要加代码围栏。字段为 status（completed、pending、blocked 或 unchanged）、change（实际处理的变更 ID）、cwd（运行 CLI 的工作目录）、root（CLI 返回的 root.path）、store（CLI 返回的 root.store_id）。未确认的字段填 null。等待用户确认时使用 pending，执行或校验失败时使用 blocked。',
    completion
  ].join("\n");
}

function parseOutcome(line: string | undefined, requested: SpecScope): WorkflowOutcome | undefined {
  if (!line) return undefined;
  try {
    const report = JSON.parse(line) as Record<string, unknown> | null;
    if (!report) return undefined;
    const { status, cwd, root, store, change, archiveName, archivePrompt } = report;
    if (status !== "completed" && status !== "pending" && status !== "blocked" && status !== "unchanged") return undefined;
    const resolved = typeof cwd === "string" && !!cwd && typeof root === "string" && !!root &&
      (store === null || isId(store)) && (!requested.store || requested.store === store) && (!requested.root || requested.root === root);
    return {
      status,
      scope: resolved ? { cwd: requested.cwd ?? (store ? "." : cwd), root, ...(store ? { store } : {}) } : undefined,
      change: isId(change) ? change : undefined,
      archiveName: isId(archiveName) ? archiveName : undefined,
      archivePrompt: status === "pending" ? archivePrompt : undefined
    };
  } catch {
    return undefined;
  }
}

export function openspecCommand(args: string, scope: SpecScope): string {
  return `openspec ${args}${scope.store ? ` --store "${scope.store}"` : ""}`;
}

export async function openSpecJson(args: string, scope: SpecScope): Promise<{ data: Record<string, unknown>; root: SpecRoot; cwd: string; exitCode: number } | undefined> {
  if ((scope.store !== undefined && !isId(scope.store)) ||
      (scope.cwd !== undefined && (typeof scope.cwd !== "string" || !scope.cwd.trim())) ||
      (scope.root !== undefined && (typeof scope.root !== "string" || !scope.root.trim()))) return undefined;
  try {
    const result = await terminal({ command: openspecCommand(args, scope), ...(scope.cwd ? { cwd: scope.cwd } : {}) });
    const data = JSON.parse(result.stdout) as Record<string, unknown> | null;
    const root = data?.root as SpecRoot | null | undefined;
    if (!data || typeof root?.path !== "string" || !root.path || typeof result.cwd !== "string" || !isAbsolute(result.cwd) ||
        (root.store_id != null && !isId(root.store_id)) ||
        (scope.root && root.path !== scope.root) || (scope.store && root.store_id !== scope.store)) return undefined;
    return { data, root, cwd: result.cwd, exitCode: result.exit_code };
  } catch {
    return undefined;
  }
}

export function specCall(method: string, scope: SpecScope, ...args: string[]): string {
  return `\`spec.${method}(${[...args.map((arg) => JSON.stringify(arg)), JSON.stringify(scope)].join(", ")})\``;
}

export function unresolved(outcome: WorkflowOutcome | undefined, message: string): string {
  return nextStep(outcome?.status === "pending" ? "先完成 Agent 说明中的确认。" : message);
}

export interface SpecChange {
  name: string;
  completedTasks?: number;
  totalTasks?: number;
  lastModified?: string;
  archived?: boolean;
}

export async function openChanges(scope: SpecScope, includeArchived = false): Promise<SpecChange[] | undefined> {
  const result = await openSpecJson(includeArchived ? "list --all --json" : "list --json", scope);
  const changes = result?.data.changes as SpecChange[] | undefined;
  if (result?.exitCode !== 0 || !Array.isArray(changes) ||
      changes.some((change) => typeof change?.name !== "string" || (includeArchived && typeof change.archived !== "boolean"))) return undefined;
  return changes;
}
