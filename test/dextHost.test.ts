import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { ContextResolver } from "../src/features/workflow/host/contextResolver.js";
import type { ContextHost } from "../src/shared/contracts/context.js";
import { ExecutionCancelledError } from "../src/shared/protocol/executionErrors.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { DextRuntime } from "../src/features/workflow/host/runtime.js";
import type { ExecutionMetadata, InvocationAst, RuntimeResponse } from "../src/shared/contracts/types.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import { workflowCases } from "./dextWorkflowCases.js";
import { conversation, createConversationHarness } from "./conversationHarness.js";
import { renderHistoryRecord } from "../src/features/conversations/presentation/historyRender.js";
import { UI_VIEW_MAX_BYTES, UI_VIEW_MAX_NODES } from "../src/shared/contracts/uiView.js";
import { dextMarkdown } from "../src/shared/lib/markdown.js";
import { markdownCodeCopy } from "../src/shared/lib/markdownCopy.js";

const runnerDirectory = resolve("src", "runner");
workflowCases(runnerDirectory);
const languageFixture = resolve("test", "fixtures", "language.ts");

const contextHost: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

const roots: string[] = [];
const hosts: DextKernelHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) host.dispose();
  // The kernel's working directory is the workspace, so Windows keeps the
  // directory locked until the process is really gone.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function workspace(prefix = "dext-kernel-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fixture(root: string, name: string, source: string): Promise<string> {
  const file = join(root, name);
  await writeFile(file, source, "utf8");
  return file;
}

async function installSpecApi(root: string): Promise<void> {
  const api = join(root, ".dext", "api", "spec");
  await cp(resolve(".dext/api/spec"), api, { recursive: true });
}

function syncChangeStatus(root: string, changeName: string, capabilities: string[]) {
  const changeRoot = join(root, "openspec", "changes", changeName);
  return { changeName, changeRoot, planningHome: { root }, artifactPaths: {
    specs: { existingOutputPaths: capabilities.map((capability) => join(changeRoot, "specs", capability, "spec.md")) }
  } };
}

async function installGitReviewApi(root: string): Promise<void> {
  const api = join(root, ".dext", "api", "git");
  await mkdir(api, { recursive: true });
  for (const name of ["commit.ts", "fix.ts", "review.ts", "reviewDependencies.ts", "reviewFindings.ts", "reviewRepair.ts"]) {
    await writeFile(join(api, name), await readFile(resolve(".dext/api/git", name)));
  }
}

function expectWorkspaceReviewRule(invocation: InvocationAst): void {
  expect(invocation.method).toBe("agent");
  const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
  expect(args).toMatchObject({ rules: ["git/review.md"], apply: true, patch: false, echo: true });
  expect(args.skills).toBeUndefined();
}

function specReply(text: string, receipt: Record<string, unknown>): string {
  return `${text}\n\nDEXT_OPENSPEC_RESULT ${JSON.stringify(receipt)}`;
}

function askResponse(invocation: InvocationAst): RuntimeResponse {
  const input = invocation.arguments.find((argument) => argument.name === "input")?.value;
  return {
    invocation,
    method: { id: invocation.method, title: invocation.method, kind: "command", source: "builtin" },
    result: { kind: "ask", text: typeof input === "string" ? input : "" },
    durationMs: 0
  };
}

function host(root: string, execute: (invocation: InvocationAst, metadata: Readonly<ExecutionMetadata>) => Promise<RuntimeResponse>, maxConcurrency?: number): DextKernelHost {
  const instance = new DextKernelHost({
    workspaceRoot: root,
    nodeExecPath: process.execPath,
    runnerDirectory,
    execute,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency })
  });
  hosts.push(instance);
  return instance;
}

/** The real extension-host runtime: built-in methods only, no Agent profile. */
function builtinRuntime(root: string): DextRuntime {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver(contextHost));
  runtime.setWorkspaceRoot(root);
  return runtime;
}

