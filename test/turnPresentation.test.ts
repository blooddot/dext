import { describe, expect, it } from "vitest";
import { presentTurn, TURN_EDIT_ACTION, TURN_RENAME_ACTION, TurnTitle } from "../src/turnPresentation.js";

describe("turn title presentation", () => {
  it("keeps the shared Input, Process, and Output presentation stable", () => {
    expect(presentTurn({ source: "prompt", mode: "agent", durationMs: 1_234 })).toEqual({
      input: {
        kind: "input", label: "Input", source: "prompt",
        mode: { value: "agent", label: "Agent", title: "Submitted in Agent mode" }
      },
      process: { kind: "process", label: "Process", detail: "Worked for 1s234ms" },
      output: { kind: "output", label: "Output" }
    });
    expect(presentTurn({ source: "internal", hideInput: true }).input).toBeUndefined();
  });

  it("distinguishes editing input from renaming the title", () => {
    expect(TURN_EDIT_ACTION).toEqual({ icon: "edit", label: "Edit input in Dext" });
    expect(TURN_RENAME_ACTION).toEqual({ icon: "rename", label: "Rename turn" });
  });

  it("does not invent elapsed time when a stored duration is unavailable or invalid", () => {
    for (const durationMs of [undefined, 0, -1, NaN, Infinity]) {
      expect(presentTurn({ source: "prompt", durationMs }).process.detail).toBeUndefined();
    }
  });

  it("restores a stored name and preserves it when a Plan turn is hydrated", () => {
    const label = { textContent: "" };
    const title = new TurnTitle(label, "Original input", "My title");
    expect(label.textContent).toBe("My title");
    title.setPlanPath(".dext/plans/implementation.md");
    expect(label.textContent).toBe("My title");
    title.rename(undefined, "Plan: implementation.md");
    expect(label.textContent).toBe("Plan: implementation.md");
  });

  it("keeps renamed cached titles through later hydration and restores the original on reset", () => {
    const label = { textContent: "" };
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
});
