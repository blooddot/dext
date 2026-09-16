import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ArchifyAdapter, type ArchifyIdMapping, type ArchifyRepository } from "../src/core/archifyAdapter.js";
import type { DiagramAdapterDocument } from "../src/core/projectDiagramAdapter.js";
import { validateProjectDiagram, type ProjectDiagram, type ProjectDiagramEvidence } from "../src/core/projectDiagram.js";
import { validateDiagramSemantics } from "../src/core/projectAiGeneration.js";

const runtimeRoot = resolve("vendor/project-diagrams/archify");
const evidence = (path: string, line = 1): ProjectDiagramEvidence[] => [{ path, line }];
const node = (id: string, label: string, role: ProjectDiagram["nodes"][number]["role"], extra: Record<string, unknown> = {}) => ({
  id, label, role, semanticIds: [], evidence: evidence(`src/${id}.ts`), ...extra
});
const relation = (id: string, from: string, to: string, kind: ProjectDiagram["relations"][number]["kind"], extra: Record<string, unknown> = {}) => ({
  id, from, to, kind, evidence: evidence(`src/${id}.ts`), ...extra
});

const architecture: ProjectDiagram = {
  schemaVersion: 1, id: "demo-architecture", title: "示例架构", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [node("web", "Web 前端", "system"), node("api", "API 服务", "service"), node("db", "数据库", "store")],
  relations: [relation("r1", "web", "api", "calls", { label: "HTTPS", order: 1 }), relation("r2", "api", "db", "reads", { label: "SQL", order: 2 })],
  semantics: { boundaries: [{ id: "backend", label: "后端边界", kind: "region", nodeIds: ["api", "db"], evidence: evidence("api") }] }
};

const workflow: ProjectDiagram = {
  schemaVersion: 1, id: "demo-workflow", title: "订单处理流程", kind: "workflow", version: 1, updatedAt: 1,
  nodes: [
    node("n1", "提交订单", "actor", { laneId: "customer" }),
    node("n2", "校验订单", "service", { laneId: "system" }),
    node("n3", "生成订单", "service", { laneId: "system" }),
    node("n4", "收到确认", "actor", { laneId: "customer" }),
    node("e1", "校验失败", "event", { laneId: "exception" })
  ],
  relations: [
    relation("x1", "n1", "n2", "calls", { label: "提交", order: 1 }),
    relation("x2", "n2", "n3", "calls", { label: "通过", order: 2, condition: "金额有效" }),
    relation("x3", "n2", "e1", "unknown", { label: "失败", order: 3, exception: true }),
    relation("x4", "n3", "n4", "returns", { label: "结果", order: 4 })
  ],
  semantics: {
    lanes: [
      { id: "customer", label: "客户", evidence: evidence("n1") },
      { id: "system", label: "系统", evidence: evidence("n2") },
      { id: "exception", label: "异常", variant: "exception", evidence: evidence("e1") }
    ],
    mainPath: ["n1", "n2", "n3", "n4"]
  }
};

const sequence: ProjectDiagram = {
  schemaVersion: 1, id: "demo-sequence", title: "登录时序", kind: "sequence", version: 1, updatedAt: 1,
  nodes: [node("u", "用户", "actor"), node("api", "API", "service"), node("db", "数据库", "store")],
  relations: [
    relation("m1", "u", "api", "calls", { label: "登录请求", order: 1 }),
    relation("m2", "api", "db", "calls", { label: "查询用户", order: 2 }),
    relation("m3", "db", "api", "returns", { label: "用户记录", order: 3 }),
    relation("m4", "api", "u", "returns", { label: "令牌", order: 4, condition: "验证通过" })
  ],
  semantics: {
    participants: [{ nodeId: "u", order: 0 }, { nodeId: "api", order: 1 }, { nodeId: "db", order: 2 }],
    messages: [
      { relationId: "m1", order: 1, kind: "call", evidence: evidence("m1") },
      { relationId: "m2", order: 2, kind: "call", evidence: evidence("m2") },
      { relationId: "m3", order: 3, kind: "return", evidence: evidence("m3") },
      { relationId: "m4", order: 4, kind: "return", evidence: evidence("m4") }
    ]
  }
};

