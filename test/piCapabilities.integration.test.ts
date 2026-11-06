import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DextApplication } from "../src/app/application.js";
import { PiAgentRunner } from "../src/features/agents/host/piAgentRunner.js";
import { PiRpcTransport } from "../src/features/agents/host/piRpcTransport.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { ContextResolver } from "../src/features/workflow/host/contextResolver.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { DextRuntime } from "../src/features/workflow/host/runtime.js";
import { parseMcpManifest } from "../src/features/mcp/domain/mcpManifest.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import type { AgentStreamEvent, ExecutionMetadata } from "../src/shared/contracts/types.js";

vi.mock("vscode", () => ({ Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }) }, workspace: { workspaceFolders: undefined } }));

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dext-pi-capabilities-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 }));
  const logPath = join(root, "protocol.jsonl");
  const runner = new PiAgentRunner({ extensionPath: resolve("media/pi-extension.mjs"), sessionDirectory: join(root, "sessions"), versionProbe: async () => {},
    transportFactory: (_command, args, cwd, env) => new PiRpcTransport(process.execPath, [resolve("test/fixtures/piAgent.mjs"), ...args], cwd, { ...env, PI_FIXTURE_LOG: logPath }) });
  cleanup.push(() => runner.dispose());
  const registry = new MethodRegistry(); registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver({ selection: async () => undefined, activeFile: async () => undefined, file: async () => undefined, symbol: async () => undefined, dir: async () => undefined }));
  runtime.setWorkspaceRoot(root); runtime.setWorkspaceTrusted(true);
  runtime.setAgentProfiles([{ id: "pi", provider: "pi", label: "Pi", command: process.execPath, models: [], writablePermissions: ["full-access"] }]);
  runtime.setAgentSelection({ profileId: "pi", permission: "full-access" }); runtime.setAgentRunner(runner);
  const log = async (): Promise<Record<string, unknown>[]> => (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const call = (method: string, args: Record<string, unknown> = {}, metadata: ExecutionMetadata = {}) => runtime.execute({ kind: "invocation", source: "code", method,
    arguments: Object.entries(args).map(([name, value]) => ({ name, value: value as never })) }, [], metadata);
  return { root, runtime, registry, call, log };
}

