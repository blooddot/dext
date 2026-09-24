import { describe, expect, it, vi } from "vitest";
import { projectEvidenceSettingsSchema, resolveProjectEvidenceSettings, projectPromptLimits } from "../src/core/projectEvidenceSettings.js";
import { ProjectStore, defaultProjectDefinition } from "../src/projectStore.js";

vi.mock("vscode", () => ({ workspace: {} }));

describe("Project-owned reading settings", () => {
  it("saves and reloads per project, preserving unrelated settings and rejecting stale edits", async () => {
    const { createProjectPanelDataSource, effectiveProjectEvidenceSettings } = await import("../src/vscodeProjectHost.js");
    const files = new Map<string, string>();
    const host = {
      readFile: async (path: string) => files.get(path),
      writeFile: async (path: string, value: string) => { files.set(path, value); },
      deleteFile: async (path: string) => { files.delete(path); },
      listDirectory: async () => []
    };
    const store = new ProjectStore(host);
    await store.writeDefinition({ ...defaultProjectDefinition(), ai: { cli: "claude" }, scan: { roots: ["src"] } }, 0);
    const source = () => createProjectPanelDataSource({
      name: "Example", root: ".", rootUri: {} as never,
      store: {
        readDefinition: () => store.readDefinition(),
        writeDefinition: (value, version) => store.writeDefinition(value, version),
        readObjects: async () => [], readArchitecture: async () => ({ decisions: [] })
      },
      readEvidence: vi.fn(),
      legacyEvidenceSettings: () => ({ depth: "deep", files: 234, include: [] })
    });
    const panel = source();
    const loaded = await panel.load();
    expect(loaded.overview.evidenceSettings).toEqual({ depth: "deep", files: 234, include: ["src/**"] });
    const before = files.get(".dext/project.json");
    await expect(panel.setEvidenceSettings!({ depth: "whole", files: 0, include: [] }, 1)).rejects.toThrow();
    expect(files.get(".dext/project.json")).toBe(before);
    await panel.setEvidenceSettings!({ depth: "whole", include: [] }, loaded.overview.evidenceSettingsVersion!);
    const saved = await new ProjectStore(host).readDefinition();
    expect(saved.ai).toEqual({ cli: "claude" });
    expect(saved.scan).toEqual({ roots: ["src"] });
    expect((await source().load()).overview).toMatchObject({ evidenceSettings: { depth: "whole", include: [] }, evidenceSettingsVersion: 2 });
    expect((await source().load()).overview.legacyScanRoots).toBeUndefined();
    // Empty scope saved in Project must replace old scan roots and all legacy overrides.
    const limits = resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(saved, { depth: "standard", files: 1, include: ["old/**"] }));
    expect(limits).toMatchObject({ maxFiles: 1000, maxEvidenceChars: 1_200_000, include: [], preset: "whole" });
    expect(projectPromptLimits(limits.maxEvidenceChars).maxInputChars).toBe(1_360_000);
    await expect(panel.setEvidenceSettings!({ depth: "standard", include: [] }, 1)).rejects.toThrow("changed");
    expect((await store.readDefinition()).evidence?.depth).toBe("whole");
  });

  it.each(["../outside/**", "C:/outside/**", "/absolute/**", "src/../../secret", "src\\file", "src\nfile"])("rejects invalid scope %s", (pattern) => {
    expect(projectEvidenceSettingsSchema.safeParse({ depth: "deep", include: [pattern] }).success).toBe(false);
  });

  it("validates globs and keeps explicit overrides while changing depth defaults", () => {
    const settings = projectEvidenceSettingsSchema.parse({ depth: "deep", files: 150, include: [" src/** ", "**/*.{ts,js}"] });
    expect(resolveProjectEvidenceSettings(settings)).toMatchObject({ maxFiles: 150, maxFileChars: 20_000, maxEvidenceChars: 900_000, include: ["src/**", "**/*.{ts,js}"] });
    expect(projectEvidenceSettingsSchema.safeParse({ ...settings, chars: 1_200_001 }).success).toBe(false);
  });
});
