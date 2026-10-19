import { describe, expect, it, vi } from "vitest";
import { buildProjectTopics, checkProjectTopics, topicDiagramRequirement, topicFingerprint } from "../src/core/projectTopics.js";
import { projectIntentSchema } from "../src/core/projectIntent.js";
import { renderProjectTopics } from "../src/webview/projectTopicsView.js";

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
      capabilities: [{ id: 'area.execution', canonicalName: 'Workflow <execution>', description: 'Run reusable workflows', contextIds: ['ctx.code'] }]
    }).capabilities[0]!];
    const topics = buildProjectTopics(saved), topic = topics[0]!;
    expect(topic.id).toBe(before.id);
    expect(topic.basis).toBe(before.basis);
    expect(topic.area).toEqual({ id: 'area.execution', title: 'Workflow <execution>', description: 'Run reusable workflows' });
    const html = renderProjectTopics(topics);
    expect(html).toContain('data-reader-area="area.execution"');
    expect(html).toContain('Workflow &lt;execution&gt;');
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
});
