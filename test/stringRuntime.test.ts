import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import type { TerminalResult } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => undefined,
  activeFile: async () => undefined,
  file: async (path) => ({ uri: `file:///${path}`, content: "", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

function setup() {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
    // The terminal stands in for any API that hands the workflow runtime a value.
    terminalRun: async ({ arguments: args }): Promise<TerminalResult> => ({
      kind: "terminal",
      status: "succeeded",
      command: typeof args.command === "string" ? args.command : "",
      cwd: ".",
      exit_code: typeof args.command === "string" && args.command.startsWith("fail") ? 2 : 0,
      stdout: typeof args.command === "string" ? args.command.split("").reverse().join("") : "",
      stderr: "",
      duration_ms: 0
    })
  });
  return { registry, workflow: new WorkflowRuntime(runtime) };
}

/** Runs a workflow and returns the text of every `print` that succeeded. */
async function printed(source: string): Promise<string[]> {
  const { registry, workflow } = setup();
  const compiled = compileWorkflow(source, registry);
  if (compiled.diagnostics.length) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
  const result = await workflow.execute(compiled.program!);
  return result.executions
    .filter((execution) => execution.result.kind === "print")
    .map((execution) => String((execution.result as { text: unknown }).text));
}

describe("string expressions at run time", () => {
  it("builds text from API results", async () => {
    expect(await printed([
      'checked = terminal(command="build")',
      'print(text=f"{checked.status}: {checked.stdout} ({checked.exit_code}ms)")',
      'print(text="status=" + checked.status)',
      'print(text="%s -> %d" % [checked.status, checked.exit_code])'
    ].join("\n"))).toEqual([
      "succeeded: dliub (0ms)",
      "status=succeeded",
      "succeeded -> 0"
    ]);
  });

  it("formats runtime numbers and applies string methods", async () => {
    expect(await printed([
      'checked = terminal(command="fail now")',
      'print(text=f"{checked.exit_code:03d}")',
      'print(text=f"{checked.exit_code:+d}")',
      'print(text=checked.stdout.upper())',
      'print(text=checked.stdout[0:4])',
      'print(text=",".join(["a", "b"]))',
      'print(text="{}".format(checked.status))'
    ].join("\n"))).toEqual([
      "002",
      "+2",
      "WON LIAF",
      "won ",
      "a,b",
      "succeeded"
    ]);
  });

  it("splits, sorts, and iterates with the pure helpers", async () => {
    expect(await printed([
      'lines = ["b", "a"]',
      "for name in sorted(lines):",
      "    print(text=name)",
      'print(text=str(len(lines)) + " lines")'
    ].join("\n"))).toEqual(["a", "b", "2 lines"]);
  });

  it("keeps a computed variable as its own step", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow([
      'checked = terminal(command="build")',
      'text = f"[{checked.status}]"'
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.steps?.map((step) => `${step.assignment ?? ""}${step.method}:${step.state}`)).toEqual([
      "checkedterminal:success",
      "text=:success"
    ]);
  });

  it("reports a formatting failure on the step that caused it", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow([
      'checked = terminal(command="build")',
      'print(text=f"{checked.status:>x}")',
      'print(text="never")'
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    const failed = result.steps?.find((step) => step.state === "failed");
    expect(failed?.error).toContain("Unknown format code 'x'");
    expect(result.steps?.at(-1)).toMatchObject({ method: "print", state: "skipped" });
  });

  it("evaluates boolean conditions over runtime text", async () => {
    expect(await printed([
      'checked = terminal(command="build")',
      'if checked.status == "succeeded" and "build" in checked.command:',
      '    print(text="ok")',
      'elif checked.exit_code > 0:',
      '    print(text="failed")',
      'else:',
      '    print(text="unknown")'
    ].join("\n"))).toEqual(["ok"]);
  });

  it("short-circuits and/or and respects not", async () => {
    expect(await printed([
      'checked = terminal(command="fail now")',
      'if checked.exit_code > 0 and not checked.status.startswith("succeed"):',
      '    print(text="unreachable")',
      'if checked.exit_code > 0 or checked.status.startswith("nope"):',
      '    print(text="caught")',
      'if not checked.status.startswith("succeed"):',
      '    print(text="unreachable")'
    ].join("\n"))).toEqual(["caught"]);
  });
});
