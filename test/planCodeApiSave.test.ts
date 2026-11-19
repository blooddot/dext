import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("vscode", async () => (await import("./planHostMock.js")).createVscodeMock());

import { DextApplication } from "../src/app/application.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { ContextResolver } from "../src/features/workflow/host/contextResolver.js";
import { DextRuntime } from "../src/features/workflow/host/runtime.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { planFileName } from "../src/features/conversations/domain/planFile.js";
import { toBoundaryJson } from "../src/shared/protocol/resultSerialization.js";
import { DextStorage } from "../src/platform/vscode/dextStorage.js";
import type { DextKernelHostOptions } from "../src/runner/dextHost.js";
import type { ContextHost } from "../src/shared/contracts/context.js";
import type { InvocationAst, InvocationValue, RuntimeResponse } from "../src/shared/contracts/types.js";
import { planHostState as state, resetPlanHostState, type PlanHostStub } from "./planHostMock.js";

const contextHost: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

let globalRoot = "";
let workspaceRoot = "";
let name = "";

const goal = "Add a Redis cache";

beforeEach(async () => {
  globalRoot = await mkdtemp(join(tmpdir(), "dext-code-plan-global-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "dext-code-plan-workspace-"));
  state.globalStorage = globalRoot;
  state.workspaceFolder = workspaceRoot;
  resetPlanHostState();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 21, 9, 5, 3));
  name = planFileName(goal, new Date());
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(globalRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

function invocation(args: Record<string, InvocationValue>): InvocationAst {
  return {
    kind: "invocation",
    method: "plan",
    arguments: Object.entries(args).map(([argumentName, value]) => ({ name: argumentName, value })),
    source: "code"
  };
}

/** What the Agent would have returned: the goal for these contract-level calls. */
function planText(invocationAst: InvocationAst): string {
  const input = invocationAst.arguments.find((argument) => argument.name === "input")?.value;
  return typeof input === "string" ? input : "";
}

function runtimeResponse(invocationAst: InvocationAst): RuntimeResponse {
  return {
    invocation: invocationAst,
    method: { id: invocationAst.method, title: invocationAst.method, kind: "command", source: "builtin" },
    result: { kind: "plan", text: planText(invocationAst) },
    durationMs: 0
  };
}

/** A real runtime: the strict argument contract, minus any configured Agent. */
function realRuntime(): DextRuntime {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver(contextHost));
  runtime.setWorkspaceRoot(workspaceRoot);
  return runtime;
}

function application(runtime?: DextRuntime): PlanHostStub {
  const app = Object.create(DextApplication.prototype) as unknown as PlanHostStub;
  app.storage = new DextStorage({ fsPath: state.globalStorage } as never);
  app.workspaceUri = state.workspaceFolder ? { fsPath: state.workspaceFolder } : undefined;
  app.workspaceTrusted = true;
  app.workspaceRoot = state.workspaceFolder ?? process.cwd();
  app.kernels = [];
  app.reservedKernels = new Set();
  app.dispatchConcurrency = 1;
  app.runtime = runtime ?? { execute: async (invocationAst: InvocationAst) => runtimeResponse(invocationAst) };
  return app;
}

const call = (app: PlanHostStub, args: Record<string, InvocationValue>): Promise<RuntimeResponse> =>
  app.executeCodeCall(invocation(args), {}, []);

/** The saved path of a plan response, narrowed out of the result union. */
function savedPlanPath(response: RuntimeResponse): string {
  if (response.result.kind !== "plan") throw new Error(`expected a plan result, got ${response.result.kind}`);
  if (!response.result.planPath) throw new Error("the plan result has no planPath");
  return response.result.planPath;
}

const globalPlans = (): string => join(globalRoot, "plans");
const workspacePlans = (): string => join(workspaceRoot, ".dext", "plans");
const list = (directory: string): Promise<string[]> => readdir(directory).catch(() => [] as string[]);

describe("code API plan() saving", () => {
  it("saves by default and returns a planPath Node can read", async () => {
    const response = await call(application(), { input: goal });
    const planPath = savedPlanPath(response);

    expect(planPath).toBe(join(globalPlans(), name));
    expect((await stat(planPath)).isFile()).toBe(true);
    expect(await readFile(planPath, "utf8")).toBe(`${goal}\n`);
    // The plan text is still the caller's value, and saving does not replace it.
    expect(response.result).toMatchObject({ kind: "plan", text: goal });
  });

  it("treats an explicit save: true exactly like the default", async () => {
    const response = await call(application(), { input: goal, save: true });

    expect(savedPlanPath(response)).toBe(join(globalPlans(), name));
    expect(await readFile(savedPlanPath(response), "utf8")).toBe(`${goal}\n`);
  });

  it("returns text only, with no file and no planPath, for save: false", async () => {
    const response = await call(application(), { input: goal, save: false, location: "workspace" });

    expect(response.result).toEqual({ kind: "plan", text: goal });
    expect(await list(globalPlans())).toEqual([]);
    expect(await list(workspacePlans())).toEqual([]);
  });

  it("keeps the workspace location's plan-directory relative path", async () => {
    state.settings.set("dext.storage.location", "workspace");
    const response = await call(application(), { input: goal });

    expect(savedPlanPath(response)).toBe(`.dext/plans/${name}`);
    expect(await readFile(join(workspacePlans(), name), "utf8")).toBe(`${goal}\n`);
  });

  it("saves to the location the call names, not the configured one", async () => {
    state.settings.set("dext.storage.location", "workspace");
    const global = await call(application(), { input: goal, location: "global" });
    expect(savedPlanPath(global)).toBe(join(globalPlans(), name));
    expect(await list(workspacePlans())).toEqual([]);

    state.settings.set("dext.storage.location", "global");
    const workspace = await call(application(), { input: goal, location: "workspace" });
    expect(savedPlanPath(workspace)).toBe(`.dext/plans/${name}`);
    expect(await list(workspacePlans())).toEqual([name]);
    // Only this call moved: the setting itself is untouched.
    expect(state.settings.get("dext.storage.location")).toBe("global");
  });

  it("follows the setting again on the next call after a location override", async () => {
    state.settings.set("dext.storage.location", "workspace");
    await call(application(), { input: goal, location: "global" });
    const next = await call(application(), { input: goal });

    expect(savedPlanPath(next)).toBe(`.dext/plans/${name}`);
  });

  it("numbers a second plan saved in the same second instead of overwriting", async () => {
    const app = application();
    const first = await call(app, { input: goal });
    const second = await call(app, { input: goal });

    expect(savedPlanPath(first)).toBe(join(globalPlans(), name));
    expect(savedPlanPath(second)).toBe(join(globalPlans(), planFileName(goal, new Date(), 2)));
    expect(await list(globalPlans())).toHaveLength(2);
  });

  it("returns no planPath for an empty plan", async () => {
    const app = application();
    app.runtime = {
      execute: async (invocationAst: InvocationAst) => ({
        ...runtimeResponse(invocationAst),
        result: { kind: "plan", text: "   \n" }
      })
    };
    const response = await call(app, { input: goal });

    expect(response.result).toEqual({ kind: "plan", text: "   \n" });
    expect(await list(globalPlans())).toEqual([]);
  });

  it("fails the call instead of returning a path when the write fails", async () => {
    state.failWrite = true;

    await expect(call(application(), { input: goal })).rejects.toThrow("disk is read-only");
    expect(await list(globalPlans())).toEqual([]);
  });

  it("writes nothing for a workspace location in an untrusted workspace", async () => {
    const app = application();
    app.workspaceTrusted = false;
    const response = await call(app, { input: goal, location: "workspace" });

    expect(response.result).toEqual({ kind: "plan", text: goal });
    expect(await list(workspacePlans())).toEqual([]);
    // A refused workspace save never silently falls back to global storage.
    expect(await list(globalPlans())).toEqual([]);
  });

  it("keeps planPath across the kernel's JSON boundary", async () => {
    const response = await call(application(), { input: goal });
    const boundary = toBoundaryJson(response, "The result of plan()");
    const crossed = JSON.parse(JSON.stringify(boundary)) as RuntimeResponse;

    expect(savedPlanPath(crossed)).toBe(join(globalPlans(), name));
    expect(await readFile(savedPlanPath(crossed), "utf8")).toBe(`${goal}\n`);
  });

  it("is wired into the kernel host's execute callback", async () => {
    const app = application();
    const kernel = app.kernelHost();
    const execute = (kernel as unknown as { options: DextKernelHostOptions }).options.execute;

    const response = await execute(invocation({ input: goal }), {}, []);
    expect(savedPlanPath(response)).toBe(join(globalPlans(), name));
    expect(await readFile(savedPlanPath(response), "utf8")).toBe(`${goal}\n`);
  });
});

describe("plan() argument contract", () => {
  it("accepts the declared save and location arguments", async () => {
    const response = await call(application(realRuntime()), { input: goal, save: false, location: "workspace" });

    expect(response.result).toEqual({ kind: "plan", text: goal });
    expect(await list(workspacePlans())).toEqual([]);
  });

  it("still rejects an undeclared argument", async () => {
    await expect(call(application(realRuntime()), { input: goal, saveTo: "global" }))
      .rejects.toThrow(/saveTo/);
  });

  it("rejects a non-boolean save and an unknown location without writing a file", async () => {
    const app = application(realRuntime());

    await expect(call(app, { input: goal, save: "no" })).rejects.toThrow(/save/);
    await expect(call(app, { input: goal, location: "project" })).rejects.toThrow(/location/);
    expect(await list(globalPlans())).toEqual([]);
    expect(await list(workspacePlans())).toEqual([]);
  });
});

