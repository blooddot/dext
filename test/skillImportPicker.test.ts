import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { skillImportChoices } from "../src/features/resources/host/skillImportPicker.js";

vi.mock("vscode", () => ({
  window: { showQuickPick: vi.fn() },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() { this.token.isCancellationRequested = true; }
    dispose() {}
  }
}));
afterEach(() => vi.clearAllMocks());

describe("Skill import source picker", () => {
  it("recommends the conversation's Agent and shows source directories", async () => {
    const picker = vi.mocked(vscode.window.showQuickPick);
    picker.mockResolvedValueOnce({ label: "Claude", agent: "claude" } as vscode.QuickPickItem);
    const choices = skillImportChoices("codex");
    expect(choices.preferredAgent).toBe("codex");
    const target = await choices.chooseTarget!({
      targets: ["shared", "codex", "claude"], recommended: "codex",
      sources: [{ path: "skills/review", agent: "shared" }, { path: ".codex/skills/review", agent: "codex" }]
    });
    expect(target).toBe("claude");
    const items = picker.mock.calls[0]![0] as vscode.QuickPickItem[];
    expect(items[0]).toMatchObject({ label: "Codex", description: "Recommended" });
    expect(items[0]?.detail).toContain(".codex/skills/review");
    expect(items[0]?.detail).toContain("skills/review");
  });

  it("returns an exact source path and lets cancellation abort the import", async () => {
    const picker = vi.mocked(vscode.window.showQuickPick);
    picker.mockResolvedValueOnce({ label: "b/review", path: "b/review" } as vscode.QuickPickItem);
    const choices = skillImportChoices();
    expect(await choices.chooseVariant!({ kind: "skill", id: "review", targetAgent: "shared",
      sources: [{ path: "a/review", agent: "shared" }, { path: "b/review", agent: "shared" }]
    })).toBe("b/review");
    picker.mockResolvedValueOnce(undefined);
    expect(await choices.chooseTarget!({ targets: ["shared"], recommended: "shared", sources: [] })).toBeUndefined();
  });

  it("closes an outstanding picker when the turn is stopped", async () => {
    const controller = new AbortController();
    vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (_items, _options, token) => {
      controller.abort(new Error("stopped"));
      expect(token?.isCancellationRequested).toBe(true);
      return undefined;
    });
    const choices = skillImportChoices("codex", controller.signal);
    await expect(choices.chooseTarget!({ targets: ["codex"], recommended: "codex", sources: [] })).rejects.toThrow("stopped");
  });
});
