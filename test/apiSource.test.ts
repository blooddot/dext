import { describe, expect, it, vi } from "vitest";
import { describeApiSource } from "../src/core/apiSource.js";
import { createApiDataSource, createFileResourceDataSource } from "../src/features/resources/host/resourceEditorProvider.js";
import { buildResourceDefinition, buildResourceList } from "../src/features/resources/presentation/resourceDocuments.js";
import { renderApiDetail, renderApiList } from "../src/features/resources/presentation/apiPanel.js";
import { renderGlobalResources } from "../src/features/resources/presentation/globalResourcesPanel.js";

const commitSource = `import { agent, type AgentResult } from "dext";
throw new Error("Browsing must not execute this module");
/** Split changes into Conventional Commits.
 * @param input - Additional instructions.
 */
export function commit(input = ""): Promise<AgentResult> { return agent({ input }); }`;

describe("file API documentation", () => {
  it("reads types, literal defaults and JSDoc without executing the module", async () => {
    expect(await describeApiSource(commitSource)).toEqual([{
      name: "commit", description: "Split changes into Conventional Commits.",
      api: {
        signature: "commit(input?: string) -> Promise<AgentResult>",
        parameters: [{ name: "input", type: "string", required: false, defaultValue: '""', description: "Additional instructions." }],
        returnType: "Promise<AgentResult>"
      }
    }]);
  });

  it("preserves nested generic/callback types, optional and rest parameters", async () => {
    const [item] = await describeApiSource(`export const map = <T extends { id: string }>(
      callback: (value: T, index: number) => Promise<Map<string, T[]>>,
      options?: { strict: boolean; keys: [string, number] }, ...rest: T[]
    ): Promise<T[]> => callback(rest[0], 0);`);
    expect(item?.api.typeParameters).toBe("<T extends { id: string }>");
    expect(item?.api.parameters).toEqual([
      { name: "callback", type: "(value: T, index: number) => Promise<Map<string, T[]>>", required: true },
      { name: "options", type: "{ strict: boolean; keys: [string, number] }", required: false },
      { name: "...rest", type: "T[]", required: false }
    ]);
    expect(item?.api.returnType).toBe("Promise<T[]>");
  });

  it("documents overloads, local export aliases and default exports without leaking helpers", async () => {
    const result = await describeApiSource(`function helper() {}
      export function run(x: string): string;
      export function run(x: number): number;
      export function run(x: string | number): string | number { return x; }
      const local = (enabled = true): void => {};
      export { local as toggle };
      export default local;
      export { external } from "./other";`);
    expect(result.map(item => item.name)).toEqual(["run", "run", "toggle", "default"]);
    expect(result.slice(0, 2).map(item => item.api.returnType)).toEqual(["string", "number"]);
    expect(result[2]?.api.parameters[0]).toEqual({ name: "enabled", type: "boolean", required: false, defaultValue: "true" });
  });

  it("does not invent types or signatures from function bodies or broken declarations", async () => {
    expect(await describeApiSource("export function broken(input: ): {" )).toEqual([]);
    expect(await describeApiSource("export interface Shape { x: number }; const hidden = () => 3;")).toEqual([]);
    const [item] = await describeApiSource("export default (value = loadSomething()) => value;");
    expect(item?.api.parameters[0]?.type).toBe("unknown");
    expect(item?.api.returnType).toBe("unknown");
  });

  it("uses the same live file metadata and highlighted markup in Resources and APIs", async () => {
    let content: string | undefined = commitSource;
    const readFile = vi.fn(async () => content);
    const files = createFileResourceDataSource({
      roots: () => ({ project: "/project/.dext" }),
      listFiles: async kind => kind === "api" ? [{ name: "git.commit", path: "git/commit.ts", scope: "project" }] : [],
      readFile, describeApi: describeApiSource
    });
    const apis = createApiDataSource({ methods: () => [], files });
    const fromResources = await files.list(["api"], "");
    const fromApis = await apis.list(["api"], "");
    expect(fromResources).toEqual(fromApis);
    const resourcesHtml = renderGlobalResources(buildResourceList({ kind: "api", scope: "project", entries: fromResources, groupBy: "kind" }), { createKinds: ["api"] });
    const apisHtml = renderApiList(buildResourceList({ kind: "api", scope: "project", entries: fromApis }));
    const signature = (html: string) => html.match(/<code class="resource-entry-signature">([\s\S]*?)<\/code>/)?.[1];
    expect(signature(resourcesHtml)).toBe(signature(apisHtml));
    expect(signature(resourcesHtml)).toContain('class="tok-propertyName">input');
    expect(signature(resourcesHtml)).toContain('class="tok-typeName">AgentResult');
    const id = fromResources[0]!.id;
    const file = (await files.definition(id))!;
    expect(file).toEqual(await apis.definition(id));
    const detail = renderApiDetail(buildResourceDefinition(file.entry, file.content));
    expect(detail).toContain("<h3>Parameters</h3>");
    expect(detail).toContain("<h3>Returns</h3>");
    expect(detail).toContain("Additional instructions.");
    expect(detail).toContain('class="tok-keyword">export');
    expect(detail).toContain('class="tok-string">&quot;dext&quot;');
    expect(await files.list(["api"], "AgentResult")).toHaveLength(1);
    readFile.mockClear();
    await files.list(["skill", "rule", "mcp"], "");
    expect(readFile).not.toHaveBeenCalled();
    content = "export function commit(count = 2): number { return count; }";
    expect((await files.list(["api"], ""))[0]?.api?.returnType).toBe("number");
    expect((await files.definition(id))?.entry.api?.parameters[0]?.name).toBe("count");
    content = undefined;
    expect((await files.list(["api"], ""))[0]?.api).toBeUndefined();
    expect(await files.definition(id)).toBeUndefined();
  });

  it("keeps colliding built-in and file API identities through rendering and detail actions", async () => {
    const files = createFileResourceDataSource({
      roots: () => ({ global: "/global" }),
      listFiles: async () => [{ name: "ask", path: "ask.ts", scope: "global" }],
      readFile: async () => "export function main(): void {}", describeApi: describeApiSource
    });
    const apis = createApiDataSource({ methods: () => [{ id: "ask", kind: "command", source: "builtin", title: "Ask", description: "Ask", input: [], output: { kind: "ask" } }], files });
    const entries = await apis.list(["api"], "");
    const html = renderApiList(buildResourceList({ kind: "api", scope: "global", entries }));
    expect(html).toContain('data-resource-open="file:api:global:ask.ts"');
    const file = (await apis.definition("file:api:global:ask.ts"))!;
    expect(renderApiDetail(buildResourceDefinition(file.entry, file.content))).toContain('data-resource-id="file:api:global:ask.ts"');
    const builtin = (await apis.definition("api:global:ask.ts"))!;
    expect(renderApiDetail(buildResourceDefinition(builtin.entry, builtin.content))).not.toContain('class="resource-source-heading"');
  });

  it("renders every exported signature and escapes source markup", async () => {
    const content = 'export function first(): string { return "<script>alert(1)</script>"; } export const second = (x: number): number => x;';
    const apiFunctions = await describeApiSource(content);
    const entry = { id: "api:project:tools.ts", kind: "api" as const, scope: "project" as const, name: "tools", path: "tools.ts", group: ".", source: { kind: "project" as const, label: "Project" }, apiFunctions, api: apiFunctions[0]!.api };
    const html = renderApiDetail(buildResourceDefinition(entry, content));
    expect(html.match(/<h3>Parameters<\/h3>/g)).toHaveLength(2);
    expect(html).toContain('class="tok-function">first');
    expect(html).toContain('class="tok-function">second');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
