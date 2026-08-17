import { describe, expect, it } from "vitest";
import { groupMethodsForDisplay, isSyntheticBuiltinGroup } from "../src/webview/methodGroups.js";
import type { SidebarState } from "../src/webviewProtocol.js";

const method = (id: string, source: "builtin" | "project" = "builtin"): SidebarState["methods"][number] => ({
  id,
  title: id,
  description: id,
  input: [],
  output: { kind: "chat" },
  kind: "command",
  source
});

describe("API panel method groups", () => {
  it("collects public top-level built-ins in one builtin group and preserves ui namespaces", () => {
    const groups = groupMethodsForDisplay([
      method("ask"), method("agent"), method("apply"), method("terminal"),
      method("skill"), method("mcp"), method("print"), method("ui.choose"),
      method("team.deploy", "project")
    ]);

    expect(groups.children.get("builtin")?.methods.map((entry) => entry.id)).toEqual([
      "ask", "agent", "apply", "terminal", "skill", "mcp", "print"
    ]);
    expect(groups.children.get("ui")?.methods.map((entry) => entry.id)).toEqual(["ui.choose"]);
    expect(groups.children.get("team")?.methods.map((entry) => entry.id)).toEqual(["team.deploy"]);
    expect(isSyntheticBuiltinGroup("builtin", "", groups.children.get("builtin")!)).toBe(true);
    expect(isSyntheticBuiltinGroup("ui", "", groups.children.get("ui")!)).toBe(false);
    expect(isSyntheticBuiltinGroup("team", "", groups.children.get("team")!)).toBe(false);
  });
});
