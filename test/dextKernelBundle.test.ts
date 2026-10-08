import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InvocationAst, RuntimeResponse } from "../src/core/types.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import { workflowCases } from "./dextWorkflowCases.js";

/**
 * The shipped kernel is a bundle, and a bundle can inline the runtime module the
 * loader hands to user code: the kernel would then keep a second in-flight registry,
 * and a run that called an API without `await` — `commit()` rather than
 * `await commit()` — would be reported finished while the call, and the agent behind
 * it, was still running. `test/dextHost.test.ts` covers the behavior in `src/`; this
 * covers the artifact, because only the build can introduce the second copy.
 *
 * `npm run check` runs the tests before the build, so a checkout without `dist/`
 * skips this; `scripts/assertWebviewAssets.mjs` asserts the same invariant on the
 * built kernel right after the build.
 */
const builtKernel = resolve("dist", "dextKernel.mjs");

const hosts: DextKernelHost[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function askResponse(invocation: InvocationAst): RuntimeResponse {
  return {
    invocation,
    method: { id: invocation.method, title: invocation.method, kind: "command", source: "builtin" },
    result: { kind: "ask", text: "done" },
    durationMs: 0
  };
}

describe.skipIf(!existsSync(builtKernel))("the built kernel", () => {
  workflowCases(resolve("dist"));
  it("waits for a call the run did not await", { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-dist-kernel-"));
    roots.push(root);
    let release = (): void => {};
    let started: (() => void) | undefined;
    const called = new Promise<void>((resolve) => { started = resolve; });
    const kernel = new DextKernelHost({
      workspaceRoot: root,
      nodeExecPath: process.execPath,
      runnerDirectory: resolve("dist"),
      execute: async (invocation) => {
        started?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return askResponse(invocation);
      }
    });
    hosts.push(kernel);
    const running = kernel.runSource('import { ask } from "dext";\nask({ input: "floating" });\n');
    await called;
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The run is still open: the call it started has not answered yet.
    expect(kernel.busy()).toBe(true);
    release();
    const response = await running;
    expect(response.steps?.map((step) => step.method)).toContain("ask");
    // The built runtime keeps the same in-flight registry as the source: the run waits
    // for the call before it reports, and says nothing about it.
    expect(response.steps?.every((step) => step.error === undefined)).toBe(true);
  });

  it("renders a logged object in the built kernel too", { timeout: 30000 }, async () => {
    // The console patch lives at the top of the kernel bundle: a build that dropped it
    // would hand Output `util.inspect`'s depth-limited `[Object]` again.
    const root = await mkdtemp(join(tmpdir(), "dext-dist-kernel-"));
    roots.push(root);
    const kernel = new DextKernelHost({
      workspaceRoot: root,
      nodeExecPath: process.execPath,
      runnerDirectory: resolve("dist"),
      execute: async (invocation) => askResponse(invocation)
    });
    hosts.push(kernel);
    const response = await kernel.runSource('console.log({ nested: { deep: { deepest: true } } });\n');
    const stdout = response.steps?.filter((step) => step.stream?.channel === "stdout").map((step) => step.stream!.text).join("") ?? "";
    expect(stdout).not.toContain("[Object]");
    expect(stdout).toContain('"deepest": true');
  });
});
