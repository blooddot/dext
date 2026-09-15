import { describe, expect, it } from "vitest";
import type { ArchitectureScanResult } from "../src/core/projectArchitecture.js";
import { buildProjectEvidencePackage, parseProjectAiResponse, ProjectAiGenerationError, ProjectAiGenerationService, type ProjectAiProvider, validateProjectAiModel } from "../src/core/projectAiGeneration.js";
import type { ProjectAiActivityEvent, ProjectAiGeneratedModel } from "../src/core/projectAiGeneration.js";

const scan: ArchitectureScanResult = {
  modules: [
    { id: "app", name: "Application", language: "typescript", paths: ["src/app.ts"], source: "detected" },
    { id: "store", name: "Store", language: "typescript", paths: ["src/store.ts"], source: "detected" }
  ],
  relations: [{ from: "app", to: "store", source: "detected", confidence: 0.9, file: "src/app.ts", line: 3, reason: "imports store" }],
  unsupported: [], parserVersions: { typescript: "fixture" }, coverage: ["typescript/compiler"]
};

const files = [
  { path: "README.md", content: "# Example\nA task application." },
  { path: "package.json", content: '{"name":"example","scripts":{"build":"tsc"}}' },
  { path: "src/app.ts", content: "import { store } from './store';\nexport function start() { return store.load(); }" , symbols: ["start", "store"] },
  { path: "src/store.ts", content: "export function load() { return []; }", symbols: ["load"] },
  { path: ".env", content: "API_KEY=should-not-be-included" },
  { path: "../outside.ts", content: "secret" }
] as const;

const validResponse = (): ProjectAiGeneratedModel => ({
  intent: {
    schemaVersion: 1,
    brief: { name: "Example", summary: "Task application", goals: [], runtime: [], audiences: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "README.md", line: 1, contentHash: "" }] },
    capabilities: [{ id: "tasks", canonicalName: "TaskManagement", description: "Manage tasks", contextIds: ["app-context"], moduleIds: ["app"], outcomes: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "src/app.ts", symbol: "start", line: 2 }] }],
    contexts: [{ id: "app-context", canonicalName: "TaskApplication", purpose: "Application boundary", moduleIds: ["app"], dependsOn: [], relatedContextIds: [], entryPoints: [], responsibilities: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "src/app.ts", line: 2 }] }],
    flows: [{ id: "load-tasks", canonicalName: "LoadTasks", description: "Load tasks", steps: [{ id: "start", label: "Start", contextId: "app-context", moduleId: "app", nextStepIds: ["read"], evidence: [{ path: "src/app.ts", symbol: "start", line: 2 }] }, { id: "read", label: "Read store", moduleId: "store", nextStepIds: [], evidence: [{ path: "src/store.ts", symbol: "load", line: 1 }] }], outcomes: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "src/app.ts", line: 2 }] }],
    terms: [{ id: "task", canonicalName: "Task", aliases: ["todo"], forbiddenNames: [], definition: "A unit of work", contextIds: ["app-context"], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "README.md", line: 2 }] }],
    constraints: [{ id: "typed", statement: "Use TypeScript", rationale: "", scope: [], origin: "inferred", review: "draft", freshness: "current", confidence: 0.8, evidence: [{ path: "package.json", line: 1 }] }], decisions: [], updatedAt: 1
  },
  diagrams: [{ schemaVersion: 1, id: "architecture", title: "Architecture", kind: "architecture", nodes: [
    { id: "app", label: "Application", role: "system", semanticIds: ["app-context"], evidence: [{ path: "src/app.ts", line: 2 }] },
    { id: "store", label: "Store", role: "store", semanticIds: [], evidence: [{ path: "src/store.ts", line: 1 }]
  }], relations: [{ id: "app-store", from: "app", to: "store", kind: "calls", confidence: 0.8, review: "draft", freshness: "current", evidence: [{ path: "src/app.ts", line: 1 }] }], version: 0, updatedAt: 1, confidence: 0.8, review: "draft", freshness: "current" }]
});

function packageInput() { return buildProjectEvidencePackage({ projectName: "Example", scan, files }); }

