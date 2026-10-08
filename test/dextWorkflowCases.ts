import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { InvocationAst, RuntimeResponse } from "../src/core/types.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import type { DextReplayEntry } from "../src/runner/dextResumeCache.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(invocation: InvocationAst): RuntimeResponse {
  const input = invocation.arguments.find((arg) => arg.name === "input")?.value;
  return {
    invocation,
    method: { id: invocation.method, title: invocation.method, kind: "command", source: "builtin" },
    result: invocation.method === "ui.form"
      ? { kind: "ui", type: "form", status: "submitted", answers: {} }
      : { kind: "ask", text: typeof input === "string" ? input : "" },
    durationMs: 0
  };
}

/** Same behavioral contract for src and dist: catches separate runtime registries. */
export function workflowCases(runnerDirectory: string): void {
  describe("imported workflow lifetime", () => {
    const roots: string[] = [];
    const hosts: DextKernelHost[] = [];
    afterEach(async () => {
      for (const host of hosts.splice(0)) host.dispose();
      for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    async function setup(source: string, execute: (invocation: InvocationAst) => Promise<RuntimeResponse> = async (call) => response(call), maxConcurrency = 4) {
      const root = await mkdtemp(join(tmpdir(), "dext-workflow-"));
      roots.push(root);
      const api = join(root, ".dext", "api");
      await mkdir(api, { recursive: true });
      await writeFile(join(api, "fix.ts"), source);
      const kernel = new DextKernelHost({ workspaceRoot: root, runnerDirectory, execute, maxConcurrency });
      hosts.push(kernel);
      return { root, api, kernel };
    }

    it.each(["fix();", "await fix();", "export async function main() { await fix(); }"])(
      "waits across timers, native file IO and a held form: %s", { timeout: 30000 }, async (entry) => {
        const form = deferred();
        const answer = deferred();
        const { root, kernel } = await setup(`
          import { ask, ui } from "dext";
          import { setTimeout as delay } from "node:timers/promises";
          import { writeFile, readFile } from "node:fs/promises";
          export async function fix() {
            await ask({ input: "scope" });
            await delay(80);
            await writeFile("knowledge.txt", "root cause");
            const title = await readFile("knowledge.txt", "utf8");
            await ui.form({ title, fields: [] });
            await delay(30);
            await ask({ input: "complete" });
          }
        `, async (call) => {
          if (call.method === "ui.form") { form.resolve(); await answer.promise; }
          return response(call);
        });
        const running = kernel.runSource(`import { fix } from "dext/api/fix"; ${entry}`);
        // Race against completion so a premature runDone fails immediately.
        expect(await Promise.race([form.promise.then(() => "form"), running.then(() => "done")])).toBe("form");
        expect(kernel.busy()).toBe(true);
        expect(await readFile(join(root, "knowledge.txt"), "utf8")).toBe("root cause");
        answer.resolve();
        const result = await running;
        expect(result.steps?.map((step) => step.method)).toEqual(["ask", "ui.form", "ask"]);
      }
    );

    it.each(["throw new Error('workflow broke')", "throw undefined"])(
      "reports native workflow rejection and resets on the next run: %s", { timeout: 30000 }, async (failure) => {
        const { kernel } = await setup(`
          import { setTimeout as delay } from "node:timers/promises";
          export async function fix() { await delay(40); ${failure}; }
        `);
        await expect(kernel.runSource('import { fix } from "dext/api/fix"; fix();'))
          .rejects.toThrow(failure.includes("undefined") ? "undefined" : "workflow broke");
        const result = await kernel.runSource('import { ask } from "dext"; await ask({ input: "fresh" });');
        expect(result.steps?.map((step) => step.method)).toEqual(["ask"]);
      }
    );

    it("supports named aliases, default/namespace imports, reexports and concurrent calls", { timeout: 30000 }, async () => {
      const started = deferred();
      const release = deferred();
      let count = 0;
      const { api, kernel } = await setup(`
        import { ask } from "dext";
        import { setTimeout as delay } from "node:timers/promises";
        export async function fix(input: string) { await delay(20); return ask({ input }); }
        export default fix;
        export function sync() { return 42; }
      `, async (call) => {
        if (++count === 3) started.resolve();
        await release.promise;
        return response(call);
      });
      await writeFile(join(api, "barrel.ts"), 'export { fix as renamed, default, sync } from "./fix.ts";');
      const running = kernel.runSource(`
        import def, { renamed as named, sync } from "dext/api/barrel";
        import * as api from "dext/api/barrel";
        console.log(sync());
        const result = await Promise.all([def("one"), named("two"), api["renamed"]("three")]);
        console.log(result.map(item => item.text).join(","));
      `);
      expect(await Promise.race([started.promise.then(() => "parallel"), running.then(() => "done")])).toBe("parallel");
      release.resolve();
      const result = await running;
      expect(result.steps?.filter((step) => step.method === "ask")).toHaveLength(3);
      expect(result.steps?.at(-1)?.stream?.text).toBe("one,two,three\n");
    });

    it.each([
      'import { fix as go } from "dext/api/fix"; go();',
      'import go from "dext/api/barrel"; go?.();',
      'import * as api from "dext/api/barrel"; api["fix"]();'
    ])("tracks floating import forms: %s", { timeout: 30000 }, async (source) => {
      const { api, kernel } = await setup(`
        import { ask } from "dext";
        import { setTimeout as delay } from "node:timers/promises";
        export async function fix() { await delay(30); await ask({ input: "done" }); }
        export default fix;
      `);
      await writeFile(join(api, "barrel.ts"), 'export { default } from "./fix.ts"; export * from "./fix.ts";');
      const result = await kernel.runSource(source);
      expect(result.steps?.map((step) => step.method)).toEqual(["ask"]);
    });

    it("preserves caught rejections and Promise.all/Promise.race semantics", { timeout: 30000 }, async () => {
      const { kernel } = await setup(`
        import { setTimeout as delay } from "node:timers/promises";
        export async function fix() { await delay(30); throw new Error("expected"); }
      `);
      const result = await kernel.runSource(`
        import { fix } from "dext/api/fix";
        try { await fix(); } catch { console.log("caught"); }
        await Promise.all([fix(), fix()]).catch(() => console.log("all caught"));
        await Promise.race([Promise.resolve("winner"), fix()]);
        console.log("race finished");
      `);
      const output = result.steps?.map((step) => step.stream?.text ?? "").join("");
      expect(output).toContain("caught\n");
      expect(output).toContain("all caught\n");
      expect(output).toContain("race finished\n");
      expect(output).not.toContain("Unhandled rejection");
    });

    it("preserves namespace receivers, optional chains, live imports and awaited arguments", { timeout: 30000 }, async () => {
      const { kernel } = await setup(`
        export const absent = undefined;
        export let value = 1;
        export function increment() { value++; }
        export function receiver() { return this.value; }
        export async function fix(value: number) { return value; }
      `);
      const result = await kernel.runSource(`
        import { absent, fix, increment, value } from "dext/api/fix";
        import * as api from "dext/api/fix";
        const __dextTrackWorkflow = "collision";
        console.log(absent?.().property);
        increment();
        console.log(api.receiver(), value, __dextTrackWorkflow);
        console.log(await fix(await Promise.resolve(7)));
      `);
      const output = result.steps?.map((step) => step.stream?.text ?? "").join("");
      expect(output).toBe("undefined\n2 2 collision\n7\n");
    });

    it("reports immediate and chained unhandled workflow failures", { timeout: 30000 }, async () => {
      const { kernel } = await setup('export async function fix() { throw new Error("immediate"); }');
      await expect(kernel.runSource('import { fix } from "dext/api/fix"; fix();')).rejects.toThrow("immediate");
      await expect(kernel.runSource('import { fix } from "dext/api/fix"; fix().then(() => {});')).rejects.toThrow("immediate");
    });

    it("keeps external configured API modules fresh across consecutive runs", { timeout: 30000 }, async () => {
      const { kernel } = await setup("");
      const external = await mkdtemp(join(tmpdir(), "dext-shared-api-"));
      roots.push(external);
      await writeFile(join(external, "fix.ts"), `
        import { ask } from "dext";
        import { setTimeout as delay } from "node:timers/promises";
        let count = 0;
        export async function fix() { await delay(20); await ask({ input: String(++count) }); }
      `);
      for (let run = 0; run < 2; run++) {
        const result = await kernel.runSource('import { fix } from "dext/api/fix"; fix();', { apiRoots: [external] });
        expect(result.executions[0]?.result).toEqual({ kind: "ask", text: "1" });
      }
    });

    it("does not wait for shadowed functions or unrelated background tasks", { timeout: 30000 }, async () => {
      const { kernel } = await setup('export function fix() { return 42; }');
      const result = await kernel.runSource(`
        import { fix } from "dext/api/fix";
        console.log(fix());
        function local(fix: () => Promise<void>) { fix(); }
        local(() => new Promise(() => {}));
        new Promise(() => {});
      `);
      expect(result.steps?.at(-1)?.stream?.text).toBe("42\n");
    });

    it("ignores old background output and refuses its API calls during a new run", { timeout: 30000 }, async () => {
      const calls: string[] = [];
      const { kernel } = await setup("", async (call) => {
        calls.push(call.method);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return response(call);
      });
      await kernel.runSource(`
        import { ask } from "dext";
        setTimeout(async () => { console.log("stale"); await ask({ input: "stale" }); }, 80);
      `);
      const result = await kernel.runSource('import { ui } from "dext"; await ui.form({ title: "new", fields: [] });');
      expect(calls).toEqual(["ui.form"]);
      expect(result.steps?.map((step) => step.method)).toEqual(["ui.form"]);
    });

    it("cancels during a native async gap and starts a clean next run", { timeout: 30000 }, async () => {
      const scope = deferred();
      const calls: string[] = [];
      const { kernel } = await setup(`
        import { ask, ui } from "dext";
        export async function fix() {
          await ask({ input: "scope" });
          await new Promise(() => {});
          await ui.form({ title: "old form", fields: [] });
        }
      `, async (call) => { calls.push(call.method); scope.resolve(); return response(call); });
      const controller = new AbortController();
      const running = kernel.runSource('import { fix } from "dext/api/fix"; fix();', { signal: controller.signal });
      const cancelled = expect(running).rejects.toBeInstanceOf(ExecutionCancelledError);
      await scope.promise;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(kernel.busy()).toBe(true);
      controller.abort();
      await cancelled;
      await kernel.runSource('import { ask } from "dext"; await ask({ input: "next" });');
      expect(calls).toEqual(["ask", "ask"]);
    });

    it("isolates late replies, queued calls and replay logs after cancellation", { timeout: 30000 }, async () => {
      const oldStarted = deferred();
      const newStarted = deferred();
      const oldAnswer = deferred();
      const newAnswer = deferred();
      const calls: string[] = [];
      const { kernel } = await setup(`
        import { ui, ask } from "dext";
        export async function fix() {
          await Promise.all([
            ui.form({ title: "old", fields: [] }),
            ask({ input: "old queued" })
          ]);
          await ask({ input: "old continuation" });
        }
      `, async (call) => {
        calls.push(call.method);
        if (call.method === "ui.form") { oldStarted.resolve(); await oldAnswer.promise; }
        else { newStarted.resolve(); await newAnswer.promise; }
        return response(call);
      }, 1);
      const controller = new AbortController();
      const running = kernel.runSource('import { fix } from "dext/api/fix"; fix();', { signal: controller.signal });
      const cancelled = expect(running).rejects.toBeInstanceOf(ExecutionCancelledError);
      await oldStarted.promise;
      controller.abort();
      await cancelled;
      let log: readonly DextReplayEntry[] = [];
      const next = kernel.runSource('import { ask } from "dext"; await ask({ input: "new" });', { onCallLog: (entries) => { log = entries; } });
      await newStarted.promise; // Old host execution must not occupy the new queue.
      oldAnswer.resolve(); // Request id 1 in both children: must not answer the new ask.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(kernel.busy()).toBe(true);
      expect(calls).toEqual(["ui.form", "ask"]);
      newAnswer.resolve();
      const result = await next;
      expect(result.steps?.map((step) => step.method)).toEqual(["ask"]);
      expect(result.executions[0]?.result).toEqual({ kind: "ask", text: "new" });
      expect(log.map((entry) => entry.method)).toEqual(["ask"]);
    });
  });
}