describe("Pi with the actual Dext host modules", { timeout: 30000 }, () => {
  it("generates resource drafts and imports through the existing text fallback without saving files", async () => {
    const h = await setup();
    const application = Object.create(DextApplication.prototype) as DextApplication;
    Object.assign(application, { runtime: h.runtime, workspaceTrusted: true, storage: { globalStorageUri: { fsPath: h.root }, attachmentPrompt: (input: string) => input },
      agents: { currentSelection: () => ({ profileId: "pi" }), list: () => [{ id: "pi", provider: "pi" }] } });
    const result = await application.draftResource({ type: "rule", scope: "global" }, "PI_RESOURCE_SMOKE", { agent: "pi" });
    expect(result.draft).toEqual({ name: "review", content: "# Review\nUse evidence." });
    expect(result.response.executions[0]?.result).toMatchObject({ kind: "ask", text: expect.stringContaining("Use evidence.") });
    const analyze = (application as unknown as { skillImportAnalyzer(metadata: ExecutionMetadata): (request: unknown) => Promise<unknown> }).skillImportAnalyzer({ agent: "pi" });
    expect(await analyze({ repository: "https://github.com/acme/PI_IMPORT_SMOKE", sourceUrl: "https://github.com/acme/PI_IMPORT_SMOKE", candidates: [{ directory: "skills/review", id: "review", fileCount: 1, shallow: "ok" }] })).toMatchObject({ packName: "review-pack", skillDirectories: ["skills/review"] });
    const startup = (await h.log()).filter((record) => record.startup);
    expect(startup.every((record) => (record.startup as string[]).includes("--no-mcp"))).toBe(true);
    await expect(readFile(join(h.root, "rules", "review.md"))).rejects.toThrow();
  });
  it("runs Code UI, MCP, Rule/Skill, preview and result cleanup through the real kernel", { timeout: 30000 }, async () => {
    const h = await setup();
    h.runtime.setRuleLoader(async () => "PI_RULE_SENTINEL");
    h.runtime.setSkillLoader(async (id) => ({ sourcePath: `/skills/${id}/SKILL.md`, instructions: "PI_SKILL_SENTINEL" }));
    const mcp = parseMcpManifest(JSON.stringify({ name: "team", transport: "stdio", command: "not-started-by-this-test", tools: [{ name: "query", inputSchema: { type: "object", properties: {} } }] }), "team.jsonc");
    expect(mcp.diagnostics).toEqual([]); h.registry.registerMany(mcp.methods, "project");
    let mcpCalls = 0, forms = 0;
    h.runtime.setMcpCaller(async () => { mcpCalls++; return { kind: "mcpRaw", server: "team", tool: "query", content: "MCP_SENTINEL" }; });
    const kernel = new DextKernelHost({ workspaceRoot: h.root, runnerDirectory: resolve("src/runner"), nodeExecPath: process.execPath, execute: (invocation, metadata) => h.runtime.execute(invocation, [], metadata) });
    cleanup.push(async () => { kernel.dispose(); });
    const response = await kernel.runSource([
      'import { ui, mcp, ask, agent, skill, apply } from "dext";',
      'await ui.form({ title: "Pi Code form", fields: [] });',
      'console.log((await mcp.team.query()).content);',
      'console.log((await ask({ input: "review", cli: "pi", skills: ["review"], rules: ["base.md"] })).text);',
      'const preview = await agent({ input: "preview", cli: "pi", apply: false, patch: false });',
      'console.log((await apply({ result: preview })).status);',
      'console.log((await skill({ input: "run", skill: "review", cli: "pi" })).text);'
    ].join("\n"), { execution: { ui: { form: async () => { forms++; return { kind: "ui", type: "form", status: "submitted", answers: {} }; } } } });
    expect(forms).toBe(1); expect(mcpCalls).toBe(1);
    const stdout = response.steps?.flatMap((step) => step.stream?.channel === "stdout" ? [step.stream.text] : []).join("");
    expect(stdout).toContain("MCP_SENTINEL"); expect(stdout).toContain("fixture answer"); expect(stdout).toContain("unchanged");
    const log = await h.log(), prompts = log.filter((record) => record.command === "prompt");
    expect(prompts).toHaveLength(3);
    expect(String(prompts[0]?.message)).toContain("PI_RULE_SENTINEL"); expect(String(prompts[0]?.message)).toContain("PI_SKILL_SENTINEL");
    expect(String(prompts[1]?.message)).toContain("Do not include a patch");
    expect(log.filter((record) => record.startup).every((record) => (record.startup as string[]).includes("--no-session"))).toBe(true);
    expect(log.filter((record) => record.accepted)).toHaveLength(3);
  });

  it("enforces write and trust gates independently of the selected permission and ignores a provider task list", async () => {
    const h = await setup(), events: AgentStreamEvent[] = [];
    await h.runtime.executeConversation("plan", "outline", { onAgentEvent: (event) => events.push(event), agentSessionId: "plan" });
    let log = await h.log();
    expect(String(log.find((record) => record.command === "prompt")?.message)).toContain("dext-plan:start");
    expect(log[0]?.startup).toContain("--no-mcp"); expect(log[0]?.startup).not.toContain("--no-context-files");
    h.runtime.setAgentSelection({ profileId: "pi", permission: "workspace-write" });
    await expect(h.runtime.executeConversation("agent", "write")).rejects.toThrow("Explicitly select Full access");
    h.runtime.setAgentSelection({ profileId: "pi", permission: "full-access" });
    await h.runtime.executeConversation("plan", "fixture:todo", { executePlan: true, onAgentEvent: (event) => events.push(event) });
    // Only plan progress drives the Todo panel; a provider's own list is dropped.
    expect(events.some((event) => event.phase === "todo")).toBe(false);
    log = await h.log(); expect(log.filter((record) => record.startup).at(-1)?.startup).toContain("builtin:mcp");
    h.runtime.setWorkspaceTrusted(false);
    await expect(h.call("agent", { input: "write" })).rejects.toThrow("trusted");
    await h.runtime.executeConversation("ask", "explain");
    expect((await h.log()).filter((record) => record.startup).at(-1)?.startup).toContain("--no-context-files");
  });

  it("renders template contracts using host structure and preserves declared values", async () => {
    const h = await setup(); await mkdir(join(h.root, "templates"));
    await writeFile(join(h.root, "templates", "review.md"), '---\ndext-template:\n  format: markdown\n  title:\n    type: string\n    description: Heading\n---\n# {{title}}\n\nHost body\n');
    const result = await h.call("template", { input: "review", source: "templates/review.md", cli: "pi" });
    expect(result.result).toMatchObject({ kind: "template", text: "# fixture answer\n\nHost body\n" });
    expect(String((await h.log()).find((record) => record.command === "prompt")?.message)).toContain("title");
  });
});
