import { describe, expect, it, vi } from "vitest";
import { projectWorkspaceSettingsSchema, projectWorkspaceSettingsFromDefinition } from "../src/core/projectSettings.js";

vi.mock("vscode", () => ({ workspace: {} }));

describe("Project workspace settings", () => {
  it("uses project values over legacy plugin values", () => {
    const settings = projectWorkspaceSettingsFromDefinition({
      paths: { planDirectory: ".project/plans", apiDirs: ["tools/api"], skillDirs: ["tools/skills"], mcpDirs: ["tools/mcp"] }
    }, { planDirectory: ".old-plans", apiDirs: ["old/api"], skillDirs: ["old/skills"], mcpDirs: ["old/mcp"] });
    expect(settings).toEqual({ planDirectory: ".project/plans", apiDirs: ["tools/api"], skillDirs: ["tools/skills"], mcpDirs: ["tools/mcp"] });
  });

  it("filters legacy absolute paths before displaying them as portable project settings", () => {
    const settings = projectWorkspaceSettingsFromDefinition(undefined, {
      planDirectory: ".dext/plans", apiDirs: ["tools/api", "C:/private/api"], skillDirs: ["tools/skills", "../outside"], mcpDirs: ["tools/mcp", "../outside"]
    });
    expect(settings.apiDirs).toEqual(["tools/api"]);
    expect(settings.skillDirs).toEqual(["tools/skills"]);
    expect(settings.mcpDirs).toEqual(["tools/mcp"]);
  });

  it("rejects project paths that can escape the workspace", () => {
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: "../plans", apiDirs: [], skillDirs: [] }).success).toBe(false);
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: ".dext/plans", apiDirs: ["C:/api"], skillDirs: [] }).success).toBe(false);
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: ".dext/plans", apiDirs: [], skillDirs: ["tools/skills"], mcpDirs: [] }).success).toBe(true);
  });
});
