import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import type { ExecutionMetadata, InvocationAst, RuntimeResponse } from "../src/core/types.js";
import { DextKernelHost } from "../src/runner/dextHost.js";

const runnerDirectory = resolve("src", "runner");
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

  it("runs each call through the injected runtime contract", { timeout: 30000 }, async () => {
    const root = await workspace();
    const runtime = builtinRuntime(root);
    const kernel = host(root, (invocation, metadata) => runtime.execute(invocation, [], metadata));
    const response = await kernel.run(languageFixture);
    expect(response.steps?.[0]?.response?.method).toMatchObject({ id: "ask", source: "builtin" });
    expect(response.steps?.[0]?.response?.result.kind).toBe("ask");
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

  it("resolves dext/api/<id> against .dext/api and any configured root", { timeout: 30000 }, async () => {
    const root = await workspace();
    const shared = join(root, "shared-api");
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "greeter.ts"), [
      "export async function main(name: string): Promise<string> {",
      "  return `hello ${name}`;",
      "}",
      ""
    ].join("\n"), "utf8");
    await mkdir(join(root, ".dext", "api"), { recursive: true });
    await writeFile(join(root, ".dext", "api", "project.ts"), [
      "export async function main(): Promise<string> { return \"project\"; }",
      ""
    ].join("\n"), "utf8");
    const file = await fixture(root, "consumer.ts", [
      "import { main as project } from \"dext/api/project\";",
      "import { main as greeter } from \"dext/api/greeter\";",
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
    const file = await fixture(root, "side-effect.ts", "console.log(\"top\");\nexport function main() { return 1; }\n");
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
      await writeFile(join(runs, `run-${1700000000000 + index}-1.ts`), "export function main() { return 1; }\n", "utf8");
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
    await writeFile(join(api, "commit.ts"), "export async function main() { return 1; }\n", "utf8");
    const kernel = host(root, async (invocation) => askResponse(invocation));
    const apiRoots = [join(root, "api")];
    await expect(kernel.runSource("git.commit();", { apiRoots }))
      .rejects.toThrow(/git is not defined[\s\S]*import \{ main as commit \} from "dext\/api\/git\/commit";/);
    // A module that exports something other than the entry point Dext runs is imported
    // by a name it has: suggesting `main` there would be a fix that cannot resolve.
    await writeFile(join(api, "commit.ts"), "export async function commit() { return 1; }\n", "utf8");
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
});
