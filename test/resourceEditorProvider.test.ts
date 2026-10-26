import { describe, expect, it } from "vitest";
import type { ResourceEntry } from "../src/features/resources/contracts/resourceDocuments.js";
import { buildResourceDefinition, buildResourceList, filterResourceEntries, groupResourceEntries, renderResourceDefinition, renderResourceList } from "../src/features/resources/presentation/resourceDocuments.js";

const entry = (name: string, path: string, kind: ResourceEntry["kind"] = "api"): ResourceEntry => ({
  id: `${kind}:project:${path}`, kind, scope: "project", name, path, group: path.split("/").slice(0, -1).join("/") || ".",
  source: { kind: "project", label: "Project", path: `.dext/${kind}/${path}` }
});

const entries = [entry("Task.Query", "Task/Query.ts"), entry("Task.Stats", "Task/Stats.ts"), entry("User.Get", "User/Get.ts")];

describe("resource documents", () => {
  it("groups entries by directory and searches by name", () => {
    const list = buildResourceList({ kind: "api", scope: "project", entries, query: "stats" });
    expect(list.entries.map((item) => item.name)).toEqual(["Task.Stats"]);
    expect(list.groups.map((group) => group.label)).toEqual(["Task"]);
    expect(groupResourceEntries(entries).map((group) => group.label)).toEqual(["Task", "User"]);
  });

  it("keeps every entry for an empty query", () => {
    expect(filterResourceEntries(entries, "  ")).toHaveLength(3);
  });

  it("renders search, grouping, source jumps and reference insertion", () => {
    const list = renderResourceList(buildResourceList({ kind: "api", scope: "project", entries }));
    expect(list).toContain('data-resource-search');
    expect(list).toContain('data-resource-group="Task"');
    expect(list).toContain('data-resource-open="api:project:Task/Query.ts"');
    const detail = renderResourceDefinition(buildResourceDefinition(entries[0]!, "export async function main(): Promise<AskResult> { ... }"));
    expect(detail).toContain("openResourceSource");
    expect(detail).toContain("insertResourceReference");
    expect(detail).toContain("export async function main()");
  });

  it("escapes resource content and names", () => {
    // The page's own client script is expected; the resource name must not become markup.
    const list = renderResourceList(buildResourceList({ kind: "api", scope: "project", entries: [entry("<script>", "Task/X.ts")] }))
      .replace(/<script>[\s\S]*?<\/script>/g, "");
    expect(list).not.toContain("<script>");
    expect(list).toContain("&lt;script&gt;");
  });

  it("offers source management actions only for managed files, with custom command prefixes in every layout", () => {
    const source = entry("review", "review/SKILL.md", "skill");
    const builtin: ResourceEntry = { ...source, id: "builtin", source: { kind: "directory", label: "builtin", path: "/builtin/SKILL.md" } };
    const list = buildResourceList({ kind: "skill", scope: "project", entries: [source, builtin] });
    for (const layout of [{}, { categoryTree: true }, { apiTree: true }]) {
      const html = renderResourceList(list, { ...layout, commandPrefix: "custom" });
      for (const command of ["openResourceSource", "openResourceFolder", "deleteResource"]) {
        expect(html.match(new RegExp(`data-resource-command="custom\\.${command}"`, "g"))).toHaveLength(1);
      }
      expect(html).toContain('aria-label="Delete resource"');
      expect(html).not.toContain('data-resource-command="dext.deleteResource"');
    }
  });
});
