import { describe, expect, it, vi } from "vitest";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { validateProjectModel } from "../src/features/project/knowledge/projectModel.js";
import { bootstrapProject, detectProjectBootstrap, readBootstrapCheckpoint } from "../src/features/project/host/projectBootstrap.js";
import type { StructureSummary } from "../src/features/project/host/indexing/projectStructure.js";
import type { ProjectAiRequest } from "../src/features/project/host/generation/projectAiGeneration.js";
import { ProjectStore, projectContentHash, type ProjectFileHost } from "../src/features/project/host/persistence/projectStore.js";

function fixture(entries: Array<[string, string]> = []) {
  const files = new Map(entries);
  const host: ProjectFileHost = { readFile: async path => files.get(path), writeFile: async (path, text) => { files.set(path, text); }, listDirectory: async dir => [...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1)) };
  const store = new ProjectStore(host);
  return { files, host, store, options: { name: "Demo", host, store, paths: entries.map(([path]) => path), ai: "test", signal: new AbortController().signal, progress: () => {} } };
}
describe("native Project bootstrap", () => {
  it("selects routes from actual artifacts and does not treat plans as durable norms", () => {
    expect(detectProjectBootstrap({ legacy: true, paths: [] })).toBe("legacy");
    expect(detectProjectBootstrap({ legacy: false, paths: ["docs/contracts/api.md"] })).toBe("documents");
    expect(detectProjectBootstrap({ legacy: false, paths: ["src/a.ts"] })).toBe("code");
    expect(detectProjectBootstrap({ legacy: false, paths: ["docs/plans/design.plan.md", "README.md"] })).toBe("empty");
  });
  it("initializes an empty project without a parser or AI and adopts documents in place", async () => {
    const empty = fixture(); const initialized = await bootstrapProject(empty.options);
    expect(initialized.model?.nodes[0]?.review).toBe("draft");
    expect(detectProjectBootstrap({ model: initialized.model!, legacy: false, paths: [] })).toBe("existing");
    const docs = fixture([["docs/contracts/api.md", "# API contract"]]);
    const adopted = await bootstrapProject(docs.options);
    expect(adopted.model?.nodes[1]?.body).toMatchObject({ kind: "document", path: "docs/contracts/api.md" });
    expect(docs.files.get("docs/contracts/api.md")).toBe("# API contract");
    expect([...docs.files.keys()].some(path => path.startsWith(".dext/project/knowledge/"))).toBe(false);
  });
  it("does not commit after cancellation or source drift", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const controller = new AbortController(); controller.abort();
    await expect(bootstrapProject({ ...f.options, signal: controller.signal })).rejects.toThrow();
    expect(f.files.has(".dext/project/model.json")).toBe(false);
  });
  it("accepts Markdown body strings from the AI and ignores text after the JSON object", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    // A real CLI appended prose after the object; the whole-text JSON.parse failed on it.
    const generate = vi.fn(async () => ({ text: `${JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: "# Contract\n\nMoney moves once." }] })}\n\nThat is the model.` }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes).toEqual([expect.objectContaining({ id: "api", review: "draft", freshness: "needs_verification", body: { kind: "inline", text: "# Contract\n\nMoney moves once." } })]);
  });
  it("supplies the host-owned header when a stage returns only nodes and relations", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    // A real provider dropped schemaVersion/revision/updatedAt, which rejected the whole import.
    const generate = vi.fn(async () => ({ text: JSON.stringify({ relations: [], nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: "# Contract" }] }) }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes.map(node => node.id)).toEqual(["api"]);
  });
  it("drops body fields the model mixes across the two body owners", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"], ["notes.md", "# Notes"]]);
    const generate = vi.fn(async () => ({ text: JSON.stringify({ relations: [], nodes: [
      { id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "# Contract", contentHash: "made-up" } },
      { id: "doc", kind: "contract", title: "Notes", canonicalName: "Notes", body: { kind: "document", path: "notes.md", contentHash: "made-up" } }] }) }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes.map(node => node.body)).toEqual([
      { kind: "inline", text: "# Contract" },
      { kind: "document", path: "notes.md", contentHash: projectContentHash("# Notes") }]);
  });
  it("reports countable stage progress and live provider activity", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const reports: Array<{ phase: string; completed?: number; total?: number; message?: string }> = [];
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      request.onEvent?.({ phase: "message", title: "Reading sources", text: "x".repeat(4_000) });
      const root = request.prompt.includes("graph root only");
      return { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: root ? "project" : "api", kind: root ? "project" : "contract", title: root ? "Demo" : "API", canonicalName: root ? "Demo" : "API", body: { kind: "inline", text: "Body" } }] }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, progress: report => reports.push(report) });
    const generating = reports.filter(report => report.phase === "generating");
    // One call per stage, each stage counted: goals first, then the responsibility batch.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generating.some(report => report.total === 2 && report.completed === 1)).toBe(true);
    expect(generating.some(report => report.message === "Reading sources")).toBe(true);
    expect(initialized.model?.nodes.map(node => node.id)).toEqual(["project", "api"]);
  });
  it("drops relations whose endpoints no stage created instead of failing the import", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const node = (id: string) => ({ id, kind: "module", title: id, canonicalName: id, body: { kind: "inline", text: "Body" } });
    const relation = (id: string, from: string, to: string) => ({ id, from, to, kind: "contains", description: "", evidence: [], origin: "inferred", review: "draft", freshness: "needs_verification" });
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      // The batch links a module it forgot to create, and the root it never saw.
      const root = request.prompt.includes("graph root only");
      return { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [node(root ? "project" : "api")], relations: [relation("project-contains-api", "project", "api"), relation("project-contains-missing", "project", "missing")] }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual(["project--contains--api"]);
    expect(initialized.model?.nodes.map(item => item.id)).toEqual(["project", "api"]);
  });
  it("repairs a cyclic and doubly-owned draft instead of refusing the import", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"], ["notes.md", "# Notes"]]);
    const document = (id: string) => ({ id, kind: "contract", title: id, canonicalName: id, body: { kind: "document", path: "notes.md", contentHash: "hash" } });
    const node = (id: string) => ({ id, kind: "module", title: id, canonicalName: id, body: { kind: "inline", text: "Body" } });
    const contains = (id: string, from: string, to: string) => ({ id, from, to, kind: "contains", description: "", evidence: [], origin: "inferred", review: "draft", freshness: "needs_verification" });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      // Two branches each adopt the same document and claim the other as their child.
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [node("alpha"), node("beta"), document("doc-a")], relations: [contains("alpha-contains-beta", "alpha", "beta"), contains("beta-contains-alpha", "beta", "alpha")] }) }
      : { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [document("doc-b")], relations: [] }) });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, progress: report => reports.push(report) });
    expect(initialized.model?.nodes.map(item => item.id)).toEqual(["alpha", "beta", "doc-a"]);
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual(["alpha--contains--beta"]);
    expect(reports.some(report => report.message?.includes("dropped"))).toBe(true);
  });
  it("takes modules and edges from the import index and lets the AI write only prose", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string, dependencies: Array<{ specifier: string; to?: string }> = []) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 2, parsed: 2, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: ["src/core/a.ts"], symbols: [], evidence: [], references: [], dependsOn: ["ui"], dependencyCount: 1, unresolved: 0, hash: "h1", members: [member("src/core/a.ts", [{ specifier: "../ui/b", to: "src/ui/b.ts" }])] },
      { id: "ui", path: "src/ui", package: "ui", languages: ["typescript"], files: 1, entryPoints: ["src/ui/b.ts"], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h2", members: [member("src/ui/b.ts")] }
    ] });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
        { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } },
        { id: "architecture", kind: "architecture", title: "Architecture", canonicalName: "Architecture", body: { kind: "inline", text: "Topology" } }] }) }
      : { text: JSON.stringify({ title: request.prompt.includes("src/core/a.ts") ? "Core Unit" : "UI Unit", body: "## Responsibility\n\nOwns a." }) });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.model?.nodes.map(node => node.id)).toEqual(["project", "architecture", "module:src-core-a-ts", "module:src-ui-b-ts"]);
    expect(initialized.model?.nodes.find(node => node.id === "module:src-core-a-ts")).toMatchObject({ title: "Core Unit", paths: ["src/core/a.ts"] });
    // Both endpoint answers come from the index: no model-proposed edge survives.
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual([
      "project--contains--architecture",
      "project--contains--module:src-core-a-ts",
      "project--contains--module:src-ui-b-ts",
      "module:src-core-a-ts--depends_on--module:src-ui-b-ts"
    ]);
  });
  it("groups indexed modules into authored functional areas and keeps the grouping on a resume", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies: [] });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 2, parsed: 2, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: ["src/core/a.ts"], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h1", members: [member("src/core/a.ts")] },
      { id: "ui", path: "src/ui", package: "ui", languages: ["typescript"], files: 1, entryPoints: ["src/ui/b.ts"], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h2", members: [member("src/ui/b.ts")] }
    ] });
    const root = { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
      { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) };
    const prose = (title: string) => ({ text: JSON.stringify({ title, body: "## Responsibility\n\nOwns a." }) });
    const areas = (moduleIds: string[]) => ({ text: JSON.stringify({ areas: [{ title: "Core runtime", description: "拥有核心运行时", moduleIds }] }) });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only") ? root
      : request.prompt.includes("functional areas") ? areas(["module:src-core-a-ts", "module:src-ui-b-ts"])
        : prose(request.prompt.includes("src/core/a.ts") ? "Core Unit" : "UI Unit"));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.model?.nodes.find(node => node.kind === "capability")).toMatchObject({ id: "area:core-runtime", title: "Core runtime",
      body: { kind: "inline", text: "拥有核心运行时" }, properties: { moduleIds: ["module:src-core-a-ts", "module:src-ui-b-ts"] } });
    expect(initialized.model?.relations.filter(edge => edge.kind === "maps_to").map(edge => edge.id)).toEqual([
      "area:core-runtime--maps_to--module:src-core-a-ts",
      "area:core-runtime--maps_to--module:src-ui-b-ts"
    ]);
    // The reader groups by these ids; a module outside every area would be listed on its own.
    expect(validateProjectModel(initialized.model!)).toEqual([]);
  });
  it("asks every drafting stage to map one name per layer", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 1, parsed: 1, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h1",
        members: [{ path: "src/core/a.ts", hash: "h", language: "typescript", lines: 1, symbols: [], dependencies: [] }] }
    ] });
    const prompts: string[] = [];
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      prompts.push(request.prompt);
      return request.prompt.includes("graph root only")
        ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
          { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
        : request.prompt.includes("functional areas") ? { text: JSON.stringify({ areas: [{ title: "Core runtime", description: "核心", moduleIds: ["module:src-core-a-ts"] }] }) }
          : { text: JSON.stringify({ title: "Core Unit", body: "## Responsibility\n\nOwns a." }) };
    });
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    const drafting = prompts.filter(prompt => prompt.includes("Explain one responsibility") || prompt.includes("functional areas"));
    expect(drafting).toHaveLength(2);
    for (const prompt of drafting) {
      // A reader follows the interface name, an agent follows the symbol; the code name wins a conflict.
      expect(prompt).toContain("**Names**: <interface name> → <public symbol or entry file>");
      expect(prompt).toContain("the code name still wins the title");
      expect(prompt).toContain("Simplified Chinese");
    }
  });
  it("leaves modules ungrouped when an area drops or duplicates one", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies: [] });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 2, parsed: 2, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h1", members: [member("src/core/a.ts")] },
      { id: "ui", path: "src/ui", package: "ui", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h2", members: [member("src/ui/b.ts")] }
    ] });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
        { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
      // One module is missing from every area: the grouping is navigation, so dropping it is worse than none.
      : request.prompt.includes("functional areas") ? { text: JSON.stringify({ areas: [{ title: "Core runtime", description: "核心", moduleIds: ["module:src-core-a-ts"] }] }) }
        : { text: JSON.stringify({ title: request.prompt.includes("src/core/a.ts") ? "Core Unit" : "UI Unit", body: "## Responsibility\n\nOwns a." }) });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure, progress: report => reports.push(report) });
    expect(initialized.model?.nodes.some(node => node.kind === "capability")).toBe(false);
    expect(initialized.model?.relations.some(edge => edge.kind === "maps_to")).toBe(false);
    expect(initialized.model?.nodes.filter(node => node.kind === "module")).toHaveLength(2);
    // A flat tree is never silent: the rejected grouping is named in the final progress report.
    expect(reports.some(report => report.message?.includes("Modules stay ungrouped"))).toBe(true);
  });
  it("accepts an area that names its modules by title instead of id", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies: [] });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 2, parsed: 2, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h1", members: [member("src/core/a.ts")] },
      { id: "ui", path: "src/ui", package: "ui", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h2", members: [member("src/ui/b.ts")] }
    ] });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
        { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
      // A real answer copied the labels the prompt lists next to each id: the tree must not go flat over it.
      : request.prompt.includes("functional areas") ? { text: JSON.stringify({ areas: [{ title: "Core runtime", description: "核心", moduleIds: ["Core Unit", "UI Unit"] }] }) }
        : { text: JSON.stringify({ title: request.prompt.includes("src/core/a.ts") ? "Core Unit" : "UI Unit", body: "## Responsibility\n\nOwns a." }) });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.model?.nodes.find(node => node.kind === "capability")?.properties).toEqual({ moduleIds: ["module:src-core-a-ts", "module:src-ui-b-ts"] });
    expect(initialized.model?.relations.filter(edge => edge.kind === "maps_to")).toHaveLength(2);
  });
  it("repairs a rejected grouping once before leaving the tree flat", async () => {
    const prompts: string[] = [];
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies: [] });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 2, parsed: 2, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      { id: "core", path: "src/core", package: "core", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h1", members: [member("src/core/a.ts")] },
      { id: "ui", path: "src/ui", package: "ui", languages: ["typescript"], files: 1, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h2", members: [member("src/ui/b.ts")] }
    ] });
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      prompts.push(request.prompt);
      return request.prompt.includes("rejected") ? { text: JSON.stringify({ areas: [{ title: "Core runtime", description: "核心", moduleIds: ["module:src-core-a-ts", "module:src-ui-b-ts"] }] }) }
        : request.prompt.includes("graph root only")
          ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
            { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
          : request.prompt.includes("functional areas") ? { text: JSON.stringify({ areas: [{ title: "Core runtime", description: "核心", moduleIds: ["module:src-core-a-ts"] }] }) }
            : { text: JSON.stringify({ title: request.prompt.includes("src/core/a.ts") ? "Core Unit" : "UI Unit", body: "## Responsibility\n\nOwns a." }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.model?.nodes.find(node => node.kind === "capability")).toMatchObject({ id: "area:core-runtime", properties: { moduleIds: ["module:src-core-a-ts", "module:src-ui-b-ts"] } });
    // Two grouping attempts: a rejected answer is repaired instead of silently discarded.
    expect(prompts.filter(prompt => prompt.includes("functional areas"))).toHaveLength(2);
  });
  it("merges groups that name one responsibility and explains only modules it could read", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const member = (path: string, dependencies: Array<{ specifier: string; to?: string }> = []) => ({ path, hash: "h-" + path, language: "typescript", lines: 1, symbols: [], dependencies });
    const module = (id: string, members: Array<ReturnType<typeof member>>) => ({ id, path: `src/${id}`, package: id, languages: ["typescript"], files: members.length, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: "h-" + id, members });
    const structure = () => Promise.resolve<StructureSummary>({ version: 2, hash: "index", files: 3, parsed: 3, cached: 0, failed: 0, unsupported: 0, issues: [], modules: [
      module("core", [member("src/core/a.ts", [{ specifier: "../ui/b", to: "src/ui/b.ts" }])]),
      // The index cap split one responsibility in two, and one group sits outside the read budget.
      module("ui", [member("src/ui/b.ts")]),
      module("gone", [member("src/gone/d.ts")])
    ] });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
        { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
      : { text: JSON.stringify({ title: "Shared Unit", body: "## Responsibility\n\nOwns both." }) });
    // src/gone/d.ts is not readable, so that module is never drafted as a path-named stub.
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.model?.nodes.filter(node => node.kind === "module")).toEqual([
      expect.objectContaining({ id: "module:src-core-a-ts", title: "Shared Unit", paths: ["src/core/a.ts", "src/ui/b.ts"] })
    ]);
    // A dependency inside the merged responsibility is not an edge.
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual(["project--contains--module:src-core-a-ts"]);
  });
  it("re-drafts an existing model on update and keeps reviewed bodies", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only")
      ? { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }] }) }
      : { text: JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: "app", kind: "module", title: "App", canonicalName: "App", body: { kind: "inline", text: "Owns app." } }] }) });
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    const saved = (await f.store.readModel())!;
    saved.nodes[0] = { ...saved.nodes[0]!, review: "accepted", freshness: "current", body: { kind: "inline", text: "Reviewed goal" } };
    await f.store.updateProject(saved, 0);
    // Update used to throw "returned no nodes", because an existing model was not treated as code to draft.
    const updated = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(generate).toHaveBeenCalledTimes(4);
    expect(updated.model?.nodes.find(node => node.id === "project")?.body).toEqual({ kind: "inline", text: "Reviewed goal" });
  });
  it("resumes a saved candidate without calling AI twice and invalidates changed sources", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const candidate = projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "Contract" } }], relations: [] });
    const generate = vi.fn(async () => ({ text: JSON.stringify(candidate) }));
    const save = f.host.writeFile.bind(f.host);
    f.host.writeFile = async (path, content) => { if (path.endsWith("model.json")) throw new Error("Interrupted commit"); await save(path, content); };
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate } })).rejects.toThrow("Interrupted");
    expect(await readBootstrapCheckpoint(f.host)).toMatchObject({ stage: "code:candidate" });
    f.host.writeFile = save;
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    // Both stages were checkpointed, so the resumed run calls no AI at all.
    expect(generate).toHaveBeenCalledTimes(2); expect(await readBootstrapCheckpoint(f.host)).toBeUndefined();
    const drift = fixture([["src/app.ts", "before"]]);
    await expect(bootstrapProject({ ...drift.options, provider: { id: "fixture", generate: async () => { drift.files.set("src/app.ts", "during generation"); return { text: JSON.stringify(candidate) }; } } })).rejects.toThrow("source changed");
    expect(drift.files.has(".dext/project/model.json")).toBe(false);
  });
});