describe("Dext kernel host", () => {
  it("records an ask step plus stdout and stderr stream steps", { timeout: 30000 }, async () => {
    const root = await workspace();
    const calls: string[] = [];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      return askResponse(invocation);
    });
    const response = await kernel.run(languageFixture);
    expect(calls).toEqual(["ask"]);
    expect(response.steps?.map((step) => step.method)).toEqual(["ask", "stdout", "stderr"]);
    const [ask, stdout, stderr] = response.steps!;
    expect(ask?.response?.result).toEqual({ kind: "ask", text: "x" });
    expect(stdout?.stream).toEqual({ channel: "stdout", text: "x\n" });
    expect(stderr?.stream).toEqual({ channel: "stderr", text: "boom\n" });
    // Stream steps are process output, not API results.
    expect(stdout?.response).toBeUndefined();
    expect(stderr?.response).toBeUndefined();
    expect(response.executions).toEqual([ask?.response]);
  });

  it("shows only the call that asked for echo", { timeout: 30000 }, async () => {
    const root = await workspace();
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const response = await kernel.runSource([
      'import { ask } from "dext";',
      'const shown = await ask({ input: "x", echo: true });',
      'const hidden = await ask({ input: "y" });',
      'console.log(shown.text + hidden.text);',
      ""
    ].join("\n"));
    const asks = response.steps?.filter((step) => step.method === "ask") ?? [];
    expect(asks.map((step) => step.quiet === true)).toEqual([false, true]);
    // Quiet only hides the step: the caller still gets the same result.
    expect(asks[0]?.response?.result).toEqual({ kind: "ask", text: "x" });
    expect(response.steps?.some((step) => step.stream?.text === "xy\n")).toBe(true);
  });

  it.each([
    { scenario: "reports partial progress", finalCount: 2, expected: "实施尚未完成。下一项是 1.3 收尾" },
    { scenario: "reports completion", finalCount: 3, expected: "开发任务已全部勾选。" },
    { scenario: "displays the skill pause", pause: true, finalCount: 2, expected: "需要确认设计。" },
    { scenario: "displays the OpenSpec blocker", blocked: true, finalCount: 2, expected: "缺少实施产物" },
    { scenario: "propagates an Agent error", fail: true, finalCount: 2, expected: "Agent execution failed" },
    { scenario: "omits the delta after deleting a task and reusing its ID", deleted: true, finalCount: 1, expected: "结束时 1/2 项已勾选" },
    { scenario: "omits the delta after reordering tasks", reordered: true, finalCount: 1, expected: "结束时 1/3 项已勾选" },
    { scenario: "omits the delta for duplicate descriptions in the same artifact", ambiguous: true, finalCount: 2, expected: "结束时 2/3 项已勾选" },
    { scenario: "keeps duplicate descriptions and IDs in different artifacts distinct", duplicate: true, finalCount: 1, expected: "本轮没有新增勾选的任务。" }
  ])("spec.apply $scenario after invoking the skill once", { timeout: 30000 }, async ({ pause, blocked, fail, deleted, reordered, ambiguous, duplicate, finalCount, expected }) => {
    const root = await workspace();
    await installSpecApi(root);
    let completed = 1;
    const calls: string[] = [];
    const descriptions = duplicate || ambiguous ? ["重复任务", "重复任务", "1.3 收尾"] : ["1.1 基线", "1.2 组件验证 verify: npm test", "1.3 收尾"];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      const response = askResponse(invocation);
      if (invocation.method === "agent") {
        expect(invocation.arguments.find(({ name }) => name === "input")?.value).toContain("Change: example");
        expect(invocation.arguments.find(({ name }) => name === "skills")?.value).toEqual(["openspec-apply-change"]);
        completed = finalCount;
        if (fail) throw new Error(expected);
        const text = specReply(pause ? "## Implementation Paused\n\n需要确认设计。" : "本轮 Agent 说明",
          { status: pause ? "pending" : blocked ? "blocked" : "completed", change: "example", root, cwd: ".", store: null });
        return { ...response, result: { kind: "agent", text } };
      }
      const command = invocation.arguments.find(({ name }) => name === "command")?.value;
      if (typeof command !== "string") throw new Error("Expected a terminal command");
      let tasks = descriptions.map((description, index) => ({
        description, done: index < completed, sourcePath: duplicate && index === 1 ? "/tasks/other.md" : "/tasks/main.md"
      }));
      if (deleted || reordered) {
        tasks[0]!.done = false;
        tasks[1]!.done = true;
        if (calls.includes("agent")) {
          if (deleted) tasks = tasks.slice(1);
          if (reordered) tasks = [tasks[1]!, tasks[0]!, tasks[2]!];
        }
      }
      const stdout = command === 'openspec instructions apply --change "example" --json'
        ? JSON.stringify({
          changeName: "example",
          root: { path: root, source: "nearest" },
          state: blocked && completed > 1 ? "blocked" : completed === 3 ? "all_done" : "ready",
          instruction: blocked ? "缺少实施产物" : completed === 3 ? "归档前建议执行验证和人工验收。" : "继续实施",
          tasks: tasks.map((task, index) => ({ ...task, id: String(duplicate && index < 2 ? 1 : index + 1) }))
        })
        : " M openspec/changes/example/tasks.md\n";
      return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
        exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
    });
    const run = kernel.runSource('import { spec } from "dext/api/spec/index";\nspec.apply("example");');
    if (fail) {
      await expect(run).rejects.toThrow(expected);
      expect(calls.filter((method) => method === "agent")).toHaveLength(1);
      return;
    }
    const response = await run;
    const output = response.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text;
    expect(calls.filter((method) => method === "agent")).toHaveLength(1);
    const total = deleted ? 2 : 3;
    expect(output).toContain(`开始时 1/3，结束时 ${finalCount}/${total} 项已勾选，剩余 ${total - finalCount} 项。`);
    if (duplicate || deleted || reordered || ambiguous) expect(output).not.toContain("本轮新增勾选");
    else expect(output).toContain("- 1.2 组件验证");
    expect(output).not.toContain("verify: npm test");
    expect(output).toContain(expected);
    expect(output).toContain(pause ? "## Implementation Paused" : "本轮 Agent 说明");
    // Whatever the state, the output ends with the one command to run next.
    const nextStep = output?.slice(output.lastIndexOf("### 下一步"));
    expect(nextStep).toBeDefined();
    const command = blocked ? 'openspec status --change "example" --json'
      : pause ? "先完成 Agent 说明中的确认"
      : finalCount === 3 ? 'spec.archive("example",' : 'spec.apply("example",';
    expect(nextStep).toContain(command);
    if (finalCount === 3) {
      expect(nextStep).toMatch(/归档前建议执行验证和人工验收。[\s\S]+完成[\s\S]+spec\.archive/u);
      expect(nextStep).not.toContain("剩下的只有归档");
    }
    if (!pause && !blocked && !ambiguous && finalCount === 2) expect(nextStep).toContain('从「1.3 收尾」继续');
  });

  it.each([
    { mode: "propose", args: '"新增示例"', id: "openspec-propose", text: "提案 example 的规划产物已写入。", next: 'spec.apply("example",' },
    { mode: "propose", args: '"新增示例"', id: "openspec-propose", text: "待确认\n\n请确认提案范围。", state: "pending", next: "先完成 Agent 说明中的确认", absent: "spec.apply" },
    { mode: "propose", args: '"新增示例"', id: "openspec-propose", text: "规划产物已写入，严格校验未通过。", state: "blocked", next: "尚未确认本轮提案已创建并通过检查", absent: "spec.apply" },
    { mode: "update", args: '"example", "修订方案"', id: "openspec-update-change", text: "方案无需修改。", state: "unchanged", next: 'spec.apply("example",' },
    { mode: "update", args: '"example"', id: "openspec-update-change", text: "待确认\n\n拟修订提案。", state: "pending", next: "未能生成可确认的修订预览", absent: "spec.apply" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "已归档到 openspec/changes/archive/2026-11-21-example。", next: 'spec.propose' },
    { mode: "archive", args: '"legacy_change"', changeName: "legacy_change", id: "openspec-archive-change", text: "历史变更已归档。", next: "活跃变更已清空" },
    { mode: "archive", args: '"legacy_change"', changeName: "legacy_change", listedArchiveName: "2026-11-20-legacy_change", id: "openspec-archive-change", text: "归档列表只有另一条历史归档。", next: "归档状态未知", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "等待选择同步方式。", state: "pending", next: "归档确认未能完成", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "归档目录已存在。", state: "blocked", next: "仍在活跃变更中", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "归档查询出错。", queryFails: true, next: "归档状态未知", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "活跃列表已找不到目标。", archiveMissing: true, next: "归档状态未知", absent: "活跃变更已清空" },
    { mode: "sync", args: "", id: "openspec-sync-specs", text: "主规格已同步。", state: "unchanged", next: 'spec.archive("example",' },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "评估期间新增了增量规格。", state: "unchanged", syncDrift: "added", next: "重新生成同步预览", absent: "spec.archive" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "校验期间改写了增量规格。", state: "unchanged", syncDrift: "modified", next: "重新生成同步预览", absent: "spec.archive" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "主规格缺少要修改的需求。", state: "blocked", next: "同步结果尚未确认", absent: "spec.archive" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "收到越界的同步路径。", state: "pending", next: "未能生成可确认的同步预览", absent: "spec.archive" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "主规格已同步。", state: "unchanged", queryFails: true, next: "校验未通过", absent: "spec.archive" },
    { mode: "explore", args: '"调查示例"', id: "openspec-explore", text: "探索结论和源码依据。", next: 'spec.propose' }
  ])("shows spec.$mode output after $text", { timeout: 30000 }, async ({
    mode, args, id, text, state = "completed", queryFails, archiveMissing, next, absent,
    changeName = "example", listedArchiveName, syncDrift
  }) => {
    const root = await workspace();
    await installSpecApi(root);
    const syncStatus = syncChangeStatus(root, "example", ["example"]);
    const updatePath = join(syncStatus.changeRoot, "proposal.md");
    const updateStatus = {
      changeName, changeRoot: syncStatus.changeRoot,
      artifactPaths: { proposal: { resolvedOutputPath: updatePath, existingOutputPaths: [updatePath] } }
    };
    if (mode === "update") {
      await mkdir(updateStatus.changeRoot, { recursive: true });
      await writeFile(updatePath, "Original");
    }
    if (mode === "sync") {
      const [path] = syncStatus.artifactPaths.specs.existingOutputPaths;
      await mkdir(resolve(path!, ".."), { recursive: true });
      await writeFile(path!, "## ADDED Requirements\n");
      syncStatus.artifactPaths.specs.existingOutputPaths = [await realpath(path!)];
    }
    const archiveName = `2026-11-21-${changeName}`;
    const calls: string[] = [];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "skill") {
        expect(args.skill).toBe(id);
        return { ...response, result: { kind: "skill", text } };
      }
      if (invocation.method === "agent") {
        expect(args).toMatchObject({ skills: [id], apply: mode !== "update" && mode !== "sync", patch: false });
        if (mode === "propose") expect(args.input).toContain("运行严格校验并报告结果");
        if (mode === "sync") expect(args.input).toContain("Change: example");
        if (syncDrift === "added") {
          const [path] = syncChangeStatus(root, "example", ["new-capability"]).artifactPaths.specs.existingOutputPaths;
          await mkdir(resolve(path!, ".."), { recursive: true });
          await writeFile(path!, "## ADDED Requirements\n");
          syncStatus.artifactPaths.specs.existingOutputPaths.push(await realpath(path!));
        }
        const receipt = { status: state, change: changeName, root, cwd: ".", store: null,
          ...(mode === "archive" && state === "completed" ? { archiveName } : {}),
          ...(mode === "sync" && state === "pending" ? { syncPrompt: { summary: text, paths: [join(root, "other", "spec.md")] } } : {}) };
        return { ...response, result: { kind: "agent", text: specReply(text, receipt) } };
      }
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command");
      const rootInfo = { path: root, source: "nearest" };
      const change = { name: changeName, completedTasks: 1, totalTasks: 3, lastModified: "2026-11-21T08:35:53.351Z" };
      let stdout = "";
      let exitCode = 0;
      if ((mode === "update" || mode === "sync") && command === 'openspec status --change "example" --json') {
        stdout = JSON.stringify({ root: rootInfo, ...(mode === "update" ? updateStatus : syncStatus) });
      } else if (command === "openspec list --json") {
        stdout = JSON.stringify({ root: rootInfo, changes: mode === "sync" ? [change] : [
          ...(calls.includes("agent") && state === "completed" ? [change] : []),
          { ...change, name: "other", lastModified: "2026-11-22T08:35:53.351Z" }
        ] });
      } else if (command === "openspec list --all --json") {
        const changes = archiveMissing ? [] : state === "completed"
          ? [{ ...change, name: listedArchiveName ?? archiveName, archived: true }]
          : [{ ...change, archived: false }];
        stdout = queryFails ? "查询失败" : JSON.stringify({ changes, root: rootInfo });
        if (queryFails) exitCode = 1;
      } else if (command === "openspec validate --specs --json") {
        if (syncDrift === "modified") {
          await writeFile(syncStatus.artifactPaths.specs.existingOutputPaths[0]!, "## MODIFIED Requirements\n");
        }
        stdout = JSON.stringify({ root: rootInfo, items: [{ id: "example", valid: !queryFails }] });
        if (queryFails) exitCode = 1;
      } else {
        expect(command).toBe("git status --porcelain -uall");
      }
      return { ...response, result: { kind: "terminal", status: exitCode === 0 ? "succeeded" : "failed", command, cwd: root,
        exit_code: exitCode, stdout, stderr: "", duration_ms: 1 } };
    });
    const response = await kernel.runSource(`import { spec } from "dext/api/spec/index";\nspec.${mode}(${args});`);
    const output = response.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream?.text).join("");
    expect(output).toContain(syncDrift ? "同步评估后，增量规格路径或规格版本已变化" : text);
    expect(output).toContain(`### 下一步`);
    expect(output).toContain(next);
    expect(output).not.toContain("DEXT_OPENSPEC_RESULT");
    if (absent) expect(output?.slice(output.lastIndexOf("### 下一步"))).not.toContain(absent);
    expect(calls.filter((method) => method === (mode === "explore" ? "skill" : "agent"))).toHaveLength(1);
  });

  it.each([
    "confirm", "cancel", "delta changed", "select change", "partial", "batch status error", "linked specs",
    "backticks", "backticks at description limit", "delta content changed", "main content changed",
    "main created", "main deleted", "already synced subset", "legacy explicit", "large batch",
    "preview file changed and restored", "list access denied", "list non-JSON error", "list denied with truncated batch",
    "blocked spec snapshot", "main outside spec root", "already synced spec changed", "missing main parent redirected",
    "delta added during write", "delta modified during write", "already synced main modified during write",
    "linked main specs", "main spec root redirected",
    "main spec root redirected during final status"
  ] as const)("handles spec.sync dialog with %s in the same Code turn", { timeout: 30000 }, async (choice) => {
    const root = await workspace();
    await installSpecApi(root);
    const runtime = builtinRuntime(root);
    const store = "team-specs";
    const scope = { cwd: root, root, store };
    const atDescriptionLimit = choice === "backticks at description limit";
    const phases: boolean[] = [];
    let statusChecks = 0;
    const capabilities = choice === "backticks" ? ["ex`ports", "nested/le``ga`cy"]
      : ["exports", atDescriptionLimit ? "nested/le``gacy" : "nested/legacy"];
    const name = choice === "legacy explicit" || choice === "select change" ? "legacy_change" : "example";
    const truncatedBatch = choice === "list denied with truncated batch";
    const listFailed = choice === "list access denied" || choice === "list non-JSON error" || truncatedBatch;
    const batch = choice === "select change" || choice === "batch status error" || choice === "large batch" || listFailed;
    const restoredDuringConfirmation = choice === "preview file changed and restored";
    const blockedSpec = choice === "blocked spec snapshot";
    const escapedSpec = choice === "main outside spec root";
    const changedSyncedMain = choice === "already synced main modified during write";
    const alreadySynced = choice === "already synced subset" || choice === "already synced spec changed" || changedSyncedMain;
    const partial = choice === "partial" || blockedSpec || escapedSpec;
    const subset = partial || alreadySynced;
    const change = syncChangeStatus(root, name, capabilities);
    const specsDir = join(change.changeRoot, "specs");
    const deltaDir = choice === "linked specs" ? join(change.changeRoot, "drafts") : specsDir;
    for (const capability of capabilities) {
      const dir = join(deltaDir, capability);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "spec.md"), "");
    }
    if (choice === "linked specs") await symlink(deltaDir, specsDir, "junction");
    const deltaPaths = await Promise.all(change.artifactPaths.specs.existingOutputPaths.map((path) => realpath(path)));
    const originalDelta = "## ADDED Requirements\n\n### Requirement: 导出 A\n用户应能导出 A。\n";
    if (restoredDuringConfirmation) await writeFile(deltaPaths[0]!, originalDelta);
    change.artifactPaths.specs.existingOutputPaths = deltaPaths;
    const approvedPaths = subset ? deltaPaths.slice(0, 1) : deltaPaths;
    const mainPaths = capabilities.map((capability) => join(root, "openspec", "specs", capability, "spec.md"));
    const main = mainPaths[0]!;
    const syncedMain = mainPaths[1]!;
    const mainParent = resolve(main, "..");
    const redirectedDuringFinalStatus = choice === "main spec root redirected during final status";
    const linkedMainSpecs = choice === "linked main specs" || choice === "main spec root redirected" || redirectedDuringFinalStatus;
    const mainSpecRoot = join(root, "openspec", "specs");
    const sharedSpecs = join(root, "shared-specs");
    if (linkedMainSpecs) {
      await mkdir(join(sharedSpecs, capabilities[0]!), { recursive: true });
      await mkdir(join(sharedSpecs, "nested"));
      await symlink(sharedSpecs, mainSpecRoot, "junction");
      await writeFile(main, "Original");
    }
    if (choice === "missing main parent redirected") await mkdir(mainParent, { recursive: true });
    if (blockedSpec) await mkdir(mainPaths[1]!, { recursive: true });
    if (escapedSpec) {
      const external = join(root, "external");
      const linkedParent = resolve(mainPaths[1]!, "..");
      await mkdir(external);
      await mkdir(resolve(linkedParent, ".."), { recursive: true });
      await symlink(external, linkedParent, "junction");
    }
    if (choice === "main content changed" || choice === "main deleted") {
      await mkdir(resolve(main, ".."), { recursive: true });
      await writeFile(main, "Original");
    }
    if (alreadySynced) {
      await writeFile(deltaPaths[1]!, originalDelta);
      await mkdir(resolve(syncedMain, ".."), { recursive: true });
      await writeFile(syncedMain, "# Legacy\n\n## Requirements\n\n### Requirement: 导出 A\n用户应能导出 A。\n");
    }
    let summary = restoredDuringConfirmation ? "exports/spec.md：新增「导出 A」需求。" : partial
      ? `exports/spec.md：新增「导出」需求。\nlegacy/spec.md：受阻，跳过该规格。${blockedSpec ? " EISDIR" : ""}`
      : alreadySynced ? "exports/spec.md：新增「导出」需求。\nlegacy/spec.md：已同步。"
      : "exports/spec.md：新增「导出」需求。";
    if (atDescriptionLimit) {
      const targetList = mainPaths.map((path) => `- \`${path}\``).join("\n");
      const prefix = [
        `OpenSpec 根目录 \`${root}\``, `Store \`${store}\``, "### 本次确认的主规格文件", targetList, "### 拟同步内容", ""
      ].join("\n\n");
      summary = summary.padEnd(20_000 - prefix.length, "x");
    }
    const diagnostic = "Unknown schema: broken-schema";
    const other = choice === "batch status error" || listFailed
      ? { changeName: "broken", status: [{ severity: "error", code: "change_error", message: diagnostic }] }
      : syncChangeStatus(root, "other", ["auth"]);
    const drafts = Array.from({ length: choice === "large batch" ? 98 : truncatedBatch ? 97 : 1 }, (_, index) => ({
      ...syncChangeStatus(root, `draft-${index}`, []), artifacts: [{ instruction: "x".repeat(3100) }]
    }));
    const statuses = [other, change, ...drafts];
    const listDiagnostic = "EACCES: permission denied, scandir 'openspec/changes/.scratch'";
    if (truncatedBatch) {
      for (const { changeName } of [other, ...drafts]) {
        await mkdir(join(root, "openspec", "changes", changeName), { recursive: true });
      }
      for (const name of [".scratch", "archive"]) {
        await mkdir(join(root, "openspec", "changes", name), { recursive: true });
      }
    }
    if (choice === "large batch") expect(Buffer.byteLength(JSON.stringify(statuses))).toBeGreaterThan(256 * 1024);
    const kernel = host(root, async (invocation, metadata) => {
      if (invocation.method === "ui.form" || invocation.method === "ui.select") return runtime.execute(invocation, [], metadata);
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "agent") {
        expect(args).toMatchObject({ skills: ["openspec-sync-specs"], apply: phases.length > 0, patch: false,
          workspace: { kind: "dirRef", uri: pathToFileURL(root).href } });
        phases.push(args.apply === true);
        const input = args.input;
        if (typeof input !== "string") throw new Error("Expected a sync Agent prompt string.");
        expect(input).toContain(`Change: ${name}`);
        expect(input).toContain(JSON.stringify(scope));
        if (linkedMainSpecs && !args.apply) {
          expect(input).toContain(JSON.stringify({ deltaPath: deltaPaths[0], mainPath: main, delta: "", main: "Original" }));
          expect(input).toContain(JSON.stringify({ deltaPath: deltaPaths[1], mainPath: mainPaths[1], delta: "", main: null }));
        }
        if ((blockedSpec || escapedSpec) && !args.apply) {
          expect(input).toContain(blockedSpec ? "EISDIR" : "主规格的实际路径超出所选规格根目录");
          expect(input).toContain(JSON.stringify(mainPaths[1]));
          const snapshot = input.split("\n").find((line) => line.startsWith("Dext 已读取规格快照 "));
          expect(snapshot).toContain(JSON.stringify(deltaPaths[0]));
          expect(snapshot).not.toContain(JSON.stringify(deltaPaths[1]));
        }
        if (args.apply === true) {
          expect(input).toContain(JSON.stringify(summary));
          expect(input).toContain(JSON.stringify(approvedPaths));
          expect(input).toContain(JSON.stringify(mainPaths.slice(0, approvedPaths.length)));
          if (linkedMainSpecs) expect(input).toContain(`本次确认的规格根目录 ${JSON.stringify(await realpath(sharedSpecs))}`);
          if (subset) expect(input).not.toContain(JSON.stringify(deltaPaths));
          await mkdir(mainParent, { recursive: true });
          await writeFile(main, "# Main spec\n");
          if (choice === "delta added during write") {
            const [added] = syncChangeStatus(root, name, ["new-capability"]).artifactPaths.specs.existingOutputPaths;
            await mkdir(resolve(added!, ".."), { recursive: true });
            await writeFile(added!, originalDelta);
            deltaPaths.push(await realpath(added!));
          }
          if (choice === "delta modified during write") await writeFile(deltaPaths[0]!, originalDelta);
          if (changedSyncedMain) {
            await writeFile(syncedMain, "# Legacy\n\n## Requirements\n\n### Requirement: 导出 B\n用户应能导出 B。\n");
          }
        }
        const receipt = { change: name, cwd: root, root, store };
        let previewSummary = summary;
        if (restoredDuringConfirmation && args.apply === false) {
          const diskVersion = originalDelta.replaceAll("导出 A", "导出 B");
          await writeFile(deltaPaths[0]!, diskVersion);
          const snapshotPrefix = "Dext 已读取规格快照 ";
          const snapshotLine = input.split("\n").find((line) => line.startsWith(snapshotPrefix));
          const snapshot = snapshotLine
            ? JSON.parse(snapshotLine.slice(snapshotPrefix.length)) as Array<{ deltaPath: string; delta: string }>
            : [];
          const pair = snapshot.find((entry) => entry.deltaPath === deltaPaths[0]);
          const comparedContent = pair?.delta ?? await readFile(deltaPaths[0]!, "utf8");
          previewSummary = summary.replace("导出 A", comparedContent.includes("导出 A") ? "导出 A" : "导出 B");
          if (pair) {
            expect(pair).toMatchObject({ deltaPath: deltaPaths[0], mainPath: main, delta: originalDelta, main: null });
            expect(input).toContain("不得重新读取");
          }
        }
        const syncPrompt = { summary: previewSummary, paths: approvedPaths,
          ...(alreadySynced ? { alreadySyncedPaths: deltaPaths.slice(1) } : {}) };
        const text = args.apply === true
          ? specReply("主规格已写入。", { ...receipt, status: "completed" })
          : specReply(previewSummary, { ...receipt, status: "pending", syncPrompt });
        return { ...response, result: { kind: "agent", text } };
      }
      expect(invocation.method).toBe("terminal");
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command string.");
      const rootInfo = { path: root, store_id: store };
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      if (command === `openspec status --change "${name}" --json --store "${store}"`) {
        statusChecks++;
        if (redirectedDuringFinalStatus && statusChecks === 3) {
          const replacement = join(root, "replacement-specs");
          await mkdir(replacement);
          expect(await readFile(main, "utf8")).toBe("# Main spec\n");
          await rm(mainSpecRoot);
          await symlink(replacement, mainSpecRoot, "junction");
          await expect(readFile(main, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
        const target = choice === "delta changed" && statusChecks > 1 ? syncChangeStatus(root, name, ["exports"]) : change;
        stdout = JSON.stringify({ ...target, root: rootInfo });
      } else if (command === `openspec list --json --store "${store}"`) {
        if (listFailed) {
          exitCode = 1;
          if (choice === "list access denied") {
            stdout = JSON.stringify({ root: null, changes: [], status: [{ severity: "error", code: "list_error", message: listDiagnostic }] });
          } else {
            stderr = listDiagnostic;
          }
        } else {
          stdout = JSON.stringify({ root: rootInfo, changes: statuses.map(({ changeName }) => ({ name: changeName })) });
        }
      } else if (command === `openspec status --all --json --store "${store}"`) {
        expect(listFailed).toBe(true);
        exitCode = 1;
        stdout = JSON.stringify({ root: rootInfo, changes: statuses });
        if (truncatedBatch) {
          const bytes = Buffer.from(stdout);
          expect(bytes.length).toBeGreaterThan(256 * 1024);
          stdout = `${bytes.subarray(0, 256 * 1024).toString()}\n[output truncated]`;
        }
      } else if (command === `openspec context --json --store "${store}"`) {
        expect(truncatedBatch).toBe(true);
        stdout = JSON.stringify({ root: rootInfo, members: [] });
      } else if (command === `openspec validate --specs --json --store "${store}"`) {
        stdout = JSON.stringify({ root: rootInfo, items: [{ id: "exports", valid: true }] });
      } else {
        const target = statuses.find(({ changeName }) => command === `openspec status --change "${changeName}" --json --store "${store}"`);
        if (target && "status" in target) {
          exitCode = 1;
          stdout = JSON.stringify({ status: target.status });
        } else if (target) {
          stdout = JSON.stringify({ ...target, root: rootInfo });
        } else {
          expect(command).toBe("git status --porcelain -uall");
        }
      }
      return { ...response, result: { kind: "terminal", status: exitCode === 0 ? "succeeded" : "failed", command, cwd: root, exit_code: exitCode, stdout,
        stderr, duration_ms: 1 } };
    });
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, { execution, signal: execution.signal! })
    });
    const session = conversation(`sync-${choice}`);
    await h.seed([session]);
    const requested = batch ? "" : name;
    const running = h.coordinator.execute(h.controller.active(), "code",
      `import { spec } from "dext/api/spec/index";\nspec.sync("${requested}", { store: "${store}" });`);
    const waitForDialog = (title: string) => vi.waitFor(() => {
      for (const message of h.messages) {
        if (message.type !== "agentEvent") continue;
        const interaction = message.event.uiInteraction;
        if (interaction?.status === "waiting" && interaction.form.title === title) return interaction;
      }
      throw new Error(`Waiting for dialog ${title}`);
    }, { timeout: 8000 });
    try {
      if (choice === "select change" || choice === "large batch") {
        const selection = await waitForDialog("选择要同步的变更");
        expect(phases).toEqual([]);
        expect(selection.form.fields[0]).toMatchObject({ options: [{ value: name }, { value: "other" }] });
        expect(h.interactions.respondUi(selection.sessionId, selection.turnId, selection.requestId, {
          kind: "ui", type: "form", status: "submitted", answers: { answer: { type: "select", selected: [name] } }
        })).toBe(true);
      }
      const request = await waitForDialog(`同步 ${name}`);
      expect(phases).toEqual([false]);
      expect(statusChecks).toBe(listFailed && !truncatedBatch ? 0 : 1);
      expect(request.form).toMatchObject({ presentation: "dialog", actions: [{ id: "sync", label: "确认同步" }], show_cancel: true });
      expect(request.form.description).toContain(root);
      expect(request.form.description).toContain(store);
      expect(request.form.description).toContain(summary);
      expect(request.form.description).toContain(mainPaths[0]);
      if (subset) expect(request.form.description).not.toContain(mainPaths[1]);
      else expect(request.form.description).toContain(mainPaths[1]);
      if (atDescriptionLimit) expect(request.form.description).toHaveLength(20_000);
      if (choice === "backticks" || atDescriptionLimit) {
        const markdown = dextMarkdown();
        const html = markdown.render(request.form.description);
        for (const path of mainPaths) expect(html).toContain(`<li><code>${markdown.utils.escapeHtml(path)}</code></li>`);
      }
      if (choice === "delta content changed") await writeFile(deltaPaths[0]!, "Modified");
      if (choice === "main created") await mkdir(resolve(main, ".."), { recursive: true });
      if (choice === "main content changed" || choice === "main created") await writeFile(main, "Modified");
      if (choice === "main deleted") await rm(main);
      if (choice === "missing main parent redirected") {
        const otherParent = join(resolve(mainParent, ".."), "other-exports");
        await mkdir(otherParent);
        await rmdir(mainParent);
        await symlink(otherParent, mainParent, "junction");
      }
      if (choice === "main spec root redirected") {
        const originalRoot = await realpath(sharedSpecs);
        const replacement = join(root, "replacement-specs");
        await mkdir(replacement);
        // Keep both file paths resolving to their previewed targets after changing the root.
        await symlink(join(originalRoot, "nested"), join(replacement, "nested"), "junction");
        await symlink(join(originalRoot, "exports"), join(replacement, "exports"), "junction");
        await rm(mainSpecRoot);
        await symlink(replacement, mainSpecRoot, "junction");
      }
      if (choice === "already synced spec changed") await writeFile(deltaPaths[1]!, "Modified");
      if (restoredDuringConfirmation) await writeFile(deltaPaths[0]!, originalDelta);
      const stale = ["delta content changed", "main content changed", "main created", "main deleted", "already synced spec changed", "missing main parent redirected", "main spec root redirected"]
        .some((reason) => choice === reason);
      const reply = choice === "cancel" ? { status: "cancelled" } : { status: "submitted", action: "sync" };
      expect(h.interactions.respondUi(request.sessionId, request.turnId, request.requestId,
        { kind: "ui", type: "form", answers: {}, ...reply })).toBe(true);
      await running;
      const turn = (await h.history.session(session.id))!.turns[0]!;
      const output = turn.response?.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream?.text).join("");
      const written = choice !== "cancel" && choice !== "delta changed" && !stale;
      expect(phases).toEqual(written ? [false, true] : [false]);
      if (written) {
        expect(output).toContain("主规格已写入");
        if (choice === "batch status error" || listFailed) expect(output).toContain(diagnostic);
        if (listFailed) expect(output).toContain(listDiagnostic);
        if (truncatedBatch) {
          expect(output).toContain("批量状态超过 terminal() 的输出上限，已改为尝试逐项读取");
          expect(output).not.toContain("- .scratch");
          expect(output).not.toContain("- archive ·");
        }
        if (partial) {
          expect(output).toContain("归档前请核对其余增量规格");
          expect(output).not.toContain("spec.archive");
        } else if (redirectedDuringFinalStatus || changedSyncedMain || choice === "delta added during write" || choice === "delta modified during write") {
          if (redirectedDuringFinalStatus) expect(output).toContain("规格根目录已变化或无法核实");
          expect(output).toContain("重新生成同步预览");
          expect(output).not.toContain("spec.archive");
        } else {
          expect(output).toContain(`spec.archive("${name}", ${JSON.stringify(scope)})`);
        }
      } else {
        expect(output).toContain(choice === "cancel" ? "已取消规格同步" : stale ? "此次确认已失效" : "未能核实指定的 OpenSpec");
        expect(output).not.toContain("spec.archive");
      }
      const preWriteChecks = (listFailed && !truncatedBatch) || choice === "cancel" ? 1 : 2;
      expect(statusChecks).toBe(preWriteChecks + (written && !partial ? 1 : 0));
    } finally {
      h.coordinator.abort(session.id);
      await running;
      h.dispose();
    }
  });

  it.each(["single change", "batch failures", "list truncated", "status truncated", "unsafe name"] as const)("returns from spec.sync without starting an Agent when there are no confirmed delta specs (%s)", { timeout: 30000 }, async (choice) => {
    const root = await workspace();
    await installSpecApi(root);
    const commands: string[] = [];
    const list = choice !== "single change" && choice !== "unsafe name";
    const diagnostic = "Unknown schema: broken-schema";
    const kernel = host(root, async (invocation) => {
      expect(invocation.method).toBe("terminal");
      const command = invocation.arguments.find(({ name }) => name === "command")?.value;
      if (typeof command !== "string") throw new Error("Expected a terminal command string.");
      commands.push(command);
      const rootInfo = { path: root };
      const change = syncChangeStatus(root, "example", []);
      let exitCode = 0;
      let stdout: string;
      if (command === "openspec list --json") {
        stdout = choice === "list truncated" ? '{"changes":["'.padEnd(256 * 1024, "x")
          : JSON.stringify({ root: rootInfo, changes: [{ name: "example" }, { name: "broken" }] });
      } else if (command === 'openspec status --change "example" --json') {
        stdout = JSON.stringify({ root: rootInfo, ...change });
      } else {
        expect(command).toBe('openspec status --change "broken" --json');
        if (choice === "status truncated") {
          stdout = '{"artifacts":[\n[output truncated]';
        } else {
          exitCode = 1;
          stdout = JSON.stringify({ status: [{ severity: "error", code: "change_error", message: diagnostic }] });
        }
      }
      return { ...askResponse(invocation), result: { kind: "terminal", status: exitCode ? "failed" : "succeeded", command, cwd: root, exit_code: exitCode, stdout,
        stderr: "", duration_ms: 1 } };
    });
    const args = list ? "" : JSON.stringify(choice === "unsafe name" ? "%USERNAME%" : "example");
    const response = await kernel.runSource(`import { spec } from "dext/api/spec/index";\nspec.sync(${args});`);
    const output = response.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text;
    if (choice === "list truncated" || choice === "status truncated") {
      expect(output).toContain("超过 terminal() 的输出上限");
      expect(output).toContain('spec.sync("<change>"');
    } else {
      expect(output).toContain(choice === "batch failures" ? diagnostic
        : choice === "unsafe name" ? "未能核实指定的 OpenSpec" : "example 没有增量规格");
    }
    const exampleStatus = 'openspec status --change "example" --json';
    if (choice === "unsafe name") expect(commands).toEqual([]);
    else if (choice === "single change") expect(commands).toEqual([exampleStatus]);
    else if (choice === "list truncated") expect(commands).toEqual(["openspec list --json"]);
    else {
      expect(commands[0]).toBe("openspec list --json");
      expect(commands.slice(1).sort()).toEqual(['openspec status --change "broken" --json', exampleStatus]);
    }
  });

  it("reports the path and reason when spec.update cannot read a preview artifact", { timeout: 30000 }, async () => {
    const root = await workspace("dext-kernel-`literal`-");
    await installSpecApi(root);
    const changeRoot = join(root, "change");
    const proposal = join(changeRoot, "proposal.md");
    await mkdir(changeRoot);
    await writeFile(proposal, "Original");
    const resolvedProposal = await realpath(proposal);
    const diagnostic = `EACCES: permission denied, open '${resolvedProposal}'`;
    const calls: string[] = [];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      expect(invocation.method).toBe("terminal");
      const command = 'openspec status --change "example" --json';
      expect(invocation.arguments.find(({ name }) => name === "command")?.value).toBe(command);
      const stdout = JSON.stringify({ changeName: "example", root: { path: root }, changeRoot,
        artifactPaths: { proposal: { resolvedOutputPath: proposal, existingOutputPaths: [proposal] } } });
      return { ...askResponse(invocation), result: { kind: "terminal", status: "succeeded", command, cwd: root,
        exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
    });
    const response = await kernel.runSource([
      'import fs from "node:fs/promises";',
      'import { syncBuiltinESMExports } from "node:module";',
      'import { spec } from "dext/api/spec/index";',
      'const readFile = fs.readFile;',
      'fs.readFile = async (path, options) => {',
      `  if (path === ${JSON.stringify(resolvedProposal)}) throw new Error(${JSON.stringify(diagnostic)});`,
      '  return readFile(path, options);',
      '};',
      'syncBuiltinESMExports();',
      'try { await spec.update("example"); }',
      'finally { fs.readFile = readFile; syncBuiltinESMExports(); }'
    ].join("\n"));
    const output = response.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text ?? "";
    expect(calls).toEqual(["terminal"]);
    expect(output).toContain("重新生成修订预览");
    expect(output).toContain(proposal);
    expect(output).toContain(diagnostic);
    const markdown = dextMarkdown().use(markdownCodeCopy);
    const rendered = markdown.render(output);
    const literal = markdown.utils.escapeHtml(`${proposal}：${diagnostic}\n`);
    expect(rendered).toContain(`<pre><code>${literal}</code></pre>`);
    expect(rendered).toContain(`data-copy="${literal}"`);
  });

  it.each(["confirm", "cancel", "scope changed", "change directory changed", "artifact path changed", "artifact content changed",
    "preview artifact changed and restored", "legacy name"] as const)("handles spec.update dialog with %s in the same Code turn", { timeout: 30000 }, async (choice) => {
    const root = await workspace();
    await installSpecApi(root);
    const runtime = builtinRuntime(root);
    const store = "team-specs";
    const name = choice === "legacy name" ? "legacy_change" : "example";
    const restoredDuringConfirmation = choice === "preview artifact changed and restored";
    const summary = "proposal.md：补充导出范围。\ntasks.md：增加导出验证。";
    const changeRoot = join(root, "change");
    const proposal = join(changeRoot, "proposal.md");
    await mkdir(changeRoot);
    await writeFile(proposal, "Original");
    const resolvedProposal = await realpath(proposal);
    const phases: boolean[] = [];
    const applyCalls: string[] = [];
    let statusChecks = 0;
    const kernel = host(root, async (invocation, metadata) => {
      if (invocation.method === "ui.form") return runtime.execute(invocation, [], metadata);
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "agent") {
        if (choice === "legacy name" && (args.skills as string[])[0] === "openspec-apply-change") {
          expect(args).toMatchObject({ apply: true, patch: false });
          expect(args.input).toContain(`Change: ${name}`);
          applyCalls.push("agent");
          return { ...response, result: { kind: "agent", text: specReply("实施已完成。", {
            status: "completed", change: name, cwd: root, root, store
          }) } };
        }
        expect(args).toMatchObject({ skills: ["openspec-update-change"], apply: phases.length > 0, patch: false,
          workspace: { kind: "dirRef", uri: pathToFileURL(root).href } });
        phases.push(args.apply === true);
        expect(args.input).toContain(JSON.stringify({ cwd: root, root, store }));
        expect(args.input).toContain("修订导出方案");
        if (args.apply === true) {
          expect(args.input).toContain(JSON.stringify(summary));
          expect(args.input).toContain(JSON.stringify({
            path: proposal, resolvedPath: resolvedProposal, digest: createHash("sha256").update("Original").digest("hex")
          }));
          expect(args.input).toContain("写入前核对");
        }
        const receipt = { change: name, cwd: root, root, store };
        let previewSummary = summary;
        if (restoredDuringConfirmation && args.apply === false) {
          await writeFile(proposal, "Modified");
          const prefix = "Dext 已读取产物快照 ";
          const line = (args.input as string).split("\n").find((line) => line.startsWith(prefix));
          const files = line ? JSON.parse(line.slice(prefix.length)) as Array<{ path: string; content: string }> : [];
          const content = files.find(({ path }) => path === proposal)?.content ?? await readFile(proposal, "utf8");
          if (content === "Modified") previewSummary = "proposal.md：补充磁盘上改写后的导出范围。";
        }
        const text = args.apply === true
          ? specReply("规划修订已写入。", { ...receipt, status: "completed" })
          : specReply(previewSummary, { ...receipt, status: "pending", updatePrompt: previewSummary });
        return { ...response, result: { kind: "agent", text } };
      }
      expect(invocation.method).toBe("terminal");
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command string.");
      let stdout = "";
      if (command === `openspec status --change "${name}" --json --store "${store}"`) {
        statusChecks++;
        const rootPath = choice === "scope changed" && statusChecks > 1 ? join(root, "different") : root;
        const currentChangeRoot = choice === "change directory changed" && statusChecks > 1 ? join(root, "moved") : changeRoot;
        const output = choice === "artifact path changed" && statusChecks > 1 ? join(changeRoot, "new-tasks.md") : join(changeRoot, "tasks.md");
        stdout = JSON.stringify({ changeName: name, root: { path: rootPath, store_id: store }, changeRoot: currentChangeRoot,
          artifactPaths: { proposal: { resolvedOutputPath: proposal, existingOutputPaths: [proposal] },
            tasks: { resolvedOutputPath: output, existingOutputPaths: [] } } });
      } else if (choice === "legacy name" && command === `openspec instructions apply --change "${name}" --json --store "${store}"`) {
        expect(args.cwd).toBe(root);
        const done = applyCalls.includes("agent");
        applyCalls.push(command);
        stdout = JSON.stringify({ changeName: name, state: done ? "all_done" : "ready", root: { path: root, store_id: store },
          tasks: [{ id: "1", description: "实施导出", done }] });
      } else {
        expect(command).toBe("git status --porcelain -uall");
      }
      return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root, exit_code: 0, stdout,
        stderr: "", duration_ms: 1 } };
    });
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, { execution, signal: execution.signal! })
    });
    const session = conversation(`update-${choice}`);
    await h.seed([session]);
    const running = h.coordinator.execute(h.controller.active(), "code",
      `import { spec } from "dext/api/spec/index";\nspec.update("${name}", "修订导出方案", { store: "team-specs" });`);
    try {
      const request = await vi.waitFor(() => {
        const message = h.messages.find((entry) => entry.type === "agentEvent" && entry.event.uiInteraction?.status === "waiting");
        if (message?.type !== "agentEvent" || !message.event.uiInteraction) throw new Error("Waiting for update dialog");
        return message.event.uiInteraction;
      }, { timeout: 8000 });
      expect(phases).toEqual([false]);
      expect(statusChecks).toBe(1);
      if (restoredDuringConfirmation) await writeFile(proposal, "Original");
      expect(request.form).toMatchObject({ title: `修订 ${name}`, description: summary, presentation: "dialog",
        actions: [{ id: "update" }], show_cancel: true });
      if (choice === "artifact content changed") await writeFile(proposal, "Modified");
      const reply = choice === "cancel" ? { status: "cancelled" } : { status: "submitted", action: "update" };
      expect(h.interactions.respondUi(request.sessionId, request.turnId, request.requestId,
        { kind: "ui", type: "form", answers: {}, ...reply })).toBe(true);
      await running;
      const turn = (await h.history.session(session.id))!.turns[0]!;
      const output = turn.response?.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream?.text).join("");
      const written = choice === "confirm" || choice === "legacy name" || restoredDuringConfirmation;
      expect(phases).toEqual(written ? [false, true] : [false]);
      expect(statusChecks).toBe(choice === "cancel" ? 1 : 2);
      if (written) {
        expect(output).toContain("规划修订已写入");
        const next = /`(spec\.apply\([^\r\n]+\))`/.exec(output ?? "")?.[1];
        expect(next).toBe(`spec.apply("${name}", ${JSON.stringify({ cwd: root, root, store })})`);
        if (choice === "legacy name") {
          const applied = await kernel.runSource(`import { spec } from "dext/api/spec/index";\n${next};`);
          const appliedOutput = applied.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text;
          const command = `openspec instructions apply --change "${name}" --json --store "${store}"`;
          expect(applyCalls).toEqual([command, "agent", command]);
          expect(appliedOutput).toContain("1/1 项已勾选");
        }
      } else {
        const message = choice === "cancel" ? "已取消规划修订" :
          choice === "scope changed" ? "未能核实指定的 OpenSpec" : "重新生成修订预览";
        expect(output).toContain(message);
        expect(output).not.toContain("spec.apply");
      }
    } finally {
      h.coordinator.abort(session.id);
      await running;
      h.dispose();
    }
  });

  it.each(["sync", "skip", "cancel"] as const)("handles the spec.archive dialog action %s in the same Code turn", { timeout: 30000 }, async (choice) => {
    const root = await workspace();
    await installSpecApi(root);
    const runtime = builtinRuntime(root);
    const summary = "example 将新建主规格。";
    const archiveName = "2026-11-21-example";
    const agentInputs: string[] = [];
    const kernel = host(root, async (invocation, metadata) => {
      if (invocation.method === "ui.form") return runtime.execute(invocation, [], metadata);
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "agent") {
        expect(args).toMatchObject({ skills: ["openspec-archive-change"], apply: true, patch: false });
        const input = args.input;
        if (typeof input !== "string") throw new Error("Expected an Agent prompt string.");
        agentInputs.push(input);
        const receipt = { change: "example", root, cwd: root, store: null };
        const text = agentInputs.length === 1
          ? specReply(summary, { ...receipt, status: "pending", archivePrompt: { kind: "sync_needed", summary } })
          : specReply("归档完成。", { ...receipt, status: "completed", archiveName });
        return { ...response, result: { kind: "agent", text } };
      }
      expect(invocation.method).toBe("terminal");
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command string.");
      const changes = command === "openspec list --all --json" ? [{ name: archiveName, archived: true }] : [{ name: "example" }];
      const stdout = command === "git status --porcelain -uall" ? "" : JSON.stringify({ changes, root: { path: root } });
      return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root, exit_code: 0, stdout,
        stderr: "", duration_ms: 1 } };
    });
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, { execution, signal: execution.signal! })
    });
    const session = conversation(`archive-${choice}`);
    await h.seed([session]);
    const running = h.coordinator.execute(h.controller.active(), "code",
      'import { spec } from "dext/api/spec/index";\nspec.archive("example");');
    try {
      const request = await vi.waitFor(() => {
        const message = h.messages.find((entry) => entry.type === "agentEvent" && entry.event.uiInteraction?.status === "waiting");
        if (message?.type !== "agentEvent" || !message.event.uiInteraction) throw new Error("Waiting for archive dialog");
        return message.event.uiInteraction;
      }, { timeout: 8000 });
      expect(agentInputs).toHaveLength(1);
      expect(request.form).toMatchObject({ title: "归档 example", description: summary, presentation: "dialog",
        actions: [{ id: "sync" }, { id: "skip" }], show_cancel: true });
      const reply = choice === "cancel" ? { status: "cancelled" } : { status: "submitted", action: choice };
      expect(h.interactions.respondUi(request.sessionId, request.turnId, request.requestId,
        { kind: "ui", type: "form", answers: {}, ...reply })).toBe(true);
      await running;
      const turn = (await h.history.session(session.id))!.turns[0]!;
      const output = turn.response?.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream?.text).join("");
      if (choice === "cancel") {
        expect(agentInputs).toHaveLength(1);
        expect(output).toContain("已取消归档");
      } else {
        expect(agentInputs).toHaveLength(2);
        expect(agentInputs[1]).toContain(JSON.stringify([{ kind: "sync_needed", action: choice, summary }]));
        expect(agentInputs[1]).toContain(JSON.stringify({ cwd: root, root }));
        expect(output).toContain("归档完成");
        expect(output).toContain("活跃变更已清空");
      }
    } finally {
      h.coordinator.abort(session.id);
      await running;
      h.dispose();
    }
  });

  it.each([
    { scenario: "a caller-selected store", requested: true, reportedRootMatches: true },
    { scenario: "a caller-selected store without a receipt", requested: true, reportedRootMatches: true, omitReceipt: true },
    { scenario: "a skill-selected store", requested: false, reportedRootMatches: true },
    { scenario: "a response from the wrong root", requested: true, reportedRootMatches: false }
  ])("scopes apply snapshots and follow-ups to $scenario", { timeout: 30000 }, async ({ requested, reportedRootMatches, omitReceipt }) => {
    const root = await workspace();
    await installSpecApi(root);
    const storeRoot = join(root, "store");
    const scopedOptions = { store: "selected", cwd: "nested directory", root: storeRoot };
    const scopedCwd = join(root, scopedOptions.cwd);
    const verifiedScope = { cwd: scopedCwd, root: storeRoot, store: "selected" };
    const calls: Array<{ command: unknown; cwd: unknown }> = [];
    let ranAgent = false;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "agent") {
        ranAgent = true;
        if (requested) {
          expect(args.workspace).toEqual({ kind: "dirRef", uri: pathToFileURL(scopedCwd).href, path: scopedOptions.cwd });
          expect(args.input).toContain(JSON.stringify(verifiedScope));
        }
        const text = "已执行所选 store 的任务。";
        return { ...response, result: { kind: "agent", text: omitReceipt ? text : specReply(text, {
          status: "completed", change: "example", store: "selected", root: storeRoot, cwd: scopedOptions.cwd
        }) } };
      }
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command");
      let stdout = "";
      if (command !== "git status --porcelain -uall") {
        calls.push({ command, cwd: args.cwd });
        const selected = command.endsWith(' --store "selected"');
        const tasks = [
          { id: "1", description: "本地与 store 中同名的任务", done: selected && ranAgent, sourcePath: "tasks.md" }
        ];
        stdout = JSON.stringify({ changeName: "example", state: tasks[0]!.done ? "all_done" : "ready", tasks,
          root: selected ? { path: ranAgent && !reportedRootMatches ? root : storeRoot, store_id: "selected" } : { path: root } });
      }
      return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: requested ? scopedCwd : root,
        exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
    });
    const arg = requested ? `, ${JSON.stringify(scopedOptions)}` : "";
    const response = await kernel.runSource(`import { spec } from "dext/api/spec/index";\nspec.apply("example"${arg});`);
    const output = response.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text;
    const applyCommand = 'openspec instructions apply --change "example" --json';
    const scopedCommand = `${applyCommand} --store "selected"`;
    expect(calls).toEqual([
      { command: requested ? scopedCommand : applyCommand, cwd: requested ? scopedOptions.cwd : undefined },
      { command: scopedCommand, cwd: requested ? scopedCwd : "." }
    ]);
    if (reportedRootMatches) {
      expect(output).toContain("1/1 项已勾选");
      expect(output).toContain(`spec.archive("example", ${JSON.stringify({ ...verifiedScope, cwd: requested ? scopedCwd : "." })})`);
      if (requested) expect(output).toContain("本轮新增勾选");
      else expect(output).not.toContain("本轮新增勾选");
    } else {
      expect(output).toContain("未能从 OpenSpec 核实任务进度");
      expect(output).toContain('openspec status --change "example" --json --store "selected"');
      expect(output).not.toContain('spec.archive("example"');
    }
  });

  it.each([
    { call: 'apply("example", { cwd: "missing" })', error: "terminal cwd must stay inside the current workspace." },
    { call: 'apply("example", { root: "/wrong-root" })' },
    { call: 'propose("新增示例", { store: "wrong-store" })' },
    { call: 'update("example", "修订", { root: "/wrong-root" })' },
    { call: 'archive("example", { cwd: "missing" })', error: "terminal cwd must stay inside the current workspace." },
    { call: 'sync("example", { root: "/wrong-root" })' }
  ])("blocks scoped spec.$call before dispatching a write", { timeout: 30000 }, async ({ call, error }) => {
    const root = await workspace();
    await installSpecApi(root);
    const calls: string[] = [];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      if (invocation.method !== "terminal") throw new Error("Unexpected write dispatch");
      if (error) throw new Error(error);
      const command = invocation.arguments.find(({ name }) => name === "command")?.value;
      if (typeof command !== "string") throw new Error("Expected a terminal command");
      return { ...askResponse(invocation), result: { kind: "terminal", status: "succeeded", command, cwd: root,
        exit_code: 0, stdout: JSON.stringify({ root: { path: root }, changeName: "example", state: "ready", tasks: [] }),
        stderr: "", duration_ms: 1 } };
    });
    const response = await kernel.runSource(`import { spec } from "dext/api/spec/index";\nspec.${call};`);
    const output = response.steps?.find((step) => step.stream?.channel === "stdout")?.stream?.text;
    expect(calls).toEqual(["terminal"]);
    expect(output).toContain("未能核实指定的 OpenSpec");
    expect(output).toContain("### 下一步");
  });

  it.each(["", "这次明确修复所有 Medium，包括维护性建议。"])("uses git.fix text as an explicit request (%s)", { timeout: 30000 }, async (input) => {
    const root = await workspace();
    await installGitReviewApi(root);
    const calls: string[] = [];
    const kernel = host(root, async (invocation) => {
      calls.push(invocation.method);
      const response = askResponse(invocation);
      if (invocation.method === "terminal") throw new Error("No fixture git repository");
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      expect(args).toMatchObject({ input, rules: ["git/fix.md"] });
      return { ...response, result: { kind: "agent", text: "执行说明" } };
    });
    const result = await kernel.runSource(`import { fix } from "dext/api/git/fix";\nfix(${JSON.stringify(input)});`);
    expect(calls).toEqual(input ? ["terminal", "agent"] : ["terminal"]);
    if (!input) expect(result.steps?.some((step) => step.stream?.text.includes("没有可用的逐条审查结果"))).toBe(true);
  });

  it("fixes an explicit batch of git.review IDs in one run", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    await fixture(root, "target.ts", "const retries = 0;\nconst timeout = 0;\nconst capacity = 1;\n");
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const readFindings = async () => (JSON.parse(await readFile(statePath, "utf8")) as {
      findings: Array<{ id: string; status: string }>;
    }).findings;
    const prompts: unknown[] = [];
    let selected: string[] = [];
    let extraDecision = "";
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root : command.includes(" status ") ? " M target.ts\0"
          : command.startsWith("git diff --raw") ? "" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/fix.md")) {
        prompts.push(args.input);
        const decisions = selected.map((id) => `- \`${id}\` | \`fixed\` | 回归验证通过`).join("\n");
        const summary = "| 位置 | 状态 |\n| --- | --- |\n| target.ts | 已修复 |\n\n已核对回归场景。";
        return { ...response, result: { kind: "agent", text: `### 修复结果\n${decisions}\n\n${summary}${extraDecision}` } };
      }
      expectWorkspaceReviewRule(invocation);
      const text = [
        "### 新发现",
        "- `target.ts:1` | `medium` | `bug` | 重试失效 | 第一次失败后没有重试",
        "- `target.ts:2` | `low` | `style` | 超时配置 | 可以简化",
        "- `target.ts:3` | `medium` | `bug` | 容量限制 | 无法容纳两个请求",
        "### 本轮未审文件",
        "（无）"
      ].join("\n");
      return { ...response, result: { kind: "agent", text } };
    });
    await kernel.runSource('import { review } from "dext/api/git/review";\nreview("workspace");');
    const [first, second, third] = await readFindings();
    selected = [first!.id, second!.id];
    const fix = (ids: string[]) => kernel.runSource(`import { fix } from "dext/api/git/fix";\nfix(${JSON.stringify(ids)});`);
    for (const [ids, message] of [
      [[], "有效问题 ID 数组"],
      [[first!.id, "invalid"], "有效问题 ID 数组"],
      [[first!.id, "R-000000000000"], "当前没有可修复的 R-000000000000"]
    ] as const) {
      const result = await fix([...ids]);
      expect(result.steps?.some((step) => step.stream?.text.includes(message))).toBe(true);
    }
    expect(prompts).toHaveLength(0);
    extraDecision = `\n- \`${first!.id}\` | \`fixed\` | 重复结论`;
    await fix([first!.id, second!.id]);
    expect((await readFindings()).map(({ status }) => status)).toEqual(["open", "deferred", "open"]);
    extraDecision = "";
    await fix([first!.id, second!.id, first!.id]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(first!.id);
    expect(prompts[1]).toContain(second!.id);
    expect(prompts[1]).not.toContain(third!.id);
    expect((await readFindings()).map(({ status }) => status)).toEqual(["pending", "pending", "open"]);
  });

  it.each(["fix", "fix with independent edit", "manual fix with independent edit"])(
    "closes git.review findings by verifying a %s", { timeout: 30000 }, async (scenario) => {
    const independentEdit = scenario !== "fix";
    const manual = scenario.startsWith("manual");
    const extraCallers = independentEdit ? "" : "a.ts\0b.ts\0c.ts\0d.ts\0e.ts\0f.ts\0g.ts\0h.ts\0";
    const root = await workspace();
    await installGitReviewApi(root);
    const target = await fixture(root, "target.ts", "export const retries = 0;\n");
    await fixture(root, "caller.ts", "import { retries } from './target';\n");
    const unrelated = await fixture(root, "unrelated.ts", "export const unrelated = 1;\n");
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as {
      findings: Array<{ id: string; status: string }>; reviewed: string[]; carried: string[]; round: number;
      files: Record<string, { hash: string; status: string }>;
    };
    let findingId = "";
    let reviews = 0;
    let fixes = 0;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root
          : command.includes(" status ") ? [" M target.ts", " M caller.ts", "D  unrelated.ts", "?? unrelated.ts", "?? .dext/state/review/workspace.json", ""].join("\0")
            : command.includes("diff --cached --raw") ? `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D\0unrelated.ts\0`
              : command.startsWith("git grep") ? `${extraCallers}target.ts\0caller.ts\0caller.ts\0z/caller.ts\0`
                : command.startsWith("git diff --raw") ? "" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/commit.md")) {
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/fix.md")) {
        fixes += 1;
        expect(args.input).toContain(findingId);
        expect(args.input).not.toContain("可选清理");
        await writeFile(target, "export const retries = 1;\n");
        if (independentEdit) await writeFile(unrelated, "export const unrelated = 2;\n");
        return { ...response, result: { kind: "agent", text: `### 修复结果\n- \`${findingId}\` | \`fixed\` | npm test 通过` } };
      }
      expectWorkspaceReviewRule(invocation);
      reviews += 1;
      expect(args.input).not.toContain("workspace.json");
      const coverage = "\n\n### 本轮未审文件\n（无）";
      if (reviews === 1) {
        expect(args.input).toContain("unrelated.ts（?? + D）");
        const text = "### 新发现\n- `target.ts:1` | `medium` | `bug` | 重试失效 | 第一次失败后没有重试\n"
          + "- `unrelated.ts:1` | `low` | `style` | 可选清理 | 可简化局部表达式" + coverage;
        return { ...response, result: { kind: "agent", text } };
      }
      if (reviews === 4) {
        expect(args.input).toContain("- unrelated.ts（?? + D）");
        expect(args.input).not.toContain("修复复核");
        return { ...response, result: { kind: "agent", text: `### 新发现\n（无）${coverage}` } };
      }
      expect(args.input).toContain(findingId);
      expect(args.input).toContain("caller.ts");
      expect(args.input).not.toContain("unrelated.ts");
      expect(args.input).toContain("修复复核");
      expect(args.input).toContain("候选调用点（按需）");
      expect(args.input).toContain("- z/caller.ts");
      expect(args.input).not.toContain("- caller.ts（M）");
      if (!manual) expect(args.input).toContain("+export const retries = 1;");
      if (independentEdit && reviews === 3) await writeFile(unrelated, "export const unrelated = 3;\n");
      const proof = reviews === 2 ? "" : `\n\n### 既有问题复核\n- \`${findingId}\` | \`resolved\` | 回归检查通过`;
      const observation = independentEdit ? "" : "\n\n### 另行审查\n- `other.ts:1` | `medium` | `bug` | 其他入口失败 | 打开旧页面时会报错";
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）${proof}${observation}${coverage}` } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nconsole.log((await review("workspace")).kind);');
    const fix = () => kernel.runSource('import { fix } from "dext/api/git/fix";\nfix("");');
    const commit = () => kernel.runSource('import { commit } from "dext/api/git/commit";\nconsole.log((await commit()).text);');
    const discovery = await review();
    const stdout = discovery.steps?.filter(({ stream }) => stream?.channel === "stdout").map(({ stream }) => stream?.text).join("\n");
    expect(stdout).toMatch(/^skill\r?$/m);
    const first = await readState();
    expect(first.findings.map(({ status }) => status)).toEqual(["open", "deferred"]);
    findingId = first.findings[0]!.id;
    if (!independentEdit) await expect(commit()).rejects.toThrow(`待处理问题：${findingId}`);
    if (manual) {
      await writeFile(target, "export const retries = 1;\n");
    } else {
      await fix();
      expect((await readState()).findings[0]).toMatchObject({ id: findingId, status: "pending" });
      if (!independentEdit) await expect(commit()).rejects.toThrow(`待复核问题：${findingId}`);
      await fix();
      expect(fixes).toBe(1);
    }
    if (manual) await writeFile(unrelated, "export const unrelated = 2;\n");

    await review();
    expect(await readState()).toMatchObject({ round: 1, findings: [{ id: findingId, status: manual ? "open" : "pending" }, { status: "deferred" }] });
    const verification = await review();
    expect(await readState()).toMatchObject({ round: 2, reviewed: ["target.ts"], carried: independentEdit ? ["caller.ts"] : ["caller.ts", "unrelated.ts"],
      findings: [{ id: findingId, status: "resolved" }, { status: "deferred" }, ...(!independentEdit ? [{ status: "deferred" }] : [])] });
    expect(verification.steps?.some((step) => step.stream?.text.includes("修复复核通过"))).toBe(true);
    if (independentEdit) {
      expect((await readState()).files["unrelated.ts"]).toEqual(first.files["unrelated.ts"]);
      expect(verification.steps?.some((step) => step.stream?.text.includes("1 个独立文件变更留待单独审查"))).toBe(true);
      await expect(commit()).rejects.toThrow("待审文件：unrelated.ts");
    } else {
      expect(verification.steps?.some((step) => step.stream?.text.includes("本批审查已完成，可以运行 git.commit()"))).toBe(true);
    }
    const next = await review();
    expect(reviews).toBe(independentEdit ? 4 : 3);
    expect(next.steps?.some((step) => step.stream?.text.includes("通过，当前范围内没有待处理问题"))).toBe(true);
    expect((await commit()).steps?.some((step) => step.stream?.text.includes("可以提交"))).toBe(true);
  });

  it("includes staged and untracked callers of exports across snapshots in incremental git.review", async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    const declarations = (name: string) => `export const ${name} = 1;\n`;
    const target = await fixture(root, "target.ts", declarations("reviewedExport"));
    const callers = ["headExport", "stagedExport", "reviewedExport", "currentExport"];
    const stagedCaller = "headExport.ts";
    const untrackedCaller = "untrackedCaller.ts";
    for (const name of callers) {
      await fixture(root, `${name}.ts`, `${name}.ts` === stagedCaller ? "void 0;\n" : `import { ${name} } from './target';\n`);
    }
    await fixture(root, untrackedCaller, "import { reviewedExport } from './target';\n");
    const headBlob = "a".repeat(40);
    const indexBlob = "b".repeat(40);
    const callerBlob = "c".repeat(40);
    let reviews = 0;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        let stdout = "0123456789";
        if (command.includes("--show-toplevel")) stdout = root;
        if (command.includes(" status ")) stdout = `MM target.ts\0MM ${stagedCaller}\0?? ${untrackedCaller}\0?? other-a.ts\0?? other-b.ts\0`;
        if (command.startsWith("git diff --cached --raw")) {
          stdout = `:100644 100644 ${headBlob} ${indexBlob} M\0target.ts\0:100644 100644 ${headBlob} ${callerBlob} M\0${stagedCaller}\0`;
        }
        if (command.startsWith("git diff --raw")) {
          const zeros = "0".repeat(40);
          stdout = `:100644 100644 ${indexBlob} ${zeros} M\0target.ts\0:100644 100644 ${callerBlob} ${zeros} M\0${stagedCaller}\0`;
        }
        if (command === `git cat-file blob ${headBlob}`) stdout = declarations("headExport");
        if (command === `git cat-file blob ${indexBlob}`) stdout = declarations("stagedExport");
        if (command.startsWith("git grep")) {
          const matches = command.includes("--cached") ? ["headExport", "stagedExport"] : callers.slice(1);
          stdout = matches.filter((name) => command.includes(`-e "${name}"`)).map((name) => `${name}.ts\0`).join("");
          if (command.includes("--untracked") && command.includes('-e "reviewedExport"')) stdout += `${untrackedCaller}\0`;
        }
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/commit.md")) {
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      expectWorkspaceReviewRule(invocation);
      const input = args.input;
      const skipped = ++reviews === 2 && typeof input === "string"
        ? [stagedCaller, untrackedCaller].filter((path) => input.includes(`- ${path}（`)) : [];
      const coverage = skipped.length ? skipped.map((path) => `- \`${path}\` — 尚未核对引用`).join("\n") : "（无）";
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）\n### 本轮未审文件\n${coverage}` } };
    });
    await fixture(root, "other-a.ts", "void 0;\n");
    await fixture(root, "other-b.ts", "void 0;\n");
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nawait review("workspace");');
    await review();
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const baseline = JSON.parse(await readFile(statePath, "utf8"));
    expect(baseline).toMatchObject({ reviewed: expect.arrayContaining([untrackedCaller]) });
    await writeFile(target, declarations("currentExport"));
    await review();
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({ mode: "incremental", skipped: [stagedCaller, untrackedCaller], carried: ["other-a.ts", "other-b.ts"],
      reviewed: ["target.ts", ...callers.sort().map((name) => `${name}.ts`).filter((path) => path !== stagedCaller)] });
    await expect(kernel.runSource('import { commit } from "dext/api/git/commit";\nawait commit();'))
      .rejects.toThrow(`待审文件：${stagedCaller}、${untrackedCaller}`);
  });

  it.each([
    { scenario: "removed export aliases", aliases: true, recurse: false, untrackedCount: 0 },
    { scenario: "submodule.recurse", aliases: false, recurse: true, untrackedCount: 1 },
    { scenario: "reverse dependency overflow", aliases: false, recurse: false, untrackedCount: 8 },
    { scenario: "multiple symbol batches and same-name modules", aliases: false, recurse: false, untrackedCount: 0, saturated: true }
  ])("keeps callers in git.review coverage with $scenario", { timeout: 30000 }, async ({ aliases, recurse, untrackedCount, saturated }) => {
    const root = await workspace();
    await installGitReviewApi(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "submodule.recurse", String(recurse));
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "/.dext/\n");
    const exportList = Array.from({ length: 25 }, (_, index) => `local as alias${index}`).join(", ");
    const original = saturated
      ? `function local(value: number) {}\nexport { ${exportList} };\nexport function publicApi(value: number) {}\n`
      : aliases
        ? "const local = 1;\nexport { local as removedExport };\nexport type {\n  LocalType /* } */ as RemovedType,\n} from './types';\n"
        : "export const removedExport = 1;\n";
    const targetPath = saturated ? "feature/index.ts" : "target.ts";
    if (saturated) await mkdir(join(root, "feature"));
    const target = await fixture(root, targetPath, original);
    const reference = saturated ? "import { publicApi } from './feature';\npublicApi(1);\n" : "import { removedExport } from './target';\n";
    const caller = await fixture(root, "caller.ts", recurse ? "void 0;\n" : reference);
    if (saturated) {
      await fixture(root, "module-caller.ts", 'import * as api from "./feature/index.js";\napi.alias24(1);\n');
      await fixture(root, "path-alias-caller.ts", 'import { alias23 } from "@api/contract";\nalias23(1);\n');
      for (let index = 0; index < 8; index += 1) {
        const directory = `area-${index}`;
        await mkdir(join(root, directory));
        await fixture(root, `${directory}/index.ts`, "export const local = 0;\n");
        await fixture(root, `${directory}/unrelated-caller.ts`, "import { local } from './index';\n");
      }
    }
    if (aliases) {
      await fixture(root, "type-caller.ts", "import type { RemovedType } from './target';\n");
      await fixture(root, "local-only.ts", "const local = 0;\n");
      await fixture(root, "types.ts", "export interface LocalType {}\n");
    }
    git("add", "--", "*.ts");
    git("-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", "commit", "-qm", "Initial", "--no-gpg-sign");
    if (recurse) await writeFile(caller, reference);
    for (let index = 0; index < Math.max(untrackedCount, 2); index += 1) {
      await fixture(root, `untracked-${index}.ts`, index < untrackedCount ? reference : "void 0;\n");
    }
    await writeFile(target, `${original}\n// First review\n`);

    const prompts: unknown[] = [];
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const { status, stdout, stderr, error } = spawnSync(command, { cwd: root, encoding: "utf8", shell: true });
        if (error) throw error;
        if (status === null) throw new Error("Git terminated without an exit code");
        return { ...response, result: { kind: "terminal", status: status === 0 ? "succeeded" : "failed", command, cwd: root,
          exit_code: status, stdout, stderr, duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/commit.md")) {
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      expectWorkspaceReviewRule(invocation);
      prompts.push(args.input);
      const coverage = saturated && prompts.length === 2 && typeof args.input === "string" && args.input.includes("- module-caller.ts（")
        ? "- `module-caller.ts` — 尚未核对引用"
        : "（无）";
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）\n### 本轮未审文件\n${coverage}` } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nawait review("workspace");');
    await review();
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const baseline = JSON.parse(await readFile(statePath, "utf8")) as { files: Record<string, { exports?: string[] }> };
    const reviewedTarget = baseline.files[targetPath]!;
    if (aliases) {
      expect(reviewedTarget.exports).toEqual(["removedExport", "RemovedType"]);
      // An older baseline may lack these names, so the next round must read HEAD too.
      delete reviewedTarget.exports;
      await writeFile(statePath, JSON.stringify(baseline));
    }
    await writeFile(target, saturated ? original.replaceAll(": number", ": string") : "void 0;\n");
    await review();

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      mode: string; reviewed: string[]; skipped: string[]; files: Record<string, { exports?: string[] }>;
    };
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("- caller.ts（");
    expect(state.mode).toBe(untrackedCount === 8 ? "full" : "incremental");
    if (saturated) {
      for (const exports of [reviewedTarget.exports, state.files[targetPath]?.exports]) {
        expect(exports).toHaveLength(26);
        expect(exports).toEqual(expect.arrayContaining(["publicApi", "alias23", "alias24"]));
      }
      expect(state.reviewed).toEqual([targetPath, "caller.ts", "path-alias-caller.ts"]);
      expect(prompts[1]).not.toContain("unrelated-caller.ts");
      expect(state.skipped).toEqual(["module-caller.ts"]);
      await expect(kernel.runSource('import { commit } from "dext/api/git/commit";\nawait commit();'))
        .rejects.toThrow("待审文件：module-caller.ts");
    } else if (aliases) {
      expect(state.reviewed).toEqual(["target.ts", "caller.ts", "type-caller.ts"]);
    } else {
      const untracked = Array.from({ length: untrackedCount }, (_, index) => `untracked-${index}.ts`);
      expect(state.reviewed).toEqual(untrackedCount === 8
        ? ["target.ts", ...untracked, "caller.ts"]
        : ["target.ts", "caller.ts", ...untracked]);
    }
  });

  it.each([
    { mode: "incremental", symbol: "publicApi" },
    { mode: "full", symbol: "publicApi" },
    { mode: "incremental", symbol: "id" },
    { mode: "full", symbol: "id" },
    { mode: "incremental", symbol: "x", aliased: true },
    { mode: "incremental", symbol: "default", pathAlias: true, stagedCaller: true },
    { mode: "full", symbol: "default" }
  ])("rechecks a restored $symbol contract and its caller in $mode git.review", { timeout: 30000 }, async ({ mode, symbol, aliased, pathAlias, stagedCaller }) => {
    const root = await workspace();
    await installGitReviewApi(root);
    await mkdir(join(root, "node_modules"));
    await symlink(resolve("node_modules/typescript"), join(root, "node_modules", "typescript"), "junction");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    await writeFile(join(root, ".git", "info", "exclude"), "/.dext/\n/node_modules/\n");
    const original = aliased
      ? `function local(value: number) { return value; }\nexport { local as ${symbol} };\n`
      : `export ${symbol === "default" ? "default function" : `function ${symbol}`}(value: number) { return value; }\n`;
    const contract = await fixture(root, "contract.ts", original);
    const callee = symbol === "default" ? "transform" : symbol;
    const binding = symbol === "default" ? callee : `{ ${symbol} }`;
    const importPath = pathAlias ? "@api/entry" : "./contract.js";
    const call = (value: string) => `import ${binding} from '${importPath}';\n${callee}(${value});\n`;
    const caller = await fixture(root, "caller.ts", call("1"));
    if (pathAlias) await fixture(root, "tsconfig.json", '{"compilerOptions":{"paths":{"@api/entry":["./contract.ts"]}}}');
    if (symbol === "id") {
      for (let i = 0; i < 9; i++) await fixture(root, `same-name-${i}.ts`, "export const item = { id: 1 };\n");
    }
    git("add", "--", ".");
    git("-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", "commit", "-qm", "Initial", "--no-gpg-sign");
    await writeFile(contract, original.replace(": number", ": string"));
    await writeFile(caller, call("'new signature'"));
    if (stagedCaller) {
      git("add", "--", "caller.ts");
      await writeFile(caller, "void 0;\n");
    }
    if (mode === "incremental") await fixture(root, "unrelated.ts", "void 0;\n");

    const prompts: unknown[] = [];
    let commits = 0;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const { status, stdout, stderr, error } = spawnSync(command, { cwd: root, encoding: "utf8", shell: true });
        if (error) throw error;
        if (status === null) throw new Error("Git terminated without an exit code");
        return { ...response, result: { kind: "terminal", status: status === 0 ? "succeeded" : "failed", command, cwd: root,
          exit_code: status, stdout, stderr, duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/commit.md")) {
        commits++;
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      expectWorkspaceReviewRule(invocation);
      prompts.push(args.input);
      const skipped = prompts.length === 2 && typeof args.input === "string" && args.input.includes("- caller.ts（")
        ? "- `caller.ts` — 尚未核对恢复后的签名" : "（无）";
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）\n### 本轮未审文件\n${skipped}` } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nawait review("workspace");');
    const commit = () => kernel.runSource('import { commit } from "dext/api/git/commit";\nawait commit();');
    await review();
    await expect(commit()).resolves.toBeDefined();

    git("restore", "--", "contract.ts");
    expect(git("status", "--porcelain", "--", "contract.ts")).toBe("");
    await expect(commit()).rejects.toThrow("待审文件：contract.ts");
    expect(commits).toBe(1);
    await review();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("- contract.ts（不在当前改动中，按现状核对）");
    expect(prompts[1]).not.toContain("same-name-");
    await expect(commit()).rejects.toThrow("待审文件：caller.ts");
    expect(prompts[1]).toContain("- caller.ts（");
    const state = JSON.parse(await readFile(join(root, ".dext", "state", "review", "workspace.json"), "utf8"));
    expect(state).toMatchObject({ mode, reviewed: expect.arrayContaining(["contract.ts"]), skipped: ["caller.ts"] });
    await writeFile(caller, call("2"));
    if (stagedCaller) git("add", "--", "caller.ts");
    await review();
    await expect(commit()).resolves.toBeDefined();
    expect(commits).toBe(2);
    const covered = prompts.length;
    await review();
    expect(prompts).toHaveLength(covered);
  });

  it("requires a new review when the Git worktree mode changes without a change in bytes or porcelain status", async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    await fixture(root, "target.ts", "void 0;\n");
    let executable = false;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      if (invocation.method === "terminal") {
        const command = invocation.arguments.find(({ name }) => name === "command")?.value;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        let stdout = "0123456789";
        if (command.includes("--show-toplevel")) stdout = root;
        if (command.includes(" status ")) stdout = " M target.ts\0";
        if (command.startsWith("git diff --raw")) {
          stdout = `:100644 ${executable ? "100755" : "100644"} ${"a".repeat(40)} ${"0".repeat(40)} M\0target.ts\0`;
        }
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      const rules = invocation.arguments.find(({ name }) => name === "rules")?.value;
      if (Array.isArray(rules) && rules.includes("git/commit.md")) {
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      expectWorkspaceReviewRule(invocation);
      return { ...response, result: { kind: "agent", text: "### 新发现\n（无）\n### 本轮未审文件\n（无）" } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nawait review("workspace");');
    const commit = () => kernel.runSource('import { commit } from "dext/api/git/commit";\nconsole.log((await commit()).text);');
    await review();
    await expect(commit()).resolves.toBeDefined();
    executable = true;
    await expect(commit()).rejects.toThrow("待审文件：target.ts");
    await review();
    await expect(commit()).resolves.toBeDefined();
  });

  it("checks actual staged versions and legacy coverage before git.commit", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "/.dext/\n");
    const source = await fixture(root, "target.ts", "const value = 0;\n");
    await fixture(root, "caller.ts", "void 0;\n");
    git("add", "--", "target.ts", "caller.ts");
    git("-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", "commit", "-qm", "Initial", "--no-gpg-sign");
    const stage = async (value: number) => {
      await writeFile(source, `const value = ${value};\n`);
      git("add", "--", "target.ts");
      await writeFile(source, "const value = 0;\n");
    };
    await stage(1);
    let skip = true;
    let submissions = 0;
    let deferredId = "";
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = git(...command.replace(/^git /u, "").split(" "));
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/commit.md")) {
        submissions++;
        return { ...response, result: { kind: "agent", text: "可以提交" } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/fix.md")) {
        expect(args.input).toContain(deferredId);
        await writeFile(join(root, "caller.ts"), "void 1;\n");
        return { ...response, result: { kind: "agent", text: `### 修复结果\n- \`${deferredId}\` | \`fixed\` | 复现已消失` } };
      }
      expectWorkspaceReviewRule(invocation);
      const coverage = skip ? "- `target.ts` — 尚未核对暂存内容" : "（无）";
      const resolution = deferredId && typeof args.input === "string" && args.input.includes(deferredId)
        ? `\n### 既有问题复核\n- \`${deferredId}\` | \`resolved\` | 回归检查通过` : "";
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）${resolution}\n### 本轮未审文件\n${coverage}` } };
    });
    const run = async (source: string) => (await kernel.runSource(source)).steps?.map((step) => step.stream?.text).join("\n");
    const review = (force = false) => run(`import { review } from "dext/api/git/review";\nawait review("workspace", ${force});`);
    const commit = () => run('import { commit } from "dext/api/git/commit";\nconsole.log((await commit()).text);');
    await review(true);
    await expect(commit()).rejects.toThrow("待审文件：target.ts");
    skip = false;
    await review();
    expect(await commit()).toContain("可以提交");

    const status = git("status", "--porcelain", "--", "target.ts");
    await stage(2);
    expect(git("status", "--porcelain", "--", "target.ts")).toBe(status);
    await expect(commit()).rejects.toThrow("待审文件：target.ts");
    await review();

    const path = join(root, ".dext", "state", "review", "workspace.json");
    const readState = async () => JSON.parse(await readFile(path, "utf8")) as {
      version: number; mode: string; report: string; followUp: string[]; files: Record<string, { index?: string }>;
      head: string; findings: Array<{ id: string; path: string; title: string; status: string }>;
    };
    const state = await readState();
    state.version = 1;
    state.followUp = ["caller.ts"];
    delete state.files["target.ts"]!.index;
    state.mode = "incremental";
    state.report += "\n### 另行审查\n- `caller.ts:1` | `medium` | `bug` | 旧调用失败 | 打开菜单时无法加载数据";
    await writeFile(path, JSON.stringify(state));
    await expect(commit()).rejects.toThrow("待审文件：target.ts");
    expect(await review()).toContain("本批审查已完成，可以运行 git.commit()");
    const migrated = await readState();
    expect(migrated).toMatchObject({ version: 2, followUp: [], findings: [{ path: "caller.ts", title: "旧调用失败", status: "deferred" }] });
    deferredId = migrated.findings[0]!.id;
    expect(await commit()).toContain("可以提交");
    git("-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", "commit", "-qm", "Move HEAD", "--no-gpg-sign", "--only", "--allow-empty");
    await expect(commit()).rejects.toThrow('git.review("workspace", true)');
    await review();
    expect(await readState()).toMatchObject({ head: git("rev-parse", "HEAD").trim(), findings: [{ id: deferredId, status: "deferred" }] });
    git("-c", "user.name=Dext Test", "-c", "user.email=dext@example.invalid", "commit", "-qm", "Commit reviewed changes", "--no-gpg-sign");
    await writeFile(source, "const value = 2;\n");
    await run(`import { fix } from "dext/api/git/fix";\nawait fix(${JSON.stringify(deferredId)});`);
    expect(await readState()).toMatchObject({ head: git("rev-parse", "HEAD").trim(), findings: [{ id: deferredId, status: "pending" }] });
    await expect(commit()).rejects.toThrow(`待复核问题：${deferredId}`);
    expect(await review()).toContain("本批审查已完成，可以运行 git.commit()");
    expect(await commit()).toContain("可以提交");
    expect(submissions).toBe(3);
  });

  it("stops git.fix retries until explicitly requested and accepts only anchored regressions from verification", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    const target = await fixture(root, "target.ts", "const retries = 0;\nconst capacity = 3;\n");
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as {
      findings: Array<{ id: string; status: string; title: string; explicitFix?: boolean }>;
      followUp: string[];
    };
    let issue = "";
    let regression = "";
    let fixes = 0;
    let reviews = 0;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root : command.includes(" status ") ? " M target.ts\0"
          : command.startsWith("git diff --raw") ? "" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/fix.md")) {
        fixes += 1;
        if (fixes === 1) {
          return { ...response, result: { kind: "agent", text: `### 修复结果\n- \`${issue}\` | \`open\` | 当前无法复现网络错误` } };
        }
        await writeFile(target, "const retries = 1;\nconst capacity = 3;\n");
        return { ...response, result: { kind: "agent", text: `### 修复结果\n- \`${issue}\` | \`fixed\` | 已复现并通过回归` } };
      }
      expectWorkspaceReviewRule(invocation);
      const text = ++reviews === 1
        ? "### 新发现\n- `target.ts:1` | `medium` | `bug` | 重试失效 | 未重试请求"
        : reviews === 3 ? `### 新发现\n（无）\n### 既有问题复核\n- \`${regression}\` | \`open\` | 仍会重复提交`
          : `### 新发现\n- \`target.ts:1\` | \`medium\` | \`bug\` | 重复提交 | ${issue} 将 retries 改为 1 后重复提交\n`
          + `- \`target.ts:2\` | \`medium\` | \`bug\` | 容量限制 | ${issue} 的附近存在另一个问题\n`
          + `### 既有问题复核\n- \`${issue}\` | \`resolved\` | 失败时会重试\n`
          + "### 另行审查\n- `ignored.ts:1` 还有独立改动\n"
          + "- `target.ts:1` | `medium` | `bug` | 重复提交 | 仍会重复提交\n"
          + "- `follow-up.ts:1` | `medium` | `bug` | 菜单打不开 | 保存后再打开会报错\n"
          + "- `style.ts:1` | `low` | `style` | 可简化命名 | 当前命名不够直接";
      return { ...response, result: { kind: "agent", text: `${text}\n### 本轮未审文件\n（无）` } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nreview("workspace");');
    const fix = (id = "") => kernel.runSource(`import { fix } from "dext/api/git/fix";\nfix(${JSON.stringify(id)});`);
    await review();
    issue = (await readState()).findings[0]!.id;
    await fix();
    const stop = await fix();
    expect(fixes).toBe(1);
    expect(stop.steps?.some((step) => step.stream?.text.includes("当前无法复现网络错误"))).toBe(true);
    await fix(issue);
    await review();
    const verified = await readState();
    expect(verified.followUp).toEqual(["target.ts"]);
    expect(verified.findings).toMatchObject([
      { id: issue, status: "resolved" },
      { title: "重复提交", status: "open", explicitFix: true },
      { title: "菜单打不开", status: "deferred" },
      { title: "可简化命名", status: "deferred" }
    ]);
    regression = verified.findings[1]!.id;
    await fix();
    await review();
    expect(fixes).toBe(2);
    expect(reviews).toBe(3);
    expect((await readState()).followUp).toEqual([]);
  });

  it("allows one concurrent git.review writer to publish its baseline", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    await fixture(root, "target.ts", "const value = 1;\n");
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const execute = async (invocation: InvocationAst): Promise<RuntimeResponse> => {
      const response = askResponse(invocation);
      if (invocation.method === "terminal") {
        const command = invocation.arguments.find(({ name }) => name === "command")?.value;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root : command.includes(" status ") ? " M target.ts\0"
          : command.startsWith("git diff --raw") ? "" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      expectWorkspaceReviewRule(invocation);
      if (++arrived === 2) release();
      await barrier;
      return { ...response, result: { kind: "agent", text: "### 新发现\n（无）\n### 本轮未审文件\n（无）" } };
    };
    const script = await fixture(root, "review-run.ts", 'import { review } from "dext/api/git/review";\nreview("workspace");');
    const results = await Promise.all([host(root, execute).run(script), host(root, execute).run(script)]);
    const messages = results.flatMap((result) => result.steps?.map(({ stream }) => stream?.text ?? "") ?? []);
    expect(messages.filter((text) => text.includes("通过，当前范围内没有待处理问题"))).toHaveLength(1);
    expect(messages.filter((text) => text.includes("审查基线在本轮运行期间已更新"))).toHaveLength(1);
  });

  it.each([false, true])("verifies git.review findings in a clean worktree and bypasses an abandoned lock (full: %s)", { timeout: 30000 }, async (full) => {
    const root = await workspace();
    await installGitReviewApi(root);
    const target = await fixture(root, "target.ts", "export const retries = 0;\n");
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    await mkdir(`${statePath}.lock`, { recursive: true });
    await mkdir(join(root, ".dext", "state", "review", "writers", "2147483647-abandoned"), { recursive: true });
    let clean = false;
    let id = "";
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root
          : command.includes(" status ") ? (clean ? "" : " M target.ts\0")
            : command.startsWith("git grep") || command.startsWith("git diff --raw") ? "" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
      }
      if (Array.isArray(args.rules) && args.rules.includes("git/fix.md")) {
        await writeFile(target, "export const retries = 1;\n");
        clean = true;
        return { ...response, result: { kind: "agent", text: `### 修复结果\n- \`${id}\` | \`fixed\` | 复现已消失` } };
      }
      expectWorkspaceReviewRule(invocation);
      expect(args.input).toContain("target.ts");
      const text = clean
        ? `### 新发现\n（无）\n### 既有问题复核\n- \`${id}\` | \`resolved\` | 已恢复基线`
        : "### 新发现\n- `target.ts:1` | `medium` | `bug` | 重试失效 | 第一次失败后没有重试";
      return { ...response, result: { kind: "agent", text: `${text}\n### 本轮未审文件\n（无）` } };
    });
    const review = (force: boolean) => kernel.runSource(`import { review } from "dext/api/git/review";\nreview("workspace", ${force});`);
    await review(false);
    const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as { findings: Array<{ id: string; status: string }> };
    id = (await readState()).findings[0]!.id;
    await kernel.runSource('import { fix } from "dext/api/git/fix";\nfix("");');
    expect((await readState()).findings[0]).toMatchObject({ id, status: "pending" });
    await review(full);
    expect((await readState()).findings[0]).toMatchObject({ id, status: "resolved" });
  });

  it("keeps standalone commit and range git.review delegated to the installed skill", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    const inputs: unknown[] = [];
    const kernel = host(root, async (invocation) => {
      expect(invocation.method).toBe("skill");
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      expect(args).toMatchObject({ skill: "open-code-review-delegate", apply: true, echo: true });
      inputs.push(args.input);
      return { ...askResponse(invocation), result: { kind: "skill", text: "## Code Review Results" } };
    });
    await kernel.runSource('import { review } from "dext/api/git/review";\nawait review("commit", "abc123");\nawait review("range", "main", "feature");');
    expect(inputs).toEqual([expect.stringContaining("commit abc123"), expect.stringContaining("main 到 feature")]);
  });

  it("renders a logged object as JSON instead of util.inspect's [Object]", { timeout: 30000 }, async () => {
    // `console.log(obj)` is how a payload reaches Output, so the object has to arrive
    // whole: `util.inspect` stops at depth 2, which is what a nested payload used to hit.
    const root = await workspace();
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const response = await kernel.runSource(
      [
        'const payload = { a: 1, nested: { deep: { deeper: { deepest: true } } }, zh: "中文" };',
        "console.log(payload);",
        'console.log("label", payload);',
        'console.log("plain", 42, true);',
        ""
      ].join("\n")
    );
    const stdout = response.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream!.text).join("") ?? "";
    expect(stdout).not.toContain("[Object]");
    expect(stdout).toContain('"deepest": true');
    // A string argument is untouched: the label stays first and the space join still holds.
    expect(stdout).toContain("label {");
    expect(stdout).toContain("plain 42 true");
    // The object text is JSON, so it can be parsed back out of the stream.
    const json = stdout.slice(stdout.indexOf("{"), stdout.indexOf("\n}\n") + 3);
    expect(JSON.parse(json)).toMatchObject({ nested: { deep: { deeper: { deepest: true } } }, zh: "中文" });
  });

  it("runs each call through the injected runtime contract", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const kernel = host(root, (invocation, metadata) => runtime.execute(invocation, [], metadata));
    const response = await kernel.run(languageFixture);
    expect(response.steps?.[0]?.response?.method).toMatchObject({ id: "ask", source: "builtin" });
    expect(response.steps?.[0]?.response?.result.kind).toBe("ask");
  });

  it("carries a saved plan path across the kernel boundary", { timeout: 30000 }, async () => {
    const root = await workspace();
    const plans = join(root, ".dext", "plans");
    const planPath = join(plans, "20260821-090503-add-a-cache.plan.md");
    await mkdir(plans, { recursive: true });
    await writeFile(planPath, "# Plan\n", "utf8");
    const kernel = host(root, async (invocation) => ({
      ...askResponse(invocation),
      result: { kind: "plan", text: "# Plan", planPath }
    }));
    const response = await kernel.runSource([
      'import { plan } from "dext";',
      'const saved = await plan({ input: "add a cache" });',
      'console.log(saved.planPath);',
      ""
    ].join("\n"));

    // The path is an ordinary JSON string, so it is identical on both sides.
    expect(response.steps?.[0]?.response?.result).toMatchObject({ kind: "plan", planPath });
    expect(response.executions[0]?.result).toMatchObject({ planPath });
    expect(response.steps?.at(-1)?.stream?.text).toBe(`${planPath}\n`);
  });

  it("drives an interactive ui call from the host while the kernel waits", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "question.ts", [
      "import { ui } from \"dext\";",
      "const answer = await ui.form({ title: \"Review\", fields: [] });",
      "console.log(answer.status);",
      ""
    ].join("\n"));
    const runtime = builtinRuntime(root);
    const asked: string[] = [];
    const kernel = host(root, (invocation, metadata) => runtime.execute(invocation, [], metadata));
    const response = await kernel.run(file, {
      execution: {
        ui: {
          form: async (form) => {
            asked.push(form.title);
            return { kind: "ui", type: "form", status: "submitted", action: "submit", answers: {} };
          }
        }
      }
    });
    expect(asked).toEqual(["Review"]);
    expect(response.steps?.[0]?.response?.result).toMatchObject({ kind: "ui", type: "form", status: "submitted" });
    expect(response.steps?.at(-1)?.stream?.text).toBe("submitted\n");
  });

  it("renders through the real host without an interaction handler and refuses JSON coercion", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const calls: string[] = [];
    const kernel = host(root, (invocation, metadata) => {
      calls.push(invocation.method);
      return runtime.execute(invocation, [], metadata);
    });
    const result = await kernel.runSource([
      'import { ui } from "dext";',
      'const returned = await ui.render({ nodes: [{ type: "Text", text: "view" }] });',
      'try { await ui.render({ nodes: [{ type: "Text", text: new Date() }] }); } catch (error) { console.log(error.message); }',
      'if (returned !== undefined) throw new Error("expected void");'
    ].join("\n"));
    expect(calls).toEqual(["ui.render"]);
    expect(result.executions[0]?.result).toEqual({ kind: "view", nodes: [{ type: "Text", text: "view" }] });
    expect(result.steps?.[0]?.quiet).toBeUndefined();
    expect(result.steps?.[1]?.stream?.text).toContain("plain JSON at nodes[0].text");
  });

  it.each(["available", "submit", "cancel", "stop"] as const)("runs and persists the inspection report for %s", { timeout: 30000 }, async (state) => {
    const root = await workspace();
    const path = "openspec/config.yaml";
    if (state === "available") {
      await mkdir(join(root, "openspec"));
      await writeFile(join(root, path), "schema: spec-driven");
    }
    const example = await readFile("docs/examples/ui-inspection-report.ts", "utf8");
    const apiDirectory = join(root, ".dext", "api");
    if (state === "submit") {
      await mkdir(apiDirectory, { recursive: true });
      await writeFile(join(apiDirectory, "inspection-report.ts"), example);
    }
    const input = state === "submit" ? [
      'import { ui } from "dext";',
      'import { inspectConfig } from "dext/api/inspection-report";',
      'console.log(JSON.stringify(await inspectConfig()));',
      'await ui.render({ nodes: [{ type: "Text", text: "检查结束" }] });',
      'throw new Error("Test retry");'
    ].join("\n") : example + "\nconsole.log(JSON.stringify((await inspectConfig()) ?? null));";
    const runtime = builtinRuntime(root);
    const calls: string[] = [];
    const kernel = host(root, (invocation, metadata) => {
      calls.push(invocation.method);
      return runtime.execute(invocation, [], metadata);
    });
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, {
        execution, signal: execution.signal!, apiRoots: [apiDirectory]
      })
    });
    try {
      const session = conversation(`inspection-${state}`);
      await h.seed([session]);
      const running = h.coordinator.execute(h.controller.active(), "code", input);
      if (state !== "available") {
        const request = await vi.waitFor(() => {
          const interaction = h.messages.find((message) =>
            message.type === "agentEvent" && message.event.uiInteraction?.status === "waiting");
          if (interaction?.type !== "agentEvent" || !interaction.event.uiInteraction) throw new Error("Waiting for the form");
          return interaction.event.uiInteraction;
        }, { timeout: 8000 });
        const { sessionId, turnId, requestId } = request;
        expect(calls).toEqual(["ui.render", "ui.form"]);
        expect(request.form).toMatchObject({ title: "确认修复计划", presentation: "inline", actions: [{ id: "confirm" }] });
        const submitted = {
          kind: "ui", type: "form", status: "submitted", action: "confirm",
          answers: { scope: { type: "select", selected: ["配置文件"] } }
        };
        const cancelled = { kind: "ui", type: "form", status: "cancelled", answers: {} };
        const respond = (reply: unknown) => h.interactions.respondUi(sessionId, turnId, requestId, reply);
        if (state === "submit") {
          expect(respond({ ...submitted, answers: { scope: { type: "select", selected: ["unexpected"] } } })).toBe(false);
          expect(respond(submitted)).toBe(true);
          expect(respond(submitted)).toBe(false);
        } else if (state === "cancel") {
          expect(respond(cancelled)).toBe(true);
          expect(respond(cancelled)).toBe(false);
        } else {
          expect(h.coordinator.abort(session.id)).toBe(true);
        }
      }
      await running;
      const record = (await h.history.session(session.id))!.turns[0]!;
      const steps = record.response!.steps!;
      const expectedSteps = {
        available: ["ui.render", "stdout"],
        submit: ["ui.render", "stdout", "ui.render"],
        cancel: ["ui.render", "ui.form", "stdout"],
        stop: ["ui.render"]
      }[state];
      expect(steps.map((step) => step.method)).toEqual(expectedSteps);
      expect(steps[0]?.response?.result).toMatchObject({ kind: "view", nodes: [{
        type: "Stack", children: [
          { type: "Section", title: "摘要" }, { type: "Section", title: "详情" }, { type: "Section", title: "说明" }
        ]
      }] });
      const html = renderHistoryRecord(record, session.id);
      if (state === "available") {
        expect(html).toContain('<p data-ui="empty">没有待修复的项目</p>');
        expect(steps.at(-1)?.stream?.text).toBe("null\n");
      } else {
        expect(html).toContain(`<pre><code>ENOENT: ${path}</code></pre>`);
      }
      expect(html).not.toContain("<form");
      if (state === "submit") {
        const output = JSON.stringify({ path, scope: "配置文件" });
        expect(html).toContain("Submitted (确认)");
        expect(steps[1]?.stream?.text).toContain(output + "\n");
        expect(record.error).toContain("Test retry");
        expect(calls).toEqual(["ui.render", "ui.form", "ui.render"]);
      } else if (state === "cancel") {
        expect(steps[1]?.response?.result).toMatchObject({ kind: "ui", type: "form", status: "cancelled", answers: {} });
        expect(steps[2]?.stream?.text).toContain('"status":"cancelled","answers":{}');
        expect(record.error).toBeUndefined();
      } else if (state === "stop") {
        expect(record.error).toBe("Execution was cancelled.");
      }
    } finally {
      h.dispose();
    }
  });

  it("round-trips a 32-level UI tree and reports the UI limit at 33 levels", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const kernel = host(root, (invocation, metadata) => runtime.execute(invocation, [], metadata));
    const result = await kernel.runSource([
      'import { ui, type UiNode } from "dext";',
      'let node: UiNode = { type: "Text", text: "leaf" };',
      'const wrap = (child: UiNode): UiNode => child.type === "TraceLine"',
      '  ? { type: "Trace", children: [child] } : { type: "TraceLine", children: [child] };',
      'for (let i = 1; i < 32; i++) node = wrap(node);',
      'await ui.render({ nodes: [node] });',
      'try { await ui.render({ nodes: [wrap(node)] }); }',
      'catch (error) { console.log(error.message); }'
    ].join("\n"));
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "failed", "success"]);
    expect(result.steps?.[1]?.error).toContain("UI tree exceeds 32 levels.");
    expect(result.steps?.[2]?.stream?.text).toContain("UI tree exceeds 32 levels.");
    const view = result.executions[0]?.result;
    expect(view?.kind === "view" && JSON.stringify(view.nodes).match(/"type":/g)).toHaveLength(32);
  });

  it("bounds ui.render node counts and JSON bytes before dispatch", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const calls: string[] = [];
    const kernel = host(root, (invocation, metadata) => {
      calls.push(invocation.method);
      return runtime.execute(invocation, [], metadata);
    });
    const result = await kernel.runSource([
      'import { ui } from "dext";',
      'const leaf = { type: "Text", text: "" };',
      `const maxNodes = ${UI_VIEW_MAX_NODES};`,
      `const maxBytes = ${UI_VIEW_MAX_BYTES};`,
      'const textLimit = maxBytes - Buffer.byteLength(JSON.stringify([leaf]));',
      'await ui.render({ nodes: Array(maxNodes).fill(leaf) });',
      'await ui.render({ nodes: [{ ...leaf, text: "x".repeat(textLimit) }] });',
      'for (const nodes of [',
      '  [{ type: "TraceLine", children: Array(maxNodes).fill(leaf) }],',
      '  [{ ...leaf, text: "中".repeat(Math.floor(textLimit / 3) + 1) }],',
      '  [{ ...leaf, text: "\\n".repeat(Math.floor(textLimit / 2) + 1) }],',
      '  [{ ...leaf, text: "x".repeat(maxBytes) }, new Date()]',
      ']) {',
      '  try { await ui.render({ nodes }); } catch (error) { console.log(error.message); }',
      '}'
    ].join("\n"));
    expect(calls).toEqual(["ui.render", "ui.render"]);
    const diagnostics = result.steps?.flatMap((step) => step.stream ? [step.stream.text] : []).join("");
    expect(diagnostics?.match(new RegExp(`UI tree exceeds ${UI_VIEW_MAX_NODES} nodes`, "g"))).toHaveLength(1);
    expect(diagnostics?.match(new RegExp(`UI tree exceeds ${UI_VIEW_MAX_BYTES} UTF-8 bytes`, "g"))).toHaveLength(3);
  });

  it("persists displays in script order when the kernel reports a later failure", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const kernel = host(root, (invocation, metadata) => runtime.execute(invocation, [], metadata));
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, { execution })
    });
    try {
      const session = conversation("display-failure");
      await h.seed([session]);
      await h.coordinator.execute(h.controller.active(), "code", [
        'import { ui } from "dext";',
        'await ui.render({ nodes: [{ type: "Text", text: "First display" }] });',
        'console.log("Between displays (stdout)");',
        'console.error("Between displays (stderr)");',
        'await ui.render({ nodes: [{ type: "Text", text: "Second display" }] });',
        'throw new Error("Script stopped <here>");'
      ].join("\n"));
      const record = (await h.history.session(session.id))!.turns[0]!;
      expect(record.error).toContain("Script stopped <here>");
      expect(record.response?.steps?.map((step) => step.method)).toEqual(["ui.render", "stdout", "stderr", "ui.render"]);
      expect(h.messages).toContainEqual(expect.objectContaining({
        type: "executionFailed", sessionId: session.id, response: record.response
      }));
      const html = renderHistoryRecord(record, session.id);
      expect(html).toMatch(/data-script-view[^]*First display[^]*Between displays \(stdout\)[^]*Between displays \(stderr\)[^]*data-script-view[^]*Second display[^]*<pre class="error">[^]*Script stopped &lt;here&gt;/);
    } finally {
      h.dispose();
    }
  });

  it("keeps recorded output when a stopped Code turn is reopened", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const kernel = host(root, (invocation, metadata) => {
      if (invocation.method === "ask") {
        const signal = metadata.signal!;
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new ExecutionCancelledError()), { once: true });
          started();
        });
      }
      return runtime.execute(invocation, [], metadata);
    });
    const h = createConversationHarness({
      executeInput: (source, execution) => kernel.runSource(source, { execution, signal: execution.signal! })
    });
    const reopened = createConversationHarness();
    try {
      const session = conversation("display-cancelled");
      await h.seed([session]);
      const running = h.coordinator.execute(h.controller.active(), "code", [
        'import { ask, ui } from "dext";',
        'await ui.render({ nodes: [{ type: "Text", text: "Display before Stop" }] });',
        'await ask({ input: "Wait for Stop" });'
      ].join("\n"));
      await Promise.race([waiting, running.then(() => { throw new Error("The turn finished before Stop."); })]);
      expect(h.coordinator.abort(session.id)).toBe(true);
      await running;
      const saved = (await h.history.session(session.id))!;
      const record = saved.turns[0]!;
      expect(record.error).toBe("Execution was cancelled.");
      expect(record.response?.steps?.map((step) => step.method)).toEqual(["ui.render"]);
      expect(h.messages).toContainEqual(expect.objectContaining({
        type: "executionFailed", sessionId: session.id, message: record.error, response: record.response
      }));
      await reopened.seed([saved]);
      const restored = reopened.controller.active().turns[0]!;
      expect(renderHistoryRecord(restored, session.id)).toMatch(/data-script-view[^]*Display before Stop[^]*<pre class="error">[^]*Execution was cancelled\./);
    } finally {
      reopened.dispose();
      h.dispose();
    }
  });

  it("resolves dext/api/<id> against .dext/api and any configured root", { timeout: 30000 }, async () => {
    const root = await workspace();
    const shared = join(root, "shared-api");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "greeter.ts"), [
      "export async function greeter(name: string): Promise<string> {",
      "  return `hello ${name}`;",
      "}",
      ""
    ].join("\n"), "utf8");
    await mkdir(join(root, ".dext", "api"), { recursive: true });
    await writeFile(join(root, ".dext", "api", "project.ts"), [
      "export async function project(): Promise<string> { return \"project\"; }",
      ""
    ].join("\n"), "utf8");
    const file = await fixture(root, "consumer.ts", [
      "import { project } from \"dext/api/project\";",
      "import { greeter } from \"dext/api/greeter\";",
      "console.log(await project());",
      "console.log(await greeter(\"dext\"));",
      ""
    ].join("\n"));
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const response = await kernel.run(file, { apiRoots: [join(root, ".dext", "api"), shared] });
    // Both writes land in the same tick, so they merge into one stdout step.
    expect(response.steps?.map((step) => step.stream?.text)).toEqual(["project\nhello dext\n"]);
  });

  it("re-evaluates the file on a second run of the same kernel", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "side-effect.ts", "console.log(\"top\");\nexport function entry() { return 1; }\n");
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const first = await kernel.run(file);
    const second = await kernel.run(file);
    expect(first.steps?.map((step) => step.stream?.text)).toEqual(["top\n"]);
    expect(second.steps?.map((step) => step.stream?.text)).toEqual(["top\n"]);
  });

  it("queues requests above the dispatch limit", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "parallel.ts", [
      "import { ask } from \"dext\";",
      "const answers = await Promise.all([1, 2, 3, 4, 5, 6].map((value) => ask({ input: String(value) })));",
      "console.log(answers.map((answer) => answer.text).join(\",\"));",
      ""
    ].join("\n"));
    let active = 0;
    let peak = 0;
    const kernel = host(root, async (invocation) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return askResponse(invocation);
    }, 2);
    const response = await kernel.run(file);
    expect(peak).toBe(2);
    expect(response.steps?.filter((step) => step.method === "ask")).toHaveLength(6);
    expect(response.steps?.at(-1)?.stream?.text).toBe("1,2,3,4,5,6\n");
  });

  it("writes the run buffer where the extension keeps it, and prunes old ones", { timeout: 30000 }, async () => {
    // The composer's buffer is not project content: the extension points this at its
    // own storage so running Code never adds a file to the repository.
    const root = await workspace();
    const runs = join(root, "storage-runs");
    const kernel = new DextKernelHost({
      workspaceRoot: root,
      nodeExecPath: process.execPath,
      runnerDirectory,
      runsDirectory: runs,
      execute: async (invocation) => askResponse(invocation)
    });
    hosts.push(kernel);
    await mkdir(runs, { recursive: true });
    // Twenty-five stale buffers, plus the two this test writes.
    for (let index = 0; index < 25; index += 1) {
      await writeFile(join(runs, `run-${1700000000000 + index}-1.ts`), "export function entry() { return 1; }\n", "utf8");
    }
    await kernel.runSource("console.log(\"first\");");
    await kernel.runSource("console.log(\"second\");");
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(runs)).sort();
    expect(names).toHaveLength(20);
    // The newest survive; the oldest are gone.
    expect(names).toContain("run-1700000000024-1.ts");
    expect(names).not.toContain("run-1700000000000-1.ts");
    // The buffers of the two runs this test made are still there — pruning must never
    // delete the file the kernel is about to import.
    expect(names.some((name) => !name.startsWith("run-1700000000"))).toBe(true);
    // Nothing was written under the workspace.
    await expect(readdir(join(root, ".dext", "runs"))).rejects.toThrow();
  });

  it("kills the kernel when a run is cancelled and restarts it for the next run", { timeout: 30000 }, async () => {
    const root = await workspace();
    const stalled = await fixture(root, "stalled.ts", "await new Promise(() => {});\n");
    const kernel = host(root, async (invocation) => askResponse(invocation));
    await kernel.start();
    const controller = new AbortController();
    const running = kernel.run(stalled, { signal: controller.signal });
    const cancelled = expect(running).rejects.toBeInstanceOf(ExecutionCancelledError);
    setTimeout(() => controller.abort(), 50);
    await cancelled;
    expect(kernel.capabilities).toBeUndefined();
    const response = await kernel.run(languageFixture);
    expect(response.steps?.map((step) => step.method)).toEqual(["ask", "stdout", "stderr"]);
  });

  it("names the import a run forgot", { timeout: 30000 }, async () => {
    // `git.commit()` was the old `.dx` spelling, and `ask(...)` always needed an
    // import: the bare V8 failure does not say which one.
    const root = await workspace();
    const api = join(root, "api", "git");
    await mkdir(api, { recursive: true });
    await writeFile(join(api, "commit.ts"), "export async function commit() { return 1; }\n", "utf8");
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const apiRoots = [join(root, "api")];
    await expect(kernel.runSource("git.commit();", { apiRoots }))
      .rejects.toThrow(/git is not defined[\s\S]*import \{ commit \} from "dext\/api\/git\/commit";/);
    await expect(kernel.runSource('await ask({ input: "x" });', { apiRoots }))
      .rejects.toThrow(/ask is not defined[\s\S]*import \{ ask \} from "dext"/);
  });

  it("waits for a call the run did not await", { timeout: 30000 }, async () => {
    // `commit()` without `await` used to end the run while the agent it started was
    // still working: the turn closed, the panel stopped updating, and the answer — or
    // the failure — landed where nothing was listening any more.
    const root = await workspace();
    let release = (): void => {};
    let started: (() => void) | undefined;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const kernel = host(root, async (invocation) => {
      started?.();
      await new Promise<void>((resolve) => { release = resolve; });
      return askResponse(invocation);
    });
    const running = kernel.runSource('import { ask } from "dext";\nask({ input: "floating" });\n');
    await called;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The run is still open: the call it started has not answered yet.
    expect(kernel.busy()).toBe(true);
    release();
    const response = await running;
    expect(response.steps?.map((step) => step.method)).toContain("ask");
    // The call was not awaited, so its result is not the run's result — and the run says
    // nothing about it: an un-awaited call is ordinary TypeScript, and the editor's types
    // are what show the promise. Nothing is appended to the program's own output either.
    expect(response.steps?.some((step) => step.state === "success")).toBe(true);
    expect(response.steps?.some((step) => Object.hasOwn(step, "notice"))).toBe(false);
    expect(response.steps?.some((step) => step.stream && /not awaited/.test(step.stream.text))).toBe(false);
  });

  it("fails a run whose un-awaited call failed", { timeout: 30000 }, async () => {
    const root = await workspace();
    let release = (): void => {};
    let started: (() => void) | undefined;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const kernel = host(root, async () => {
      started?.();
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("the agent the call started failed");
    });
    const running = kernel.runSource('import { ask } from "dext";\nask({ input: "floating" });\n');
    const failed = expect(running).rejects.toThrow(/the agent the call started failed/);
    await called;
    release();
    await failed;
  });

  it("reports whether a run is in flight", { timeout: 30000 }, async () => {
    // A host is built around one workspace, so the extension replaces it when the
    // folder changes — but only while it is idle, which is what this reports.
    const root = await workspace();
    const stalled = await fixture(root, "busy.ts", "await new Promise(() => {});\n");
    const kernel = host(root, async (invocation) => askResponse(invocation));
    expect(kernel.busy()).toBe(false);
    const controller = new AbortController();
    const running = kernel.run(stalled, { signal: controller.signal });
    const cancelled = expect(running).rejects.toBeInstanceOf(ExecutionCancelledError);
    // The handshake is part of the run, so the host is busy before it is ready.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kernel.busy()).toBe(true);
    controller.abort();
    await cancelled;
    expect(kernel.busy()).toBe(false);
  });

  it("runs two Code conversations in parallel on separate kernels", { timeout: 30000 }, async () => {
    // A kernel's run state (generation, replay, `settleCalls`) is process-wide, so
    // concurrent Code conversations get a process each instead of queueing.
    const root = await workspace();
    const file = (name: string): Promise<string> => fixture(root, `${name}.ts`, [
      'import { ask } from "dext";',
      `const answer = await ask({ input: "${name}" });`,
      "console.log(answer.text);"
    ].join("\n"));
    let release = (): void => {};
    let started = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const first = host(root, async (invocation) => {
      if (invocation.arguments.some((argument) => argument.value === "slow")) {
        started();
        await gate;
      }
      return askResponse(invocation);
    });
    const second = host(root, async (invocation) => askResponse(invocation));
    const slow = first.run(await file("slow"));
    await entered;
    const fast = await second.run(await file("fast"));
    // The fast run finished while the slow one was still in flight.
    expect(first.busy()).toBe(true);
    expect(fast.steps?.at(-1)?.stream?.text).toBe("fast\n");
    release();
    const slowDone = await slow;
    expect(slowDone.steps?.at(-1)?.stream?.text).toBe("slow\n");
  });
});
