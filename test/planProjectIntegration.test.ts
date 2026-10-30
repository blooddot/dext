import { describe, expect, it, vi } from "vitest";
import { DextApplication } from "../src/app/application.js";
import { ProjectStore, projectContentHash } from "../src/features/project/host/persistence/projectStore.js";
import { ProjectPlanService } from "../src/features/project/host/projectPlanService.js";
import { ProjectPlanReconciler } from "../src/features/project/host/projectPlanReconcile.js";
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
    const context = port.bindPlan(await port.readPlanContext({ workspaceKey: process.cwd(), input: "API" }), "native.plan.md", "1. [ ] Implement API norms: api", { assessment, reason: "Checked normative contract", refs: ["api"], coverage: "complete" });
    expect(context.assessment).toBe(assessment);
    expect((await port.validatePlan(context, "1. [x] Implement API norms: api")).valid).toBe(true);
    model.nodes[0]!.body = { kind: "inline", text: "Changed interface during cancellation" };
    files.set(".dext/project/model.json", JSON.stringify(model));
    expect((await port.validatePlan(context, "1. [ ] Implement API norms: api")).valid).toBe(false);
    // A finished run may have rewritten the norms it read; only the Plan body matters at the end.
    expect((await port.validatePlan(context, "1. [ ] Implement API norms: api", { basis: false })).valid).toBe(true);
    expect((await port.validatePlan(context, "1. [ ] Other work", { basis: false })).valid).toBe(false);
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
  it.each(["change", "unknown", "conflict"] as const)("returns a pre-Build %s assessment for the caller to record or block", async assessment => {
    const app = Object.create(DextApplication.prototype) as DextApplication;
    const context = { workspaceKey: "virtual", planPath: "a.plan.md", documentHash: "", fileHash: "", availability: "ready" as const, assessment, reason: "Checked API", basis: [], reviewStatus: "pending" as const };
    Object.assign(app, {
      workspaceUri: { fsPath: "virtual" },
      projectPlanPort: {
        readPlanContext: async () => ({ availability: "ready", workspaceKey: "virtual", basis: [], grounding: "", diagnostics: [], omitted: [] }),
        bindPlan: () => context,
        validatePlan: async () => ({ valid: true, diagnostics: [] })
      },
      runtime: { executeConversation: async () => ({ result: { kind: "ask", text: JSON.stringify({ assessment, reason: "Checked API", refs: [], coverage: "complete" }) } }) }
    });
    const run = app.preparePlanBuild("a.plan.md", "# Plan", { ...context, assessment: "unknown" });
    await expect(run).resolves.toMatchObject({ assessment });
  });
  it("re-derives a stale assessment instead of blocking Build after the plan or the norms change", async () => {
    const app = Object.create(DextApplication.prototype) as DextApplication;
    const execute = vi.fn(async () => ({ result: { kind: "ask", text: JSON.stringify({ assessment: "change", reason: "Checked API", refs: [], coverage: "complete" }) } }));
    Object.assign(app, {
      workspaceUri: { fsPath: "virtual" },
      projectPlanPort: {
        readPlanContext: async () => ({ availability: "ready", workspaceKey: "virtual", basis: [], grounding: "", diagnostics: [], omitted: [] }),
        bindPlan: () => ({ workspaceKey: "virtual", planPath: "a.plan.md", documentHash: "new", fileHash: "new", availability: "ready", assessment: "change", reason: "Checked API", basis: [], reviewStatus: "pending" }),
        validatePlan: async () => ({ valid: false, diagnostics: ["Plan document changed; review the design before resuming."] })
      },
      runtime: { executeConversation: execute }
    });
    const stale = { workspaceKey: "virtual", planPath: "a.plan.md", documentHash: "old", fileHash: "old", availability: "ready" as const, assessment: "none" as const, reason: "", basis: [], reviewStatus: "current" as const };
    await expect(app.preparePlanBuild("a.plan.md", "# Plan", stale)).resolves.toMatchObject({ assessment: "change" });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("recovers a fenced answer and treats prose as unknown instead of failing Build", async () => {
    const app = Object.create(DextApplication.prototype) as DextApplication;
    const context = { workspaceKey: "virtual", planPath: "a.plan.md", documentHash: "", fileHash: "", availability: "ready", assessment: "unknown", reason: "Checked API", basis: [], reviewStatus: "pending" };
    let answer = "";
    Object.assign(app, {
      workspaceUri: { fsPath: "virtual" },
      projectPlanPort: {
        readPlanContext: async () => ({ availability: "ready", workspaceKey: "virtual", basis: [], grounding: "", diagnostics: [], omitted: [] }),
        bindPlan: (_read: unknown, _path: string, _document: string, impact?: { assessment: string }) => ({ ...context, assessment: impact?.assessment ?? "unknown" }),
        validatePlan: async () => ({ valid: true, diagnostics: [] })
      },
      runtime: { executeConversation: async () => ({ result: { kind: "ask", text: answer } }) }
    });
    answer = `Here is the assessment:\n\`\`\`json\n${JSON.stringify({ assessment: "change", reason: "Touches API", refs: [], coverage: "partial" })}\n\`\`\``;
    await expect(app.preparePlanBuild("a.plan.md", "# Plan")).resolves.toMatchObject({ assessment: "change" });
    answer = "**Assessment**: the plan changes the API.";
    await expect(app.preparePlanBuild("a.plan.md", "# Plan")).resolves.toMatchObject({ assessment: "unknown" });
  });
  it.each(["none", "change", "unknown", "conflict"] as const)("grounds %s in existing objects without creating native storage", async assessment => {
    const files = new Map([[".dext/objects/api.json", JSON.stringify({ id: "api", canonicalName: "Api", kind: "module", source: "user" })]]);
    const write = vi.fn(async () => {});
    const port = new ProjectPlanService(new ProjectStore({ readFile: async path => files.get(path), writeFile: write, listDirectory: async dir => dir === ".dext/objects" ? ["api.json"] : [] }), process.cwd());
    const read = await port.readPlanContext({ workspaceKey: process.cwd(), input: "Api" });
    const context = port.bindPlan(read, "a.plan.md", "# Existing plan\n1. [ ] Work norms: api", { assessment, reason: "Checked API", refs: ["api"], coverage: "complete" });
    expect(context.assessment).toBe(assessment); expect(write).not.toHaveBeenCalled();
    expect(files.has(".dext/project/model.json")).toBe(false);
  });
  it("applies a reviewed change unattended and keeps a guard failure pending", async () => {
    const model = projectModelSchema.parse({ schemaVersion: 1, revision: 2, updatedAt: 0, nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "old" } }], relations: [] });
    const files = new Map([[".dext/project/model.json", JSON.stringify(model)]]);
    const store = new ProjectStore({ readFile: async path => files.get(path), writeFile: async (path, value) => { files.set(path, value); }, listDirectory: async () => [] });
    const basis = [
      { locator: ".dext/project/model.json#/nodes/api", id: "api", hash: "h", kind: "object" as const },
      { locator: "project:applicability", id: "{}", hash: "h", kind: "applicability" as const }
    ];
    const report = (evidence: string) => ({ assessment: "change", reason: "Contract text changed", refs: ["api"], coverage: "complete",
      checks: [{ source: "agent_reported", description: "Compared the contract", status: "passed" }],
      projectDelta: [{ op: "update", target: "node", id: "api", beforeHash: projectContentHash(JSON.stringify(model.nodes[0])), after: { body: { kind: "inline", text: "new" } }, evidence: [evidence] }] });
    const app = Object.create(DextApplication.prototype) as DextApplication;
    fs.files.clear(); fs.files.set("virtual/a.plan.md", "# Plan\n1. [ ] Work norms: api");
    const remove = vi.fn(async () => {});
    Object.assign(app, {
      workspaceUri: { fsPath: "virtual" },
      planUri: () => ({ fsPath: "virtual/a.plan.md" }),
      projectReconciler: new ProjectPlanReconciler(store),
      projectChangeEvidence: { compare: async () => ({ evidenceId: "e", complete: true, diagnostics: [], changes: [{ path: "src/a.ts", kind: "modified" }], renameCandidates: [] }), remove },
      projectPlanPort: {
        readPlanContext: async () => ({ availability: "ready", workspaceKey: "virtual", basis, grounding: "", diagnostics: [], omitted: [] }),
        validatePlan: async () => ({ valid: true, diagnostics: [] })
      },
      runtime: { executeConversation: async () => ({ result: { kind: "ask", text: JSON.stringify(report(current)) } }) }
    });
    const context = { workspaceKey: "virtual", planPath: "a.plan.md", documentHash: "d", fileHash: "f", availability: "ready" as const, assessment: "change" as const, reason: "Anticipated", basis, reviewStatus: "pending" as const, evidenceId: "00000000-0000-4000-8000-000000000000" };
    let current = "src/a.ts";
    const applied = await app.finishPlanProject(context, "summary", new AbortController().signal);
    expect(applied).toMatchObject({ reviewStatus: "reconciled", evidenceId: undefined });
    expect(applied.receipts).toHaveLength(1);
    expect(files.get(".dext/project/model.json")).toContain("new");
    expect(remove).toHaveBeenCalledOnce();
    current = "src/b.ts";
    const pending = await app.finishPlanProject(context, "summary", new AbortController().signal);
    expect(pending.reviewStatus).toBe("pending");
    expect(pending.reason).toContain("src/b.ts");
  });
});
