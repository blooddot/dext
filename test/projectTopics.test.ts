import { describe, expect, it, vi } from "vitest";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import { buildProjectTopics, checkProjectTopics, readingOrder, topicDiagramRequirement, topicFingerprint } from "../src/features/project/knowledge/projectTopics.js";
import { renderProjectTopics } from "../src/features/project/presentation/projectTopicsView.js";

const intent = () => projectIntentSchema.parse({
  schemaVersion: 1, updatedAt: 1,
  brief: { name: "Example" },
  contexts: [{ id: "ctx.code", canonicalName: "Code execution", purpose: "Run TypeScript", responsibilities: ["Execute modules"], entryPoints: ["src/kernel.ts:run"], evidence: [{ path: "src/kernel.ts", contentHash: "old" }] }],
  flows: [{ id: "flow.run", canonicalName: "Run a module", trigger: "Submit Code", steps: [{ id: "step.run", label: "Run module", contextId: "ctx.code", evidence: [{ path: "src/kernel.ts", contentHash: "old" }] }], evidence: [{ path: "src/old.ts" }] }],
  constraints: [{ id: "rule", scope: ["ctx.code"], statement: "Await tracked calls", evidence: [{ path: "src/kernel.ts", contentHash: "old" }] }, { id: "unrelated", scope: ["ctx.other"], statement: "Unrelated rule" }]
});

