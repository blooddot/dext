import { describe, expect, it, vi } from "vitest";
import { describeApiFlow } from "../src/features/workflow/host/apiFlow.js";
import { describeApiSource } from "../src/features/workflow/host/apiSource.js";
import { createFileResourceDataSource } from "../src/features/resources/host/resourceEditorProvider.js";
import { buildResourceDefinition, renderResourceDefinition } from "../src/features/resources/presentation/resourceDocuments.js";
import { renderApiFlow, renderApiFlowMermaid } from "../src/features/resources/presentation/apiFlowDiagram.js";
import type { ApiFlow } from "../src/features/workflow/contracts/apiFlow.js";

describe("API flow analysis", () => {
  it("reads declarations, arrows, export aliases and their direct calls", async () => {
    const flow = await describeApiFlow(`import { ask } from "dext";
function helper(): void {}
const viaArrow = () => helper();
export { viaArrow as run };
export function entry(): void { helper(); }`);
    expect(flow.functions.map((fn) => [fn.name, fn.exported, fn.calls, fn.unused])).toEqual([
      ["helper", false, [], false],
      ["viaArrow", true, ["helper"], false],
      ["entry", true, ["helper"], false]
    ]);
    expect(flow.edges).toEqual([
      { from: "viaArrow", to: "helper", line: 3 },
      { from: "entry", to: "helper", line: 5 }
    ]);
    expect(flow.issues).toEqual([]);
  });

  it("resolves aliased named imports and namespace member calls to top-level API labels", async () => {
    const flow = await describeApiFlow(`import { ask as askAlias, agent } from "dext";
import * as ai from "dext";
function helper() {}
function askForPlan() { return askAlias({}); }
function runAgent() { return ai.agent({}); }
function runPlan() { return ai["plan"]({}); }
export function entry() { askForPlan(); runAgent(); runPlan(); helper(); }`);
    const byName = new Map(flow.functions.map((fn) => [fn.name, fn]));
    expect(byName.get("askForPlan")?.apiCalls).toEqual([{ tag: "ask", line: 4, callee: "askAlias" }]);
    expect(byName.get("runAgent")?.apiCalls).toEqual([{ tag: "agent", line: 5, callee: "ai.agent" }]);
    expect(byName.get("runPlan")?.apiCalls).toEqual([{ tag: "plan", line: 6, callee: 'ai["plan"]' }]);
    expect(byName.get("helper")?.apiCalls).toEqual([]);
    expect(flow.issues).toEqual([]);
    expect(flow.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      "entry->askForPlan", "entry->runAgent", "entry->runPlan", "entry->helper"
    ]);
  });

  it("keeps recursion and marks functions unreachable from an export as unused", async () => {
    const flow = await describeApiFlow(`export function loop(n: number): number { return n ? loop(n - 1) : 0; }
function orphan(): void {}`);
    expect(flow.functions.map((fn) => [fn.name, fn.unused])).toEqual([["loop", false], ["orphan", true]]);
    expect(flow.edges).toEqual([{ from: "loop", to: "loop", line: 1 }]);
    expect(flow.issues).toEqual([]);
  });

  it("recognises function expressions and default-exported local functions", async () => {
    const flow = await describeApiFlow(`function helper(): number { return 1; }
const expression = function named() { return helper(); };
export default expression;`);
    expect(flow.functions.map((fn) => [fn.name, fn.exported, fn.calls])).toEqual([
      ["helper", false, []],
      ["expression", true, ["helper"]]
    ]);
    expect(flow.functions.some((fn) => fn.unused)).toBe(false);
  });

  it("merges overloads into one implementation node and recognises default exports", async () => {
    const flow = await describeApiFlow(`export function run(x: string): string;
export function run(x: number): number;
export function run(x: string | number): string | number { return String(x); }
export default function () {}`);
    expect(flow.functions.map((fn) => [fn.name, fn.exported, fn.line])).toEqual([["run", true, 3], ["default", true, 4]]);
  });

  it("reports multiple top-level API calls from one function", async () => {
    const flow = await describeApiFlow(`import { ask, agent } from "dext";
export function entry() { return Promise.all([ask({}), agent({})]); }`);
    expect(flow.issues.map((issue) => issue.rule)).toEqual(["multiple-api-calls"]);
    expect(flow.issues[0]).toMatchObject({ severity: "error", function: "entry", line: 2 });
    expect(flow.issues[0]?.message).toContain("ask and agent");
    expect(flow.issues[0]?.suggestion).toContain("wrapper");
  });

  it("reports a top-level API wrapper that also composes a local helper", async () => {
    const flow = await describeApiFlow(`import { ask } from "dext";
function prepare() {}
function askForPlan() { prepare(); return ask({}); }
export function entry() { return askForPlan(); }`);
    expect(flow.issues.map((issue) => [issue.rule, issue.function])).toEqual([["api-wrapper-composes", "askForPlan"]]);
    expect(flow.issues[0]?.message).toContain("prepare");
  });

  it("ignores calls in comments, strings, nested functions and callbacks", async () => {
    const flow = await describeApiFlow(`import { ask, agent } from "dext";
export function entry() {
  // ask({})
  const text = "agent({})";
  const template = \`plan({})\`;
  const nested = () => ask({});
  [1].forEach(() => agent({}));
  return text + template + nested.name;
}`);
    expect(flow.functions[0]?.apiCalls).toEqual([]);
    expect(flow.functions[0]?.calls).toEqual([]);
    expect(flow.issues).toEqual([]);
  });

  it("parses without executing a module whose top level throws", async () => {
    const flow = await describeApiFlow(`import { agent } from "dext";
throw new Error("must not run");
export function commit() { return agent({}); }`);
    expect(flow.functions.map((fn) => fn.name)).toEqual(["commit"]);
    expect(flow.issues).toEqual([]);
  });

  it("fails safely on broken syntax and on modules without functions", async () => {
    expect(await describeApiFlow("export function broken(input: ): {")).toEqual({ functions: [], edges: [], issues: [] });
    expect(await describeApiFlow("export interface Shape { x: number }")).toEqual({ functions: [], edges: [], issues: [] });
  });
});

