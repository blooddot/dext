import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow, parseWorkflowImports } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import { WorkflowCheckpoint } from "../src/core/workflowCheckpoint.js";
import type { TerminalResult, WorkflowContinuation } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

function methods(): MethodRegistry {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  return registry;
}

function terminalResult(command: string): TerminalResult {
  return {
    kind: "terminal",
    status: "succeeded",
    command,
    cwd: ".",
    exit_code: 0,
    stdout: command,
    stderr: "",
    duration_ms: 0
  };
}

/** "Continue from the failed Code step" resumes the run through the checkpoint that
 * the failed turn kept. Completed steps and branches are replayed from it, so their
 * effects (a CLI process, a file write, a paid model call) never happen twice. */
describe("Code workflow continuation", () => {
  it("resumes a failed run without repeating the work that already succeeded", async () => {
    const registry = methods();
    const calls = new Map<string, number>();
    let failing: string | undefined = "b";
    const workflow = new WorkflowRuntime(new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        const command = typeof args.command === "string" ? args.command : "";
        calls.set(command, (calls.get(command) ?? 0) + 1);
        // The failing branch waits, so the other worker has already recorded the
        // branches it owns by the time the fan-out reports the failure. That keeps the
        // replay assertion below independent of machine speed.
        if (command === failing) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error(`branch ${command} failed`);
        }
        return terminalResult(command);
      }
    }));
    workflow.setMaxConcurrency(2);
    const compiled = compileWorkflow([
      'head = terminal(command="head")',
      'commands = ["a", "b", "c", "d"]',
      "runs = [terminal(command=command) for command in commands]",
      'print(text="done")'
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);

    let continuation: WorkflowContinuation | undefined;
    const failed = await workflow.execute(compiled.program!, [], {
      onWorkflowFailure: (value) => { continuation = value; }
    });
    // A failed run still reports the whole shape: the branch that failed and the
    // statement that never started because of it.
    expect(continuation).toBeDefined();
    expect(failed.steps?.find((step) => step.state === "failed")).toMatchObject({ method: "terminal", branch: 1 });
    expect(failed.steps?.at(-1)).toMatchObject({ method: "print", state: "skipped" });

    failing = undefined;
    const resumed = await continuation!.resume();
    expect(resumed.steps?.map((step) => `${step.method}#${step.branch ?? "-"}:${step.state}`)).toEqual([
      "terminal#-:success",
      "terminal#0:success",
      "terminal#1:success",
      "terminal#2:success",
      "terminal#3:success",
      "=#-:success",
      "print#-:success"
    ]);
    // Only the branch that failed ran a second time: the leading step and the branches
    // that had already finished came back from the checkpoint.
    expect(Object.fromEntries(calls)).toEqual({ head: 1, a: 1, b: 2, c: 1, d: 1 });
    expect(resumed.executions.map((item) => item.result.kind === "terminal" ? item.result.command : "").filter(Boolean))
      .toEqual(["head", "a", "b", "c", "d"]);
  });

  it("refuses to replay a checkpoint against different code", async () => {
    const registry = methods();
    const workflow = new WorkflowRuntime(new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => terminalResult(typeof args.command === "string" ? args.command : "")
    }));
    const compiled = compileWorkflow([
      'commands = ["a", "b"]',
      "runs = [terminal(command=command) for command in commands]"
    ].join("\n"), registry);
    const rewritten = compileWorkflow([
      'commands = ["a", "b", "c"]',
      "runs = [terminal(command=command) for command in commands]"
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    expect(rewritten.diagnostics).toEqual([]);

    const checkpoint = new WorkflowCheckpoint();
    await workflow.execute(compiled.program!, [], { workflowCheckpoint: checkpoint });
    // A turn that kept the checkpoint is resumed with the code it ran, so replaying it
    // against an edited program has to fail loudly instead of mixing the two.
    await expect(workflow.execute(rewritten.program!, [], { workflowCheckpoint: checkpoint }))
      .rejects.toThrow("changed since it stopped");
  });

  it("gives a call's cached response and the program it runs separate identities", () => {
    const checkpoint = new WorkflowCheckpoint();
    const call = checkpoint.child("call:0");
    const program = call.child("program");
    const invocation = '{"kind":"invocation","method":"git.commit","source":"code","arguments":[]}';
    const source = 'def main() -> TerminalResult:\n    return terminal(command="git status")\n';
    // One identity per node: the call caches its response by invocation, and the
    // program node it parents is bound to the API source. Rebinding either with its
    // own value is the normal resume path and must not look like a changed workflow.
    call.bind(invocation);
    program.bind(source);
    expect(() => { call.bind(invocation); program.bind(source); }).not.toThrow();
    expect(() => call.bind('{"kind":"invocation","method":"git.push"}')).toThrow("changed since it stopped");
    expect(() => program.bind('def main() -> TerminalResult:\n    return terminal(command="git log")\n'))
      .toThrow("changed since it stopped");
  });

  it("runs a custom API call under a checkpoint instead of reporting changed code", async () => {
    const registry = methods();
    const root = "C:/workspace/.dext/api";
    const apiPath = `${root}/git/commit.dx`;
    const api = 'def main(text: str) -> TerminalResult:\n    return terminal(command=text)\n';
    const loaded = await loadCustomApis(true, [root], async () => [apiPath], async () => api, registry);
    expect(loaded.diagnostics).toEqual([]);

    const calls = new Map<string, number>();
    let failing = true;
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        const command = typeof args.command === "string" ? args.command : "";
        calls.set(command, (calls.get(command) ?? 0) + 1);
        if (failing && command === "b") throw new Error("b failed");
        return terminalResult(command);
      }
    });
    runtime.setCustomPlans(loaded.plans);

    const source = [
      "import git.commit",
      "",
      'first = git.commit(text="a")',
      'second = terminal(command="b")',
      'terminal(command="c")'
    ].join("\n");
    const compiled = compileWorkflow(source, registry, {
      allowImports: true,
      aliases: parseWorkflowImports(source),
      customApiIds: new Set(["git.commit"]),
      requireCustomApiImports: false
    });
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);

    let continuation: WorkflowContinuation | undefined;
    const failed = await new WorkflowRuntime(runtime).execute(compiled.program!, [], {
      onWorkflowFailure: (value) => { continuation = value; }
    });
    // A custom API is an ordinary step. Keeping a checkpoint for the turn must not
    // make it look like the workflow or the API changed and fail on the first run.
    expect(failed.steps?.[0]).toMatchObject({ method: "git.commit", state: "success" });
    expect(failed.steps?.find((step) => step.state === "failed")).toMatchObject({ method: "terminal" });

    failing = false;
    const resumed = await continuation!.resume();
    expect(resumed.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "git.commit:success",
      "terminal:success",
      "terminal:success"
    ]);
    // The resumed turn replays the custom API call: its terminal effect happens once.
    expect(Object.fromEntries(calls)).toEqual({ a: 1, b: 2, c: 1 });
  });

  it("checkpoints custom API calls in branches, loops and fan-out", async () => {
    const registry = methods();
    const root = "C:/workspace/.dext/api";
    const contents = new Map([
      [`${root}/demo/echo.dx`, 'def main(text: str) -> TerminalResult:\n    return terminal(command=text)\n'],
      // A custom API that calls another custom API: nested calls need their own nodes too.
      [`${root}/demo/wrap.dx`, 'import demo.echo as echo\n\ndef main(text: str) -> TerminalResult:\n    return echo(text=text)\n']
    ]);
    const loaded = await loadCustomApis(true, [root], async () => [...contents.keys()], async (path) => contents.get(path), registry);
    expect(loaded.diagnostics).toEqual([]);

    const calls = new Map<string, number>();
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        const command = typeof args.command === "string" ? args.command : "";
        calls.set(command, (calls.get(command) ?? 0) + 1);
        return terminalResult(command);
      }
    });
    runtime.setCustomPlans(loaded.plans);

    const source = [
      "import demo.echo",
      "import demo.wrap",
      "",
      'direct = demo.echo(text="direct")',
      'nested = demo.wrap(text="nested")',
      'commands = ["x", "y"]',
      "runs = [demo.echo(text=command) for command in commands]",
      "for command in commands:",
      "    demo.echo(text=command)",
      "if direct.exit_code == 0:",
      '    demo.echo(text="branch")'
    ].join("\n");
    const compiled = compileWorkflow(source, registry, {
      allowImports: true,
      aliases: parseWorkflowImports(source),
      customApiIds: new Set(["demo.echo", "demo.wrap"]),
      requireCustomApiImports: false
    });
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);

    let continuation: WorkflowContinuation | undefined;
    const execution = await new WorkflowRuntime(runtime).execute(compiled.program!, [], {
      onWorkflowFailure: (value) => { continuation = value; }
    });
    // Each call shape gets its own call node and its own program node, so none of them
    // can be mistaken for a changed workflow or a changed custom API.
    expect(execution.steps?.filter((step) => step.state !== "success")).toEqual([]);
    expect(continuation).toBeUndefined();
    expect(Object.fromEntries(calls)).toEqual({ direct: 1, nested: 1, x: 2, y: 2, branch: 1 });
  });

  it("still refuses a checkpoint when the custom API it ran has changed", async () => {
    const registry = methods();
    const root = "C:/workspace/.dext/api";
    const apiPath = `${root}/demo/echo.dx`;
    const loaded = await loadCustomApis(
      true,
      [root],
      async () => [apiPath],
      async () => 'def main(text: str) -> TerminalResult:\n    return terminal(command="boom")\n',
      registry
    );
    expect(loaded.diagnostics).toEqual([]);

    let failing = true;
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        const command = typeof args.command === "string" ? args.command : "";
        if (failing && command === "boom") throw new Error("boom failed");
        return terminalResult(command);
      }
    });
    runtime.setCustomPlans(loaded.plans);

    const source = 'import demo.echo\n\nfirst = demo.echo(text="a")\n';
    const compiled = compileWorkflow(source, registry, {
      allowImports: true,
      aliases: parseWorkflowImports(source),
      customApiIds: new Set(["demo.echo"]),
      requireCustomApiImports: false
    });
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);

    let continuation: WorkflowContinuation | undefined;
    const failed = await new WorkflowRuntime(runtime).execute(compiled.program!, [], {
      onWorkflowFailure: (value) => { continuation = value; }
    });
    expect(failed.steps?.find((step) => step.state === "failed")).toMatchObject({ method: "demo.echo" });

    // Edit the API the checkpoint ran. The recorded program identity no longer matches,
    // so the resume reports the edit instead of replaying a call into a different API.
    failing = false;
    const plan = loaded.plans.get("demo.echo")!;
    runtime.setCustomPlans(new Map([["demo.echo", {
      ...plan,
      program: { ...plan.program, source: 'def main(text: str) -> TerminalResult:\n    return terminal(command="ok")\n' }
    }]]));
    const resumed = await continuation!.resume();
    expect(resumed.steps?.find((step) => step.state === "failed")?.error).toContain("changed since it stopped");
  });
});
