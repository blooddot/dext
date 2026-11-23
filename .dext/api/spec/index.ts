/// <reference types="node" />
import { isAbsolute, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { agent, skill, terminal, ui, type SkillResult } from "dext";

/** The skill ids come from the pack in `.dext/skill-packs/openspec`; keeping them
 * here is what makes the menu and the completions carry them instead of your
 * memory. */

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

/**
 * A skill that must create or edit files. `skill()` runs every call with
 * `allowWorkspaceWrite: false` (only the `agent` API enables writes), so a skill
 * that has to run `openspec new change` or write artifacts comes back as prose
 * and nothing reaches the disk. `agent()` loads the very same SKILL.md through
 * its `skills` argument and runs with the selected write scope, so the skill
 * executes instead of describing what it would do. The result keeps the
 * `{ kind: "skill", text }` shape callers already handle, and appends the paths
 * that git only now considers dirty — the answer to "did anything reach the
 * disk?". Paths that were already dirty before the run are reported separately:
 * git cannot attribute their changes to this run, so listing them as new would be
 * a lie and hiding them would look like nothing happened.
 */
async function runWriting(id: string, input: string, scope: SpecScope, completion: string, verified?: ResolvedScope): Promise<WritingResult> {
  if (!verified && hasScope(scope)) {
    const result = await openSpecJson("list --json", scope);
    if (result?.exitCode !== 0) return unverifiedScope();
    verified = resolvedScope(result);
  }
  const selected = verified ?? scope;
  const cwd = verified?.cwd;
  const before = await dirtyPaths(cwd);
  const result = await agent({ input: [input, workflowReport(selected, completion)].filter(Boolean).join("\n\n"),
    skills: [id], apply: true, patch: false,
    ...(cwd ? { workspace: { kind: "dirRef", uri: pathToFileURL(cwd).href, path: relative(process.cwd(), cwd) || "." } } : {}) });
  const report = /(?:^|\r?\n)DEXT_OPENSPEC_RESULT ([^\r\n]+)\s*$/.exec(result.text);
  const text = report ? result.text.slice(0, report.index).trimEnd() : result.text;
  const outcome = parseOutcome(report?.[1], selected);
  const after = await dirtyPaths(cwd);
  if (!before || !after) return { kind: "skill", text, outcome };
  const added = [...after].filter((path) => !before.has(path)).sort();
  const preexisting = [...before].filter((path) => after.has(path)).length;
  const sections = [text];
  sections.push(added.length
    ? `Newly dirty paths:\n${added.map((path) => `- ${path}`).join("\n")}`
    : "Newly dirty paths: none.");
  if (preexisting) {
    sections.push(`(${preexisting} other path(s) were already dirty before the run, so their changes cannot be attributed to it.)`);
  }
  return { kind: "skill", text: sections.join("\n\n"), outcome };
}

/** `change` is the name the skill's commands take as `--change "<name>"`. It
 * travels as its own line so the model never has to pick a name out of prose. */
function describeChange(change: string, input = ""): string {
  return [change === "" ? "" : `Change: ${change}`, input]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** `next` is the one command that moves the work forward. It is rendered last and
also travels in the returned text, so a script and a human read the same answer to
"what do I run now?". */
function displayResult(result: SkillResult, heading: string, next = ""): SkillResult {
  const text = next ? `${result.text}\n\n${next}` : result.text;
  console.log(`### ${heading}\n\n${text}`);
  return { kind: "skill", text };
}

/** Every call ends with this section; the heading is what makes it findable at the
 * bottom of a long skill reply. */
function nextStep(...lines: string[]): string {
  return ["### 下一步", ...lines].join("\n\n");
}

interface SpecScope {
  store?: string;
  cwd?: string;
  root?: string;
}

interface SpecRoot {
  path: string;
  store_id?: string | null;
}

type ResolvedScope = SpecScope & { cwd: string; root: string };

const archiveActions = {
  artifacts: [{ id: "continue", label: "继续归档检查" }],
  tasks: [{ id: "continue", label: "继续归档检查" }],
  sync_needed: [{ id: "sync", label: "同步后归档（推荐）" }, { id: "skip", label: "跳过同步，直接归档" }],
  already_synced: [{ id: "archive", label: "直接归档" }, { id: "sync", label: "重新同步后归档" }],
  sync_blocked: [{ id: "skip", label: "跳过同步，直接归档" }]
} as const;

type ArchivePrompt = { kind: keyof typeof archiveActions; summary: string };

function parseArchivePrompt(value: unknown): ArchivePrompt | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { kind, summary } = value as Record<string, unknown>;
  if (typeof kind === "string" && Object.hasOwn(archiveActions, kind) && typeof summary === "string" && summary.trim()) {
    return { kind: kind as ArchivePrompt["kind"], summary: summary.trim().slice(0, 20000) };
  }
  return undefined;
}

interface WorkflowOutcome {
  status: "completed" | "pending" | "blocked" | "unchanged";
  scope?: SpecScope;
  change?: string;
  archiveName?: string;
  archivePrompt?: ArchivePrompt;
}

interface WritingResult extends SkillResult {
  outcome?: WorkflowOutcome;
}

const isId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

function hasScope(scope: SpecScope): boolean {
  return scope.cwd !== undefined || scope.root !== undefined || scope.store !== undefined;
}

function resolvedScope({ cwd, root }: { cwd: string; root: SpecRoot }): ResolvedScope {
  return { cwd, root: root.path, ...(root.store_id ? { store: root.store_id } : {}) };
}

function unverifiedScope(): WritingResult {
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
      archivePrompt: status === "pending" ? parseArchivePrompt(archivePrompt) : undefined
    };
  } catch {
    return undefined;
  }
}