describe("Project AI evidence package", () => {
  it("bounds files, redacts secrets and records deterministic input", () => {
    const first = packageInput(); const second = packageInput();
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.files.map((file) => file.path)).not.toContain(".env");
    expect(first.files.map((file) => file.path)).not.toContain("../outside.ts");
    expect(first.files.find((file) => file.path === "README.md")?.text).toContain("Example");
    expect(first.characterCount).toBe(JSON.stringify(first).length);
    expect(first.omitted.files).toBe(2);
  });

  it("enforces total and per-file budgets while preserving omission counts", () => {
    const bounded = buildProjectEvidencePackage({ scan, files }, { maxFileChars: 64, maxTotalChars: 2_048, maxFiles: 2, maxModules: 1, maxRelations: 0 },);
    expect(bounded.files.length).toBeLessThanOrEqual(2);
    expect(bounded.characterCount).toBeLessThanOrEqual(2_048);
    expect(bounded.omitted.files).toBeGreaterThan(0);
  });

  it("parses and validates strict structured output with evidence", () => {
    const input = packageInput();
    const output = validResponse();
    // Fill content hashes from the bounded input to model a provider's valid response.
    output.intent.brief.evidence[0]!.contentHash = input.files.find((file) => file.path === "README.md")!.contentHash;
    const parsed = parseProjectAiResponse(JSON.stringify(output), input);
    expect(parsed.intent.capabilities[0]!.review).toBe("draft");
    expect(parsed.diagrams[0]!.kind).toBe("architecture");
  });

  it("accepts JSON wrapped in a model explanation or markdown fence", () => {
    const input = packageInput();
    const output = validResponse();
    output.intent.brief.evidence[0]!.contentHash = input.files.find((file) => file.path === "README.md")!.contentHash;
    const json = JSON.stringify(output);
    expect(parseProjectAiResponse(`Here is the project model:\n\n${json}`, input).intent.brief.name).toBe("Example");
    expect(parseProjectAiResponse(`I generated this model:\n\n\`\`\`json\n${json}\n\`\`\``, input).diagrams[0]!.id).toBe("architecture");
  });

  it("accepts an intent-shaped root response from conversation models", () => {
    const input = packageInput();
    const output = validResponse();
    output.intent.brief.evidence[0]!.contentHash = input.files.find((file) => file.path === "README.md")!.contentHash;
    const root = { ...output.intent, diagrams: output.diagrams };
    const parsed = parseProjectAiResponse(JSON.stringify(root), input);
    expect(parsed.intent.contexts[0]!.id).toBe("app-context");
    expect(parsed.diagrams).toHaveLength(1);
  });

  it("rejects malformed JSON, unsupported evidence and dangling diagram relations", () => {
    const input = packageInput();
    expect(() => parseProjectAiResponse("not json", input)).toThrowError(ProjectAiGenerationError);
    const model = validResponse();
    model.diagrams[0]!.relations[0]!.to = "missing";
    expect(validateProjectAiModel(model, input).some((error) => error.includes("dangling_relation"))).toBe(true);
    model.intent.brief.evidence = [{ path: "src/nope.ts" }];
    expect(validateProjectAiModel(model, input).some((error) => error.includes("not included"))).toBe(true);
  });

  it("retries invalid output and stamps inferred draft provenance", async () => {
    const input = packageInput(); const value = validResponse();
    value.intent.brief.evidence[0]!.contentHash = input.files.find((file) => file.path === "README.md")!.contentHash;
    let calls = 0;
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: (++calls === 1) ? "{}" : JSON.stringify(value), model: "mock-model" }) };
    const result = await new ProjectAiGenerationService(provider, { timeoutMs: 2_000, now: () => 42 }).generate(input);
    expect(calls).toBe(2); expect(result.metadata.attempts).toBe(2); expect(result.intent.brief.origin).toBe("inferred"); expect(result.intent.brief.review).toBe("draft");
    expect(result.intent.generatedAt).toBe(42);
  });

  it("reports live CLI activity and the actual validation results of each attempt", async () => {
    const events: ProjectAiActivityEvent[] = [];
    const input = packageInput(); const value = validResponse();
    value.intent.brief.evidence[0]!.contentHash = input.files.find((file) => file.path === "README.md")!.contentHash;
    const provider: ProjectAiProvider = { id: "mock", generate: async (request) => {
      request.onEvent?.({ id: "cli-output", phase: "message", text: "Preparing the project model." });
      expect(events.some((event) => event.id === "cli-output")).toBe(true);
      return { text: request.attempt === 1 ? "{}" : JSON.stringify(value) };
    } };
    await new ProjectAiGenerationService(provider).generate(input, { onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.title === "AI analysis attempt failed")).toEqual([
      expect.objectContaining({ text: expect.stringContaining("intent:"), done: true })
    ]);
    expect(events).toContainEqual(expect.objectContaining({ title: "Retrying AI analysis", text: expect.stringContaining("Attempt 2 of 2") }));
    expect(events.at(-1)).toMatchObject({ title: "AI output validated", text: "Validated project knowledge and 1 diagram.", done: true });
  });

  it("reports the terminal provider error before rejecting", async () => {
    const events: ProjectAiActivityEvent[] = [];
    const provider: ProjectAiProvider = { id: "failed", generate: async () => ({ text: "CLI authentication expired.", finishReason: "error" }) };
    await expect(new ProjectAiGenerationService(provider, { maxAttempts: 1 }).generate(packageInput(), { onEvent: (event) => events.push(event) })).rejects.toMatchObject({
      code: "provider_error", diagnostics: ["CLI authentication expired."]
    });
    expect(events.at(-1)).toMatchObject({ title: "AI analysis attempt failed", text: expect.stringContaining("CLI authentication expired.") });
  });

  it("cancels a provider without waiting for it to resolve", async () => {
    const provider: ProjectAiProvider = { id: "hanging", generate: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
    const controller = new AbortController(); const promise = new ProjectAiGenerationService(provider, { timeoutMs: 10_000 }).generate(packageInput(), { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  });

  it("fails explicitly when no Project provider is configured", async () => {
    await expect(new ProjectAiGenerationService(undefined).generate(packageInput())).rejects.toMatchObject({ code: "unavailable" });
  });
});
