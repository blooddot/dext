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
});
