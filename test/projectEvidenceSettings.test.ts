import { describe, expect, it, vi } from "vitest";
import { projectEvidenceSettingsSchema, resolveProjectEvidenceSettings, projectPromptLimits } from "../src/features/project/contracts/projectEvidenceSettings.js";
import { ProjectStore, defaultProjectDefinition } from "../src/features/project/host/persistence/projectStore.js";

vi.mock("vscode", () => ({ workspace: {} }));

describe("Project-owned reading settings", () => {
  it("keeps explicit evidence unchanged after removing redundant scan settings and saving paths", async () => {
    const { createProjectPanelDataSource, effectiveProjectEvidenceSettings } = await import("../src/features/project/host/projectPanelDataSource.js");
    const clean = { ...defaultProjectDefinition(), evidence: { depth: "whole" as const, include: ["src/**"] } };
    const legacy = { ...clean, scan: { roots: ["src"], includeTests: false, extraExcludes: [] } };
    const limits = resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(clean));
    expect(resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(legacy))).toEqual(limits);
    expect(limits).toEqual({ maxFiles: 1000, maxSourceFiles: 1000, maxFileChars: 24000, maxEvidenceChars: 1200000, include: ["src/**"], preset: "whole" });

    const files = new Map([[".dext/project.json", JSON.stringify(clean)]]);
    const store = new ProjectStore({
      readFile: async (path) => files.get(path),
      writeFile: async (path, content) => { files.set(path, content); },
      listDirectory: async () => []
    });
    const panel = createProjectPanelDataSource({
      name: "Example", root: ".", rootUri: {} as never,
      store: {
        readDefinition: () => store.readDefinition(),
        writeDefinition: (value, version) => store.writeDefinition(value, version),
        readObjects: async () => [], readArchitecture: async () => ({ decisions: [] })
      },
      readEvidence: vi.fn(),
      readStructureIndex: vi.fn()
    });
    const workspace = { planDirectory: ".project/plans", apiDirs: ["tools/api"], skillDirs: [], mcpDirs: [] };
    await panel.setWorkspaceSettings!(workspace, clean.version);
    const saved = await store.readDefinition();
    expect(saved.paths).toEqual(workspace);
    expect(saved).not.toHaveProperty("preset");
    expect(saved).not.toHaveProperty("scan");
    expect(resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(saved))).toEqual(limits);
  });

  it("saves and reloads per project, preserving unrelated settings and rejecting stale edits", async () => {
    const { createProjectPanelDataSource, effectiveProjectEvidenceSettings } = await import("../src/features/project/host/projectPanelDataSource.js");
    const files = new Map<string, string>();
    const host = {
      readFile: async (path: string) => files.get(path),
      writeFile: async (path: string, value: string) => { files.set(path, value); },
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
      readStructureIndex: vi.fn()
    });
    const panel = source();
    const loaded = await panel.load();
    expect(loaded.overview.evidenceSettings).toEqual({ depth: "standard", include: [] });
    const before = files.get(".dext/project.json");
    await expect(panel.setEvidenceSettings!({ depth: "whole", files: 0, include: [] }, 1)).rejects.toThrow();
    expect(files.get(".dext/project.json")).toBe(before);
    await panel.setEvidenceSettings!({ depth: "whole", include: [] }, loaded.overview.evidenceSettingsVersion!);
    const saved = await new ProjectStore(host).readDefinition();
    expect(saved.ai).toEqual({ cli: "claude" });
    expect(saved.scan).toEqual({ roots: ["src"] });
    expect((await source().load()).overview).toMatchObject({ evidenceSettings: { depth: "whole", include: [] }, evidenceSettingsVersion: 2 });
    expect((await source().load()).overview.evidenceConfigured).toBe(true);
    // Explicit empty scope is valid; old scan roots are inactive.
    const limits = resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(saved));
    expect(limits).toMatchObject({ maxFiles: 1000, maxEvidenceChars: 1_200_000, include: [], preset: "whole" });
    expect(projectPromptLimits(limits.maxEvidenceChars).maxInputChars).toBe(1_360_000);
    await expect(panel.setEvidenceSettings!({ depth: "standard", include: [] }, 1)).rejects.toThrow("changed");
    expect((await store.readDefinition()).evidence?.depth).toBe("whole");
  });

  it.each([
    ["standard", 600, 16_000, 600_000],
    ["deep", 800, 20_000, 900_000],
    ["whole", 1000, 24_000, 1_200_000]
  ] as const)("keeps %s evidence and prompt budgets aligned", (depth, files, fileChars, chars) => {
    const limits = resolveProjectEvidenceSettings({ depth, include: [] });
    expect(limits).toEqual({ maxFiles: files, maxSourceFiles: files, maxFileChars: fileChars, maxEvidenceChars: chars, include: [], preset: depth });
    expect(projectPromptLimits(chars)).toEqual({ maxInputChars: chars + 160_000, maxOutputChars: 240_000, maxOutputTokens: 32_000 });
  });

  it("defaults missing evidence to standard while keeping prompt headroom for small overrides", async () => {
    const { effectiveProjectEvidenceSettings } = await import("../src/features/project/host/projectPanelDataSource.js");
    expect(effectiveProjectEvidenceSettings(undefined)).toEqual({ depth: "standard", include: [] });
    const limits = resolveProjectEvidenceSettings(projectEvidenceSettingsSchema.parse({ depth: "whole", chars: 20_000, include: [] }));
    expect(projectPromptLimits(limits.maxEvidenceChars).maxInputChars).toBe(400_000);
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
