import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InvocationAst, RuntimeResponse } from "../src/core/types.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import { CHANGED_SINCE_STOPPED, type DextReplayEntry, stableStringify } from "../src/runner/dextResumeCache.js";

const runnerDirectory = resolve("src", "runner");

const roots: string[] = [];
const hosts: DextKernelHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) host.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-resume-"));
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

function host(root: string, execute: (invocation: InvocationAst) => Promise<RuntimeResponse>): DextKernelHost {
  const instance = new DextKernelHost({ workspaceRoot: root, nodeExecPath: process.execPath, runnerDirectory, execute });
  hosts.push(instance);
  return instance;
}

const TWO_ASKS = [
  "import { ask } from \"dext\";",
  "const first = await ask({ input: \"one\" });",
  "const second = await ask({ input: \"two\" });",
  "console.log(first.text + second.text);",
  ""
].join("\n");

describe("Dext run replay", () => {
  it("replays recorded calls instead of running them again", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "run.ts", TWO_ASKS);
    let calls = 0;
    const first = host(root, async (invocation) => {
      calls += 1;
      return askResponse(invocation);
    });
    let recorded: readonly DextReplayEntry[] = [];
    const attempt = await first.run(file, { onCallLog: (entries) => { recorded = entries; } });
    expect(calls).toBe(2);
    expect(attempt.steps?.map((step) => step.method)).toEqual(["ask", "ask", "stdout"]);
    expect(recorded.map((entry) => entry.method)).toEqual(["ask", "ask"]);

    // The retry replays both calls: the executor must not run again.
    const second = host(root, async (invocation) => {
      calls += 1;
      return askResponse(invocation);
    });
    const replayed = await second.run(file, { resume: recorded });
    expect(calls).toBe(2);
    expect(replayed.steps?.map((step) => step.method)).toEqual(["ask", "ask", "stdout"]);
    expect(replayed.steps?.[0]?.response?.result).toEqual({ kind: "ask", text: "one" });
    expect(replayed.steps?.at(-1)?.stream?.text).toBe("onetwo\n");
    expect(replayed.executions).toHaveLength(2);
  });

  it("refuses to reuse a recorded response when the calls no longer line up", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "run.ts", TWO_ASKS);
    const recorded: DextReplayEntry[] = [
      { method: "ask", arguments: { input: "different" }, response: { result: { kind: "ask", text: "different" } } }
    ];
    let calls = 0;
    const kernel = host(root, async (invocation) => {
      calls += 1;
      return askResponse(invocation);
    });
    await expect(kernel.run(file, { resume: recorded })).rejects.toThrow(CHANGED_SINCE_STOPPED);
    expect(calls).toBe(0);
  });

  it("refuses to reuse a response a different call produced", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "run.ts", TWO_ASKS);
    const recorded: DextReplayEntry[] = [
      { method: "terminal", arguments: { command: "ls" }, response: { result: { kind: "ask", text: "one" } } }
    ];
    const kernel = host(root, async (invocation) => askResponse(invocation));
    await expect(kernel.run(file, { resume: recorded })).rejects.toThrow("recorded calls no longer line up");
  });

  it("stops on a non-deterministic divergence instead of reusing the wrong answer", { timeout: 30000 }, async () => {
    const root = await workspace();
    // The argument depends on a value the recording cannot see (a file read
    // outside the API boundary), so the retry asks a different question than the
    // recorded one.
    await writeFile(join(root, "choice.txt"), "heads", "utf8");
    const file = await fixture(root, "divergent.ts", [
      "import { ask } from \"dext\";",
      "import { readFileSync } from \"node:fs\";",
      "const choice = readFileSync(new URL(\"./choice.txt\", import.meta.url), \"utf8\").trim();",
      "const value = await ask({ input: choice });",
      "console.log(value.text);",
      ""
    ].join("\n"));
    let recorded: readonly DextReplayEntry[] = [];
    const first = host(root, async (invocation) => askResponse(invocation));
    await first.run(file, { onCallLog: (entries) => { recorded = entries; } });
    expect(recorded.map((entry) => entry.arguments)).toEqual([{ input: "heads" }]);

    await writeFile(join(root, "choice.txt"), "tails", "utf8");
    const second = host(root, async (invocation) => askResponse(invocation));
    await expect(second.run(file, { resume: recorded })).rejects.toThrow(CHANGED_SINCE_STOPPED);
  });

  it("does not let stream steps consume recorded calls", { timeout: 30000 }, async () => {
    const root = await workspace();
    const file = await fixture(root, "streams.ts", [
      "import { ask } from \"dext\";",
      "console.log(\"before\");",
      "const answer = await ask({ input: \"one\" });",
      "console.error(\"after\");",
      "console.log(answer.text);",
      ""
    ].join("\n"));
    const recorded: DextReplayEntry[] = [
      { method: "ask", arguments: { input: "one" }, response: { result: { kind: "ask", text: "one" } } }
    ];
    let calls = 0;
    const kernel = host(root, async (invocation) => {
      calls += 1;
      return askResponse(invocation);
    });
    const response = await kernel.run(file, { resume: recorded });
    expect(calls).toBe(0);
    // Streams are flushed stdout-then-stderr before the call's own step, so the
    // recorded call stays aligned with the second `ask`.
    expect(response.steps?.map((step) => step.method)).toEqual(["stdout", "ask", "stdout", "stderr"]);
    expect(response.steps?.filter((step) => step.method === "ask")).toHaveLength(1);
  });

  it("fingerprints arguments independently of key order", () => {
    expect(stableStringify({ a: 1, b: [{ c: 2 }] })).toBe(stableStringify({ b: [{ c: 2 }], a: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});
