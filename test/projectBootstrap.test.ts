import { describe, expect, it, vi } from "vitest";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { bootstrapProject, detectProjectBootstrap, readBootstrapCheckpoint } from "../src/features/project/host/projectBootstrap.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
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
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only") ? rootReply() : ({ text: `${JSON.stringify({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: "# Contract\n\nMoney moves once." }] })}\n\nThat is the model.` }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes.filter(node => node.kind === "contract")).toEqual([expect.objectContaining({ id: "api", review: "draft", freshness: "needs_verification",
      body: { kind: "document", path: ".dext/project/knowledge/api.md", contentHash: projectContentHash("# Contract\n\nMoney moves once.") } })]);
    expect(f.files.get(".dext/project/knowledge/api.md")).toBe("# Contract\n\nMoney moves once.");
  });
  it("supplies the host-owned header when a stage returns only nodes and relations", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    // A real provider dropped schemaVersion/revision/updatedAt, which rejected the whole import.
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only") ? rootReply() : ({ text: JSON.stringify({ relations: [], nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: "# Contract" }] }) }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes.map(node => node.id)).toEqual(["project", "architecture", "api"]);
  });
  it("drops body fields the model mixes across the two body owners", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"], ["notes.md", "# Notes"]]);
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only") ? rootReply() : ({ text: JSON.stringify({ relations: [], nodes: [
      { id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "# Contract", contentHash: "made-up" } },
      { id: "doc", kind: "contract", title: "Notes", canonicalName: "Notes", body: { kind: "document", path: "notes.md", contentHash: "made-up" } }] }) }));
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.nodes.filter(node => node.kind === "contract").map(node => node.body)).toEqual([
      { kind: "document", path: ".dext/project/knowledge/api.md", contentHash: projectContentHash("# Contract") },
      { kind: "document", path: "notes.md", contentHash: projectContentHash("# Notes") }]);
  });
  it("reports countable stage progress and live provider activity", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const reports: Array<{ phase: string; completed?: number; total?: number; message?: string }> = [];
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      request.onEvent?.({ phase: "message", title: "Reading sources", text: "x".repeat(4_000) });
      if (request.prompt.includes("graph root only")) return rootReply();
      return { text: JSON.stringify({ relations: [], nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "Body" } }] }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, progress: report => reports.push(report) });
    const generating = reports.filter(report => report.phase === "generating");
    // One call per stage, each stage counted: goals first, then the responsibility batch.
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generating.some(report => report.total === 3 && report.completed === 1)).toBe(true);
    expect(generating.some(report => report.message === "Reading sources")).toBe(true);
    expect(generating.some(report => report.message?.includes("runtime boundaries skipped"))).toBe(true);
    expect(initialized.model?.nodes.map(node => node.id)).toEqual(["project", "architecture", "api"]);
  });
  it("drops relations whose endpoints no stage created instead of failing the import", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const node = (id: string) => ({ id, kind: "module", title: id, canonicalName: id, body: { kind: "inline", text: "Body" } });
    const relation = (id: string, from: string, to: string) => ({ id, from, to, kind: "contains", description: "", evidence: [], origin: "inferred", review: "draft", freshness: "needs_verification" });
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      // The batch links a module it forgot to create, and the root it never saw.
      if (request.prompt.includes("graph root only")) return rootReply();
      return { text: JSON.stringify({ nodes: [node("api")], relations: [relation("project-contains-api", "project", "api"), relation("project-contains-missing", "project", "missing")] }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual(["project--contains--architecture", "project--contains--api"]);
    expect(initialized.model?.nodes.map(item => item.id)).toEqual(["project", "architecture", "api"]);
  });
  it("repairs a cyclic and doubly-owned draft instead of refusing the import", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"], ["notes.md", "# Notes"]]);
    const document = (id: string) => ({ id, kind: "contract", title: id, canonicalName: id, body: { kind: "document", path: "notes.md", contentHash: "hash" } });
    const node = (id: string) => ({ id, kind: "module", title: id, canonicalName: id, body: { kind: "inline", text: "Body" } });
    const contains = (id: string, from: string, to: string) => ({ id, from, to, kind: "contains", description: "", evidence: [], origin: "inferred", review: "draft", freshness: "needs_verification" });
    const generate = vi.fn(async (request: ProjectAiRequest) => request.prompt.includes("graph root only") ? rootReply()
      // Two branches each adopt the same document and claim the other as their child.
      : { text: JSON.stringify({ nodes: [node("alpha"), node("beta"), document("doc-a"), document("doc-b")], relations: [contains("alpha-contains-beta", "alpha", "beta"), contains("beta-contains-alpha", "beta", "alpha")] }) });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, progress: report => reports.push(report) });
    expect(initialized.model?.nodes.map(item => item.id)).toEqual(["project", "architecture", "alpha", "beta", "doc-a"]);
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual(["project--contains--architecture", "alpha--contains--beta"]);
    expect(reports.some(report => report.message?.includes("dropped"))).toBe(true);
  });
  const memberOf = (path: string, dependencies: Array<{ specifier: string; to?: string; typeOnly?: boolean }> = []) =>
    ({ path, hash: `h-${path}`, language: "typescript", lines: 1, symbols: [], dependencies });
  const moduleOf = (id: string, pkg: string, members: Array<ReturnType<typeof memberOf>>) =>
    ({ id, path: `src/${id}`, package: pkg, languages: ["typescript"], files: members.length, entryPoints: [], symbols: [], evidence: [], references: [], dependsOn: [], dependencyCount: 0, unresolved: 0, hash: `h-${id}`, members });
  const summaryOf = (modules: Array<ReturnType<typeof moduleOf>>) => () => Promise.resolve<StructureSummary>({ version: 2, hash: "index",
    files: modules.reduce((sum, module) => sum + module.files, 0), parsed: modules.length, cached: 0, failed: 0, unsupported: 0, issues: [], modules });
  const titleOf = (path: string) => path.split("/").pop()!.replace(/\.[^/.]+$/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
  const payloadOf = (request: ProjectAiRequest): Record<string, unknown> => JSON.parse(request.prompt.slice(request.prompt.indexOf("\n\n") + 2)) as Record<string, unknown>;
  const rootReply = () => ({ text: JSON.stringify({ project: { title: "Demo", body: "Goal" }, architecture: { title: "Architecture", body: "Topology" } }) });
  const proposalReply = (request: ProjectAiRequest, groups?: ReadonlyArray<{ name: string; files: string[] }>) => {
    const payload = payloadOf(request) as { candidates?: Array<{ files: Array<{ path: string }> }>; responsibilities?: Array<{ paths: string[] }> };
    const inventory = payload.candidates ? payload.candidates.flatMap(candidate => candidate.files.map(file => file.path))
      : (payload.responsibilities ?? []).flatMap(context => context.paths);
    const chosen = groups ?? inventory.map(path => ({ name: titleOf(path), files: [path] }));
    return { text: JSON.stringify({ contexts: chosen.map(group => ({ canonicalName: group.name, purpose: `${group.name} responsibility`,
      uncertainties: [], sourceFiles: group.files, entryPoints: [group.files[0]] })) }) };
  };
  const proseReply = (request: ProjectAiRequest, titles?: ReadonlyMap<string, string>) => {
    const payload = payloadOf(request) as { paths: string[] };
    const path = payload.paths[0]!;
    return { text: JSON.stringify({ title: titles?.get(path) ?? titleOf(path), body: "## Responsibility\n\nOwns a." }) };
  };
  const projectAi = (options: { groups?: (request: ProjectAiRequest) => ReadonlyArray<{ name: string; files: string[] }> | undefined;
    titles?: ReadonlyMap<string, string>; proseOnly?: boolean; c4?: unknown } = {}) => vi.fn(async (request: ProjectAiRequest) => {
    if (request.prompt.includes("graph root only")) return rootReply();
    if (request.prompt.includes("runtime architecture only")) return { text: JSON.stringify(options.c4 ? { c4: options.c4 } : {}) };
    if (request.prompt.includes("Identify developer-facing responsibilities") || request.prompt.includes("Consolidate provisional responsibility")) {
      return options.proseOnly ? { text: "These files belong to two capabilities." } : proposalReply(request, options.groups?.(request));
    }
    return proseReply(request, options.titles);
  });

  it.each([false, true])("keeps root identities and C4 systems when updating (indexed: %s)", async indexed => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["README.md", "# Dext"]]);
    const rootId = indexed ? "saved-project" : "project", architectureId = indexed ? "saved-architecture" : "architecture";
    const previous = projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [
      { id: rootId, kind: "project", title: "Dext", canonicalName: "Dext", body: { kind: "inline", text: "Old goal" }, properties: { c4SystemId: "dext" } },
      { id: architectureId, kind: "architecture", title: "Architecture", canonicalName: "Architecture", body: { kind: "inline", text: "Old topology" } },
      { id: "dext", kind: "system", title: "Dext", canonicalName: "Dext", body: { kind: "inline", text: "Product" } },
      { id: "ui", kind: "container", title: "Webview", canonicalName: "Webview", body: { kind: "inline", text: "UI" } }
    ], relations: [{ id: "dext--contains--ui", from: "dext", to: "ui", kind: "contains" }] });
    f.files.set(".dext/project/model.json", JSON.stringify(previous));
    const reply = projectAi();
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      if (request.prompt.includes("graph root only")) return rootReply();
      if (indexed) return reply(request);
      return { text: JSON.stringify({ nodes: [{ id: "core", kind: "module", title: "Core", canonicalName: "Core", body: "Owns a.", paths: ["src/core/a.ts"] }], relations: [] }) };
    });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate },
      ...(indexed ? { structure: summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]) } : {}) });
    expect(initialized.model?.nodes.filter(node => node.kind === "project").map(node => node.id)).toEqual([rootId]);
    expect(initialized.model?.nodes.find(node => node.id === rootId)?.evidence).toContainEqual({ path: "README.md", contentHash: projectContentHash("# Dext") });
    expect(initialized.model?.nodes.filter(node => node.kind === "architecture").map(node => node.id)).toEqual([architectureId]);
    expect(initialized.model?.relations).toContainEqual(expect.objectContaining({ from: rootId, to: architectureId, kind: "contains" }));
    expect(initialized.intent?.c4).toMatchObject({ systemId: "dext", elements: [expect.objectContaining({ id: "dext", kind: "system" }), expect.objectContaining({ id: "ui", parentId: "dext" })] });
    expect(generate.mock.calls[0]?.[0].responseSchema).toMatchObject({ additionalProperties: false, required: ["project", "architecture"],
      properties: { project: { additionalProperties: false, required: ["title", "body"] }, architecture: { additionalProperties: false, required: ["title", "body"] } } });
    if (indexed) expect(initialized.model?.relations).toContainEqual(expect.objectContaining({ from: rootId, to: "module:src-core-a-ts", kind: "contains" }));
  });

  it.each([false, true])("rejects AI-owned root ids before saving (indexed: %s)", async indexed => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const generate = vi.fn(async () => ({ text: JSON.stringify({ project: { id: "dext", title: "Dext", body: "Goal" }, architecture: { title: "Architecture", body: "Topology" } }) }));
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate },
      ...(indexed ? { structure: summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]) } : {}) })).rejects.toThrow("Unrecognized key");
    expect(f.files.has(".dext/project/model.json")).toBe(false);
  });

  it.each([false, true])("resumes incomplete stages and aligns root ids without replacing C4 (indexed: %s)", async indexed => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    f.files.set(".dext/project/model.json", JSON.stringify(projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [
      { id: "project", kind: "project", title: "Dext", canonicalName: "Dext", body: { kind: "inline", text: "Old goal" } },
      { id: "dext", kind: "system", title: "Dext", canonicalName: "Dext", body: { kind: "inline", text: "Product" } }
    ] })));
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const reply = projectAi();
    let interrupted = true;
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      if (request.prompt.includes("graph root only")) return rootReply();
      if (interrupted) throw new Error("Interrupted after root");
      if (indexed) return reply(request);
      return { text: JSON.stringify({ nodes: [{ id: "module:src-core-a-ts", kind: "module", title: "Core", canonicalName: "Core", body: "Owns a.", paths: ["src/core/a.ts"] }],
        relations: [{ id: "root-core", from: "dext", to: "module:src-core-a-ts", kind: "contains" }] }) };
    });
    const run = () => bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, ...(indexed ? { structure } : {}) });
    await expect(run()).rejects.toThrow("Interrupted after root");
    const checkpointPath = ".dext/project/bootstrap.checkpoint.json";
    const checkpoint = JSON.parse(f.files.get(checkpointPath)!) as { candidate: ReturnType<typeof projectModelSchema.parse> };
    checkpoint.candidate.nodes.find(node => node.kind === "project")!.id = "dext";
    checkpoint.candidate.relations = checkpoint.candidate.relations.map(edge => ({ ...edge, from: edge.from === "project" ? "dext" : edge.from }));
    f.files.set(checkpointPath, JSON.stringify(checkpoint));
    interrupted = false;
    const initialized = await run();
    expect(generate.mock.calls.filter(([request]) => request.prompt.includes("graph root only"))).toHaveLength(1);
    expect(initialized.model?.nodes.filter(node => node.kind === "project").map(node => node.id)).toEqual(["project"]);
    expect(initialized.model?.nodes.some(node => node.id === "module:src-core-a-ts")).toBe(true);
    expect(initialized.model?.relations).toContainEqual(expect.objectContaining({ from: "project", to: "module:src-core-a-ts", kind: "contains" }));
    expect(initialized.intent?.c4?.systemId).toBe("dext");
  });

  it("keeps a module when the prose stage answers with the Markdown body only", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    let bodyOnly = false;
    const generate = vi.fn(async (request: ProjectAiRequest) => {
      if (request.prompt.includes("graph root only")) return rootReply();
      if (request.prompt.includes("runtime architecture only")) return { text: "{}" };
      if (request.prompt.includes("Identify developer-facing responsibilities")) return proposalReply(request);
      return bodyOnly ? { text: "```markdown\n## Responsibility\n\nOwns a.\n```" } : proseReply(request);
    });
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")]), moduleOf("ui", "app", [memberOf("src/ui/b.ts")])]);
    const run = () => bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    await run();
    bodyOnly = true;
    f.files.set("src/core/a.ts", "export const a = 2");
    const updated = await run();
    expect(updated.model?.nodes.find(node => node.id === "module:src-core-a-ts")).toMatchObject({ title: "A", body: { kind: "document", path: ".dext/project/knowledge/src/core/a.md" } });
  });

  it("treats a responsibility proposal answered in prose as rejected and keeps candidate boundaries", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "core", [memberOf("src/core/a.ts")]), moduleOf("ui", "ui", [memberOf("src/ui/b.ts")])]);
    const generate = projectAi({ proseOnly: true });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure, progress: report => reports.push(report) });
    expect(generate.mock.calls.filter(([request]) => request.prompt.includes("Identify developer-facing responsibilities"))).toHaveLength(2);
    expect(initialized.model?.nodes.filter(node => node.paths.length).map(node => node.paths)).toEqual([["src/core/a.ts"], ["src/ui/b.ts"]]);
    expect(reports.some(report => report.message?.includes("responsibility batch"))).toBe(true);
  });

  it("takes modules and edges from the import index and lets the AI write only prose", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const structure = summaryOf([
      moduleOf("core", "app", [memberOf("src/core/a.ts", [{ specifier: "../ui/b", to: "src/ui/b.ts" }])]),
      moduleOf("ui", "app", [memberOf("src/ui/b.ts")])
    ]);
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    expect(initialized.model?.nodes.filter(node => node.paths.length).map(node => node.id)).toEqual(["module:src-core-a-ts", "module:src-ui-b-ts"]);
    expect(initialized.model?.nodes.find(node => node.id === "module:src-core-a-ts")).toMatchObject({ title: "A", paths: ["src/core/a.ts"] });
    // Two entries in one directory make it the parent that groups them.
    expect(initialized.model?.nodes.find(node => node.id === "module:src")).toMatchObject({ kind: "module", title: "src", paths: [], properties: { overview: true } });
    expect(initialized.model?.relations.map(edge => edge.id)).toEqual([
      "project--contains--architecture",
      "module:src--contains--module:src-core-a-ts",
      "module:src--contains--module:src-ui-b-ts",
      "project--contains--module:src",
      "module:src-core-a-ts--depends_on--module:src-ui-b-ts"
    ]);
    expect(initialized.model?.nodes.some(node => node.kind === "capability")).toBe(false);
    // Every generated body is a Markdown file laid out like the module tree.
    expect([...f.files.keys()].filter(path => path.startsWith(".dext/project/knowledge/")).sort()).toEqual([
      ".dext/project/knowledge/architecture.md",
      ".dext/project/knowledge/project.md",
      ".dext/project/knowledge/src.md",
      ".dext/project/knowledge/src/core/a.md",
      ".dext/project/knowledge/src/ui/b.md"
    ]);
  });

  it("attaches a module the update did not re-draft to its directory instead of the root", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    // legacy.ts is outside this run's read scope, so only the saved model still knows that module.
    f.files.set(".dext/project/model.json", JSON.stringify(projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [
      { id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Old goal" } },
      { id: "module:legacy", kind: "module", title: "Legacy", canonicalName: "Legacy", body: { kind: "inline", text: "Older boundary" }, paths: ["src/core/legacy.ts"] }
    ], relations: [{ id: "project--contains--module:legacy", from: "project", to: "module:legacy", kind: "contains" }] })));
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    const contains = initialized.model!.relations.filter(edge => edge.kind === "contains").map(edge => edge.id);
    expect(contains).toEqual(expect.arrayContaining(["module:src-core--contains--module:legacy", "module:src-core--contains--module:src-core-a-ts"]));
    expect(contains).not.toContain("project--contains--module:legacy");
  });

  it("keeps one directory in one module and parents only a branching directory", async () => {
    const f = fixture([["src/core/alpha.ts", "export const a = 1"], ["src/core/beta.ts", "export const b = 2"], ["src/ui/gamma.ts", "export const c = 3"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/alpha.ts"), memberOf("src/core/beta.ts")]), moduleOf("ui", "app", [memberOf("src/ui/gamma.ts")])]);
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    // A directory is a boundary: its files stay one module and no parent is derived for it alone.
    expect(initialized.model?.nodes.filter(node => node.kind === "module" && node.paths.length).map(node => node.paths)).toEqual([
      ["src/core/alpha.ts", "src/core/beta.ts"], ["src/ui/gamma.ts"]]);
    expect(initialized.model?.nodes.some(node => node.id === "module:src-core")).toBe(false);
    expect(initialized.model?.nodes.find(node => node.id === "module:src")?.body).toMatchObject({ kind: "document", path: ".dext/project/knowledge/src.md" });
    const contains = initialized.model!.relations.filter(edge => edge.kind === "contains").map(edge => edge.id);
    expect(contains).toEqual(expect.arrayContaining([
      "module:src--contains--module:src-core-alpha-ts",
      "module:src--contains--module:src-ui-gamma-ts"
    ]));
    expect(contains).not.toContain("project--contains--module:src-core-alpha-ts");
  });

  it("rejects a split inside one directory and keeps the directory as one module", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/core/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts"), memberOf("src/core/b.ts")])]);
    const generate = projectAi({ groups: () => [{ name: "A", files: ["src/core/a.ts"] }, { name: "B", files: ["src/core/b.ts"] }] });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure, progress: report => reports.push(report) });
    expect(initialized.model?.nodes.filter(node => node.kind === "module" && node.paths.length).map(node => node.paths)).toEqual([["src/core/a.ts", "src/core/b.ts"]]);
    expect(reports.some(report => report.message?.includes("split rejected"))).toBe(true);
  });

  it("rejects a cross-directory merge without structural evidence and keeps the candidate boundaries", async () => {
    const f = fixture([["src/core/model.ts", "export const model = 1"], ["src/ui/view.ts", "export const view = 2"]]);
    const structure = summaryOf([moduleOf("core", "core", [memberOf("src/core/model.ts")]), moduleOf("ui", "ui", [memberOf("src/ui/view.ts")])]);
    const generate = projectAi({ groups: () => [{ name: "Everything", files: ["src/core/model.ts", "src/ui/view.ts"] }] });
    const reports: Array<{ message?: string }> = [];
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure, progress: report => reports.push(report) });
    expect(initialized.model?.nodes.filter(node => node.paths.length).map(node => node.paths.sort())).toEqual([["src/core/model.ts"], ["src/ui/view.ts"]]);
    expect(reports.some(report => report.message?.includes("merge rejected without structural evidence"))).toBe(true);
  });

  it("keeps one responsibility when the index connects a cross-directory merge", async () => {
    const f = fixture([["src/core/model.ts", "import { view } from '../ui/view'; export const model = 1"], ["src/ui/view.ts", "export const view = 2"]]);
    const structure = summaryOf([
      moduleOf("core", "app", [memberOf("src/core/model.ts", [{ specifier: "../ui/view", to: "src/ui/view.ts" }])]),
      moduleOf("ui", "app", [memberOf("src/ui/view.ts")])
    ]);
    const generate = projectAi({ groups: () => [{ name: "Shared Model", files: ["src/core/model.ts", "src/ui/view.ts"] }], titles: new Map([["src/core/model.ts", "Shared Model"]]) });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    const modules = initialized.model?.nodes.filter(node => node.kind === "module");
    expect(modules?.map(node => node.paths)).toEqual([["src/core/model.ts", "src/ui/view.ts"]]);
    expect(modules?.[0]?.title).toBe("Shared Model");
  });

  it("consolidates provisional responsibilities across batches and checks every owner", async () => {
    const paths = Array.from({ length: 13 }, (_, index) => `src/area${index}/file${index}.ts`);
    const f = fixture(paths.map(path => [path, `export const value${path.length} = 1`]));
    const structure = summaryOf(paths.map((path, index) => moduleOf(`area${index}`, "app", [memberOf(path,
      index === 0 ? [{ specifier: "../area12/file12", to: "src/area12/file12.ts" }] : [])])));
    const generate = projectAi({ groups: request => {
      const payload = payloadOf(request) as { responsibilities?: Array<{ paths: string[] }> };
      if (!payload.responsibilities) return undefined;
      const merged = ["src/area0/file0.ts", "src/area12/file12.ts"];
      return [
        { name: "Shared Core", files: merged },
        ...paths.filter(path => !merged.includes(path)).map(path => ({ name: titleOf(path), files: [path] }))
      ];
    }, titles: new Map([["src/area0/file0.ts", "Shared Core"]]) });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(generate.mock.calls.filter(([request]) => request.prompt.includes("Consolidate provisional responsibility"))).toHaveLength(1);
    const modules = initialized.model!.nodes.filter(node => node.kind === "module");
    // Twelve leaf responsibilities plus the src parent their cross-directory merge creates.
    expect(modules.filter(node => node.paths.length)).toHaveLength(12);
    expect(modules.find(node => node.title === "Shared Core")?.paths).toEqual(["src/area0/file0.ts", "src/area12/file12.ts"]);
    const owned = modules.flatMap(node => node.paths);
    expect(new Set(owned).size).toBe(13);
    expect(owned).toHaveLength(13);
  });

  it("drafts runtime boundaries so the Knowledge reader gets its C4 landscape", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["esbuild.mjs", "export default { entryPoints: ['src/core/a.ts'] }"], ["README.md", "A tool with a webview and a host."]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const generate = projectAi({ c4: { systemId: "demo-system", elements: [
      { id: "demo-system", name: "Demo", description: "Product", kind: "system", contextIds: [], evidence: [{ path: "README.md" }] },
      { id: "demo-user", name: "User", description: "Person", kind: "person", contextIds: [], evidence: [{ path: "README.md" }] },
      { id: "demo-ui", name: "Webview", description: "Browser UI", kind: "container", parentId: "demo-system", contextIds: ["module:src-core-a-ts"], evidence: [{ path: "src/core/a.ts", line: 1 }, { path: "missing.ts" }] },
      { id: "demo-ghost", name: "Ghost", description: "Unsupported", kind: "system", contextIds: [], evidence: [{ path: "missing.ts" }] }
    ], relationships: [{ id: "user-uses", from: "demo-user", to: "demo-system", description: "Uses the tool", evidence: [{ path: "README.md" }] }] } });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(initialized.intent?.c4?.elements.map(element => element.id)).toEqual(["demo-system", "demo-user", "demo-ui"]);
    expect(initialized.intent?.c4?.elements.find(element => element.id === "demo-ui")).toMatchObject({ parentId: "demo-system", contextIds: ["module:src-core-a-ts"], evidence: [{ path: "src/core/a.ts", line: 1 }] });
    const topics = buildProjectTopics(initialized.intent!);
    expect(topics.find(topic => topic.kind === "system_context")?.diagram?.nodes.map(node => node.id)).toEqual(["demo-system", "demo-user"]);
    expect(topics.find(topic => topic.kind === "containers")?.diagram?.nodes.map(node => node.id)).toContain("demo-ui");
    expect(initialized.intent?.c4?.relationships.map(relation => relation.id)).toEqual(["demo-user--communicates--demo-system"]);
    const c4Prompt = generate.mock.calls.find(([request]) => request.prompt.includes("runtime architecture only"))?.[0].prompt ?? "";
    expect(c4Prompt).toContain("esbuild.mjs");
    expect(c4Prompt).toContain("src/core/a.ts");
    const updated = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(generate.mock.calls.filter(([request]) => request.prompt.includes("runtime architecture only"))).toHaveLength(1);
    expect(updated.intent?.c4?.elements.map(element => element.id)).toEqual(["demo-system", "demo-user", "demo-ui"]);
  });

  it("asks responsibility and prose stages to map one name per layer", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const prompts: string[] = [];
    const generate = projectAi();
    generate.mockImplementation(async (request: ProjectAiRequest) => {
      prompts.push(request.prompt);
      if (request.prompt.includes("graph root only")) return rootReply();
      if (request.prompt.includes("runtime architecture only")) return { text: "{}" };
      if (request.prompt.includes("Identify developer-facing responsibilities")) return proposalReply(request);
      return proseReply(request);
    });
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    const drafting = prompts.filter(prompt => prompt.includes("Identify developer-facing responsibilities") || prompt.includes("Explain one responsibility"));
    expect(drafting).toHaveLength(2);
    for (const prompt of drafting) {
      expect(prompt).toContain("**Names**: <interface name> → <public symbol or entry file>");
      expect(prompt).toContain("the code name still wins the title");
      expect(prompt).toContain("Simplified Chinese");
    }
    // A generated body shows its flow as one Mermaid block, which both the file and the reader render.
    const prose = prompts.filter(prompt => prompt.includes("Explain one responsibility"));
    expect(prose).toHaveLength(1);
    expect(prose[0]).toContain("mermaid");
  });

  it("explains only readable modules and never creates a stub for an unread file", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")]), moduleOf("ui", "app", [memberOf("src/ui/b.ts")]), moduleOf("gone", "app", [memberOf("src/gone/d.ts")])]);
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    expect(initialized.model?.nodes.filter(node => node.paths.length).map(node => node.paths)).toEqual([["src/core/a.ts"], ["src/ui/b.ts"]]);
    expect(initialized.model?.nodes.some(node => node.paths.includes("src/gone/d.ts"))).toBe(false);
  });

  it("reuses unchanged modules and re-drafts only the module whose file changed", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")]), moduleOf("ui", "app", [memberOf("src/ui/b.ts")])]);
    const prompts: string[] = [];
    const generate = projectAi();
    generate.mockImplementation(async (request: ProjectAiRequest) => {
      prompts.push(request.prompt);
      if (request.prompt.includes("graph root only")) return rootReply();
      if (request.prompt.includes("runtime architecture only")) return { text: "{}" };
      if (request.prompt.includes("Identify developer-facing responsibilities")) return proposalReply(request);
      return proseReply(request);
    });
    const prose = () => prompts.filter(prompt => prompt.includes("Explain one responsibility"));
    const run = () => bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    await run();
    expect(prose()).toHaveLength(2);
    const first = (await f.store.readModel())!;
    await f.store.updateProject({ ...first, nodes: first.nodes.map(node => node.id === "module:src-core-a-ts" ? { ...node, review: "accepted", freshness: "current", body: { kind: "inline", text: "Reviewed core" } } : node) }, first.revision);
    prompts.length = 0;
    const unchanged = await run();
    expect(prose()).toHaveLength(0);
    expect(unchanged.model?.nodes.find(node => node.id === "module:src-core-a-ts")).toMatchObject({ review: "accepted", freshness: "current",
      body: { kind: "document", path: ".dext/project/knowledge/src/core/a.md" } });
    expect(f.files.get(".dext/project/knowledge/src/core/a.md")).toBe("Reviewed core");
    f.files.set("src/ui/b.ts", "export const b = 3");
    prompts.length = 0;
    await run();
    expect(prose()).toHaveLength(1);
    expect(prose()[0]).toContain("src/ui/b.ts");
  });

  it("keeps a module's Markdown file when its title changes", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const run = (title: string) => bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi({ titles: new Map([["src/core/a.ts", title]]) }) }, structure });
    await run("Core");
    f.files.set("src/core/a.ts", "export const a = 2");
    const renamed = await run("Core store");
    // The module is re-drafted under a new title, but its file and folder stay put.
    expect(renamed.model?.nodes.find(node => node.id === "module:src-core-a-ts")?.title).toBe("Core store");
    expect(f.files.get(".dext/project/knowledge/src/core.md")).toBe("## Responsibility\n\nOwns a.");
    expect([...f.files.keys()].filter(path => path.startsWith(".dext/project/knowledge/")).sort()).toEqual([
      ".dext/project/knowledge/architecture.md", ".dext/project/knowledge/project.md", ".dext/project/knowledge/src/core.md"]);
  });

  it("keeps a knowledge file a person edited instead of the next draft", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const run = () => bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    await run();
    f.files.set(".dext/project/knowledge/src/core/a.md", "## Responsibility\n\nHand written.");
    f.files.set("src/core/a.ts", "export const a = 2");
    const edited = await run();
    // The edited file wins over the re-drafted prose, and its hash follows the file.
    expect(f.files.get(".dext/project/knowledge/src/core/a.md")).toBe("## Responsibility\n\nHand written.");
    expect(edited.model?.nodes.find(node => node.id === "module:src-core-a-ts")?.body)
      .toEqual({ kind: "document", path: ".dext/project/knowledge/src/core/a.md", contentHash: projectContentHash("## Responsibility\n\nHand written.") });
  });

  it("reuses a matching identity and removes a module whose files moved away", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/core/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts"), memberOf("src/core/b.ts")])]);
    const generate = projectAi({ groups: () => [{ name: "Shared Unit", files: ["src/core/a.ts", "src/core/b.ts"] }] });
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect((await f.store.readModel())?.nodes.filter(node => node.kind === "module").map(node => [node.id, node.paths])).toEqual([
      ["module:src-core-a-ts", ["src/core/a.ts", "src/core/b.ts"]]
    ]);
    // The next run reads only a.ts: the merged identity survives and b.ts is no longer claimed by a stale module.
    const narrowed = fixture([["src/core/a.ts", "export const a = 1"]]);
    narrowed.files.set(".dext/project/model.json", f.files.get(".dext/project/model.json")!);
    const narrowedStructure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    const regrown = await bootstrapProject({ ...narrowed.options, provider: { id: "fixture", generate: projectAi() }, structure: narrowedStructure });
    expect(regrown.model?.nodes.filter(node => node.kind === "module").map(node => [node.id, node.paths])).toEqual([["module:src-core-a-ts", ["src/core/a.ts"]]]);
  });

  it("protects reviewed bodies, keeps out-of-scope modules and rejects a revision conflict", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")])]);
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi() }, structure });
    const saved = (await f.store.readModel())!;
    const outside = projectModelSchema.parse({ ...saved, nodes: [...saved.nodes.map(node => node.id === "module:src-core-a-ts"
      ? { ...node, review: "accepted", freshness: "current", body: { kind: "inline", text: "Reviewed module" } }
      : node.id === "project" ? { ...node, review: "accepted", freshness: "current", body: { kind: "inline", text: "Reviewed goal" } } : node),
      { id: "module:src-other-ts", kind: "module", title: "Other", canonicalName: "Other", body: { kind: "inline", text: "Outside scope" }, paths: ["src/other/x.ts"], review: "draft" },
      { id: "module:src-old-parent", kind: "module", title: "Old", canonicalName: "Old", body: { kind: "inline", text: "Old parent" }, paths: [], review: "draft" }] });
    await f.store.updateProject(outside, saved.revision);
    const updated = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate: projectAi({ titles: new Map([["src/core/a.ts", "Changed"]]) }) }, structure });
    expect(updated.model?.nodes.find(node => node.id === "project")?.body).toEqual({ kind: "document", path: ".dext/project/knowledge/project.md", contentHash: projectContentHash("Reviewed goal") });
    expect(f.files.get(".dext/project/knowledge/project.md")).toBe("Reviewed goal");
    expect(updated.model?.nodes.find(node => node.id === "module:src-core-a-ts")?.body).toEqual({ kind: "document", path: ".dext/project/knowledge/src/core/a.md", contentHash: projectContentHash("Reviewed module") });
    expect(f.files.get(".dext/project/knowledge/src/core/a.md")).toBe("Reviewed module");
    expect(updated.model?.nodes.find(node => node.id === "module:src-other-ts")?.paths).toEqual(["src/other/x.ts"]);
    expect(updated.model?.nodes.some(node => node.id === "module:src-old-parent")).toBe(false);

    const conflicting = projectAi();
    conflicting.mockImplementation(async (request: ProjectAiRequest) => {
      if (request.prompt.includes("Identify developer-facing responsibilities")) {
        const current = (await f.store.readModel())!;
        await f.store.updateProject({ ...current, nodes: current.nodes.map(node => node.id === "project" ? { ...node, body: { kind: "inline", text: "External edit" } } : node) }, current.revision);
        return proposalReply(request);
      }
      if (request.prompt.includes("graph root only")) return rootReply();
      if (request.prompt.includes("runtime architecture only")) return { text: "{}" };
      return proseReply(request);
    });
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate: conflicting }, structure })).rejects.toThrow("revision conflict");
  });

  it("resumes every structured stage from the checkpoint and invalidates it when a source changes", async () => {
    const f = fixture([["src/core/a.ts", "export const a = 1"], ["src/ui/b.ts", "export const b = 2"]]);
    const structure = summaryOf([moduleOf("core", "app", [memberOf("src/core/a.ts")]), moduleOf("ui", "app", [memberOf("src/ui/b.ts")])]);
    const generate = projectAi();
    let calls = 0;
    generate.mockImplementation(async (request: ProjectAiRequest) => {
      calls += 1;
      if (request.prompt.includes("graph root only")) return rootReply();
      if (request.prompt.includes("runtime architecture only")) return { text: "{}" };
      if (request.prompt.includes("Identify developer-facing responsibilities")) return proposalReply(request);
      return proseReply(request);
    });
    const save = f.host.writeFile.bind(f.host);
    f.host.writeFile = async (path, content) => { if (path.endsWith("model.json")) throw new Error("Interrupted commit"); await save(path, content); };
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure })).rejects.toThrow("Interrupted");
    expect(await readBootstrapCheckpoint(f.host)).toMatchObject({ stage: "code:candidate" });
    const checkpoint = JSON.parse(f.files.get(".dext/project/bootstrap.checkpoint.json")!) as { responsibilities?: unknown; prose?: number };
    expect(checkpoint.responsibilities).toHaveLength(2);
    expect(checkpoint.prose).toBe(2);
    f.host.writeFile = save;
    const before = calls;
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    expect(calls).toBe(before);
    expect(await readBootstrapCheckpoint(f.host)).toBeUndefined();

    // A changed source invalidates the whole boundary plan instead of resuming it.
    f.files.set("src/core/a.ts", "export const a = 9");
    const beforeDrift = calls;
    const saveAgain = f.host.writeFile.bind(f.host);
    f.host.writeFile = async (path, content) => { if (path.endsWith("model.json")) throw new Error("Interrupted again"); await saveAgain(path, content); };
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure })).rejects.toThrow("Interrupted again");
    expect(calls).toBeGreaterThan(beforeDrift);
    f.host.writeFile = saveAgain;
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
  });
  it("keeps same-named responsibilities apart and absorbs a supporting parser into its feature", async () => {
    const f = fixture([
      ["src/config/parser.ts", "export const config = 1"],
      ["src/docs/parser.ts", "export const docs = 1"],
      ["src/docs/render.ts", "export const render = 1"],
      ["src/docs/template.ts", "export const template = 1"]
    ]);
    const structure = summaryOf([moduleOf("config", "app", [memberOf("src/config/parser.ts")]),
      moduleOf("docs", "app", [memberOf("src/docs/parser.ts"), memberOf("src/docs/render.ts"), memberOf("src/docs/template.ts")])]);
    const generate = projectAi({ groups: () => [
      { name: "Parser", files: ["src/config/parser.ts"] },
      { name: "Parser", files: ["src/docs/parser.ts", "src/docs/render.ts", "src/docs/template.ts"] }
    ], titles: new Map([["src/config/parser.ts", "Parser"], ["src/docs/parser.ts", "Parser"]]) });
    const initialized = await bootstrapProject({ ...f.options, provider: { id: "fixture", generate }, structure });
    const parsers = initialized.model?.nodes.filter(node => node.kind === "module" && node.title === "Parser");
    expect(parsers?.map(node => node.paths)).toEqual([["src/config/parser.ts"], ["src/docs/parser.ts", "src/docs/render.ts", "src/docs/template.ts"]]);
    expect(parsers?.[0]?.id).not.toBe(parsers?.[1]?.id);
  });
});
