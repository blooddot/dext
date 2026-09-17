import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///selection.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => undefined,
  file: async () => undefined,
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

let workspace: string;
let apiRoot: string;
let created: string[];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "dext-api-failure-"));
  apiRoot = join(workspace, ".dext", "api");
  created = [];
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

async function put(relative: string, content: string): Promise<string> {
  const path = join(apiRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  created.push(path);
  return path;
}

async function load(trusted = true) {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const loaded = await loadCustomApis(
    trusted,
    [apiRoot],
    async () => [...created],
    async (path) => readFile(path, "utf8"),
    registry
  );
  const runtime = new DextRuntime(registry, new ContextResolver(host));
  runtime.setCustomPlans(loaded.plans);
  runtime.setCustomApiDiagnostics(loaded.diagnosticDetails, loaded.blocked);
  return { registry, loaded, runtime };
}

function invoke(runtime: DextRuntime, method: string, args: Record<string, string> = {}): Promise<unknown> {
  return runtime.execute({
    kind: "invocation", method, source: "code",
    arguments: Object.entries(args).map(([name, value]) => ({ name, value }))
  });
}

describe("custom API runtime failures", () => {
  it("reports the failing function, reason and line instead of a bare 'not available'", async () => {
    // Mirrors the reported case: a helper lost a parameter and one call site
    // was missed. `main` compiles, so the API stays registered, but the file
    // has no plan and calling it used to say only "is not available".
    const source = [
      "def analyze_root_cause(seed_text: str) -> AskResult:",
      "    return ask(input=seed_text)",
      "",
      "def confirm_fix_solution() -> PrintResult:",
      '    return analyze_root_cause(wrong="x")',
      "",
      "def main() -> PrintResult:",
      "    return confirm_fix_solution()",
      ""
    ].join("\n");
    const path = await put("dev/fix.dx", source);
    const { registry, loaded, runtime } = await load();
    expect(registry.get("dev.fix")).toBeDefined();
    expect(loaded.plans.has("dev.fix")).toBe(false);
    // Every independent error is kept, each carrying the enclosing function.
    expect(loaded.diagnosticDetails.map((item) => [item.apiId, item.code])).toEqual([
      ["dev.fix", "dext/compile"], ["dev.fix", "dext/compile"], ["dev.fix", "dext/compile"]
    ]);
    // The flat text keeps the position, so the API panel does not lose it.
    expect(loaded.diagnostics.find((item) => item.includes("Unknown argument 'wrong'")))
      .toMatch(/:5:\d+: error dext\/compile: confirm_fix_solution\(\): Unknown argument 'wrong'/);

    const message = await invoke(runtime, "dev.fix").then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("Custom API 'dev.fix' is registered but its function body failed to compile:");
    expect(message).toContain("confirm_fix_solution()");
    expect(message).toContain("Unknown argument 'wrong' for 'analyze_root_cause'");
    expect(message).toContain("Missing required argument 'seed_text'");
    expect(message).toContain(`${path}:5:`);
    expect(message).not.toContain("is not available.");
  });

  it("names the MCP server and tool when a declared tool is not registered", async () => {
    const source = [
      "def main(task_id: str) -> PrintResult:",
      "    return mcp.task-tracker.get_task(task_id=task_id)",
      ""
    ].join("\n");
    await put("dev/fix.dx", source);
    const { loaded, runtime } = await load();
    runtime.setDeclaredMcpTools(["mcp.task-tracker.get_task"]);
    // An unregistered MCP path names the tool instead of the `mcp` root.
    expect(loaded.diagnosticDetails[0]).toMatchObject({ code: "dext/unknown-api", message: "main(): Unknown Dext API 'mcp.task-tracker.get_task'." });

    const message = await invoke(runtime, "dev.fix", { task_id: "1" }).then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("Unknown Dext API 'mcp.task-tracker.get_task'");
    expect(message).toContain("MCP server 'task-tracker' is not connected or 'get_task' is not registered on it.");
  });

  it("does not blame an MCP server for a tool no manifest declares", async () => {
    await put("dev/fix.dx", "def main(task_id: str) -> PrintResult:\n    return mcp.task-tracker.get_task(task_id=task_id)\n");
    const { runtime } = await load();
    runtime.setDeclaredMcpTools(["mcp.other.fetch"]);

    const message = await invoke(runtime, "dev.fix", { task_id: "1" }).then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("Unknown Dext API 'mcp.task-tracker.get_task'");
    expect(message).not.toContain("is not connected");
  });

  it("calls an untrusted workspace disabled rather than unavailable", async () => {
    await put("dev/fix.dx", 'def main() -> PrintResult:\n    return print(text="ok")\n');
    const { loaded, runtime } = await load(false);
    expect(loaded.blocked).toBe(true);

    const message = await invoke(runtime, "dev.fix").then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("disabled because this workspace is untrusted");
  });

  it("keeps the disabled reason for an API that is still registered from an earlier load", async () => {
    await put("dev/fix.dx", 'def main() -> PrintResult:\n    return print(text="ok")\n');
    const { runtime } = await load();
    runtime.setCustomPlans(new Map());
    runtime.setCustomApiDiagnostics([], true);

    const message = await invoke(runtime, "dev.fix").then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("Custom API 'dev.fix' is not available: custom .dext/api files are disabled because this workspace is untrusted");
  });

  it("still explains a plan that is missing with no recorded diagnostic", async () => {
    await put("dev/fix.dx", 'def main() -> PrintResult:\n    return print(text="ok")\n');
    const { runtime } = await load();
    runtime.setCustomPlans(new Map());
    runtime.setCustomApiDiagnostics([], false);

    const message = await invoke(runtime, "dev.fix").then(() => "", (error: unknown) => (error as Error).message);
    expect(message).toContain("Custom API 'dev.fix' is registered but its function body has no compiled plan.");
  });

  it("runs a compiled API unchanged", async () => {
    await put("dev/fix.dx", 'def main() -> PrintResult:\n    return print(text="ok")\n');
    const { runtime } = await load();
    const response = await invoke(runtime, "dev.fix") as { result: { kind: string; text: string } };
    expect(response.result).toMatchObject({ kind: "print", text: "ok" });
  });
});