describe("Project topics", () => {
  it("groups module navigation by generated capabilities without changing analysis identities", () => {
    const saved = intent();
    const before = buildProjectTopics(saved)[0]!;
    saved.capabilities = [projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: 'Example' },
      capabilities: [{ id: 'area.execution', canonicalName: 'Workflow <execution>', description: 'Run **reusable** workflows', contextIds: ['ctx.code'] }]
    }).capabilities[0]!];
    const topics = buildProjectTopics(saved), topic = topics[0]!;
    expect(topic.id).toBe(before.id);
    expect(topic.basis).toBe(before.basis);
    expect(topic.area).toEqual({ id: 'area.execution', title: 'Workflow <execution>', description: 'Run **reusable** workflows' });
    const html = renderProjectTopics(topics);
    expect(html).toContain('data-reader-area="area.execution"');
    expect(html).toContain('Workflow &lt;execution&gt;');
    expect(html).toContain('<div class="project-help project-reader-area-note"><p>Run <strong>reusable</strong> workflows</p>');
    expect(html).toContain('data-project-norm="ctx.code"');
    expect(html).toContain('data-reader-topic="flow.run"');
    expect(renderProjectTopics(buildProjectTopics(intent()))).not.toContain('data-reader-area=');
  });
  it("projects stable topics with scoped constraints and step evidence, without guessing relationships", () => {
    const topics = buildProjectTopics(intent());
    expect(topics.map((topic) => topic.id)).toEqual(["ctx.code", "flow.run"]);
    expect(topics[0]!.constraints).toEqual(["Await tracked calls"]);
    expect(topics[0]!.evidence).toHaveLength(1);
    expect(topics[1]!.evidence.map((entry) => entry.path)).toEqual(["src/old.ts", "src/kernel.ts"]);
    expect(topics[1]!.entryPoints).toEqual(["Submit Code"]);
    expect(topicDiagramRequirement(topics[1]!)).toContain("unverified historical hypothesis");
  });

  it("reads a dependency before the topic that depends on it", () => {
    const topics = (dependsOn?: string[]) => buildProjectTopics(projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" },
      contexts: [
        { id: "ctx.alpha", canonicalName: "Alpha", purpose: "Reuse the beta module", responsibilities: [], entryPoints: [], evidence: [], ...(dependsOn ? { dependsOn } : {}) },
        { id: "ctx.beta", canonicalName: "Beta", purpose: "Provide the reused behavior", responsibilities: [], entryPoints: [], evidence: [] }
      ] }));
    expect(readingOrder(topics()).map((topic) => topic.id)).toEqual(["ctx.alpha", "ctx.beta"]);
    const ordered = topics(["ctx.beta"]);
    expect(ordered[0]!.dependsOn).toEqual(["ctx.beta"]);
    expect(readingOrder(ordered).map((topic) => topic.id)).toEqual(["ctx.beta", "ctx.alpha"]);
  });

  it("keeps every topic when dependencies form a cycle", () => {
    const cyclic = buildProjectTopics(projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" },
      contexts: [
        { id: "ctx.a", canonicalName: "A", purpose: "First", responsibilities: [], entryPoints: [], evidence: [], dependsOn: ["ctx.b"] },
        { id: "ctx.b", canonicalName: "B", purpose: "Second", responsibilities: [], entryPoints: [], evidence: [], dependsOn: ["ctx.a"] }
      ] }));
    const first = readingOrder(cyclic).map((topic) => topic.id);
    expect(first).toHaveLength(2);
    expect([...first].sort()).toEqual(["ctx.a", "ctx.b"]);
    expect(readingOrder(cyclic).map((topic) => topic.id)).toEqual(first);
  });

  it("deduplicates source reads and reports changed, missing and unverifiable evidence honestly", async () => {
    const topics = buildProjectTopics(intent());
    const snapshot = vi.fn(async (path: string) => path === "src/kernel.ts" ? { contentHash: "new" } : undefined);
    const results = await checkProjectTopics(topics, snapshot, 10);
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(results.map((result) => result.state)).toEqual(["changed", "missing"]);
    expect(results[0]).toMatchObject({ checkedAt: 10, fingerprint: topicFingerprint(topics[0]!) });
    const unchanged = await checkProjectTopics(topics, async () => ({ contentHash: "old" }));
    expect(unchanged.map((result) => result.state)).toEqual(["unchanged", "unknown"]);
    const unreadable = await checkProjectTopics(topics, async () => { throw new Error("Permission denied"); });
    expect(unreadable.every((result) => result.state === "unknown")).toBe(true);
    expect((await checkProjectTopics([{ ...topics[0]!, evidence: [] }], snapshot))[0]!.state).toBe("unknown");
  });

  it("uses the same step IDs and evidence in prose and diagrams, and only records explicit transitions", () => {
    const saved = intent();
    saved.flows[0]!.steps.push({ ...saved.flows[0]!.steps[0]!, id: "step.finish", label: "Finish", description: "Wait for pending calls", nextStepIds: [] });
    let topic = buildProjectTopics(saved)[1]!;
    expect(topic.diagram!.relations).toEqual([]);
    saved.flows[0]!.steps[0]!.nextStepIds = ["step.finish"];
    topic = buildProjectTopics(saved)[1]!;
    expect(topic.sections![1]).toMatchObject({ id: "step.finish", description: "Wait for pending calls", relatedTopicIds: ["ctx.code"] });
    expect(topic.diagram!.nodes[1]).toMatchObject({ id: "step.finish", semanticIds: ["step.finish", "ctx.code"], description: topic.sections![1]!.description, evidence: topic.sections![1]!.evidence });
    expect(topic.diagram!.relations).toMatchObject([{ from: "step.run", to: "step.finish" }]);
    expect(topic.relatedTopics).toEqual([{ id: "ctx.code", title: "Code execution" }]);
  });

  it("includes evidence of linked saved views in the topic freshness check", async () => {
    const topic = buildProjectTopics(intent())[1]!;
    const diagram = { ...topic.diagram!, id: "focused", metadata: { topicId: topic.id }, nodes: [{ ...topic.diagram!.nodes[0]!, evidence: [{ path: "src/new.ts", contentHash: "old" }] }] };
    const linked = buildProjectTopics(intent(), [diagram])[1]!;
    expect(linked.diagrams).toContainEqual({ id: "focused", title: diagram.title });
    expect(topicFingerprint(linked)).not.toEqual(topicFingerprint(topic));
    const checks = await checkProjectTopics([linked], async (path) => ({ contentHash: path === "src/new.ts" ? "new" : "old" }));
    expect(checks[0]!.state).toBe("changed");
  });

  it("does not reuse a check after content changes and escapes topic content", async () => {
    const topics = buildProjectTopics(intent());
    const checks = await checkProjectTopics(topics, async () => ({ contentHash: "old" }));
    const changed = [{ ...topics[0]!, description: '<img src=x onerror="bad()">' }];
    const html = renderProjectTopics(changed, checks);
    expect(html).toContain("These are saved source references.");
    expect(html).not.toContain("Evidence unchanged · checked");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
  it("renders a saved module tree and its overview children", () => {
    const saved = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" },
      contexts: [
        { id: "ctx.group", canonicalName: "Runtime modules", purpose: "Groups executable modules", responsibilities: [], entryPoints: [], evidence: [] },
        { id: "ctx.code", canonicalName: "Code execution", purpose: "Run TypeScript", parentId: "ctx.group", responsibilities: [], entryPoints: [], evidence: [] }
      ] });
    const topics = buildProjectTopics(saved);
    expect(topics.map(topic => [topic.id, topic.parentId])).toEqual([["ctx.group", undefined], ["ctx.code", "ctx.group"]]);
    const html = renderProjectTopics(topics);
    expect(html).toContain('data-topic-node="ctx.group"');
    expect(html).toContain('data-topic-children="ctx.group"');
    expect(html).toContain('data-reader-toggle="ctx.group"');
    expect(html).toContain('data-reader-topic="ctx.code"');
    // The parent article is a readable overview that links to its saved children.
    expect(html).toContain("Grouped modules · 1");
  });
  it("shows directory groupings at the top level and marks them apart from responsibilities", () => {
    const saved = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [
      { id: "ctx.src", canonicalName: "src", overview: true, responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.features", canonicalName: "features", overview: true, parentId: "ctx.src", responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.chat", canonicalName: "chat", overview: true, parentId: "ctx.features", responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.turn", canonicalName: "Turn execution", parentId: "ctx.chat", responsibilities: [], entryPoints: [], evidence: [] }
    ] });
    const topics = buildProjectTopics(saved);
    expect(topics.find(topic => topic.id === "ctx.chat")?.overview).toBe(true);
    const html = renderProjectTopics(topics);
    // src and features only hold other groupings, so they are not indentation levels.
    expect(html).not.toContain('data-topic-node="ctx.src"');
    expect(html).not.toContain('data-topic-node="ctx.features"');
    expect(html).toContain('data-topic-children="ctx.chat"');
    expect(html).toContain('<small class="project-reader-review">Directory grouping</small>');
  });
  it("keeps a grouping that also holds modules instead of lifting them to the top level", () => {
    const saved = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" }, contexts: [
      { id: "ctx.project", canonicalName: "project", overview: true, responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.host", canonicalName: "host", overview: true, parentId: "ctx.project", responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.store", canonicalName: "ProjectStore", parentId: "ctx.project", responsibilities: [], entryPoints: [], evidence: [] },
      { id: "ctx.fs", canonicalName: "VscodeProjectFileHost", parentId: "ctx.host", responsibilities: [], entryPoints: [], evidence: [] }
    ] });
    const html = renderProjectTopics(buildProjectTopics(saved));
    expect(html).toContain('data-topic-children="ctx.project"');
    expect(html.indexOf('data-topic-node="ctx.store"')).toBeGreaterThan(html.indexOf('data-topic-children="ctx.project"'));
  });
});
