import { describe, expect, it } from "vitest";
import { formatTurnTokenUsage, presentTurn, resultCopyText, TURN_COPY_ACTION, TURN_COPY_INPUT_ACTION, TURN_EDIT_ACTION, TURN_RENAME_ACTION } from "../src/features/conversations/presentation/turnPresentation.js";
import type { DextResult } from "../src/shared/contracts/types.js";
import { TurnTitle } from "../src/features/conversations/browser/turnTitle.js";

describe("turn title presentation", () => {
  it("keeps the shared Process and Output presentation stable", () => {
    expect(presentTurn({ durationMs: 1_234 })).toEqual({
      process: { kind: "process", detail: "Worked 1s234ms" },
      output: { kind: "output" }
    });
  });

  it("distinguishes editing input from renaming the title", () => {
    expect(TURN_EDIT_ACTION).toEqual({ icon: "edit", label: "Edit input in Dext" });
    expect(TURN_RENAME_ACTION).toEqual({ icon: "rename", label: "Rename turn" });
    // Copying the prompt uses the same icon as every other copy control; the
    // Markdown export is the one that gets a different glyph.
    expect(TURN_COPY_INPUT_ACTION).toEqual({ icon: "copy", label: "Copy input only" });
    expect(TURN_COPY_ACTION).toEqual({ icon: "markdown", label: "Copy turn as Markdown" });
  });

  it("keeps the last reported usage through completion without summing snapshots", () => {
    const process = [
      { phase: "status" as const, text: "", usage: { totalTokens: 900 } },
      { phase: "status" as const, text: "", usage: { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 234 } },
      { phase: "message" as const, text: "Done" }
    ];
    expect(presentTurn({ durationMs: 1_234, process }).process.detail)
      .toBe("Worked 1s234ms · 1.2k tokens");
    expect(presentTurn({ process }).process.detail).toBe("1.2k tokens");
  });

  it("keeps billed usage when a later snapshot only carries context occupancy", () => {
    const process = [
      { phase: "status" as const, text: "", usage: { totalTokens: 900 } },
      { phase: "status" as const, text: "", usage: { contextTokens: 12_345, contextWindowTokens: 1_000_000 } }
    ];
    expect(presentTurn({ process }).process.detail).toBe("900 tokens");
  });

  it.each([
    [{ totalTokens: 0 }, "0 tokens"],
    [{ totalTokens: 999 }, "999 tokens"],
    [{ totalTokens: 12_345, inputTokens: 1, outputTokens: 2 }, "12k tokens"],
    [{ contextTokens: 12_345, contextWindowTokens: 1_000_000 }, "12k/1M context"],
    [{ contextTokens: 4_500 }, "4.5k context"],
    [{ contextTokens: 900 }, "900 context"],
    [{ contextTokens: 12_345, totalTokens: 900 }, "900 tokens"],
    [{ contextTokens: -1 }, ""],
    [{ inputTokens: 1 }, ""],
    [{ cachedInputTokens: 800 }, ""],
    [{ totalTokens: -1 }, ""],
    [{ totalTokens: Infinity }, ""],
    [undefined, ""]
  ])("formats provider usage %j consistently", (usage, expected) => {
    expect(formatTurnTokenUsage(usage)).toBe(expected);
  });

  it("does not invent elapsed time when a stored duration is unavailable or invalid", () => {
    for (const durationMs of [undefined, 0, -1, NaN, Infinity]) {
      expect(presentTurn({ durationMs }).process.detail).toBeUndefined();
    }
  });

  it("copies only what Output shows", () => {
    const terminal = { kind: "terminal" as const, status: "succeeded" as const, command: "git rev-parse HEAD", cwd: "/w", exit_code: 0, stdout: "f0af18c\n", stderr: "", duration_ms: 1 };
    expect(resultCopyText(terminal)).toBe("");
    expect(resultCopyText({ reported: true } as unknown as DextResult)).toBe("");
    expect(resultCopyText({ kind: "ask", text: "检查通过。" })).toBe("检查通过。");
    expect(resultCopyText({ kind: "mcpRaw", server: "files", tool: "read", content: "x" })).toContain('"tool": "read"');
  });

  it("restores a stored name and preserves it when a Plan turn is hydrated", () => {
    const label = { textContent: "", hidden: false };
    const title = new TurnTitle(label, "Original input", "My title");
    expect(label.textContent).toBe("My title");
    title.setPlanPath(".dext/plans/implementation.md");
    expect(label.textContent).toBe("My title");
    title.rename(undefined, "Plan: implementation.md");
    expect(label.textContent).toBe("Plan: implementation.md");
  });

  it("keeps renamed cached titles through later hydration and restores the original on reset", () => {
    const label = { textContent: "", hidden: false };
    const title = new TurnTitle(label, "Original input");
    title.rename('<New & "title">', "Original input");
    expect(label.textContent).toBe('<New & "title">');
    title.setPlanPath(".dext/plans/plan.md");
    expect(label.textContent).toBe('<New & "title">');
    title.rename(undefined, "Original input");
    expect(label.textContent).toBe("Original input");
    title.setPlanPath(".dext/plans/plan.md");
    expect(label.textContent).toBe("Plan: plan.md");
  });

  it("uses the prompt as the label until a name is given", () => {
    const label = { textContent: "", hidden: false };
    const title = new TurnTitle(label, "first line", undefined, {});
    expect(label.hidden).toBe(true);
    title.rename("Custom name", "first line");
    expect(label.hidden).toBe(false);
    expect(label.textContent).toBe("Custom name");
    title.rename(undefined, "first line");
    expect(label.hidden).toBe(true);
    // A Plan turn has no prompt element, so its Plan label always shows.
    const plan = { textContent: "", hidden: true };
    new TurnTitle(plan, "Plan: a.md");
    expect(plan.hidden).toBe(false);
  });
});
