import { describe, expect, it } from "vitest";
import { attachProjectStructure, buildProjectEvidencePackage, ProjectAiGenerationService, type ProjectAiRequest } from "../src/features/project/host/generation/projectAiGeneration.js";
import { buildStructureIndex, structureCacheSchema } from "../src/features/project/host/indexing/projectStructure.js";
import { structureCandidates, type StructureCandidate } from "../src/features/project/host/indexing/projectStructureKnowledge.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));
const fixture = {
  "web/package.json": '{"name":"web"}',
  "web/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  "web/src/main.ts": 'import { Store } from "@/data/store"; import("./view"); export class App { run() {} }',
  "web/src/data/store.ts": 'export interface Store { save(): void }; export const create = () => 1;',
  "web/src/view.tsx": 'export function View() { return <div />; }',
  "web/src/worker.js": 'const x = require("./data/store"); require(variable); export function work() {}',
  "server/Cargo.toml": '[package]\nname = "server"\nversion = "0.1.0"',
  "server/src/lib.rs": 'pub mod api; use crate::api::Request; pub trait Run { fn run(&self); }',
  "server/src/api.rs": 'pub struct Request {} impl Request { pub fn run(&self) {} }',
  "worker/pyproject.toml": '[project]\nname = "worker"',
  "worker/src/tasks/__init__.py": 'from .store import Store\nimport tasks.store\nclass Worker:\n def run(self): pass',
  "worker/src/tasks/store.py": 'class Store:\n def save(self): pass'
};

