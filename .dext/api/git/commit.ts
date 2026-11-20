import { readdir, stat } from "node:fs/promises";
import { agent, terminal, type AgentResult } from "dext";

/** Default request when the caller only selects the API. */
const DEFAULT_TASK = "请整理当前工作区的改动，按功能创建独立的 Conventional Commit。";

/** Change names are the directory names the OpenSpec skills take as `--change`. */
const CHANGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/** `git <args>` in the workspace root. A command git refuses reads as empty.
 * The output is not trimmed: a porcelain status line starts with the index position,
 * and that leading space is what puts every path at the same offset. */
async function git(args: string): Promise<string> {
  const result = await terminal({ command: `git ${args}` });
  return result.exit_code === 0 ? result.stdout.replace(/\r/g, "") : "";
}

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then((entry) => entry.isDirectory(), () => false);
}

/** Active first, then the archive; a date prefix names one archive directory. */
async function resolveChangeDir(toplevel: string, change: string): Promise<string> {
  const name = change.replace(DATE_PREFIX, "");
  const active = `openspec/changes/${name}`;
  const archive = "openspec/changes/archive";
  if (DATE_PREFIX.test(change) && (await isDirectory(`${toplevel}/${archive}/${change}`))) {
    return `${archive}/${change}`;
  }
  if (await isDirectory(`${toplevel}/${active}`)) return active;
  const entries = await readdir(`${toplevel}/${archive}`).catch(() => [] as string[]);
  const matches = entries.filter((entry) => entry === change || entry.replace(DATE_PREFIX, "") === name);
  if (matches.length === 1) return `${archive}/${matches[0]}`;
  throw new Error(matches.length === 0
    ? `找不到 OpenSpec change '${change}'：openspec/changes/${name} 与 ${archive}/ 都没有对应目录。`
    : `OpenSpec change '${change}' 匹配到多个归档目录：${matches.join("、")}，请改用完整目录名。`);
}

/** `XY <path>`, or `XY <old> -> <new>` where the path dirty now is the right one. */
function dirtied(porcelain: string): { code: string; path: string }[] {
  return porcelain.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim().split(" -> ").pop() ?? "" }))
    .filter((entry) => entry.path !== "");
}

/** The facts the rule would otherwise spend a dozen tool calls rediscovering. */
async function scopeBrief(change: string, sweep: boolean): Promise<string> {
  const toplevel = (await git("rev-parse --show-toplevel")).trim();
  if (toplevel === "") throw new Error("按 OpenSpec change 提交需要一个 git 工作区。");

  const dir = await resolveChangeDir(toplevel, change);
  const capabilities = await readdir(`${toplevel}/${dir}/specs`).catch(() => [] as string[]);
  const owned = [dir, ...capabilities.map((capability) => `openspec/specs/${capability}`)];
  const dirty = dirtied(await git("-c core.quotePath=false status --porcelain=v1 -uall"));
  const staged = (await git("diff --cached --name-only")).split("\n").map((path) => path.trim()).filter((path) => path !== "");
  const foreign = dirty.filter((entry) => !owned.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`)));
  const fast = dirty.length > 0 && staged.length === 0 && (sweep || foreign.length === 0);
  const shortstat = (await git("diff --shortstat HEAD")).trim();
  const list = (entries: string[]) => entries.length === 0 ? "    （无）" : entries.map((entry) => `    ${entry}`).join("\n");

  return [
    "Scope（主机读取磁盘得出，不要再用 git status / git diff / ls 复核）:",
    `  change: ${dir}`,
    `  owned prefixes:\n${list(owned)}`,
    `  index: ${staged.length === 0 ? "clean" : `已暂存 ${staged.length} 个路径:\n${list(staged)}`}`,
    `  dirty（${dirty.length}）:\n${list(dirty.map((entry) => `${entry.code} ${entry.path}`))}`,
    `  outside the change（${foreign.length}）:\n${list(foreign.map((entry) => `${entry.code} ${entry.path}`))}`,
    `  diffstat: ${shortstat === "" ? "（无）" : shortstat}`,
    `  快速通道: ${fast ? "可用 — 整份 diff 都属于该 change" : "不可用 — 按 hunk 筛选"}`
  ].join("\n");
}

/**
 * Split current changes into one Conventional Commit per feature.
 * @param input Additional requirements for this run.
 */
async function commitChanges(input: string): Promise<AgentResult> {
  return agent({
    input: input || DEFAULT_TASK,
    patch: false,
    rules: ["git/commit.md"],
    echo: true
  });
}

async function commitSpec(change: string, sweep: boolean): Promise<AgentResult> {
  return agent({
    input: `将 OpenSpec change \`${change}\` 对应的工作区改动提交为一个 Conventional Commit。\n\n${await scopeBrief(change, sweep)}`,
    patch: false,
    rules: ["git/commit-spec.md"],
    echo: true
  });
}

/** 按功能拆分当前工作区的改动。`input` 可提供额外要求。 */
export function commit(input?: string): Promise<AgentResult>;
/**
 * 将指定 OpenSpec change 对应的工作区改动提交为一个 commit。
 * @param change 原 change 名称或完整归档目录名，例如 `2026-11-20-unify-ui-primitives`。
 * @param options.sweep 确认工作区所有改动都属于该 change：跳过逐 hunk 归属判断，直接提交。
 */
export function commit(mode: "spec", change: string, options?: { sweep?: boolean }): Promise<AgentResult>;
export async function commit(input = "", change?: string, options?: { sweep?: boolean }): Promise<AgentResult> {
  if (arguments.length < 2) return await commitChanges(input);

  if (arguments.length > 3 || input !== "spec") {
    throw new Error('按 OpenSpec change 提交时，请使用 commit("spec", change)。');
  }
  if (typeof change !== "string" || !CHANGE_NAME.test(change)) {
    throw new Error("请提供有效的 OpenSpec change 名称，例如 add-video-export。");
  }

  return await commitSpec(change, options?.sweep === true);
}