function openspecCommand(args: string, scope: SpecScope): string {
  return `openspec ${args}${scope.store ? ` --store "${scope.store}"` : ""}`;
}

async function openSpecJson(args: string, scope: SpecScope): Promise<{ data: Record<string, unknown>; root: SpecRoot; cwd: string; exitCode: number } | undefined> {
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

function specCall(method: string, scope: SpecScope, ...args: string[]): string {
  return `\`spec.${method}(${[...args.map((arg) => JSON.stringify(arg)), JSON.stringify(scope)].join(", ")})\``;
}

function unresolved(outcome: WorkflowOutcome | undefined, message: string): string {
  return nextStep(outcome?.status === "pending" ? "先完成 Agent 说明中的确认。" : message);
}

interface SpecChange {
  name: string;
  completedTasks?: number;
  totalTasks?: number;
  lastModified?: string;
  archived?: boolean;
}

async function openChanges(scope: SpecScope, includeArchived = false): Promise<SpecChange[] | undefined> {
  const result = await openSpecJson(includeArchived ? "list --all --json" : "list --json", scope);
  const changes = result?.data.changes as SpecChange[] | undefined;
  if (result?.exitCode !== 0 || !Array.isArray(changes) ||
      changes.some((change) => typeof change?.name !== "string" || (includeArchived && typeof change.archived !== "boolean"))) return undefined;
  return changes;
}

function newest(changes: SpecChange[] | undefined): SpecChange | undefined {
  return changes?.slice().sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""))[0];
}

function changeProgress(change: SpecChange): string {
  const total = change.totalTasks ?? 0;
  return total > 0 ? `${change.completedTasks ?? 0}/${total} 项已勾选` : "还没有任务清单";
}

interface ApplyTask {
  id: string;
  description: string;
  done: boolean;
  sourcePath?: string;
}

interface ApplyInstructions {
  tasks: ApplyTask[];
  state: "ready" | "blocked" | "all_done";
  instruction?: string;
  root: SpecRoot;
  cwd: string;
}

/** Use the CLI's task list so custom schemas and human acceptance stay out of the count. */
async function applyInstructions(change: string, scope: SpecScope, verified = false): Promise<ApplyInstructions | undefined> {
  if (!isId(change)) return undefined;
  const result = await openSpecJson(`instructions apply --change "${change}" --json`, scope);
  if (verified && (result?.cwd !== scope.cwd || (result?.root.store_id ?? undefined) !== scope.store)) return undefined;
  const data = result?.data as (ApplyInstructions & { changeName?: unknown }) | undefined;
  if (result?.exitCode === 0 && data?.changeName === change &&
    (data.state === "ready" || data.state === "blocked" || data.state === "all_done") && Array.isArray(data.tasks) && data.tasks.every((task) =>
    typeof task?.id === "string" && typeof task.description === "string" && typeof task.done === "boolean" &&
    (task.sourcePath === undefined || typeof task.sourcePath === "string"))) {
    return { ...data, cwd: result.cwd, instruction: typeof data.instruction === "string" ? data.instruction : undefined };
  }
  return undefined;
}