const dataFlow: ProjectDiagram = {
  schemaVersion: 1, id: "demo-data-flow", title: "数据流", kind: "data_flow", version: 1, updatedAt: 1,
  nodes: [node("src", "数据源", "actor", { stageId: "s1" }), node("proc", "处理服务", "service", { stageId: "s2" }), node("store", "存储库", "store", { stageId: "s3" })],
  relations: [relation("f1", "src", "proc", "flows_to", { label: "原始事件", order: 1 }), relation("f2", "proc", "store", "writes", { label: "写入", order: 2 })],
  semantics: {
    stages: [
      { id: "s1", label: "采集", order: 0, evidence: evidence("s1") },
      { id: "s2", label: "处理", order: 1, evidence: evidence("s2") },
      { id: "s3", label: "存储", order: 2, evidence: evidence("s3") }
    ]
  }
};

const lifecycle: ProjectDiagram = {
  schemaVersion: 1, id: "demo-lifecycle", title: "订单生命周期", kind: "lifecycle", version: 1, updatedAt: 1,
  nodes: [node("created", "创建", "state"), node("paid", "已支付", "state"), node("shipped", "已发货", "state"), node("done", "已完成", "state"), node("cancelled", "已取消", "event")],
  relations: [
    relation("t1", "created", "paid", "transitions", { label: "支付", order: 1 }),
    relation("t2", "paid", "shipped", "transitions", { label: "发货", order: 2 }),
    relation("t3", "shipped", "done", "transitions", { label: "签收", order: 3 }),
    relation("t4", "paid", "cancelled", "transitions", { label: "取消", order: 4, condition: "超时" }),
    relation("t5", "cancelled", "paid", "transitions", { label: "重试", order: 5 })
  ],
  semantics: {
    lanes: [{ id: "main", label: "阶段", evidence: evidence("created") }, { id: "terminal", label: "结果", evidence: evidence("done") }],
    states: [
      { nodeId: "created", kind: "initial", evidence: evidence("created") },
      { nodeId: "paid", kind: "normal", evidence: evidence("paid") },
      { nodeId: "shipped", kind: "normal", evidence: evidence("shipped") },
      { nodeId: "done", kind: "terminal", outcome: "success", evidence: evidence("done") },
      { nodeId: "cancelled", kind: "terminal", outcome: "failure", evidence: evidence("cancelled") }
    ],
    transitions: [
      { relationId: "t1", event: "支付", evidence: evidence("t1") },
      { relationId: "t2", event: "发货", evidence: evidence("t2") },
      { relationId: "t3", event: "签收", evidence: evidence("t3") },
      { relationId: "t4", event: "取消", condition: "超时", evidence: evidence("t4") },
      { relationId: "t5", event: "重试", evidence: evidence("t5") }
    ]
  }
};

const fixtures: readonly ProjectDiagram[] = [architecture, workflow, sequence, dataFlow, lifecycle];

/**
 * A local stand-in for the vendored CLI. It mirrors the one upstream restriction the adapter has to
 * respect — `--repo-root` is accepted for architecture diagrams only — so a regression that passes
 * the flag for another kind fails here instead of only in a real git workspace.
 */
const STUB_CLI = `import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const argv = process.argv.slice(2);
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "argv.log"), JSON.stringify(argv) + "\\n");
const [command, type] = argv;
if (argv.includes("--repo-root") && type !== "architecture") {
  process.stdout.write(JSON.stringify({
    ok: false, stage: "arguments",
    error: "--repo-root is currently supported for architecture diagrams only.",
    diagnostics: [{ code: "cli/unsupported-option", severity: "error", message: "--repo-root is currently supported for architecture diagrams only.", supportedFixes: ["remove --repo-root or use an architecture diagram"] }]
  }));
  process.exit(2);
}
if (command === "deliver") writeFileSync(argv[3], "<!DOCTYPE html><html><body>stub</body></html>");
process.stdout.write(JSON.stringify({ ok: true, composition: { status: "passed", summary: { errors: 0, warnings: 0 } } }));
`;

const STUB_ASSETS = [
  "assets/template.html",
  "renderers/architecture/render-architecture.mjs",
  "renderers/workflow/render-workflow.mjs",
  "renderers/sequence/render-sequence.mjs",
  "renderers/dataflow/render-dataflow.mjs",
  "renderers/lifecycle/render-lifecycle.mjs",
  "schemas/architecture.schema.json",
  "schemas/workflow.schema.json",
  "schemas/sequence.schema.json",
  "schemas/dataflow.schema.json",
  "schemas/lifecycle.schema.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md"
] as const;