describe("local multilingual structure index (real WASM parsers)", () => {
  it("distinguishes type-only, mixed, default and side-effect TS imports and re-exports", async () => {
    const index = await buildStructureIndex(inputs({ "src/types.ts": "export interface A {}; export const B = 1; export default B;",
      "src/main.ts": [
        'import type { A } from "./types";', 'import { type A } from "./types";',
        'export type { A } from "./types";', 'export { type A } from "./types";',
        'import { type A, B } from "./types";', 'import B, { type A } from "./types";',
        'import "./types";', 'export * from "./types";'
      ].join("\n") }));
    expect(index.dependencies.map(edge => !!edge.typeOnly)).toEqual([true, true, true, true, false, false, false, false]);
    const member = index.summary.modules.flatMap(module => module.members).find(file => file.path === "src/main.ts")!;
    expect(member.dependencies.map(edge => !!edge.typeOnly)).toEqual([true, true, true, true, false, false, false, false]);
  });
  it("extracts all supported languages and resolves only supported static dependencies", async () => {
    const index = await buildStructureIndex(inputs(fixture));
    expect(index.summary.parsed).toBe(8);
    expect(index.summary.failed).toBe(0);
    expect(new Set(index.cache.files.map(file => file.language))).toEqual(new Set(["typescript", "tsx", "javascript", "rust", "python"]));
    expect(index.cache.files.find(file => file.path.endsWith("store.ts"))?.symbols.map(symbol => symbol.name)).toContain("Store");
    expect(index.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "web/src/main.ts", to: "web/src/data/store.ts", status: "resolved" }),
      expect.objectContaining({ from: "server/src/lib.rs", to: "server/src/api.rs", status: "resolved" }),
      expect.objectContaining({ from: "worker/src/tasks/__init__.py", to: "worker/src/tasks/store.py", status: "resolved" }),
      expect.objectContaining({ specifier: "<dynamic>", status: "unresolved" })
    ]));
    expect(index.summary.modules.reduce((sum, module) => sum + module.files, 0)).toBe(8);
    expect(index.summary.modules.find(module => module.path === "web/src")?.dependsOn).toContain("module:web/src/data");
  });

  it("reuses unchanged parse results, invalidates edits, drops deletions and recomputes config-dependent edges", async () => {
    const first = await buildStructureIndex(inputs(fixture));
    const second = await buildStructureIndex(inputs(fixture), { cache: first.cache });
    expect(second.summary.cached).toBe(first.summary.parsed);
    expect(second.summary.hash).toBe(first.summary.hash);
    const changed = { ...fixture, "web/tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["missing/*"]}}}', "server/src/api.rs": "pub struct NewRequest {}" };
    delete (changed as Record<string, string>)["web/src/view.tsx"];
    const third = await buildStructureIndex(inputs(changed), { cache: second.cache });
    expect(third.summary.cached).toBe(first.summary.parsed - 2);
    expect(third.cache.files.some(file => file.path.endsWith("view.tsx"))).toBe(false);
    expect(third.dependencies.find(edge => edge.specifier === "@/data/store")?.status).toBe("unresolved");
    expect(third.summary.hash).not.toBe(first.summary.hash);
    expect(structureCacheSchema.safeParse({ version: 0, files: [] }).success).toBe(false);
  });

  it("retains coverage beyond 4000 files and reports unsupported, unreadable and malformed sources", async () => {
    const files = Array.from({ length: 4100 }, (_, i) => ({ path: `src/area-${i % 41}/file-${i}.ts`, content: `export function f${i}() {}` }));
    const index = await buildStructureIndex([...files, { path: "src/malformed.py", content: "def broken(" }, { path: "src/secret.ts", issue: "Unreadable" }, { path: "src/unsupported.go", content: "package main" }]);
    expect(index.summary.parsed).toBe(4101);
    expect(index.summary.modules).toHaveLength(42);
    expect(index.summary.modules.reduce((sum, module) => sum + module.files, 0)).toBe(4101);
    expect(index.summary.failed).toBe(2);
    expect(index.summary.unsupported).toBe(1);
    expect(new Set(structureCandidates(index.summary).flatMap(candidate => candidate.files.map(file => file.path))).size).toBe(4101);
  }, 30_000);

  it("honors cancellation without producing a completed snapshot", async () => {
    const controller = new AbortController();
    await expect(buildStructureIndex(inputs(fixture), { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
  });
});

describe("structure-driven AI generation", () => {
  it("redacts signature strings without damaging JSON structure or dropping later files", async () => {
    const index = await buildStructureIndex(inputs({
      'src/auth.ts': 'export function login(password: string, authorization = "fixture-token") {}',
      'src/worker.ts': 'export function run() {}'
    }));
    const original = JSON.stringify(index.summary);
    const evidence = buildProjectEvidencePackage({ files: [{ path: 'README.md', content: 'App' }] });
    const packaged = attachProjectStructure(evidence, index.summary);
    const members = packaged.structure!.modules.flatMap(module => module.members);
    expect(members.map(file => file.path).sort()).toEqual(['src/auth.ts', 'src/worker.ts']);
    expect(members.find(file => file.path === 'src/auth.ts')!.symbols[0]!.signature).toContain('[REDACTED]');
    expect(members.find(file => file.path === 'src/worker.ts')!.symbols[0]!.name).toBe('run');
    expect(JSON.stringify(packaged)).not.toContain('fixture-token');
    expect(JSON.stringify(index.summary)).toBe(original);
    expect(attachProjectStructure(evidence, index.summary).inputHash).toBe(packaged.inputHash);
  });

  async function setup(count = 25) {
    const index = await buildStructureIndex(Array.from({ length: count }, (_, i) => ({ path: `src/core/feature${i}.ts`, content: `export function feature${i}() {}` })));
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: "README.md", content: "A modular application." }] }, { maxTotalChars: 48_000 }), index.summary);
    return { index, evidence };
  }
  function reply(request: ProjectAiRequest, omit = false) {
    const ids = [...new Set(request.prompt.match(/responsibility:[a-f0-9]+/g) ?? [])];
    const brief = { name: "App", summary: "A modular application", evidence: [{ path: "README.md", line: 1 }] };
    if (request.prompt.includes("Optionally describe C4")) return { text: JSON.stringify({ brief,
      capabilities: [{ canonicalName: "Application features", description: "Features provided by the application", contextIds: ids }],
      c4: { systemId: "system:app", elements: [{ id: "system:app", name: "App", kind: "system", contextIds: ids, evidence: brief.evidence }] } }) };
    if (request.prompt.includes("Responsibility outlines:")) {
      const items = JSON.parse(request.prompt.match(/Responsibility outlines: ([^\n]+)/)![1]!) as { id: string; name: string; purpose: string; sourceFiles: string[]; entryPoints: string[] }[];
      return { text: JSON.stringify({ contexts: (omit ? items.slice(1) : items).map(item => ({ canonicalName: item.name, purpose: item.purpose, sourceFiles: item.sourceFiles, entryPoints: item.entryPoints })) }) };
    }
    const candidates = JSON.parse(request.prompt.match(/Candidate file facts: ([^\n]+)/)![1]!) as StructureCandidate[];
    const files = candidates.flatMap(candidate => candidate.files);
    return { text: JSON.stringify({ contexts: (omit ? files.slice(1) : files).map(file => ({ canonicalName: file.path, purpose: "A feature module", sourceFiles: [file.path], entryPoints: [file.path] })) }) };
  }

  it("splits one flat directory into responsibilities across bounded batches, then produces shared C4 knowledge", async () => {
    const { evidence } = await setup();
    const requests: ProjectAiRequest[] = [];
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => { requests.push(request); return reply(request); } }, { maxAttempts: 1 });
    const result = await service.generateIndex(evidence);
    expect(requests).toHaveLength(5);
    expect(result.intent.contexts).toHaveLength(25);
    expect(result.intent.structure).toMatchObject({ parsed: 25, modules: 1, responsibilities: 25 });
    expect(new Set(result.intent.contexts.flatMap(context => context.sourceFiles!)).size).toBe(25);
    expect(result.intent.contexts.every(context => context.structureHash && context.detail === "outline")).toBe(true);
    expect(result.intent.contexts.every(context => context.evidence[0]?.contentHash)).toBe(true);
    expect(result.intent.c4?.systemId).toBe("system:app");
    expect(result.intent.capabilities[0]!.contextIds).toHaveLength(25);
    expect(result.intent.capabilities[0]!.evidence.every(item => item.contentHash)).toBe(true);
    expect(buildProjectTopics(result.intent).find(topic => topic.kind === "context")?.area?.title).toBe("Application features");
    expect(buildProjectTopics(result.intent).some(topic => topic.kind === "system_context")).toBe(true);
  });

  it("rejects missing file ownership instead of silently reducing coverage", async () => {
    const { evidence } = await setup(2);
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => reply(request, true) }, { maxAttempts: 1 });
    await expect(service.generateIndex(evidence)).rejects.toMatchObject({ diagnostics: expect.arrayContaining([expect.stringContaining("Missing source ownership")]) });
  });

  it.each(['missing', 'duplicate', 'unknown'])("rejects %s functional-area membership", async mode => {
    const { evidence } = await setup(2);
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      const response = reply(request);
      if (!request.prompt.includes('Optionally describe C4')) return response;
      const value = JSON.parse(response.text) as { capabilities: { contextIds: string[] }[] };
      const ids = value.capabilities[0]!.contextIds;
      if (mode === 'missing') ids.pop();
      if (mode === 'duplicate') ids.push(ids[0]!);
      if (mode === 'unknown') ids.push('invented');
      return { text: JSON.stringify(value) };
    } }, { maxAttempts: 1 });
    await expect(service.generateIndex(evidence)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it("grounds C4 in targeted source excerpts and rejects lines outside the read window", async () => {
    const path = 'src/worker.ts', content = '// header\n'.repeat(300) + 'export function main() { spawn("node"); }';
    const index = await buildStructureIndex([{ path, content }]);
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [
      { path: 'README.md', content: 'A modular application.' }, { path, content, excerptStartLine: 295 }
    ] }), index.summary);
    const requests: ProjectAiRequest[] = [];
    const service = (line: number) => new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      requests.push(request);
      const response = reply(request);
      if (!request.prompt.includes('Optionally describe C4')) return response;
      const value = JSON.parse(response.text) as { c4: { elements: { evidence: { path: string; line: number }[] }[] } };
      value.c4.elements[0]!.evidence = [{ path, line }];
      return { text: JSON.stringify(value) };
    } }, { maxAttempts: 1 });
    await expect(service(1).generateIndex(evidence)).rejects.toMatchObject({ diagnostics: expect.arrayContaining([expect.stringContaining('outside the supplied excerpt')]) });
    const result = await service(301).generateIndex(evidence);
    expect(result.intent.c4!.elements[0]!.evidence[0]).toMatchObject({ path, line: 301, contentHash: index.cache.files[0]!.hash });
    for (const request of requests.filter(request => request.prompt.includes('Candidate file facts:'))) {
      const input = JSON.parse(request.prompt.match(/Evidence data: ([^\n]+)/)![1]!) as { files: { kind: string }[] };
      expect(input.files.every(file => file.kind !== 'source')).toBe(true);
    }
    expect(requests.at(-1)!.prompt).toContain('"sourceFiles":["src/worker.ts"]');
  });

  it("includes consumers across candidate boundaries so shared helpers are not attributed to one feature", async () => {
    const index = await buildStructureIndex(inputs({
      'src/shared/policy.ts': 'export function check() {}',
      'src/billing/run.ts': 'import { check } from "../shared/policy";',
      'src/search/run.ts': 'import { check } from "../shared/policy";'
    }));
    const helper = structureCandidates(index.summary).flatMap(candidate => candidate.files).find(file => file.path === 'src/shared/policy.ts');
    expect(helper?.consumers).toEqual(['src/billing/run.ts', 'src/search/run.ts']);
  });

  it("retains every file and its declarations beyond the former 3 entry / 12 symbol summary", async () => {
    const index = await buildStructureIndex(Array.from({ length: 80 }, (_, i) => ({ path: `src/core/projectPart${i}.ts`, content: Array.from({ length: 20 }, (_, n) => `export function symbol${i}_${n}() {}`).join('\n') })));
    expect(index.summary.modules).toHaveLength(1);
    expect(index.summary.modules[0]!.members).toHaveLength(80);
    expect(structureCandidates(index.summary).flatMap(candidate => candidate.files).reduce((sum, file) => sum + file.symbols.length, 0)).toBe(1600);
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: "README.md", content: "App" }] }), index.summary);
    const requests: ProjectAiRequest[] = [];
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => { requests.push(request); return reply(request); } }, { maxAttempts: 1 });
    const result = await service.generateIndex(evidence);
    const sent = requests.filter(request => request.prompt.includes("Candidate file facts:")).flatMap(request => (JSON.parse(request.prompt.match(/Candidate file facts: ([^\n]+)/)![1]!) as StructureCandidate[]).flatMap(candidate => candidate.files));
    expect(sent).toHaveLength(80);
    expect(sent.reduce((sum, file) => sum + file.symbols.length, 0)).toBe(1600);
    expect(result.intent.contexts.flatMap(context => context.sourceFiles!)).toHaveLength(80);
  });

  it.each(['duplicate', 'unknown', 'foreign-entry', 'missing-merge'])("rejects %s ownership", async mode => {
    const { evidence } = await setup(mode === 'missing-merge' ? 25 : 2);
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => {
      const response = reply(request);
      if (request.prompt.includes("Optionally describe C4")) return response;
      const parsed = JSON.parse(response.text) as { contexts: { sourceFiles: string[]; entryPoints: string[] }[] };
      if (mode === 'missing-merge' && request.prompt.includes('Responsibility outlines:')) parsed.contexts.shift();
      if (request.prompt.includes('Candidate file facts:')) {
        if (mode === 'duplicate') parsed.contexts[0]!.sourceFiles.push(parsed.contexts[1]!.sourceFiles[0]!);
        if (mode === 'unknown') parsed.contexts[0]!.sourceFiles.push('src/invented.ts');
        if (mode === 'foreign-entry') parsed.contexts[0]!.entryPoints = parsed.contexts[1]!.sourceFiles;
      }
      return { text: JSON.stringify(parsed) };
    } }, { maxAttempts: 1 });
    await expect(service.generateIndex(evidence)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it("allows cross-directory ownership and derives dependencies and stable ids from exact member files", async () => {
    const source = { 'src/core/billing.ts': 'export function invoice() {}', 'src/webview/billingView.ts': 'import { invoice } from "../core/billing";', 'src/core/payments.ts': 'import { invoice } from "./billing";' };
    const index = await buildStructureIndex(inputs(source));
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: 'README.md', content: 'Billing app' }] }), index.summary);
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => request.prompt.includes('Optionally describe C4') || request.prompt.includes('Responsibility outlines:') ? reply(request) : { text: JSON.stringify({ contexts: [
      { canonicalName: 'Billing', purpose: 'Invoice preparation', sourceFiles: ['src/core/billing.ts', 'src/webview/billingView.ts'], entryPoints: ['src/webview/billingView.ts'] },
      { canonicalName: 'Payments', purpose: 'Payments use invoices', sourceFiles: ['src/core/payments.ts'], entryPoints: ['src/core/payments.ts'] }
    ] }) } }, { maxAttempts: 1 });
    const first = await service.generateIndex(evidence), second = await service.generateIndex(evidence);
    expect(first.intent.contexts.map(context => context.id)).toEqual(second.intent.contexts.map(context => context.id));
    expect(first.intent.contexts[1]!.dependsOn).toEqual([first.intent.contexts[0]!.id]);
    expect(buildProjectTopics(first.intent).find(topic => topic.title === 'Billing')?.sourceFiles).toHaveLength(2);
    const changed = await buildStructureIndex(inputs({ ...source, 'src/core/billing.ts': 'export function invoice() { return 1; }' }), { cache: index.cache });
    const refreshed = await service.generateIndex(attachProjectStructure(evidence, changed.summary));
    expect(refreshed.intent.contexts[0]!.id).toBe(first.intent.contexts[0]!.id);
    expect(refreshed.intent.contexts[0]!.structureHash).not.toBe(first.intent.contexts[0]!.structureHash);
    expect(buildProjectTopics(refreshed.intent).find(topic => topic.title === 'Billing')?.basis).not.toBe(buildProjectTopics(first.intent).find(topic => topic.title === 'Billing')?.basis);
  });

  it("reconciles the same responsibilities across batches without losing file ownership", async () => {
    const { evidence } = await setup();
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      if (request.prompt.includes('Optionally describe C4')) return reply(request);
      if (request.prompt.includes('Responsibility outlines:')) {
        const items = JSON.parse(request.prompt.match(/Responsibility outlines: ([^\n]+)/)![1]!) as { id: string; name: string; sourceFiles: string[] }[];
        return { text: JSON.stringify({ contexts: ['Search', 'Completion'].map(name => ({ canonicalName: name, purpose: name, sourceFiles: items.filter(item => item.name === name).flatMap(item => item.sourceFiles), entryPoints: items.filter(item => item.name === name).flatMap(item => item.sourceFiles).slice(0, 6) })) }) };
      }
      const response = JSON.parse(reply(request).text) as { contexts: { canonicalName: string; sourceFiles: string[] }[] };
      for (const context of response.contexts) context.canonicalName = Number(context.sourceFiles[0]!.match(/feature(\d+)/)![1]) % 2 ? 'Search' : 'Completion';
      return { text: JSON.stringify(response) };
    } }, { maxAttempts: 1 });
    const result = await service.generateIndex(evidence);
    expect(result.intent.contexts).toHaveLength(2);
    expect(result.intent.contexts.flatMap(context => context.sourceFiles!)).toHaveLength(25);
    expect(result.intent.contexts.map(context => context.sourceFiles!.length).sort()).toEqual([12, 13]);
  });

  it("consolidates even one source batch and retains uncertainty separately from module purpose", async () => {
    const { evidence } = await setup(2);
    let consolidated = false;
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      if (!request.prompt.includes('Responsibility outlines:')) return reply(request);
      const outlines = JSON.parse(request.prompt.match(/Responsibility outlines: ([^\n]+)/)![1]!) as { id: string; sourceFiles: string[]; declarations: { count: number }[] }[];
      expect(outlines.flatMap(item => item.sourceFiles)).toHaveLength(2);
      expect(outlines.every(item => item.declarations[0]!.count > 0)).toBe(true);
      consolidated = true;
      return { text: JSON.stringify({ contexts: [{ canonicalName: 'Feature execution', purpose: 'Run the feature with its supporting helpers',
        sourceFiles: outlines.flatMap(item => item.sourceFiles), entryPoints: ['src/core/feature0.ts'], uncertainties: ['Does src/core/feature0.ts run before the external service is ready?', 'Runtime verification is required.'] }] }) };
    } }, { maxAttempts: 1 });
    const result = await service.generateIndex(evidence);
    expect(consolidated).toBe(true);
    expect(result.intent.contexts).toHaveLength(1);
    expect(result.intent.contexts[0]).toMatchObject({ sourceFiles: ['src/core/feature0.ts', 'src/core/feature1.ts'], uncertainties: ['Does src/core/feature0.ts run before the external service is ready?'] });
    expect(buildProjectTopics(result.intent).find(topic => topic.kind === 'context')?.uncertainties).toEqual(['Does src/core/feature0.ts run before the external service is ready?']);
  });

  it("reports an oversized file instead of truncating its structure facts", async () => {
    const { evidence } = await setup(1);
    evidence.selection.evidenceChars = 10;
    let calls = 0;
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => { calls++; return reply(request); } });
    await expect(service.generateIndex(evidence)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(calls).toBe(0);
  });

  it("can move a misgrouped helper using file consumers during consolidation", async () => {
    const index = await buildStructureIndex(inputs({
      'src/profiles.ts': 'import { parseConfig } from "./config"; export function profiles() { return parseConfig(); }',
      'src/config.ts': 'export function parseConfig() { return {}; }',
      'src/templates.ts': 'export function renderTemplate() {}'
    }));
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: 'README.md', content: 'An app' }] }), index.summary);
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      if (request.prompt.includes('Optionally describe C4')) return reply(request);
      if (request.prompt.includes('Responsibility outlines:')) {
        const items = JSON.parse(request.prompt.match(/Responsibility outlines: ([^\n]+)/)![1]!) as { declarations: { path: string; consumers: string[] }[] }[];
        expect(items.flatMap(item => item.declarations).find(item => item.path === 'src/config.ts')?.consumers).toEqual(['src/profiles.ts']);
        return { text: JSON.stringify({ contexts: [
          { canonicalName: 'Profiles', purpose: 'Read agent settings', sourceFiles: ['src/profiles.ts', 'src/config.ts'], entryPoints: ['src/profiles.ts'], uncertainties: ['Does src/config.ts accept legacy account fields?', 'This needs runtime verification.', 'Does startup need verification?'] },
          { canonicalName: 'Templates', purpose: 'Render documents', sourceFiles: ['src/templates.ts'], entryPoints: ['src/templates.ts'] }
        ] }) };
      }
      return { text: JSON.stringify({ contexts: [
        { canonicalName: 'Profiles', purpose: 'Read agent settings', sourceFiles: ['src/profiles.ts'], entryPoints: ['src/profiles.ts'] },
        { canonicalName: 'Templates', purpose: 'Render documents', sourceFiles: ['src/templates.ts', 'src/config.ts'], entryPoints: ['src/templates.ts'] }
      ] }) };
    } }, { maxAttempts: 1 });
    const result = await service.generateIndex(evidence);
    expect(result.intent.contexts[0]).toMatchObject({ sourceFiles: ['src/config.ts', 'src/profiles.ts'], uncertainties: ['Does src/config.ts accept legacy account fields?'] });
    expect(result.intent.contexts[1]!.sourceFiles).toEqual(['src/templates.ts']);
  });

  it.each(['retained', 'reassigned', 'unresolved', 'missing-decision', 'duplicate-decision', 'foreign-evidence'])("validates ownership decisions and preserves unresolved warnings: %s", async status => {
    const correct = status === 'reassigned';
    const invalid = ['missing-decision', 'duplicate-decision', 'foreign-evidence'].includes(status);
    const index = await buildStructureIndex(inputs({
      'src/profiles.ts': 'import { parse } from "./config"; export function profiles() { return parse(); }',
      'src/config.ts': 'export function parse() { return {}; }',
      'src/view.ts': 'import type { profiles } from "./profiles"; export function view() {}'
    }));
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ files: [{ path: 'README.md', content: 'App' }] }), index.summary);
    let reviews = 0;
    const groups = (fixed: boolean) => [
      { canonicalName: 'Profiles', purpose: 'Read settings', sourceFiles: fixed ? ['src/profiles.ts', 'src/config.ts'] : ['src/profiles.ts'], entryPoints: ['src/profiles.ts'] },
      { canonicalName: 'View', purpose: 'Display UI', sourceFiles: fixed ? ['src/view.ts'] : ['src/view.ts', 'src/config.ts'], entryPoints: ['src/view.ts'] }
    ];
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      if (request.prompt.includes('Optionally describe C4')) return reply(request);
      if (request.prompt.includes('Ownership review facts:')) {
        reviews++;
        expect(request.prompt).toContain('"typeOnly":true');
        expect(request.prompt).toContain('src/config.ts');
        const decision = { sourcePath: 'src/config.ts', status: invalid ? 'retained' : status,
          reason: correct ? 'Settings parser belongs with profile configuration.' : status === 'retained' ? 'The parser defines the view configuration format consumed by profile setup.' : 'Consumer facts alone do not establish ownership.',
          evidence: [{ path: status === 'foreign-evidence' ? 'src/unread.ts' : 'src/config.ts' }, { path: 'src/profiles.ts' }] };
        return { text: JSON.stringify({ contexts: groups(correct), decisions: status === 'missing-decision' ? [] : status === 'duplicate-decision' ? [decision, decision] : [decision] }) };
      }
      return { text: JSON.stringify({ contexts: groups(false) }) };
    } }, { maxAttempts: 1 });
    if (invalid) {
      await expect(service.generateIndex(evidence)).rejects.toMatchObject({ code: 'invalid_output' });
      expect(reviews).toBe(1);
      return;
    }
    const result = await service.generateIndex(evidence);
    expect(reviews).toBe(1);
    expect(result.intent.contexts.flatMap(context => context.sourceFiles!).sort()).toEqual(['src/config.ts', 'src/profiles.ts', 'src/view.ts']);
    expect(result.intent.qualityIssues?.find(issue => issue.code === 'ownership-review')).toMatchObject({ status });
    expect(result.intent.qualityIssues?.filter(issue => issue.code === 'ownership-review' && issue.status === 'unresolved')).toHaveLength(status === 'unresolved' ? 1 : 0);
    if (status === 'unresolved') expect(buildProjectTopics(result.intent).find(topic => topic.title === 'View')?.qualityWarnings?.[0]).toContain('src/config.ts');
  });

  it.each(['missing', 'duplicate', 'unknown', 'foreign-entry'])("rejects %s files after consolidation reassignment", async mode => {
    const { evidence } = await setup(2);
    const service = new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      const response = reply(request);
      if (!request.prompt.includes('Responsibility outlines:')) return response;
      const value = JSON.parse(response.text) as { contexts: { sourceFiles: string[]; entryPoints: string[] }[] };
      if (mode === 'missing') value.contexts.pop();
      if (mode === 'duplicate') value.contexts[0]!.sourceFiles.push(value.contexts[1]!.sourceFiles[0]!);
      if (mode === 'unknown') value.contexts[0]!.sourceFiles.push('src/invented.ts');
      if (mode === 'foreign-entry') value.contexts[0]!.entryPoints = value.contexts[1]!.sourceFiles;
      return { text: JSON.stringify(value) };
    } }, { maxAttempts: 1 });
    await expect(service.generateIndex(evidence)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it("accepts separate source windows but rejects citations in their unread gap", async () => {
    const path = 'src/transport.ts', content = Array.from({ length: 200 }, (_, i) => `// line ${i + 1}`).join('\n');
    const index = await buildStructureIndex([{ path, content }]);
    const evidence = attachProjectStructure(buildProjectEvidencePackage({ allowMultipleExcerpts: true, files: [
      { path: 'README.md', content: 'Application' },
      { path, content, excerptStartLine: 10, excerptEndLine: 20 },
      { path, content, excerptStartLine: 100, excerptEndLine: 110 }
    ] }), index.summary);
    expect(evidence.inventory.filter(file => file.path === path)).toHaveLength(1);
    expect(evidence.omitted.files).toBe(0);
    const service = (line: number) => new ProjectAiGenerationService({ id: 'fixture', generate: async request => {
      const response = reply(request);
      if (!request.prompt.includes('Optionally describe C4')) return response;
      const value = JSON.parse(response.text) as { c4: { elements: { evidence: { path: string; line: number }[] }[] } };
      value.c4.elements[0]!.evidence = [{ path, line }];
      return { text: JSON.stringify(value) };
    } }, { maxAttempts: 1 });
    await expect(service(15).generateIndex(evidence)).resolves.toBeDefined();
    await expect(service(105).generateIndex(evidence)).resolves.toBeDefined();
    await expect(service(55).generateIndex(evidence)).rejects.toMatchObject({ diagnostics: expect.arrayContaining([expect.stringContaining('outside the supplied excerpt')]) });
  });

  it("cancels between batches and never returns a partial model", async () => {
    const { evidence } = await setup();
    const controller = new AbortController();
    let calls = 0;
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => { calls++; controller.abort(); return reply(request); } }, { maxAttempts: 1 });
    await expect(service.generateIndex(evidence, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

it("discovers literal browser entries without executing build scripts and records gaps", async () => {
  const { browserBuildEntries } = await import("../src/features/project/host/indexing/projectStructureKnowledge.js");
  const found = browserBuildEntries('throw new Error("must not run"); build({ platform: "browser", entryPoints: { main: "src/chat.ts", project: "src/project.ts", dynamic: entries } }); build({platform:"node",entryPoints:["src/host.ts"]});');
  expect(found.paths).toEqual(["src/chat.ts", "src/project.ts"]);
  expect(found.gaps).toContain("Nonliteral browser entry was omitted.");
});

it("reads injected API, sending, and receiving as separate original-line windows", async () => {
  const { runtimeEvidenceWindows } = await import("../src/features/project/host/indexing/projectStructureKnowledge.js");
  const source = 'interface Api { postMessage(message: unknown): void; }\nconst api = (window as Window & { __dextApi?: Api }).__dextApi;\n' + '// gap\n'.repeat(100) + 'api.postMessage({ type: "ready" });\n' + '// gap\n'.repeat(100) + 'window.addEventListener("message", receive);';
  const index = await buildStructureIndex([{ path: "src/view.ts", content: source }]);
  const windows = runtimeEvidenceWindows(source, index.cache.files[0]!, 180);
  expect(windows.map(window => window.category)).toEqual(expect.arrayContaining(["client", "send", "receive"]));
  expect(windows.find(window => window.category === "receive")!.startLine).toBeGreaterThan(190);
});
