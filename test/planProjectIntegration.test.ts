import { describe, expect, it, vi } from "vitest";
import { DextApplication } from "../src/app/application.js";
import { ProjectStore } from "../src/features/project/host/persistence/projectStore.js";
import { ProjectPlanService } from "../src/features/project/host/projectPlanService.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";

const fs = vi.hoisted(() => ({ files: new Map<string, string>(), write: vi.fn() }));
vi.mock("vscode", () => ({
  Uri: { file: (path: string) => ({ scheme: "file", fsPath: path, toString: () => path }), joinPath: (root: { fsPath: string }, ...parts: string[]) => ({ fsPath: [root.fsPath, ...parts].join("/") }) },
  workspace: { workspaceFolders: undefined, isTrusted: true, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), fs: {
    stat: async () => ({}), createDirectory: async () => {},
    readFile: async (uri: { fsPath: string }) => new TextEncoder().encode(fs.files.get(uri.fsPath) ?? ""),
    writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => { fs.write(uri.fsPath); fs.files.set(uri.fsPath, new TextDecoder().decode(bytes)); }
  } },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: async () => {} },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} }
}));

describe("Plan Project integration without migration", () => {
  it.each(["none", "change", "unknown", "conflict"] as const)("uses the same port on native models: %s", async assessment => {
    const model = projectModelSchema.parse({ schemaVersion: 1, revision: 4, updatedAt: 0, nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "Existing interface" }, review: "accepted" }], relations: [] });
    const files = new Map([[".dext/project/model.json", JSON.stringify(model)], [".dext/project-intent.json", "obsolete invalid data"]]);
    const write = vi.fn(async () => {});
    const port = new ProjectPlanService(new ProjectStore({ readFile: async path => files.get(path), writeFile: write, listDirectory: async () => [] }), process.cwd());
    const context = port.bindPlan(await port.readPlanContext({ workspaceKey: process.cwd(), input: "API" }), "native.plan.md", "1. [ ] Implement API", { assessment, reason: "Checked normative contract", refs: ["api"], coverage: "complete" });
    expect(context.assessment).toBe(assessment);
    expect((await port.validatePlan(context, "1. [x] Implement API")).valid).toBe(true);
    model.nodes[0]!.body = { kind: "inline", text: "Changed interface during cancellation" };
    files.set(".dext/project/model.json", JSON.stringify(model));
    expect((await port.validatePlan(context, "1. [ ] Implement API")).valid).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("does not create a model for an empty workspace", async () => {
    const write = vi.fn(async () => {});
    const port = new ProjectPlanService(new ProjectStore({ readFile: async () => undefined, writeFile: write, listDirectory: async () => [] }), process.cwd());
    expect((await port.readPlanContext({ workspaceKey: process.cwd(), input: "New feature" })).availability).toBe("absent");
    expect(write).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves external plan edits during revision: concurrent=%s", async concurrent => {
    fs.files.clear(); fs.write.mockClear(); fs.files.set("virtual/a.plan.md", "# Original\n");
    const app = Object.create(DextApplication.prototype) as DextApplication;
    Object.assign(app, {
      workspaceTrusted: true, workspaceUri: { fsPath: "virtual" },
      storage: { attachmentPrompt: (input: string) => input, location: () => "workspace" },
      planUri: () => ({ fsPath: "virtual/a.plan.md" }),
      runtime: { executeConversation: async () => {
        if (concurrent) fs.files.set("virtual/a.plan.md", "# External edit\n");
        return { method: { id: "plan" }, result: { kind: "plan", text: "Revised\n<!-- dext-plan:start -->\n# Revised\n<!-- dext-plan:end -->" } };
      } }
    });
    const run = app.executeConversation("plan", "Revise", { planPath: "a.plan.md" });
    if (concurrent) {
      await expect(run).rejects.toThrow("external edits were preserved");
      expect(fs.files.get("virtual/a.plan.md")).toBe("# External edit\n"); expect(fs.write).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toMatchObject({ executions: [{ result: { planPath: "a.plan.md" } }] });
      expect(fs.files.get("virtual/a.plan.md")).toBe("# Revised\n");
    }
  });
  it.each(["none", "change", "unknown", "conflict"] as const)("grounds %s in existing objects without creating native storage", async assessment => {
    const files = new Map([[".dext/objects/api.json", JSON.stringify({ id: "api", canonicalName: "Api", kind: "module", source: "user" })]]);
    const write = vi.fn(async () => {});
    const port = new ProjectPlanService(new ProjectStore({ readFile: async path => files.get(path), writeFile: write, listDirectory: async dir => dir === ".dext/objects" ? ["api.json"] : [] }), process.cwd());
    const read = await port.readPlanContext({ workspaceKey: process.cwd(), input: "Api" });
    const context = port.bindPlan(read, "a.plan.md", "# Existing plan", { assessment, reason: "Checked API", refs: ["api"], coverage: "complete" });
    expect(context.assessment).toBe(assessment); expect(write).not.toHaveBeenCalled();
    expect(files.has(".dext/project/model.json")).toBe(false);
  });
});