async function createStubRuntime(): Promise<{ runtimeRoot: string; calls(): Promise<string[][]>; dispose(): Promise<void> }> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "dext-archify-stub-"));
  for (const asset of [...STUB_ASSETS, "bin/archify.mjs"]) {
    const path = join(runtimeRoot, asset);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, asset === "bin/archify.mjs" ? STUB_CLI : "");
  }
  await writeFile(join(runtimeRoot, "package.json"), JSON.stringify({ name: "archify", version: "2.17.0-dev.1" }));
  return {
    runtimeRoot,
    calls: async () => {
      try {
        return (await readFile(join(runtimeRoot, "argv.log"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
      } catch { return []; }
    },
    dispose: () => rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  };
}

describe("ArchifyAdapter", () => {
  it("probes the pinned runtime and its required resources", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    expect(await adapter.probe()).toEqual({ available: true });
    const missing = new ArchifyAdapter(resolve("vendor/project-diagrams"));
    expect((await missing.probe()).available).toBe(false);
    adapter.dispose();
  });

  it("maps all five kinds to the upstream schemas with bidirectional stable ids", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const expectations = [
      ["architecture", (ir: Record<string, unknown>) => (ir["components"] as unknown[]).length === 3 && (ir["boundaries"] as unknown[]).length === 1],
      ["workflow", (ir: Record<string, unknown>) => ir["schema_version"] === 2 && (ir["lanes"] as unknown[]).length === 3 && (ir["nodes"] as Array<{ lane: string }>).every((entry) => entry.lane)],
      ["sequence", (ir: Record<string, unknown>) => (ir["participants"] as unknown[]).length === 3 && (ir["messages"] as unknown[]).length === 4],
      ["data_flow", (ir: Record<string, unknown>) => ir["diagram_type"] === "dataflow" && (ir["stages"] as unknown[]).length === 3],
      ["lifecycle", (ir: Record<string, unknown>) => (ir["lanes"] as Array<{ id: string }>).some((lane) => lane.id === "main") && (ir["lanes"] as Array<{ id: string }>).some((lane) => lane.id === "terminal") && (ir["states"] as unknown[]).length === 5 && (ir["transitions"] as unknown[]).length === 5]
    ] as const;
    for (const [kind, check] of expectations) {
      const fixture = fixtures.find((item) => item.kind === kind)!;
      const document = await adapter.transform(fixture);
      const payload = document.payload as { ir: Record<string, unknown>; mapping: ArchifyIdMapping };
      expect(check(payload.ir), `${kind} upstream mapping`).toBe(true);
      for (const node of fixture.nodes) {
        const archifyId = payload.mapping.ids[node.id];
        expect(archifyId).toBeTruthy();
        expect(payload.mapping.reverseIds[archifyId!]).toBe(node.id);
      }
      for (const item of fixture.relations) {
        const archifyId = payload.mapping.relationIds[item.id];
        expect(archifyId).toBeTruthy();
        expect(payload.mapping.reverseRelationIds[archifyId!]).toBe(item.id);
      }
    }
    adapter.dispose();
  });

  it("rejects diagrams whose kind semantics are missing", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const invalid: ProjectDiagram = { ...workflow, semantics: { ...workflow.semantics, lanes: [] } };
    expect(validateDiagramSemantics(invalid).length).toBeGreaterThan(0);
    await expect(adapter.transform(invalid)).rejects.toThrow("lane");
    adapter.dispose();
  });

  it("renders real native HTML for all five kinds and validates the result", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    for (const fixture of fixtures) {
      const document = await adapter.transform(fixture);
      const artifact = await adapter.render(document, { format: "html" });
      expect(artifact.format).toBe("html");
      expect(artifact.mimeType).toBe("text/html");
      expect(artifact.adapterId).toBe("archify");
      expect(artifact.adapterVersion).toContain("2.17.0-dev.1");
      expect(String(artifact.content)).toContain("<!DOCTYPE html>");
      const receipt = await adapter.validate(document);
      expect(receipt.status).not.toBe("failed");
      expect(validateProjectDiagram(fixture).filter((issue) => issue.severity === "error")).toEqual([]);
    }
    adapter.dispose();
  }, 120_000);

  it("handles branches, multiple lanes, more than six steps, long Chinese labels and state cycles", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const steps = Array.from({ length: 9 }, (_, index) => node(`s${index}`, `步骤 ${index + 1}：非常长的中文标签用于验证换行与布局`, index % 2 === 0 ? "service" : "actor", { laneId: "main" }));
    const longWorkflow: ProjectDiagram = {
      schemaVersion: 1, id: "long-workflow", title: "超过六步的长流程", kind: "workflow", version: 1, updatedAt: 1,
      nodes: [...steps, node("blocked", "被阻塞", "event", { laneId: "exception" })],
      relations: [
        ...steps.slice(0, -1).map((step, index) => relation(`p${index}`, step.id, steps[index + 1]!.id, "calls", { label: `下一步 ${index + 1}`, order: index + 1 })),
        relation("block", "s3", "blocked", "unknown", { label: "失败", order: 20, exception: true })
      ],
      semantics: { lanes: [{ id: "main", label: "主流程", evidence: evidence("s0") }, { id: "exception", label: "异常处理", variant: "exception", evidence: evidence("blocked") }], mainPath: steps.map((step) => step.id) }
    };
    expect((await adapter.render(await adapter.transform(longWorkflow))).content.length).toBeGreaterThan(0);
    expect((await adapter.render(await adapter.transform(lifecycle))).content.length).toBeGreaterThan(0);
    adapter.dispose();
  }, 120_000);

  it("renders more than 24 nodes without truncating the artifact", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const nodes = Array.from({ length: 30 }, (_, index) => node(`n${index}`, `服务 ${index + 1}`, "service"));
    const relations = nodes.slice(1).map((entry, index) => relation(`e${index}`, nodes[index]!.id, entry.id, "depends_on", { label: "调用", order: index + 1 }));
    const big: ProjectDiagram = { schemaVersion: 1, id: "big-architecture", title: "大型架构", kind: "architecture", version: 1, updatedAt: 1, nodes, relations };
    const artifact = await adapter.render(await adapter.transform(big));
    const html = String(artifact.content);
    for (const entry of nodes) expect(html).toContain(entry.label);
    expect((html.match(/data-node-id=/g) ?? []).length).toBeGreaterThanOrEqual(30);
    adapter.dispose();
  }, 60_000);

  it("requires the live viewer for SVG export instead of extracting an SVG from HTML", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const document = await adapter.transform(architecture);
    await expect(adapter.render(document, { format: "svg" })).rejects.toThrow("viewer");
    adapter.dispose();
  });

  it("returns understandable diagnostics instead of throwing for invalid upstream input", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    const document = await adapter.transform(architecture);
    const broken: DiagramAdapterDocument = { ...document, payload: { ...(document.payload as object), ir: { schema_version: 1, diagram_type: "workflow", meta: { title: "Broken" }, lanes: [], nodes: [], edges: [] } } };
    const receipt = await adapter.validate(broken);
    expect(receipt.status).toBe("failed");
    expect(receipt.issues.length).toBeGreaterThan(0);
    adapter.dispose();
  }, 60_000);

  it("attaches repository evidence to architecture only and still renders every other kind", async () => {
    const stub = await createStubRuntime();
    const repository: ArchifyRepository = { root: stub.runtimeRoot, url: "https://example.test/repo.git", revision: "a".repeat(40) };
    const adapter = new ArchifyAdapter(stub.runtimeRoot, async () => repository);
    try {
      const architectureDocument = await adapter.transform(architecture);
      const architecturePayload = architectureDocument.payload as { ir: Record<string, unknown>; evidenceAttached: boolean };
      expect(architecturePayload.evidenceAttached).toBe(true);
      expect((architecturePayload.ir["meta"] as Record<string, unknown>)["repository"]).toBeTruthy();
      expect(JSON.stringify(architecturePayload.ir)).toContain("sources");
      await expect(adapter.render(architectureDocument)).resolves.toMatchObject({ format: "html" });

      // Upstream rejects `--repo-root` for every other kind, so the adapter must not send it and
      // the diagram must not carry repository metadata either.
      for (const fixture of [workflow, sequence, dataFlow, lifecycle]) {
        const document = await adapter.transform(fixture);
        const payload = document.payload as { ir: Record<string, unknown>; evidenceAttached: boolean };
        expect(payload.evidenceAttached, `${fixture.kind} evidence`).toBe(false);
        expect((payload.ir["meta"] as Record<string, unknown>)["repository"], `${fixture.kind} meta`).toBeUndefined();
        expect(JSON.stringify(payload.ir), `${fixture.kind} sources`).not.toContain("sources");
        await expect(adapter.render(document), `${fixture.kind} render`).resolves.toMatchObject({ format: "html" });
      }

      const calls = await stub.calls();
      expect(calls.find((argv) => argv[1] === "architecture")).toContain("--repo-root");
      for (const kind of ["workflow", "sequence", "dataflow", "lifecycle"]) {
        const call = calls.find((argv) => argv[1] === kind);
        expect(call, `${kind} call`).toBeDefined();
        expect(call, `${kind} args`).not.toContain("--repo-root");
      }
    } finally {
      adapter.dispose();
      await stub.dispose();
    }
  }, 120_000);
});
