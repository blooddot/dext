import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliAgentRunner } from "../src/features/agents/host/agentRunner.js";
import { DextRuntime } from "../src/features/workflow/host/runtime.js";
import { MethodRegistry } from "../src/features/workflow/domain/registry.js";
import { BUILTIN_METHODS } from "../src/features/workflow/domain/builtins.js";
import { ContextResolver } from "../src/features/workflow/host/contextResolver.js";
import { ProjectStore } from "../src/features/project/host/persistence/projectStore.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { ProjectPlanService } from "../src/features/project/host/projectPlanService.js";
import { ProjectChangeEvidence } from "../src/features/project/host/projectChangeEvidence.js";
import { projectImpactSchema } from "../src/shared/contracts/planProject.js";
import { execFileSync } from "node:child_process";

// Opt-in: uses the installed Codex login, and writes only an owned temporary fixture.
describe.skipIf(!process.env.DEXT_TEST_PROJECT_CODEX)("live Project-aware Plan", { timeout: 180_000 }, () => {
  let directory: string; let root: string; let runtime: DextRuntime; let port: ProjectPlanService;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dext-plan-live-")); root = join(directory, "repo"); await mkdir(root);
    execFileSync("git", ["init", "--quiet", root]);
    const registry = new MethodRegistry(); registry.registerMany(BUILTIN_METHODS, "builtin");
    runtime = new DextRuntime(registry, new ContextResolver({ selection: async () => undefined, activeFile: async () => undefined,
      file: async path => ({ uri: path, content: await readFile(join(root, path), "utf8"), version: 1 }), symbol: async () => undefined,
      dir: async path => ({ kind: "dirRef", uri: path, path }) }));
    runtime.setWorkspaceRoot(root); runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", provider: "codex", label: "Codex", command: process.env.DEXT_TEST_PROJECT_CODEX!, models: [] }]);
    runtime.setAgentSelection({ profileId: "codex", ...(process.env.DEXT_TEST_PROJECT_MODEL ? { model: process.env.DEXT_TEST_PROJECT_MODEL } : {}) });
    runtime.setAgentRunner(new CliAgentRunner(170_000));
    const store = new ProjectStore({ readFile: async path => { try { return await readFile(join(root, path), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
      writeFile: async (path, content) => { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); },
      listDirectory: async path => { try { return await readdir(join(root, path)); } catch { return []; } } });
    await store.updateProject(projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0,
      nodes: [{ id: "api", title: "Greeting API", canonicalName: "GreetingAPI", kind: "contract", paths: ["api.ts"], review: "accepted", freshness: "current", body: { kind: "inline", text: "greet(name: string) returns a string. The result is exactly Hello followed by one space then the name. An empty name returns Hello followed by one space. This public return type and behavior are normative." } }], relations: [] }), null);
    await writeFile(join(root, "api.ts"), 'export const greet = (name: string): string => "Hello " + name;\n');
    port = new ProjectPlanService(store, root); runtime.setProjectPlanPort(port);
  });
  afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  it.each([
    ["none", "Add a test for greet with an empty name; preserve the existing public contract and implementation."],
    ["change", "Change greet to return an object with a message string instead of a string. Update the public GreetingAPI norm accordingly."]
  ] as const)("grounds a real Plan as %s", async (assessment, input) => {
    const before = await readFile(join(root, ".dext/project/model.json"), "utf8");
    const result = await runtime.executeConversation("plan", `${input}\nThis is an integration fixture: inspect only this workspace, do not delegate, do not write files. Include the required dext-project-impact summary referencing api.`, { signal: AbortSignal.timeout(175_000) });
    expect(result.result).toMatchObject({ kind: "plan", projectContext: { availability: "ready", assessment } });
    expect(await readFile(join(root, ".dext/project/model.json"), "utf8")).toBe(before);
  });
  it("reassesses an actual interface change even when the expected impact was none", async () => {
    const evidence = new ProjectChangeEvidence(root, join(directory, "evidence")); const baseline = await evidence.capture();
    await writeFile(join(root, "api.ts"), 'export const greet = (name: string) => ({ message: "Hello " + name });\n');
    const changes = await evidence.compare(baseline.id); expect(changes.complete).toBe(true);
    const grounding = await port.readPlanContext({ workspaceKey: root, input: "GreetingAPI", paths: ["api.ts"] });
    const result = await runtime.executeConversation("ask", `Read-only final impact review. The earlier plan expected none; actual content changes follow. Compare responsibilities, public interface and behavior with these maintained norms. Reply only JSON with assessment (none/change/unknown/conflict), reason, refs (norm IDs), coverage (complete/partial/unknown). Do not delegate or write.\n${JSON.stringify({ grounding, changes })}`, { signal: AbortSignal.timeout(175_000) });
    expect(result.result.kind).toBe("ask");
    if (result.result.kind !== "ask") throw new Error("Unexpected result");
    const report = projectImpactSchema.parse(JSON.parse(result.result.text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()));
    // An unapproved implementation change may be a proposed norm change or a contract conflict.
    expect(["change", "conflict"]).toContain(report.assessment); expect(report.refs).toContain("api");
  });
});
