import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-kernel-"));
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
  await mkdir(api, { recursive: true });
  await writeFile(join(api, "index.ts"), await readFile(resolve(".dext/api/spec/index.ts")));
}

async function installGitReviewApi(root: string): Promise<void> {
  const api = join(root, ".dext", "api", "git");
  await mkdir(api, { recursive: true });
  for (const name of ["fix.ts", "review.ts", "reviewFindings.ts", "reviewRepair.ts"]) {
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
    { mode: "update", args: '"example", "修订方案"', id: "openspec-update-change", text: "已修订 proposal.md。", next: 'spec.apply("example",' },
    { mode: "update", args: '"example"', id: "openspec-update-change", text: "待确认\n\n拟修订提案。", state: "pending", next: "先完成 Agent 说明中的确认", absent: "spec.apply" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "已归档到 openspec/changes/archive/2026-11-21-example。", next: 'spec.propose' },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "等待选择同步方式。", state: "pending", next: "归档确认未能完成", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "归档目录已存在。", state: "blocked", next: "仍在活跃变更中", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "归档查询出错。", queryFails: true, next: "归档状态未知", absent: "活跃变更已清空" },
    { mode: "archive", args: '"example"', id: "openspec-archive-change", text: "活跃列表已找不到目标。", archiveMissing: true, next: "归档状态未知", absent: "活跃变更已清空" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "已同步 openspec/specs/example/spec.md。", next: 'spec.archive("example",' },
    { mode: "sync", args: "", id: "openspec-sync-specs", text: "已同步 openspec/specs/。", next: 'spec.archive("example",' },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "主规格校验失败。", state: "blocked", next: "同步结果尚未确认", absent: "spec.archive" },
    { mode: "sync", args: '"example"', id: "openspec-sync-specs", text: "主规格仍有校验错误。", queryFails: true, next: "校验未通过", absent: "spec.archive" },
    { mode: "explore", args: '"调查示例"', id: "openspec-explore", text: "探索结论和源码依据。", next: 'spec.propose' }
  ])("shows spec.$mode output after $text", { timeout: 30000 }, async ({ mode, args, id, text, state = "completed", queryFails, archiveMissing, next, absent }) => {
    const root = await workspace();
    await installSpecApi(root);
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
        expect(args).toMatchObject({ skills: [id], apply: true, patch: false });
        if (mode === "propose") expect(args.input).toContain("运行严格校验并报告结果");
        const receipt = { status: state, change: "example", root, cwd: ".", store: null,
          ...(mode === "archive" && state === "completed" ? { archiveName: "2026-11-21-example" } : {}) };
        return { ...response, result: { kind: "agent", text: specReply(text, receipt) } };
      }
      const command = args.command;
      if (typeof command !== "string") throw new Error("Expected a terminal command");
      const rootInfo = { path: root, source: "nearest" };
      const change = { name: "example", completedTasks: 1, totalTasks: 3, lastModified: "2026-11-21T08:35:53.351Z" };
      let stdout = "";
      let exitCode = 0;
      if (command === "openspec list --json") {
        stdout = JSON.stringify({ root: rootInfo, changes: [
          ...(calls.includes("agent") && state === "completed" ? [change] : []),
          { ...change, name: "other", lastModified: "2026-11-22T08:35:53.351Z" }
        ] });
      } else if (command === "openspec list --all --json") {
        const changes = archiveMissing ? [] : state === "completed"
          ? [{ ...change, name: "2026-11-21-example", archived: true }]
          : [{ ...change, archived: false }];
        stdout = queryFails ? "查询失败" : JSON.stringify({ changes, root: rootInfo });
        if (queryFails) exitCode = 1;
      } else if (command === "openspec validate --specs --json") {
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
    expect(output).toContain(text);
    expect(output).toContain(`### 下一步`);
    expect(output).toContain(next);
    expect(output).not.toContain("DEXT_OPENSPEC_RESULT");
    if (absent) expect(output?.slice(output.lastIndexOf("### 下一步"))).not.toContain(absent);
    expect(calls.filter((method) => method === (mode === "explore" ? "skill" : "agent"))).toHaveLength(1);
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
        const input = String(args.input);
        agentInputs.push(input);
        const receipt = { change: "example", root, cwd: root, store: null };
        const text = agentInputs.length === 1
          ? specReply(summary, { ...receipt, status: "pending", archivePrompt: { kind: "sync_needed", summary } })
          : specReply("归档完成。", { ...receipt, status: "completed", archiveName });
        return { ...response, result: { kind: "agent", text } };
      }
      expect(invocation.method).toBe("terminal");
      const command = String(args.command);
      const changes = command === "openspec list --all --json" ? [{ name: archiveName, archived: true }] : [{ name: "example" }];
      const stdout = command === "git status --porcelain -uall" ? "" : JSON.stringify({ changes, root: { path: root } });
      return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root, exit_code: 0, stdout,
        stderr: "", duration_ms: 1 } };
    });
    const h = createConversationHarness({
      executeInput: (source, execution, run) => kernel.runSource(source, { ...run, execution, signal: execution.signal! })
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

  it.each(["fix", "fix with independent edit", "manual fix with independent edit"])(
    "closes git.review findings by verifying a %s", { timeout: 30000 }, async (scenario) => {
    const independentEdit = scenario !== "fix";
    const manual = scenario.startsWith("manual");
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
            : command.startsWith("git grep") ? "target.ts\0caller.ts\0caller.ts\0" : "0123456789";
        return { ...response, result: { kind: "terminal", status: "succeeded", command, cwd: root,
          exit_code: 0, stdout, stderr: "", duration_ms: 1 } };
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
      expect(args.input).toContain(findingId);
      expect(args.input).toContain("caller.ts");
      expect(args.input).not.toContain("unrelated.ts");
      expect(args.input).toContain("修复复核");
      expect(args.input).toContain("候选调用点（按需）");
      expect(args.input).not.toContain("- caller.ts（M）");
      if (!manual) expect(args.input).toContain("+export const retries = 1;");
      if (independentEdit && reviews === 3) await writeFile(unrelated, "export const unrelated = 3;\n");
      const proof = reviews === 2 ? "" : `\n\n### 既有问题复核\n- \`${findingId}\` | \`resolved\` | 回归检查通过`;
      return { ...response, result: { kind: "agent", text: `### 新发现\n（无）${proof}${coverage}` } };
    });
    const review = () => kernel.runSource('import { review } from "dext/api/git/review";\nconsole.log((await review("workspace")).kind);');
    const fix = () => kernel.runSource('import { fix } from "dext/api/git/fix";\nfix("");');
    const discovery = await review();
    const stdout = discovery.steps?.filter(({ stream }) => stream?.channel === "stdout").map(({ stream }) => stream?.text).join("\n");
    expect(stdout).toMatch(/^skill\r?$/m);
    const first = await readState();
    expect(first.findings.map(({ status }) => status)).toEqual(["open", "deferred"]);
    findingId = first.findings[0]!.id;
    if (manual) {
      await writeFile(target, "export const retries = 1;\n");
    } else {
      await fix();
      expect((await readState()).findings[0]).toMatchObject({ id: findingId, status: "pending" });
      await fix();
      expect(fixes).toBe(1);
    }
    if (manual) await writeFile(unrelated, "export const unrelated = 2;\n");

    await review();
    expect(await readState()).toMatchObject({ round: 1, findings: [{ id: findingId, status: manual ? "open" : "pending" }, { status: "deferred" }] });
    const verification = await review();
    expect(await readState()).toMatchObject({ round: 2, reviewed: ["target.ts"], carried: independentEdit ? ["caller.ts"] : ["caller.ts", "unrelated.ts"],
      findings: [{ id: findingId, status: "resolved" }, { status: "deferred" }] });
    expect(verification.steps?.some((step) => step.stream?.text.includes("修复复核通过"))).toBe(true);
    if (independentEdit) {
      expect((await readState()).files["unrelated.ts"]).toEqual(first.files["unrelated.ts"]);
      expect(verification.steps?.some((step) => step.stream?.text.includes("1 个独立文件变更留待单独审查"))).toBe(true);
    }
    const reuse = await review();
    expect(reviews).toBe(3);
    expect(reuse.steps?.some((step) => step.stream?.text.includes("通过，当前范围内没有待处理问题"))).toBe(true);
  });

  it("stops git.fix retries until explicitly requested and accepts only anchored regressions from verification", { timeout: 30000 }, async () => {
    const root = await workspace();
    await installGitReviewApi(root);
    const target = await fixture(root, "target.ts", "const retries = 0;\nconst capacity = 3;\n");
    const statePath = join(root, ".dext", "state", "review", "workspace.json");
    const readState = async () => JSON.parse(await readFile(statePath, "utf8")) as {
      findings: Array<{ id: string; status: string; title: string; explicitFix?: boolean }>;
    };
    let issue = "";
    let fixes = 0;
    let reviews = 0;
    const kernel = host(root, async (invocation) => {
      const response = askResponse(invocation);
      const args = Object.fromEntries(invocation.arguments.map(({ name, value }) => [name, value]));
      if (invocation.method === "terminal") {
        const command = args.command;
        if (typeof command !== "string") throw new Error("Expected a terminal command");
        const stdout = command.includes("--show-toplevel") ? root : command.includes(" status ") ? " M target.ts\0" : "0123456789";
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
        : `### 新发现\n- \`target.ts:1\` | \`medium\` | \`bug\` | 重复提交 | ${issue} 将 retries 改为 1 后重复提交\n`
          + `- \`target.ts:2\` | \`medium\` | \`bug\` | 容量限制 | ${issue} 的附近存在另一个问题\n`
          + `### 既有问题复核\n- \`${issue}\` | \`resolved\` | 失败时会重试`;
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
    expect((await readState()).findings).toMatchObject([
      { id: issue, status: "resolved" },
      { title: "重复提交", status: "open", explicitFix: true }
    ]);
    await fix();
    await review();
    expect(fixes).toBe(2);
    expect(reviews).toBe(2);
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
        const stdout = command.includes("--show-toplevel") ? root : command.includes(" status ") ? " M target.ts\0" : "0123456789";
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
            : command.startsWith("git grep") ? "" : "0123456789";
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
      'import { existsSync } from "node:fs";',
      'import { ui } from "dext";',
      'import { inspectConfig } from "dext/api/inspection-report";',
      'console.log(JSON.stringify(await inspectConfig()));',
      'await ui.render({ nodes: [{ type: "Text", text: "检查结束" }] });',
      'if (!existsSync("resume-ready")) throw new Error("Test retry");'
    ].join("\n") : example + "\nconsole.log(JSON.stringify((await inspectConfig()) ?? null));";
    const runtime = builtinRuntime(root);
    const calls: string[] = [];
    const kernel = host(root, (invocation, metadata) => {
      calls.push(invocation.method);
      return runtime.execute(invocation, [], metadata);
    });
    const h = createConversationHarness({
      executeInput: (source, execution, run) => kernel.runSource(source, {
        ...run, execution, signal: execution.signal!, apiRoots: [apiDirectory]
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
        const continuation = h.coordinator.takeContinuation(session.id, record.id);
        expect(continuation?.map((entry) => entry.method)).toEqual(calls);
        expect(h.coordinator.takeContinuation(session.id, record.id)).toBeUndefined();
        await writeFile(join(root, "resume-ready"), "");
        h.messages.length = 0;
        await h.coordinator.execute(h.controller.active(), "code", input, { codeContinuation: continuation! });
        const resumed = (await h.history.session(session.id))!.turns.at(-1)!;
        expect(resumed.error).toBeUndefined();
        expect(resumed.response?.steps?.map((step) => step.method)).toEqual(["ui.render", "ui.form", "stdout", "ui.render"]);
        expect(resumed.response?.steps?.[2]?.stream?.text).toBe(steps[1]?.stream?.text);
        expect(calls).toEqual(["ui.render", "ui.form", "ui.render"]);
        expect(h.messages.some((message) => message.type === "agentEvent" && message.event.uiInteraction?.status === "waiting")).toBe(false);
      } else if (state === "cancel") {
        expect(steps[1]?.response?.result).toMatchObject({ kind: "ui", type: "form", status: "cancelled", answers: {} });
        expect(steps[2]?.stream?.text).toContain('"status":"cancelled","answers":{}');
        expect(record.error).toBeUndefined();
      } else if (state === "stop") {
        expect(record.error).toBe("Execution was cancelled.");
        expect(h.coordinator.takeContinuation(session.id, record.id)).toBeUndefined();
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
      executeInput: (source, execution, run) => kernel.runSource(source, { ...run, execution })
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
      executeInput: (source, execution, run) => kernel.runSource(source, { ...run, execution, signal: execution.signal! })
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
      expect(h.coordinator.takeContinuation(session.id, record.id)).toBeUndefined();
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