function taskLabel(task: ApplyTask): string {
  return task.description.replace(/\s+verify:\s+.*$/is, "").replace(/\s+/g, " ").trim();
}

/** Use the CLI state to guide the next step and retain its completion instructions. */
function applyNext(change: string, scope: SpecScope, instructions: ApplyInstructions | undefined): string {
  const applyAgain = specCall("apply", scope, change);
  const status = `在 OpenSpec 根目录 \`${scope.root}\` 运行 \`${openspecCommand(`status --change "${change}" --json`, scope)}\``;
  if (!instructions) {
    return nextStep(`${status}，确认状态后再决定是否继续 ${applyAgain}。`);
  }
  if (instructions.state === "all_done") {
    return nextStep(...[
      instructions.instruction,
      `完成审查或验证及变更要求的人工验收后，运行 ${specCall("archive", scope, change)}。`
    ].filter((line): line is string => Boolean(line?.trim())));
  }
  if (instructions.state === "blocked") {
    return nextStep(
      `${status}，用 ${specCall("update", scope, change, "…")} 补齐缺失产物后重跑 ${applyAgain}。`);
  }
  const next = instructions.tasks.find((task) => !task.done);
  return nextStep(next
    ? `${applyAgain} —— 从「${taskLabel(next)}」继续；中断后重跑同一条命令即可，不用做别的决定。`
    : `${applyAgain} —— 再跑一次，OpenSpec 会重新报出第一项未完成的任务。`);
}

