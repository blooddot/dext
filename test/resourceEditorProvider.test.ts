import { describe, expect, it } from "vitest";
import type { ResourceEntry } from "../src/resourceDocuments.js";
import { applyResourceEdit, buildResourceDefinition, buildResourceList, filterResourceEntries, groupResourceEntries, renderResourceDefinition, renderResourceList } from "../src/resourceDocuments.js";

const entry = (name: string, path: string, kind: ResourceEntry["kind"] = "api"): ResourceEntry => ({
  id: `${kind}:project:${path}`, kind, scope: "project", name, path, group: path.split("/").slice(0, -1).join("/") || ".",
  source: { kind: "project", label: "Project", path: `.dext/${kind}/${path}` }
});

const entries = [entry("Task.Query", "Task/Query.dx"), entry("Task.Stats", "Task/Stats.dx"), entry("User.Get", "User/Get.dx")];

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
    expect(list).toContain('data-resource-open="api:project:Task/Query.dx"');
    const detail = renderResourceDefinition(buildResourceDefinition(entries[0]!, "def main() -> AskResult:\n  pass"));
    expect(detail).toContain("openResourceSource");
    expect(detail).toContain("insertResourceReference");
    expect(detail).toContain("def main()");
  });

  it("reports a concurrent edit as a conflict instead of overwriting", () => {
    const document = buildResourceDefinition(entries[0]!, "one");
    expect(applyResourceEdit(document, "two", "one")).toEqual({ status: "applied", content: "two" });
    expect(applyResourceEdit(document, "one", "one")).toEqual({ status: "unchanged", content: "one" });
    expect(applyResourceEdit(document, "two", "someone-else")).toEqual({ status: "conflict", content: "someone-else" });
  });

  it("escapes resource content and names", () => {
    // The page's own client script is expected; the resource name must not become markup.
    const list = renderResourceList(buildResourceList({ kind: "api", scope: "project", entries: [entry("<script>", "Task/X.dx")] }))
      .replace(/<script>[\s\S]*?<\/script>/g, "");
    expect(list).not.toContain("<script>");
    expect(list).toContain("&lt;script&gt;");
  });
});
