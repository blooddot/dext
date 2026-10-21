import { describe, expect, it, vi } from "vitest";
import { projectWorkspaceSettingsSchema, projectWorkspaceSettingsFromDefinition } from "../src/features/project/contracts/projectSettings.js";

vi.mock("vscode", () => ({ workspace: {} }));

describe("Project workspace settings", () => {
  it("uses explicit project paths", () => {
    const settings = projectWorkspaceSettingsFromDefinition({
      paths: { planDirectory: ".project/plans", apiDirs: ["tools/api"], skillDirs: ["tools/skills"], mcpDirs: ["tools/mcp"] }
    });
    expect(settings).toEqual({ planDirectory: ".project/plans", apiDirs: ["tools/api"], skillDirs: ["tools/skills"], mcpDirs: ["tools/mcp"] });
  });

  it("uses built-in defaults when project paths are missing or partial", () => {
    expect(projectWorkspaceSettingsFromDefinition(undefined)).toEqual({
      planDirectory: ".dext/plans", apiDirs: [], skillDirs: [], mcpDirs: []
    });
    expect(projectWorkspaceSettingsFromDefinition({ paths: { apiDirs: ["tools/api"] } })).toEqual({
      planDirectory: ".dext/plans", apiDirs: ["tools/api"], skillDirs: [], mcpDirs: []
    });
  });

  it("rejects project paths that can escape the workspace", () => {
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: "../plans", apiDirs: [], skillDirs: [] }).success).toBe(false);
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: ".dext/plans", apiDirs: ["C:/api"], skillDirs: [] }).success).toBe(false);
    expect(projectWorkspaceSettingsSchema.safeParse({ planDirectory: ".dext/plans", apiDirs: [], skillDirs: ["tools/skills"], mcpDirs: [] }).success).toBe(true);
  });
});