function applyProgress(before: ApplyTask[] | undefined, after: ApplyTask[] | undefined, reason = ""): string {
  const heading = "### OpenSpec 实施进度";
  if (!after) return [heading, reason, "未能从 OpenSpec 核实任务进度。"].filter(Boolean).join("\n\n");

  const total = after.length;
  const completed = after.filter((task) => task.done).length;
  const next = after.find((task) => !task.done);
  const start = before ? `开始时 ${before.filter((task) => task.done).length}/${before.length}，结束时 ` : "";
  const progress = `${completed}/${total} 项已勾选，剩余 ${total - completed} 项。`;
  const sections = [heading, `${start}${progress}`, reason];
  if (before) {
    const taskKey = (task: ApplyTask) => JSON.stringify([task.sourcePath, task.description]);
    const keys = before.map(taskKey);
    // OpenSpec IDs are positional. Only attribute changes in a stable, unambiguous list.
    if (keys.length === after.length && new Set(keys).size === keys.length &&
        after.every((task, index) => taskKey(task) === keys[index])) {
      const newlyCompleted = after.filter((task, index) => task.done && !before[index]!.done);
      sections.push(newlyCompleted.length
        ? `本轮新增勾选\n\n${newlyCompleted.map((task) => `- ${taskLabel(task)}`).join("\n")}`
        : "本轮没有新增勾选的任务。");
    } else {
      sections.push("任务清单发生变化或存在重复描述，本轮仅显示总进度。");
    }
  }
  sections.push(next ? `实施尚未完成。下一项是 ${taskLabel(next)}` : total ? "开发任务已全部勾选。" : "当前没有开发任务。");
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Plan a change: proposal, spec delta, design and tasks. Writes only
 * `openspec/changes/<name>/`, never code.
 * @param input What you want to build or fix.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
async function propose(input = "", scope: SpecScope = {}): Promise<SkillResult> {
  const result = await runWriting("openspec-propose", input, scope,
    "规划产物齐备后，按所选 OpenSpec store 运行严格校验并报告结果。只有本轮 new change 成功创建了该变更且规划检查通过时，才报告 completed。");
  const outcome = result.outcome;
  const selected = outcome?.scope;
  let next = unresolved(outcome, "尚未确认本轮提案已创建并通过检查，请查看 Agent 说明。");
  if (outcome?.status === "completed" && selected && outcome.change) {
    const change = (await openChanges(selected))?.find((entry) => entry.name === outcome.change);
    if (change) next = (change.totalTasks ?? 0) > 0
      ? nextStep(`${specCall("apply", selected, change.name)} —— 审阅本轮规划产物并确认方案后运行。`)
      : nextStep(`${specCall("update", selected, change.name, "…")} —— 补齐任务清单后再实施。`);
  }
  return displayResult(result, "OpenSpec 提案结果", next);
}

/**
 * Implement an existing change by working through its tasks.
 * @param change The change to apply, e.g. "add-video-export".
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
async function apply(change: string, scope: SpecScope = {}): Promise<SkillResult> {
  const before = await applyInstructions(change, scope);
  const explicit = hasScope(scope);
  if (explicit && !before) {
    return displayResult(unverifiedScope(), "OpenSpec 实施受阻", nextStep("核对调用参数后重新运行。"));
  }
  const verified = explicit && before ? resolvedScope(before) : undefined;
  let result: WritingResult;
  try {
    result = await runWriting("openspec-apply-change", describeChange(change), scope,
      "请报告本轮实际实施的变更。因用户确认或阻塞而暂停时，保留对应状态。", verified);
  } catch (error) {
    const after = verified ? await applyInstructions(change, verified, true) : undefined;
    console.log(applyProgress(verified ? before?.tasks : undefined, after?.tasks, "实施执行出错，请查看本轮错误。"));
    throw error;
  }
  const outcome = result.outcome;
  const selected = verified ?? (outcome?.change === change ? outcome.scope : undefined);
  const after = selected ? await applyInstructions(change, selected, !!verified) : undefined;
  // The initial lookup can resolve the default root before the skill selects a store.
  const sameRoot = before && after && before.root.path === after.root.path && (before.root.store_id ?? null) === (after.root.store_id ?? null);
  const reason = after?.state === "blocked" ? ["OpenSpec 报告实施受阻。", after.instruction].filter(Boolean).join("\n\n") : "";
  const next = selected && outcome?.status !== "pending"
    ? outcome?.status === "blocked" && after?.state !== "blocked"
      ? nextStep("先处理 Agent 说明中的阻塞，再继续实施。")
      : applyNext(change, selected, after)
    : unresolved(outcome, "未能核实本轮实施范围，请查看 Agent 说明。");
  const text = [applyProgress(sameRoot ? before.tasks : undefined, after?.tasks, reason), `### Agent 执行说明\n\n${result.text}`, next].join("\n\n");
  console.log(text);
  return { kind: "skill", text };
}

/**
 * Merge a finished change's delta into `openspec/specs` and archive it.
 * @param change The change to archive.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
async function archive(change: string, scope: SpecScope = {}): Promise<SkillResult> {
  const confirmations: { kind: ArchivePrompt["kind"]; action: string; summary: string }[] = [];
  let selectedScope = scope;
  let result: WritingResult;
  for (;;) {
    result = await runWriting("openspec-archive-change", describeChange(change), selectedScope, [
      "只有本轮成功移动变更目录才报告 completed，同时追加 archiveName（实际归档目录名，不含路径）。",
      "归档确认由 Dext API 弹窗收集。遇到未经确认的步骤时，先说明发现，再报告 pending，追加 archivePrompt 对象（kind 和简体中文纯文本 summary）。等待确认期间不要同步或移动目录。",
      "kind 为 artifacts（产物未齐）、tasks（任务未完成）、sync_needed（需要同步）、already_synced（已同步）或 sync_blocked（同步受阻）。summary 列出该步的警告或各规格的同步评估。",
      `本次 API 调用中用户已提交的确认 ${JSON.stringify(confirmations)}。重新检查选定变更和范围，仅在确认项及其条件仍相符时使用该选择。continue 表示通过该步的警告并继续检查，sync 表示执行并验证同步后归档，skip 表示跳过同步后归档，archive 表示已同步时直接归档。`
    ].join("\n"));
    const outcome = result.outcome;
    if (outcome?.status !== "pending" || outcome.change !== change || !outcome.scope || !outcome.archivePrompt) break;
    const { kind, summary } = outcome.archivePrompt;
    if (confirmations.some((confirmation) => confirmation.kind === kind)) break;

    const checked = await openSpecJson("list --json", outcome.scope);
    if (checked?.exitCode !== 0 || !Array.isArray(checked.data.changes) ||
        !checked.data.changes.some((entry: SpecChange | null) => entry?.name === change)) break;

    const actions = archiveActions[kind];
    const reply = await ui.form({
      title: `归档 ${change}`,
      description: summary,
      fields: [],
      actions: [...actions],
      cancel_label: "取消",
      on_cancel: "return",
      presentation: "dialog"
    });
    if (reply.status !== "submitted" || !actions.some(({ id }) => id === reply.action)) {
      return displayResult({ kind: "skill", text: "已取消归档。" }, "OpenSpec 归档结果", nextStep("需要归档时可重新运行原调用。"));
    }
    confirmations.push({ kind, action: reply.action, summary });
    selectedScope = resolvedScope(checked);
  }
  const outcome = result.outcome;
  const selected = outcome?.change === change ? outcome.scope : undefined;
  const changes = selected ? await openChanges(selected, true) : undefined;
  const active = changes?.filter((entry) => !entry.archived);
  const archiveName = outcome?.archiveName;
  const datePrefix = /^\d{4}-\d{2}-\d{2}-/;
  const matchesTarget = archiveName && datePrefix.test(archiveName) &&
    (datePrefix.test(change) ? archiveName === change : archiveName.slice(11) === change);
  let next: string;
  if (outcome?.status === "pending") {
    next = nextStep("归档确认未能完成，请查看 Agent 说明后重新运行原调用。");
  } else if (active?.some((entry) => entry.name === change)) {
    next = nextStep(`${change} 仍在活跃变更中。请处理 Agent 说明中的确认事项或阻塞。`);
  } else if (selected && outcome?.status === "completed" && matchesTarget &&
      changes?.some((entry) => entry.archived && entry.name === archiveName)) {
    const remaining = newest(active);
    next = remaining
      ? nextStep(`${specCall("apply", selected, remaining.name)} —— 还有活跃变更 ${remaining.name}（${changeProgress(remaining)}）。`)
      : nextStep(`活跃变更已清空。要开新变更时用 ${specCall("propose", selected, "…")}。`);
  } else {
    next = unresolved(outcome, "归档状态未知，请核对 Agent 说明和所选 OpenSpec 根目录中的归档记录。");
  }
  return displayResult(result, "OpenSpec 归档结果", next);
}

/**
 * Read the specs and the code and answer a question. Writes nothing.
 * @param input The question to explore.
 */
async function explore(input = ""): Promise<SkillResult> {
  return displayResult(await skill({ skill: "openspec-explore", input }), "OpenSpec 探索结论",
    nextStep("结论会改变对外行为时 `spec.propose(\"…\")` 开一个 change；只是读代码到这里就结束。"));
}

/**
 * Revise a change that is still being planned.
 * @param change The change to revise.
 * @param input What to change about the plan.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
async function update(change: string, input = "", scope: SpecScope = {}): Promise<SkillResult> {
  const request = describeChange(change, [input,
    "在最终说明开头明确写出当前状态（待确认、已写入、无需修改或阻塞）。如仍需确认，列出拟修订内容。"
  ].filter(Boolean).join("\n\n"));
  const result = await runWriting("openspec-update-change", request, scope, "只有修订已写入时才报告 completed。无需修改时用 unchanged。");
  const outcome = result.outcome;
  const next = outcome?.change === change && outcome.scope && (outcome.status === "completed" || outcome.status === "unchanged")
    ? nextStep(`${specCall("apply", outcome.scope, change)} —— 方案确认后开始实施。`)
    : unresolved(outcome, "尚未确认规划修订结果，请查看 Agent 说明。");
  return displayResult(result, "OpenSpec 规划修订", next);
}

/**
 * Realign `openspec/specs` with what the code now does.
 * @param change The change whose delta to sync, or omit to let the skill select it.
 * @param scope Optional store, working directory and expected OpenSpec root.
 */
async function sync(change = "", scope: SpecScope = {}): Promise<SkillResult> {
  const result = await runWriting("openspec-sync-specs", describeChange(change), scope,
    "只有所选变更的增量规格已同步且主规格校验通过时才报告 completed。");
  const outcome = result.outcome;
  const selected = outcome?.scope;
  const synced = outcome?.change;
  let next = unresolved(outcome, "同步结果尚未确认，请查看 Agent 说明。");
  if (outcome?.status === "completed" && selected && synced && (!change || change === synced)) {
    const validation = await openSpecJson("validate --specs --json", selected);
    const items = validation?.data.items as Array<{ valid?: boolean }> | undefined;
    if (validation && Array.isArray(items) && items.every((item) => typeof item?.valid === "boolean")) {
      next = validation.exitCode === 0 && items.every((item) => item.valid)
        ? nextStep(`${specCall("archive", selected, synced)} —— 规格已同步且主规格校验通过，可以归档。`)
        : nextStep("主规格校验未通过。先处理校验问题，再重新同步。");
    } else {
      next = nextStep("主规格校验结果未知，请在所选 OpenSpec 根目录核对。");
    }
  }
  return displayResult(result, "OpenSpec 规格同步", next);
}

export const spec = { propose, apply, archive, explore, update, sync };