describe("API flow entry statements", () => {
  const source = `export async function demo() {
  const a = await prepare();
  if (!a) return "bad";
  await run(a);
  while (true) { if (await again()) break; }
  return "ok";
}`;

  it("walks the entry statements in source order with decisions, loops and an exit per branch", async () => {
    const entry = (await describeApiFlow(source, undefined, "demo")).entry!;
    expect(entry.name).toBe("demo");
    expect(entry.steps.map((step) => [step.kind, step.label])).toEqual([
      ["entry", "demo L1"],
      ["step", "prepare L2"],
      ["decision", "!a"],
      ["end", "结束"],
      ["step", "run L4"],
      ["loop", "true"],
      ["decision", "await again()"],
      ["end", "结束"]
    ]);
    // A branch's `return` closes where it stands: one shared end node at the bottom
    // would draw a rail down the whole diagram for every guard clause.
    expect(entry.steps.filter((step) => step.kind === "end")).toHaveLength(2);
    expect(entry.edges).toEqual([
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3, label: "yes" },
      { from: 2, to: 4, label: "no" },
      { from: 4, to: 5 },
      { from: 5, to: 6 },
      { from: 6, to: 5, label: "no" },
      { from: 5, to: 7 },
      // `break` leaves the loop, so its branch keeps an arrow to what follows the loop.
      { from: 6, to: 7, label: "yes" }
    ]);
  });

  it("keeps a short string literal in a condition and folds a long one", async () => {
    const entry = (await describeApiFlow(`export function demo() {
  if (state.label === "no-plan") return 1;
  if (state.label === "a value far too long to fit in one box") return 2;
  return 3;
}`, undefined, "demo")).entry!;
    const decisions = entry.steps.filter((step) => step.kind === "decision").map((step) => step.label);
    expect(decisions[0]).toBe('state.label === "no-plan"');
    expect(decisions[1]).toBe("state.label === …");
  });

  it("tags a step that calls a wrapper or a top-level API", async () => {
    const entry = (await describeApiFlow(`import { ask } from "dext";
function askForPlan() { return ask({}); }
export async function demo() { await askForPlan(); }`, undefined, "demo")).entry!;
    expect(entry.steps[1]).toEqual({ id: 1, kind: "step", label: "askForPlan L3", tag: "ask" });
  });

  it("renders the entry flow top-to-bottom with decisions, the end nodes and ordered edges", async () => {
    const flow = await describeApiFlow(source, undefined, "demo");
    const mermaid = renderApiFlowMermaid(flow);
    expect(mermaid.startsWith("flowchart TB")).toBe(true);
    expect(mermaid).toContain('n0(["demo L1 · entry"])');
    expect(mermaid).toContain('n2{"!a"}');
    expect(mermaid).toContain('n3(["结束"])');
    expect(mermaid).toContain('n7(["结束"])');
    expect(mermaid).toContain("n0 --> n1");
    expect(mermaid).toContain("n2 -->|yes| n3");
    expect(mermaid).toContain("n6 -->|no| n5");
    // `break` leaves the loop, so its branch keeps an arrow to what follows the loop.
    expect(mermaid).toContain("n6 -->|yes| n7");
    expect(mermaid).toContain("n5 --> n7");
    expect(mermaid).toContain("class n0 entry");
    expect(renderApiFlow(flow, "demo")).toContain("data-api-flow-source");
  });

  it("falls back to the call graph when the entry is missing, ambiguous or unparseable", async () => {
    const missing = await describeApiFlow("export function other() { return 1; }", undefined, "demo");
    expect(missing.entry).toBeUndefined();
    expect(missing.functions.map((fn) => fn.name)).toEqual(["other"]);
    const ambiguous = await describeApiFlow("export function demo() { return 1; }\nexport const demo = () => 2;", undefined, "demo");
    expect(ambiguous.entry).toBeUndefined();
    expect(renderApiFlowMermaid(ambiguous).startsWith("flowchart LR")).toBe(true);
    const broken = await describeApiFlow("export async function demo( {", undefined, "demo");
    expect(broken).toEqual({ functions: [], edges: [], issues: [] });
    expect(renderApiFlow(broken, "demo")).toBe("");
  });

  it("takes the entry from the file name and never from main", async () => {
    expect((await describeApiFlow("export async function demo() {}", undefined, "demo")).entry?.name).toBe("demo");
    // The name the compatibility period accepted: it is not an entry point any more.
    const legacy = "main";
    const flow = await describeApiFlow(`export async function ${legacy}() {}`, undefined, "demo");
    expect(flow.entry).toBeUndefined();
    expect(renderApiFlowMermaid(flow).startsWith("flowchart LR")).toBe(true);
  });
});

