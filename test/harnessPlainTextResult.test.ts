import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { DeepSeekHarnessRunner } from "../src/core/deepseekHarnessRunner.js";
import { DeepSeekHarnessTransport } from "../src/core/deepseekHarnessTransport.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import type { AgentStreamEvent } from "../src/core/types.js";

/** The `agent()` call a long `dev.plan` task-list turn makes, wired end to end
 * to a Harness that ignores the JSON envelope and answers in Markdown. This is
 * the regression that used to invalidate the whole 35-minute turn. */
const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

const fixture = resolve("test/fixtures/acpAgent.mjs");
const MARKDOWN_RESULT = [
  "[DEV_PLAN_TASKLIST] T1,T2,T4",
  "",
  "| ID | Task | Status |",
  "| --- | --- | --- |",
  "| T1 | Load rules | pending |"
].join("\n");

describe("Harness plain-text agent result", { timeout: 15000 }, () => {
  const runners: DeepSeekHarnessRunner[] = [];
  afterEach(async () => { await Promise.all(runners.splice(0).map((runner) => runner.dispose())); });

  it("continues the turn when the Harness answers an agent() call in Markdown", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    const harness = new DeepSeekHarnessRunner(15000,
      (_command, _args, cwd, client) => new DeepSeekHarnessTransport(process.execPath, [fixture], cwd, client));
    runners.push(harness);
    runtime.setAgentProfiles([{ id: "deepseek-harness", provider: "deepseek-harness", label: "DeepSeek Harness", command: process.execPath, models: [] }]);
    runtime.setAgentSelection({ profileId: "deepseek-harness" });
    runtime.setAgentRunner(harness);
    const events: AgentStreamEvent[] = [];

    const response = await runtime.execute({
      kind: "invocation",
      method: "agent",
      source: "code",
      arguments: [{ name: "input", value: "plain-markdown" }, { name: "apply", value: false }]
    }, [], { onAgentEvent: (event) => events.push(event) });

    expect(response.result).toEqual({ kind: "agent", text: MARKDOWN_RESULT });
    expect(events.some((event) => event.title?.includes("fell back to plain-text wrapping"))).toBe(true);
  });
});
