import { describe, expect, it, vi } from "vitest";
import { buildProjectEvidencePackage, type ProjectAiRequest } from "../src/core/projectAiGeneration.js";

vi.mock("vscode", () => ({
  Uri: {
    file: (fsPath: string) => ({ scheme: "file", fsPath, path: fsPath, toString: () => `file:///${fsPath}` }),
    joinPath: (base: { fsPath?: string }, ...parts: string[]) => ({ scheme: "file", fsPath: [base.fsPath ?? "", ...parts].join("/") })
  },
  workspace: { fs: { writeFile: vi.fn() } },
  window: { showSaveDialog: vi.fn() }
}));

const evidence = () => buildProjectEvidencePackage({ projectName: "Example", files: [] });

/** A provider that behaves like the CLI bridge: it reports one line of activity per attempt, then fails. */
const failingProvider = () => ({
  id: "fixture-cli",
  generate: async (request: ProjectAiRequest) => {
    request.onEvent?.({ phase: "message" as const, text: "Selected model is at capacity. Please try a different model." });
    throw new Error("Codex CLI exited with code 1");
  }
});

async function failedInitializationOutput(): Promise<string> {
  const { createProjectPanelDataSource } = await import("../src/vscodeProjectHost.js");
  const dataSource = createProjectPanelDataSource({
    name: "Example",
    root: "C:/ws",
    rootUri: { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never,
    store: { readObjects: async () => [], readArchitecture: async () => ({ decisions: [] }) },
    readEvidence: async () => evidence(),
    projectAiProvider: failingProvider()
  });
  await expect(dataSource.initialize?.()).rejects.toThrow();
  return dataSource.initialization?.().output ?? "";
}

describe("project initialization output", () => {
  it("writes every provider activity line to the output exactly once", async () => {
    const output = await failedInitializationOutput();
    const lines = output.split("\n").filter(Boolean);

    // `AI analysis started` is emitted once by the service; forwarding the same event through both
    // `onOutput` and a second event-to-text path used to append it twice (a real UI bug).
    expect(lines.filter((line) => line.startsWith("AI analysis started:"))).toHaveLength(1);
    // Two attempts run, so the provider's single line per attempt must appear exactly twice in total.
    expect(lines.filter((line) => line === "Selected model is at capacity. Please try a different model.")).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("AI analysis attempt failed:"))).toHaveLength(2);
  });

  it("keeps the failed state readable instead of hiding the CLI reason", async () => {
    const output = await failedInitializationOutput();
    expect(output).toContain("Selected model is at capacity. Please try a different model.");
    expect(output).toContain("AI analysis attempt failed: Codex CLI exited with code 1");
  });

  it("records what the model was given and never opens a path the record does not list", async () => {
    const { createProjectPanelDataSource } = await import("../src/vscodeProjectHost.js");
    const written: unknown[] = [];
    const opened: string[] = [];
    const summary = {
      version: 1, trigger: "initialize", generatedAt: 7, inputHash: "hash",
      selection: { scope: ["src/**"], preset: "standard", files: 600, fileChars: 16_000, evidenceChars: 600_000 },
      inventory: { total: 2, withSymbols: 1, byKind: { source: 2 } },
      excerpts: { total: 1, truncated: 0, byKind: { source: 1 } },
      omitted: { files: 1, objects: 0, knowledge: 0 },
      coverage: ["Source text exceeds the limit."],
      paths: ["src/app.ts", "src/deep/other.ts"],
      excerpted: ["src/app.ts"]
    } as never;
    const dataSource = createProjectPanelDataSource({
      name: "Example",
      root: "C:/ws",
      rootUri: { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never,
      store: {
        readObjects: async () => [],
        readArchitecture: async () => ({ decisions: [] }),
        readDiagrams: async () => [],
        readEvidenceSummary: async () => summary,
        writeEvidenceSummary: async (value) => { written.push(value); }
      },
      readEvidence: async () => evidence(),
      openEvidence: async (path) => { opened.push(path); },
      projectAiProvider: failingProvider()
    });

    // The record survives a failed generation: it describes the input, not the outcome.
    await expect(dataSource.initialize?.()).rejects.toThrow();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ version: 1, trigger: "initialize" });

    const loaded = await dataSource.load();
    expect(loaded.architecture.evidence).toMatchObject({ inputHash: "hash", paths: ["src/app.ts", "src/deep/other.ts"] });

    await dataSource.openEvidencePath?.("src/app.ts");
    expect(opened).toEqual(["src/app.ts"]);
    // A path the model never saw, and an unsafe one, are both refused.
    await dataSource.openEvidencePath?.("src/secret.ts");
    await dataSource.openEvidencePath?.("../outside.ts");
    expect(opened).toEqual(["src/app.ts"]);
  });

  it("surfaces a removed scan profile instead of silently ignoring the configured roots", async () => {
    const { createProjectPanelDataSource, legacyScanInclude, legacyScanRoots } = await import("../src/vscodeProjectHost.js");
    const definition = {
      schemaVersion: 1, version: 1, preset: { default: "engineering" },
      knowledge: { enabled: true, initialized: true }, ai: {}, updatedAt: 1,
      // The removed scanner profile survives on disk and keeps acting as the evidence scope.
      scan: { roots: ["src", "tools/"], includeTests: false, extraExcludes: [] }
    } as never;
    expect(legacyScanRoots(definition)).toEqual(["src", "tools/"]);
    expect(legacyScanInclude(definition)).toEqual(["src/**", "tools/**"]);
    expect(legacyScanInclude(undefined)).toEqual([]);
    expect(legacyScanInclude({ scan: { roots: ["."] } } as never)).toEqual(["**"]);

    const dataSource = createProjectPanelDataSource({
      name: "Example",
      root: "C:/ws",
      rootUri: { scheme: "file", fsPath: "C:/ws", path: "/C:/ws" } as never,
      store: {
        readObjects: async () => [],
        readArchitecture: async () => ({ decisions: [] }),
        readDefinition: async () => definition,
        readDiagrams: async () => []
      },
      readEvidence: async () => evidence()
    });
    const data = await dataSource.load();
    expect(data.overview.legacyScanRoots).toEqual(["src", "tools/"]);
  });
});