describe("API flow presentation", () => {
  const flow: ApiFlow = {
    functions: [
      { name: "main", line: 2, exported: true, calls: ["askForPlan", "runAgent"], apiCalls: [], unused: false },
      { name: "askForPlan", line: 5, exported: false, calls: [], apiCalls: [{ tag: "ask", line: 6, callee: "ask" }], unused: false },
      { name: "runAgent", line: 9, exported: false, calls: [], apiCalls: [{ tag: "agent", line: 10, callee: "agent" }], unused: false }
    ],
    edges: [
      { from: "main", to: "askForPlan", line: 3 },
      { from: "main", to: "runAgent", line: 4 }
    ],
    issues: []
  };

  it("emits a stable Mermaid flowchart with entry, wrapper and helper shapes", () => {
    const source = renderApiFlowMermaid(flow);
    expect(source.startsWith("flowchart LR")).toBe(true);
    expect(source).toContain('n0(["main L2 · entry"])');
    expect(source).toContain('n1[["askForPlan L5 · ask"]]');
    expect(source).toContain('n2[["runAgent L9 · agent"]]');
    expect(source).toContain("n0 --> n1");
    expect(source).toContain("n0 --> n2");
    expect(source).toContain("classDef violation");
  });

  it("marks violating nodes with their own class and unused nodes as unused", () => {
    const source = renderApiFlowMermaid({
      ...flow,
      functions: [
        { ...flow.functions[0]!, apiCalls: [{ tag: "ask", line: 3, callee: "ask" }, { tag: "agent", line: 3, callee: "agent" }] },
        { ...flow.functions[1]!, unused: true }
      ],
      issues: [{ rule: "multiple-api-calls", severity: "error", function: "main", line: 2, message: "m", suggestion: "s" }]
    });
    expect(source).toContain("class n0 violation");
    expect(source).toContain("class n1 unused");
  });

  it("renders a self-contained shell and escapes names and Mermaid source", () => {
    const unsafe: ApiFlow = {
      functions: [{ name: "<script>alert(1)</script>", line: 1, exported: true, calls: [], apiCalls: [{ tag: "ask", line: 2, callee: "ask" }], unused: false }],
      edges: [],
      issues: []
    };
    const html = renderApiFlow(unsafe, "unsafe");
    expect(html).toContain("data-api-flow");
    expect(html).toContain('data-api-flow-state="loading"');
    expect(html).toContain("data-api-flow-preview");
    expect(html).toContain("data-api-flow-source");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('style="');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderApiFlowMermaid(unsafe)).not.toContain("<");
    expect(html).toMatch(/<details class="resource-api-flow-source"[^>]*><summary>/);
    expect(renderApiFlow(undefined, "empty")).toBe("");
    expect(renderApiFlow({ functions: [], edges: [], issues: [] }, "empty")).toBe("");
  });

  it("inserts the flow between the API signature and Source", () => {
    const content = `import { agent } from "dext";\nexport function commit() { return agent({}); }`;
    return describeApiSource(content).then(async (apiFunctions) => {
      const entry = {
        id: "api:project:git/commit.ts", kind: "api" as const, scope: "project" as const, name: "git.commit",
        path: "git/commit.ts", group: "git", source: { kind: "project" as const, label: "Project" },
        api: apiFunctions[0]!.api, apiFunctions, apiFlow: await describeApiFlow(content)
      };
      const html = renderResourceDefinition(buildResourceDefinition(entry, content));
      expect(html.indexOf("Execution flow")).toBeGreaterThan(html.indexOf("<h3>Returns</h3>"));
      expect(html.indexOf("Execution flow")).toBeLessThan(html.indexOf("resource-source-heading"));
    });
  });

  it("parses the flow only for a detail page, never for the list", async () => {
    const content = `import { ask } from "dext";\nexport function flow() { return ask({}); }`;
    const describe = vi.fn((content: string, entryName?: string) => describeApiFlow(content, undefined, entryName));
    const files = createFileResourceDataSource({
      roots: () => ({ project: "/project/.dext" }),
      listFiles: async (kind) => kind === "api" ? [{ name: "dev.flow", path: "dev/flow.ts", scope: "project" as const }] : [],
      readFile: async () => content,
      describeApi: describeApiSource,
      describeApiFlow: describe
    });
    const list = await files.list(["api"], "");
    expect(list[0]?.apiFlow).toBeUndefined();
    expect(describe).not.toHaveBeenCalled();
    const detail = await files.definition(list[0]!.id);
    expect(describe).toHaveBeenCalledOnce();
    expect(detail?.entry.apiFlow?.functions.map((fn) => fn.name)).toEqual(["flow"]);
  });
});
